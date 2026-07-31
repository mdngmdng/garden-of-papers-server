const crypto = require('node:crypto');
const { promisify } = require('node:util');
const zlib = require('node:zlib');
const config = require('../config');
const qwen = require('./qwen');
const s3Service = require('./s3');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const SCHEMA_VERSION = 1;
const INSTRUCTION_VERSION = 'citation-evidence-v1';
const memoryCache = new Map();
const buildJobs = new Map();

function semanticIndexKey(projectName, fileId) {
  return [
    'semantic-index',
    projectName,
    fileId,
    `${config.qwen.indexName}.json.gz`,
  ].join('/');
}

function sentenceHash(sentences) {
  return crypto
    .createHash('sha256')
    .update(sentences.join('\u001e'))
    .digest('hex');
}

function encodeVectors(embeddings, dimensions) {
  const buffer = Buffer.allocUnsafe(embeddings.length * dimensions * 4);
  let byteOffset = 0;
  for (const vector of embeddings) {
    if (!Array.isArray(vector) || vector.length !== dimensions) {
      throw new Error('Cannot cache inconsistent Qwen embedding dimensions');
    }
    for (const value of vector) {
      buffer.writeFloatLE(value, byteOffset);
      byteOffset += 4;
    }
  }
  return buffer.toString('base64');
}

function decodeVectors(encoded, sentenceCount, dimensions) {
  const buffer = Buffer.from(encoded, 'base64');
  const expectedBytes = sentenceCount * dimensions * 4;
  if (buffer.length !== expectedBytes) {
    throw new Error('Cached semantic index has an invalid vector payload');
  }
  const vectors = new Float32Array(sentenceCount * dimensions);
  for (let index = 0; index < vectors.length; index += 1) {
    vectors[index] = buffer.readFloatLE(index * 4);
  }
  return vectors;
}

function hydrateIndex(payload) {
  if (
    payload?.schemaVersion !== SCHEMA_VERSION
    || !Number.isInteger(payload.sentenceCount)
    || !Number.isInteger(payload.dimensions)
    || payload.dimensions <= 0
    || typeof payload.vectors !== 'string'
  ) {
    throw new Error('Cached semantic index has an unsupported format');
  }
  return {
    ...payload,
    vectors: decodeVectors(
      payload.vectors,
      payload.sentenceCount,
      payload.dimensions,
    ),
  };
}

function serializeIndex(index) {
  return {
    schemaVersion: SCHEMA_VERSION,
    instructionVersion: INSTRUCTION_VERSION,
    model: index.model,
    sentenceHash: index.sentenceHash,
    sentenceCount: index.sentenceCount,
    dimensions: index.dimensions,
    createdAt: index.createdAt,
    vectors: encodeVectors(index.embeddings, index.dimensions),
  };
}

function cacheIndex(cacheKey, index) {
  memoryCache.delete(cacheKey);
  memoryCache.set(cacheKey, index);
  while (memoryCache.size > config.qwen.memoryCacheEntries) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
}

function isMissingObject(error) {
  return Boolean(
    error?.name === 'NoSuchKey'
    || error?.Code === 'NoSuchKey'
    || error?.$metadata?.httpStatusCode === 404,
  );
}

async function loadSemanticIndex(projectName, fileId, expectedHash) {
  const cacheKey = `${projectName}/${fileId}`;
  const cached = memoryCache.get(cacheKey);
  if (
    cached
    && cached.sentenceHash === expectedHash
    && cached.model === config.qwen.embeddingModel
    && cached.instructionVersion === INSTRUCTION_VERSION
  ) {
    cacheIndex(cacheKey, cached);
    return cached;
  }

  try {
    const compressed = await s3Service.downloadSemanticIndex(
      semanticIndexKey(projectName, fileId),
    );
    const payload = JSON.parse((await gunzip(compressed)).toString('utf8'));
    const index = hydrateIndex(payload);
    if (
      index.sentenceHash !== expectedHash
      || index.model !== config.qwen.embeddingModel
      || index.instructionVersion !== INSTRUCTION_VERSION
    ) {
      return null;
    }
    cacheIndex(cacheKey, index);
    console.log(`[SemanticIndex] Loaded ${cacheKey} from S3`);
    return index;
  } catch (error) {
    if (isMissingObject(error)) return null;
    console.warn(`[SemanticIndex] Could not load ${cacheKey}: ${error.message}`);
    return null;
  }
}

async function buildSemanticIndex(projectName, fileId, sentences) {
  const cacheKey = `${projectName}/${fileId}`;
  console.log(`[SemanticIndex] Embedding ${sentences.length} sentences for ${cacheKey}`);
  const result = await qwen.embedDocuments(sentences);
  const index = {
    schemaVersion: SCHEMA_VERSION,
    instructionVersion: INSTRUCTION_VERSION,
    model: result.model,
    sentenceHash: sentenceHash(sentences),
    sentenceCount: sentences.length,
    dimensions: result.dimensions,
    createdAt: new Date().toISOString(),
    embeddings: result.embeddings,
    vectors: null,
  };
  const compressed = await gzip(
    Buffer.from(JSON.stringify(serializeIndex(index)), 'utf8'),
  );
  await s3Service.uploadSemanticIndex(
    semanticIndexKey(projectName, fileId),
    compressed,
  );
  const hydrated = {
    ...index,
    vectors: decodeVectors(
      encodeVectors(result.embeddings, result.dimensions),
      sentences.length,
      result.dimensions,
    ),
  };
  delete hydrated.embeddings;
  cacheIndex(cacheKey, hydrated);
  console.log(
    `[SemanticIndex] Saved ${cacheKey} to S3 `
    + `(${sentences.length}x${result.dimensions})`,
  );
  return hydrated;
}

async function ensureSemanticIndex(projectName, fileId, sentences) {
  if (!config.qwen.enabled) {
    throw new Error('Qwen retrieval is disabled');
  }
  const cacheKey = `${projectName}/${fileId}`;
  const hash = sentenceHash(sentences);
  const existingJob = buildJobs.get(cacheKey);
  if (existingJob) return existingJob;

  const job = (async () => {
    const existing = await loadSemanticIndex(projectName, fileId, hash);
    return existing || buildSemanticIndex(projectName, fileId, sentences);
  })().finally(() => {
    buildJobs.delete(cacheKey);
  });
  buildJobs.set(cacheKey, job);
  return job;
}

function dotProduct(query, vectors, start, dimensions) {
  let score = 0;
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    score += query[dimension] * vectors[start + dimension];
  }
  return score;
}

function shouldUseGeminiFallback({ rerankError, confidence, margin }) {
  return Boolean(
    rerankError
    || confidence < config.qwen.minimumRerankScore
    || (
      confidence < config.qwen.highConfidenceRerankScore
      && margin < config.qwen.minimumRerankMargin
    )
  );
}

async function findClosestSentence({
  projectName,
  fileId,
  context,
  sentences,
}) {
  const index = await ensureSemanticIndex(projectName, fileId, sentences);
  const query = await qwen.embedQuery(context);
  if (query.dimensions !== index.dimensions) {
    throw new Error('Qwen query and document embedding dimensions do not match');
  }

  const candidates = sentences
    .map((text, sentenceIndex) => ({
      sentenceIndex,
      text,
      retrievalScore: dotProduct(
        query.embedding,
        index.vectors,
        sentenceIndex * index.dimensions,
        index.dimensions,
      ),
    }))
    .sort((left, right) => right.retrievalScore - left.retrievalScore)
    .slice(0, Math.min(config.qwen.topK, sentences.length));

  let ranked = candidates;
  let provider = 'qwen-embedding';
  let rerankError = null;
  try {
    const reranked = await qwen.rerank(
      context,
      candidates.map((candidate) => candidate.text),
    );
    ranked = candidates
      .map((candidate, candidateIndex) => ({
        ...candidate,
        rerankScore: reranked.scores[candidateIndex],
      }))
      .sort((left, right) => right.rerankScore - left.rerankScore);
    provider = 'qwen-reranker';
  } catch (error) {
    rerankError = error;
    console.warn(`[SemanticIndex] Reranker unavailable: ${error.message}`);
  }

  const winner = ranked[0];
  const runnerUp = ranked[1];
  const confidence = winner?.rerankScore ?? winner?.retrievalScore ?? 0;
  const margin = runnerUp
    ? confidence - (runnerUp.rerankScore ?? runnerUp.retrievalScore)
    : confidence;
  return {
    index: winner?.sentenceIndex ?? -1,
    confidence,
    margin,
    provider,
    candidateIndices: ranked.map((candidate) => candidate.sentenceIndex),
    needsGeminiFallback: shouldUseGeminiFallback({
      rerankError,
      confidence,
      margin,
    }),
  };
}

module.exports = {
  semanticIndexKey,
  sentenceHash,
  encodeVectors,
  decodeVectors,
  shouldUseGeminiFallback,
  ensureSemanticIndex,
  findClosestSentence,
};
