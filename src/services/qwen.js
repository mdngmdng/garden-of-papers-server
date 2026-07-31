const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.qwen.serviceUrl,
  timeout: config.qwen.requestTimeoutMs,
  headers: { 'Content-Type': 'application/json' },
});

function assertEmbeddingResponse(data, expectedCount) {
  if (
    !data
    || !Number.isInteger(data.dimensions)
    || data.dimensions <= 0
    || !Array.isArray(data.embeddings)
    || data.embeddings.length !== expectedCount
    || data.embeddings.some(
      (vector) => !Array.isArray(vector) || vector.length !== data.dimensions,
    )
  ) {
    throw new Error('Qwen returned an invalid embedding response');
  }
}

async function embedTexts(texts, kind, task = 'citation_evidence') {
  if (!config.qwen.enabled) {
    throw new Error('Qwen retrieval is disabled');
  }
  const allEmbeddings = [];
  let dimensions = 0;
  let model = config.qwen.embeddingModel;
  for (let offset = 0; offset < texts.length; offset += config.qwen.requestBatchSize) {
    const batch = texts.slice(offset, offset + config.qwen.requestBatchSize);
    const { data } = await client.post('/embed', { texts: batch, kind, task });
    assertEmbeddingResponse(data, batch.length);
    if (dimensions && data.dimensions !== dimensions) {
      throw new Error('Qwen embedding dimensions changed within one request');
    }
    dimensions = data.dimensions;
    model = data.model || model;
    allEmbeddings.push(...data.embeddings);
  }
  return { model, dimensions, embeddings: allEmbeddings };
}

async function embedDocuments(texts) {
  return embedTexts(texts, 'document');
}

async function embedQuery(text) {
  const result = await embedTexts([text], 'query');
  return {
    model: result.model,
    dimensions: result.dimensions,
    embedding: result.embeddings[0],
  };
}

async function embedPaperDocuments(texts) {
  return embedTexts(texts, 'document', 'paper_retrieval');
}

async function embedPaperQuery(text) {
  const result = await embedTexts([text], 'query', 'paper_retrieval');
  return {
    model: result.model,
    dimensions: result.dimensions,
    embedding: result.embeddings[0],
  };
}

async function rerank(query, documents, task = 'citation_evidence') {
  if (!config.qwen.enabled) {
    throw new Error('Qwen retrieval is disabled');
  }
  const { data } = await client.post('/rerank', { query, documents, task });
  if (
    !data
    || !Array.isArray(data.scores)
    || data.scores.length !== documents.length
    || data.scores.some((score) => !Number.isFinite(score))
  ) {
    throw new Error('Qwen returned an invalid reranking response');
  }
  return {
    model: data.model || config.qwen.rerankerModel,
    scores: data.scores,
  };
}

async function rerankPapers(query, documents) {
  return rerank(query, documents, 'paper_retrieval');
}

async function health() {
  const { data } = await client.get('/health', { timeout: 5_000 });
  return data;
}

module.exports = {
  embedDocuments,
  embedQuery,
  embedPaperDocuments,
  embedPaperQuery,
  rerank,
  rerankPapers,
  health,
};
