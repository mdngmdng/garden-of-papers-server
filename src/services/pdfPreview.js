const { getClient } = require('./mongo');
const s3Service = require('./s3');

const PDF_PREVIEW_VERSION = 2;
const PDF_PREVIEW_MAX_WIDTH = 320;
const PDF_PREVIEW_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const configuredPreviewConcurrency = Number(
  process.env.PDF_PREVIEW_MAX_CONCURRENCY || 2,
);
const MAX_CONCURRENT_PREVIEW_JOBS = Math.max(
  1,
  Math.min(
    4,
    Number.isFinite(configuredPreviewConcurrency)
      ? Math.floor(configuredPreviewConcurrency)
      : 2,
  ),
);

let pdfModulePromise;
let canvasModule;
const previewJobs = new Map();
const previewQueue = [];
let activePreviewJobs = 0;

function pdfS3Key(projectName, fileId) {
  return `papers/${projectName}/${fileId}.pdf`;
}

function previewS3Key(projectName, fileId, updatedAt) {
  return `previews/${projectName}/${fileId}`
    + `/current-v${PDF_PREVIEW_VERSION}-${updatedAt}.webp`;
}

function previewUrl(projectName, fileId, pageIndex, updatedAt) {
  return `/pdf_preview/${encodeURIComponent(projectName)}/${encodeURIComponent(fileId)}`
    + `?pageIndex=${pageIndex}&v=${updatedAt}`;
}

function createPreviewDescriptor(projectName, fileId, preview) {
  if (!preview || preview.version !== PDF_PREVIEW_VERSION) return null;
  const pageIndex = Number(preview.pageIndex);
  const width = Number(preview.width);
  const height = Number(preview.height);
  const updatedAt = Number(preview.updatedAt);
  if (
    !Number.isInteger(pageIndex)
    || pageIndex < 0
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(updatedAt)
    || updatedAt <= 0
  ) {
    return null;
  }
  return {
    version: PDF_PREVIEW_VERSION,
    sourceId: fileId,
    pageIndex,
    mimeType: 'image/webp',
    url: previewUrl(projectName, fileId, pageIndex, updatedAt),
    width,
    height,
    updatedAt,
  };
}

function isPreviewCurrent(preview, fileId, pageIndex) {
  return Boolean(
    preview
    && preview.version === PDF_PREVIEW_VERSION
    && preview.sourceId === fileId
    && preview.pageIndex === pageIndex
    && typeof preview.url === 'string'
    && preview.url.startsWith('/pdf_preview/')
    && Number.isFinite(preview.width)
    && preview.width > 0
    && Number.isFinite(preview.height)
    && preview.height > 0,
  );
}

function isMissingPdfError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return Boolean(
    error?.name === 'NoSuchKey'
    || error?.Code === 'NoSuchKey'
    || error?.$metadata?.httpStatusCode === 404
    || /specified key does not exist|file not found|no such key/i.test(message),
  );
}

function canAttemptPdfPreview(metadata, now = Date.now()) {
  if (metadata?.previewStatus !== 'failed') return true;
  if (metadata.previewRetryable === false) return false;
  const failedAt = metadata.previewFailedAt
    ? new Date(metadata.previewFailedAt).getTime()
    : 0;
  return !failedAt || now - failedAt >= PDF_PREVIEW_RETRY_COOLDOWN_MS;
}

async function loadRenderer() {
  canvasModule ??= require('@napi-rs/canvas');
  pdfModulePromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    canvas: canvasModule,
    pdfjs: await pdfModulePromise,
  };
}

async function renderPdfPage(pdfBuffer, pageIndex, maxWidth = PDF_PREVIEW_MAX_WIDTH) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('Cannot render an empty PDF');
  }
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error('Invalid PDF preview page');
  }

  const { canvas, pdfjs } = await loadRenderer();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useSystemFonts: true,
    verbosity: 0,
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (pageIndex >= document.numPages) {
      throw new Error(`PDF preview page ${pageIndex + 1} is out of range`);
    }
    const page = await document.getPage(pageIndex + 1);
    const originalViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1, maxWidth / originalViewport.width);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const output = canvas.createCanvas(width, height);
    const context = output.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    await page.render({
      canvas: output,
      viewport,
      background: '#fff',
    }).promise;
    return {
      buffer: await output.encode('webp', 68),
      width,
      height,
      pageCount: document.numPages,
    };
  } finally {
    await document?.destroy().catch(() => {});
    await loadingTask.destroy().catch(() => {});
  }
}

function previewMetadataCollection(client, projectName) {
  return client.db(projectName).collection('PdfMeta');
}

async function generatePdfPreview(
  projectName,
  fileId,
  pageIndex,
  { pdfBuffer, force = false, mongoClient } = {},
) {
  const client = mongoClient ?? getClient();
  if (!client) throw new Error('MongoDB is not connected');
  const metadataCollection = previewMetadataCollection(client, projectName);
  const existing = await metadataCollection.findOne({ fileId });
  if (!force && !canAttemptPdfPreview(existing)) return null;
  const existingPreview = existing?.pdfPagePreview;
  const existingDescriptor = createPreviewDescriptor(
    projectName,
    fileId,
    existingPreview,
  );
  if (!force && isPreviewCurrent(existingDescriptor, fileId, pageIndex)) {
    try {
      await s3Service.headPdfPreview(existingPreview.s3Key);
      await client.db(projectName).collection('SaveFile').updateMany(
        { fileId, abovePageIndex: pageIndex },
        { $set: { pdfPagePreview: existingDescriptor } },
      );
      return existingDescriptor;
    } catch {
      // Missing preview objects are regenerated from the durable PDF below.
    }
  }

  const source = pdfBuffer ?? await s3Service.downloadPdfBuffer(
    pdfS3Key(projectName, fileId),
  );
  const rendered = await renderPdfPage(source, pageIndex);
  const updatedAt = Date.now();
  const s3Key = previewS3Key(projectName, fileId, updatedAt);
  await s3Service.uploadPdfPreview(s3Key, rendered.buffer, 'image/webp');
  const storedPreview = {
    version: PDF_PREVIEW_VERSION,
    pageIndex,
    mimeType: 'image/webp',
    s3Key,
    width: rendered.width,
    height: rendered.height,
    updatedAt,
  };
  const descriptor = createPreviewDescriptor(projectName, fileId, storedPreview);
  await metadataCollection.updateOne(
    { fileId },
    {
      $set: {
        fileId,
        pageCount: rendered.pageCount,
        pdfPagePreview: storedPreview,
        previewStatus: 'ready',
        previewGeneratedAt: new Date(updatedAt),
      },
      $unset: {
        previewError: '',
        previewRetryable: '',
        previewFailedAt: '',
      },
    },
    { upsert: true },
  );
  await client.db(projectName).collection('SaveFile').updateMany(
    { fileId, abovePageIndex: pageIndex },
    { $set: { pdfPagePreview: descriptor } },
  );
  if (existingPreview?.s3Key && existingPreview.s3Key !== s3Key) {
    await s3Service.deletePdf(existingPreview.s3Key).catch(() => {});
  }
  return descriptor;
}

async function markPreviewFailure(
  projectName,
  fileId,
  pageIndex,
  error,
  mongoClient,
) {
  const client = mongoClient ?? getClient();
  if (!client) return;
  const message = error instanceof Error ? error.message : String(error);
  const retryable = !isMissingPdfError(error);
  console.error(`[PDF preview] Failed ${projectName}/${fileId} page=${pageIndex + 1}:`, message);
  await previewMetadataCollection(client, projectName).updateOne(
    { fileId },
    {
      $set: {
        fileId,
        previewStatus: 'failed',
        previewError: message,
        previewRetryable: retryable,
        previewFailedAt: new Date(),
      },
    },
    { upsert: true },
  ).catch(() => {});
}

function drainPreviewQueue() {
  while (
    activePreviewJobs < MAX_CONCURRENT_PREVIEW_JOBS
    && previewQueue.length > 0
  ) {
    const state = previewQueue.shift();
    activePreviewJobs += 1;
    state.running = true;
    Promise.resolve()
      .then(async () => {
        while (state.requestedPageIndex !== null) {
          const pageIndex = state.requestedPageIndex;
          const pdfBuffer = state.pdfBuffer;
          state.requestedPageIndex = null;
          state.pdfBuffer = undefined;
          state.currentPageIndex = pageIndex;
          try {
            await generatePdfPreview(state.projectName, state.fileId, pageIndex, {
              pdfBuffer,
            });
          } catch (error) {
            await markPreviewFailure(
              state.projectName,
              state.fileId,
              pageIndex,
              error,
            );
          } finally {
            state.currentPageIndex = null;
          }
        }
      })
      .finally(() => {
        activePreviewJobs -= 1;
        if (state.requestedPageIndex !== null) {
          state.running = false;
          previewQueue.push(state);
        } else {
          previewJobs.delete(state.jobKey);
        }
        drainPreviewQueue();
      });
  }
}

function queuePdfPreview(projectName, fileId, pageIndex, pdfBuffer) {
  if (
    typeof projectName !== 'string'
    || !projectName
    || typeof fileId !== 'string'
    || !fileId
    || !Number.isInteger(pageIndex)
    || pageIndex < 0
  ) {
    return false;
  }
  const jobKey = `${projectName}/${fileId}`;
  const existing = previewJobs.get(jobKey);
  if (existing) {
    if (existing.currentPageIndex === pageIndex) {
      existing.requestedPageIndex = null;
      return false;
    }
    if (existing.requestedPageIndex === pageIndex) {
      return false;
    }
    existing.requestedPageIndex = pageIndex;
    if (pdfBuffer) existing.pdfBuffer = pdfBuffer;
    return false;
  }
  const state = {
    jobKey,
    projectName,
    fileId,
    requestedPageIndex: pageIndex,
    currentPageIndex: null,
    pdfBuffer,
    running: false,
  };
  previewJobs.set(jobKey, state);
  previewQueue.push(state);
  drainPreviewQueue();
  return true;
}

module.exports = {
  PDF_PREVIEW_VERSION,
  PDF_PREVIEW_MAX_WIDTH,
  canAttemptPdfPreview,
  createPreviewDescriptor,
  generatePdfPreview,
  isPreviewCurrent,
  markPreviewFailure,
  previewS3Key,
  queuePdfPreview,
  renderPdfPage,
};
