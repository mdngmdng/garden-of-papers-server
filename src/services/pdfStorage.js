const crypto = require('node:crypto');
const { getClient } = require('./mongo');
const s3Service = require('./s3');

const SHARED_DATABASE = '_GardenOfPapersShared';
const LIBRARY_COLLECTION = 'PdfLibrary';
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_LOOKUP_TTL_MS = 10 * 60 * 1000;
const resolutionCache = new Map();
const negativeLookupCache = new Map();
const initializedClients = new WeakMap();

function legacyPdfS3Key(projectName, fileId) {
  return `papers/${projectName}/${fileId}.pdf`;
}

function stagingPdfS3Key(projectName, fileId) {
  return `papers/uploads/${encodeURIComponent(projectName)}/${fileId}.pdf`;
}

function sharedPdfS3Key(pdfSha256) {
  return `papers/shared/sha256/${pdfSha256}.pdf`;
}

function isMissingObjectError(error) {
  return Boolean(
    error?.name === 'NoSuchKey'
    || error?.Code === 'NoSuchKey'
    || error?.$metadata?.httpStatusCode === 404
    || /specified key does not exist|file not found|no such key/i.test(
      String(error?.message || ''),
    ),
  );
}

function cleanText(value, maximum = 1_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizeDoi(value) {
  return cleanText(value, 300)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
    .toLowerCase();
}

function canonicalUrl(value) {
  const text = cleanText(value, 2_000);
  if (!text) return '';
  try {
    const url = new URL(text);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function normalizeTitle(value) {
  return cleanText(value, 1_000)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function normalizeAuthor(value) {
  return cleanText(value, 300)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function paperIdentityKeys(identity = {}) {
  const keys = new Set();
  const resultIds = [
    identity.resultId,
    identity.semanticScholarId,
    identity.paperId,
  ].map((value) => cleanText(value, 300).toLowerCase()).filter(Boolean);
  for (const resultId of resultIds) keys.add(`result:${resultId}`);

  const doi = normalizeDoi(identity.doi);
  if (doi) keys.add(`doi:${doi}`);

  const urls = [
    identity.pdfSourceUrl,
    identity.resourceLink,
    identity.url,
  ].map(canonicalUrl).filter(Boolean);
  for (const url of urls) keys.add(`url:${url}`);

  const title = normalizeTitle(identity.title || identity.paperName);
  const year = cleanText(identity.year, 20).toLowerCase();
  const firstAuthor = normalizeAuthor(
    Array.isArray(identity.authors) ? identity.authors[0] : identity.firstAuthor,
  );
  if (title && (year || firstAuthor)) {
    keys.add(`title:${title}|year:${year}|author:${firstAuthor}`);
  }
  return [...keys];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function legacyPaperQuery(identity = {}) {
  const alternatives = [];
  const resultIds = [
    identity.resultId,
    identity.semanticScholarId,
    identity.paperId,
  ].map((value) => cleanText(value, 300)).filter(Boolean);
  if (resultIds.length) alternatives.push({ resultId: { $in: resultIds } });

  const doi = normalizeDoi(identity.doi);
  if (doi) {
    alternatives.push({
      doi: { $regex: `^(?:https?://(?:dx\\.)?doi\\.org/|doi:\\s*)?${escapeRegex(doi)}$`, $options: 'i' },
    });
  }

  const urls = [
    identity.pdfSourceUrl,
    identity.resourceLink,
    identity.url,
  ].map((value) => cleanText(value, 2_000)).filter(Boolean);
  if (urls.length) {
    alternatives.push({ pdfSourceUrl: { $in: urls } });
    alternatives.push({ resourceLink: { $in: urls } });
  }

  const title = cleanText(identity.title || identity.paperName, 1_000);
  const year = cleanText(identity.year, 20);
  if (title && year) {
    const exactTitle = { $regex: `^${escapeRegex(title)}$`, $options: 'i' };
    alternatives.push({
      $and: [
        { $or: [{ paperName: exactTitle }, { title: exactTitle }] },
        { year: { $in: [year, Number(year)].filter((value) => value !== 0) } },
      ],
    });
  }

  if (!alternatives.length) return null;
  return {
    type: 'GX.MAROScientificPaper',
    fileId: { $exists: true, $nin: ['', null] },
    $or: alternatives,
  };
}

function identityFromLegacyDocument(document = {}) {
  return {
    resultId: document.resultId,
    doi: document.doi,
    title: document.paperName || document.title,
    authors: document.authors,
    year: document.year,
    resourceLink: document.resourceLink,
    pdfSourceUrl: document.pdfSourceUrl,
  };
}

function metadataCacheKey(projectName, fileId) {
  return `${Buffer.byteLength(projectName, 'utf8')}:${projectName}:${fileId}`;
}

function rememberPdfS3Key(projectName, fileId, s3Key) {
  resolutionCache.set(metadataCacheKey(projectName, fileId), {
    s3Key,
    expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS,
  });
}

async function ensureLibraryIndexes(client = getClient()) {
  if (!client) throw new Error('MongoDB is not connected');
  let initialized = initializedClients.get(client);
  if (!initialized) {
    const collection = client.db(SHARED_DATABASE).collection(LIBRARY_COLLECTION);
    initialized = Promise.all([
      collection.createIndex({ pdfSha256: 1 }, { unique: true }),
      collection.createIndex({ identityKeys: 1 }),
      collection.createIndex({ updatedAt: -1 }),
    ]).catch((error) => {
      initializedClients.delete(client);
      throw error;
    });
    initializedClients.set(client, initialized);
  }
  await initialized;
}

async function resolvePdfS3Key(projectName, fileId, options = {}) {
  const cacheKey = metadataCacheKey(projectName, fileId);
  const cached = resolutionCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.s3Key;
  if (cached) resolutionCache.delete(cacheKey);

  const client = options.mongoClient ?? getClient();
  const metadata = client
    ? await client.db(projectName).collection('PdfMeta').findOne(
      { fileId },
      { projection: { s3Key: 1 } },
    )
    : null;
  const resolved = cleanText(metadata?.s3Key, 2_000)
    || legacyPdfS3Key(projectName, fileId);
  rememberPdfS3Key(projectName, fileId, resolved);
  return resolved;
}

async function storeSharedPdf({
  projectName,
  fileId,
  pdfBuffer,
  identity = {},
  mongoClient,
  s3 = s3Service,
}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('Cannot store an empty PDF');
  }
  const client = mongoClient ?? getClient();
  if (!client) throw new Error('MongoDB is not connected');
  const pdfSha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const s3Key = sharedPdfS3Key(pdfSha256);
  try {
    await s3.headPdf(s3Key);
  } catch (error) {
    if (!isMissingObjectError(error)) throw error;
    await s3.uploadPdf(s3Key, pdfBuffer);
  }

  const now = new Date();
  const identityKeys = paperIdentityKeys(identity);
  await ensureLibraryIndexes(client);
  const library = client.db(SHARED_DATABASE).collection(LIBRARY_COLLECTION);
  const update = {
    $set: {
      pdfSha256,
      s3Key,
      size: pdfBuffer.length,
      updatedAt: now,
    },
    $setOnInsert: { createdAt: now },
    $addToSet: {
      sourceRefs: { projectName, fileId },
      ...(identityKeys.length
        ? { identityKeys: { $each: identityKeys } }
        : {}),
    },
  };
  await library.updateOne({ pdfSha256 }, update, { upsert: true });
  await client.db(projectName).collection('PdfMeta').updateOne(
    { fileId },
    {
      $set: {
        fileId,
        pdfSha256,
        s3Key,
        size: pdfBuffer.length,
        sharedStorage: true,
        libraryUpdatedAt: now,
      },
    },
    { upsert: true },
  );
  rememberPdfS3Key(projectName, fileId, s3Key);
  for (const key of identityKeys) negativeLookupCache.delete(key);
  return {
    pdfSha256,
    s3Key,
    size: pdfBuffer.length,
    identityKeys,
    sourceRefs: [{ projectName, fileId }],
  };
}

function reusableCitationFields(metadata = {}) {
  const names = [
    'citationHits',
    'pageSizeList',
    'pageSizes',
    'referenceList',
    'references',
    'referenceTitleList',
    'paperMetadata',
    'citationStatus',
    'citationRecoveredFrom',
    'citationsExtractedAt',
  ];
  return Object.fromEntries(
    names.flatMap((name) => (
      metadata[name] === undefined ? [] : [[name, metadata[name]]]
    )),
  );
}

async function validateLibraryCandidate(candidate, s3 = s3Service) {
  if (!candidate?.s3Key || !candidate?.pdfSha256) return false;
  try {
    await s3.headPdf(candidate.s3Key);
    return true;
  } catch (error) {
    if (isMissingObjectError(error)) return false;
    throw error;
  }
}

async function findIndexedPdf(identity, options = {}) {
  const client = options.mongoClient ?? getClient();
  const s3 = options.s3 ?? s3Service;
  const identityKeys = paperIdentityKeys(identity);
  if (!client || !identityKeys.length) return null;
  const allNegative = identityKeys.every(
    (key) => (negativeLookupCache.get(key) ?? 0) > Date.now(),
  );
  if (allNegative) return null;
  await ensureLibraryIndexes(client);
  const candidates = await client
    .db(SHARED_DATABASE)
    .collection(LIBRARY_COLLECTION)
    .find({ identityKeys: { $in: identityKeys } })
    .sort({ updatedAt: -1 })
    .limit(10)
    .toArray();
  for (const candidate of candidates) {
    if (await validateLibraryCandidate(candidate, s3)) return candidate;
  }
  return null;
}

async function findLegacyPdf(projectName, identity, options = {}) {
  const client = options.mongoClient ?? getClient();
  const s3 = options.s3 ?? s3Service;
  const query = legacyPaperQuery(identity);
  if (!client || !query) return null;
  const databases = await client.db().admin().listDatabases();
  const excluded = new Set([
    projectName,
    SHARED_DATABASE,
    'admin',
    'config',
    'local',
    'UserNameList',
  ]);
  for (const entry of databases.databases ?? []) {
    const sourceProjectName = cleanText(entry.name, 300);
    if (!sourceProjectName || excluded.has(sourceProjectName)) continue;
    const sourceDocument = await client
      .db(sourceProjectName)
      .collection('SaveFile')
      .findOne(query, { projection: {
        fileId: 1,
        resultId: 1,
        doi: 1,
        paperName: 1,
        title: 1,
        authors: 1,
        year: 1,
        resourceLink: 1,
        pdfSourceUrl: 1,
      } });
    const sourceFileId = cleanText(sourceDocument?.fileId, 300);
    if (!sourceFileId) continue;
    const originalKey = await resolvePdfS3Key(
      sourceProjectName,
      sourceFileId,
      { mongoClient: client },
    );
    try {
      const pdfBuffer = await s3.downloadPdfBuffer(originalKey);
      const stored = await storeSharedPdf({
        projectName: sourceProjectName,
        fileId: sourceFileId,
        pdfBuffer,
        identity: {
          ...identityFromLegacyDocument(sourceDocument),
          ...identity,
        },
        mongoClient: client,
        s3,
      });
      if (originalKey !== stored.s3Key) {
        await s3.deletePdf(originalKey).catch(() => {});
      }
      return {
        ...stored,
        sourceRefs: [{ projectName: sourceProjectName, fileId: sourceFileId }],
      };
    } catch (error) {
      if (!isMissingObjectError(error)) throw error;
    }
  }
  return null;
}

async function findReusablePdf(projectName, identity, options = {}) {
  const identityKeys = paperIdentityKeys(identity);
  if (!identityKeys.length) return null;
  const indexed = await findIndexedPdf(identity, options);
  if (indexed) return indexed;
  const legacy = await findLegacyPdf(projectName, identity, options);
  if (legacy) return legacy;
  const expiresAt = Date.now() + NEGATIVE_LOOKUP_TTL_MS;
  for (const key of identityKeys) negativeLookupCache.set(key, expiresAt);
  return null;
}

async function reusePdfIntoProject({
  projectName,
  fileId,
  identity,
  mongoClient,
  s3 = s3Service,
}) {
  const client = mongoClient ?? getClient();
  if (!client) throw new Error('MongoDB is not connected');
  const reusable = await findReusablePdf(projectName, identity, {
    mongoClient: client,
    s3,
  });
  if (!reusable) return null;
  const sourceRef = (reusable.sourceRefs ?? []).find(
    (candidate) => candidate?.projectName && candidate?.fileId,
  );
  const sourceMetadata = sourceRef
    ? await client.db(sourceRef.projectName).collection('PdfMeta').findOne({
      fileId: sourceRef.fileId,
    })
    : null;
  const now = new Date();
  const citationFields = reusableCitationFields(sourceMetadata);
  await client.db(projectName).collection('PdfMeta').updateOne(
    { fileId },
    {
      $set: {
        fileId,
        pdfSha256: reusable.pdfSha256,
        s3Key: reusable.s3Key,
        size: reusable.size,
        sharedStorage: true,
        reusedFrom: sourceRef || { pdfSha256: reusable.pdfSha256 },
        uploadedAt: now,
        ...citationFields,
      },
      $unset: {
        citationError: '',
        citationRetryable: '',
        citationsFailedAt: '',
        pdfPagePreview: '',
        previewError: '',
        previewRetryable: '',
        previewFailedAt: '',
        previewStatus: '',
      },
    },
    { upsert: true },
  );
  await client.db(SHARED_DATABASE).collection(LIBRARY_COLLECTION).updateOne(
    { pdfSha256: reusable.pdfSha256 },
    {
      $set: { updatedAt: now },
      $addToSet: {
        sourceRefs: { projectName, fileId },
        identityKeys: { $each: paperIdentityKeys(identity) },
      },
    },
  );
  rememberPdfS3Key(projectName, fileId, reusable.s3Key);
  return {
    ...reusable,
    fileId,
    sourceRef,
    metadata: {
      fileId,
      size: reusable.size,
      pdfSha256: reusable.pdfSha256,
      s3Key: reusable.s3Key,
      ...citationFields,
    },
  };
}

module.exports = {
  LIBRARY_COLLECTION,
  SHARED_DATABASE,
  canonicalUrl,
  findReusablePdf,
  isMissingObjectError,
  legacyPaperQuery,
  legacyPdfS3Key,
  normalizeDoi,
  paperIdentityKeys,
  rememberPdfS3Key,
  resolvePdfS3Key,
  reusePdfIntoProject,
  sharedPdfS3Key,
  stagingPdfS3Key,
  storeSharedPdf,
};
