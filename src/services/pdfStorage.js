const crypto = require('node:crypto');
const { getClient } = require('./mongo');
const s3 = require('./s3');

function normalizeDoi(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[\s.,;]+$/g, '')
    .toLowerCase();
}

function isValidDoi(value) {
  return /^10\.\d{4,9}\/\S+$/i.test(normalizeDoi(value));
}

function legacyPdfKey(projectName, fileId) {
  return `papers/${projectName}/${fileId}.pdf`;
}

function doiPdfKey(doi) {
  const normalized = normalizeDoi(doi);
  if (!isValidDoi(normalized)) return '';
  const digest = crypto.createHash('sha256').update(normalized).digest('hex');
  return `papers/by-doi/${digest}.pdf`;
}

function uploadPdfKey(projectName, fileId, doi) {
  return doiPdfKey(doi) || legacyPdfKey(projectName, fileId);
}

function pdfMetaCollection(projectName, client = getClient()) {
  return client.db(projectName).collection('PdfMeta');
}

async function resolvePdfKey(projectName, fileId, client = getClient()) {
  const metadata = await pdfMetaCollection(projectName, client).findOne(
    { fileId },
    { projection: { storageKey: 1 } },
  );
  return metadata?.storageKey || legacyPdfKey(projectName, fileId);
}

async function findDoiPdf(doi) {
  const normalizedDoi = normalizeDoi(doi);
  const storageKey = doiPdfKey(normalizedDoi);
  if (!storageKey) return null;
  try {
    const metadata = await s3.headPdf(storageKey);
    return {
      doi: normalizedDoi,
      storageKey,
      size: metadata.size,
    };
  } catch (error) {
    if (
      error?.name === 'NoSuchKey'
      || error?.Code === 'NoSuchKey'
      || error?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

async function saveProjectPdfMetadata(
  projectName,
  fileId,
  { doi, storageKey, size, citationStatus = 'processing', uploadedAt = new Date() },
  client = getClient(),
) {
  const normalizedDoi = normalizeDoi(doi);
  await pdfMetaCollection(projectName, client).updateOne(
    { fileId },
    {
      $set: {
        fileId,
        size,
        storageKey: storageKey || legacyPdfKey(projectName, fileId),
        ...(normalizedDoi ? { doi: normalizedDoi } : {}),
        citationStatus,
        uploadedAt,
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
}

module.exports = {
  doiPdfKey,
  findDoiPdf,
  isValidDoi,
  legacyPdfKey,
  normalizeDoi,
  pdfMetaCollection,
  resolvePdfKey,
  saveProjectPdfMetadata,
  uploadPdfKey,
};
