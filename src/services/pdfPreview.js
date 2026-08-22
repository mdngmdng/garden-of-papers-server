const { getClient } = require('./mongo');
const s3Service = require('./s3');
const pdfStorage = require('./pdfStorage');
const { execFile } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const PDF_PREVIEW_VERSION = 2;
const PDF_PREVIEW_RECOVERY_VERSION = 1;
const PDF_PREVIEW_MAX_WIDTH = 320;
const PDF_PREVIEW_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const SHARED_PREVIEW_COLLECTION = 'PdfPreviewLibrary';
const MIN_PDF_PREVIEW_BYTES = 1_000;
const execFileAsync = promisify(execFile);
const configuredPreviewConcurrency = Number(
  process.env.PDF_PREVIEW_MAX_CONCURRENCY || 4,
);
const MAX_CONCURRENT_PREVIEW_JOBS = Math.max(
  1,
  Math.min(
    4,
    Number.isFinite(configuredPreviewConcurrency)
      ? Math.floor(configuredPreviewConcurrency)
      : 4,
  ),
);

let pdfModulePromise;
let canvasModule;
const initializedPreviewClients = new WeakMap();
const previewJobs = new Map();
const previewQueue = [];
let activePreviewJobs = 0;

function previewS3Key(projectName, fileId, updatedAt) {
  return `previews/${projectName}/${fileId}`
    + `/current-v${PDF_PREVIEW_VERSION}-${updatedAt}.webp`;
}

function sharedPreviewS3Key(pdfSha256, pageIndex) {
  return `previews/shared/sha256/${pdfSha256}`
    + `/page-${pageIndex}-v${PDF_PREVIEW_VERSION}.webp`;
}

function sharedPreviewId(pdfSha256, pageIndex) {
  return `${pdfSha256}:page:${pageIndex}:v${PDF_PREVIEW_VERSION}`;
}

function previewForPage(metadata, pageIndex) {
  if (pageIndex === 0) {
    if (metadata?.pdfFirstPagePreview?.pageIndex === 0) {
      return metadata.pdfFirstPagePreview;
    }
    if (metadata?.pdfPagePreview?.pageIndex === 0) {
      return metadata.pdfPagePreview;
    }
    return null;
  }
  return metadata?.pdfPagePreview?.pageIndex === pageIndex
    ? metadata.pdfPagePreview
    : null;
}

function bufferFromMongoBinary(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value.value === 'function') {
    const buffer = value.value(true);
    if (Buffer.isBuffer(buffer)) return buffer;
    if (buffer instanceof Uint8Array) return Buffer.from(buffer);
  }
  if (value?.buffer instanceof Uint8Array) return Buffer.from(value.buffer);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

async function ensureSharedPreviewIndexes(client) {
  let initialized = initializedPreviewClients.get(client);
  if (!initialized) {
    const collection = client
      .db(pdfStorage.SHARED_DATABASE)
      .collection(SHARED_PREVIEW_COLLECTION);
    initialized = Promise.all([
      collection.createIndex(
        { pdfSha256: 1, pageIndex: 1, version: 1 },
        { unique: true, name: 'pdf_preview_by_hash_page_version' },
      ),
      collection.createIndex(
        { updatedAt: -1 },
        { name: 'pdf_preview_updated' },
      ),
    ]).catch((error) => {
      initializedPreviewClients.delete(client);
      throw error;
    });
    initializedPreviewClients.set(client, initialized);
  }
  await initialized;
}

async function loadSharedPreview(client, pdfSha256, pageIndex) {
  if (!pdfSha256) return null;
  await ensureSharedPreviewIndexes(client);
  const document = await client
    .db(pdfStorage.SHARED_DATABASE)
    .collection(SHARED_PREVIEW_COLLECTION)
    .findOne({ _id: sharedPreviewId(pdfSha256, pageIndex) });
  const buffer = bufferFromMongoBinary(document?.image);
  if (!document || !buffer || buffer.length < MIN_PDF_PREVIEW_BYTES) return null;
  return { ...document, buffer };
}

async function storeSharedPreview(client, {
  pdfSha256,
  pageIndex,
  buffer,
  width,
  height,
  s3Key,
  updatedAt,
}) {
  if (!pdfSha256 || !Buffer.isBuffer(buffer) || !buffer.length) return null;
  await ensureSharedPreviewIndexes(client);
  const timestamp = new Date(updatedAt);
  const document = {
    _id: sharedPreviewId(pdfSha256, pageIndex),
    pdfSha256,
    pageIndex,
    version: PDF_PREVIEW_VERSION,
    mimeType: 'image/webp',
    width,
    height,
    size: buffer.length,
    image: buffer,
    s3Key,
    updatedAt: timestamp,
  };
  await client
    .db(pdfStorage.SHARED_DATABASE)
    .collection(SHARED_PREVIEW_COLLECTION)
    .updateOne(
      { _id: document._id },
      {
        $set: {
          pdfSha256,
          pageIndex,
          version: PDF_PREVIEW_VERSION,
          mimeType: 'image/webp',
          width,
          height,
          size: buffer.length,
          image: buffer,
          s3Key,
          updatedAt: timestamp,
        },
        $setOnInsert: { createdAt: timestamp },
      },
      { upsert: true },
    );
  return { ...document, buffer };
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
  if (metadata.previewRetryable === false) {
    return metadata.previewRecoveryVersion !== PDF_PREVIEW_RECOVERY_VERSION;
  }
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

function hasVisiblePageContent(context, width, height) {
  const pixels = context.getImageData(0, 0, width, height).data;
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 20_000)));
  let sampled = 0;
  let nonWhite = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      sampled += 1;
      if (
        pixels[offset] < 245
        || pixels[offset + 1] < 245
        || pixels[offset + 2] < 245
      ) nonWhite += 1;
    }
  }
  return sampled > 0 && nonWhite / sampled >= 0.0005;
}

async function renderPdfPageWithPoppler(
  pdfBuffer,
  pageIndex,
  maxWidth,
  pageCount,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gop-pdf-preview-'));
  const pdfPath = path.join(directory, 'source.pdf');
  const outputBase = path.join(directory, 'page');
  const outputPath = `${outputBase}.png`;
  try {
    await writeFile(pdfPath, pdfBuffer);
    await execFileAsync(
      process.env.PDFTOPPM_PATH || 'pdftoppm',
      [
        '-f', String(pageIndex + 1),
        '-l', String(pageIndex + 1),
        '-singlefile',
        '-scale-to-x', String(maxWidth),
        '-scale-to-y', '-1',
        '-png',
        pdfPath,
        outputBase,
      ],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const { canvas } = await loadRenderer();
    const image = await canvas.loadImage(await readFile(outputPath));
    const output = canvas.createCanvas(image.width, image.height);
    const context = output.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    return {
      buffer: await output.encode('webp', 68),
      width: image.width,
      height: image.height,
      pageCount,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
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
    if (!hasVisiblePageContent(context, width, height)) {
      return renderPdfPageWithPoppler(
        pdfBuffer,
        pageIndex,
        maxWidth,
        document.numPages,
      );
    }
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

function storedPreviewFromShared(shared) {
  return {
    version: PDF_PREVIEW_VERSION,
    pageIndex: shared.pageIndex,
    mimeType: shared.mimeType || 'image/webp',
    s3Key: shared.s3Key,
    mongoCacheId: shared._id,
    width: shared.width,
    height: shared.height,
    updatedAt: new Date(shared.updatedAt).getTime(),
  };
}

async function savePreviewMetadata(
  client,
  projectName,
  fileId,
  pageIndex,
  storedPreview,
  { pageCount } = {},
) {
  const descriptor = createPreviewDescriptor(projectName, fileId, storedPreview);
  const metadataSet = {
    fileId,
    previewStatus: 'ready',
    previewRecoveryVersion: PDF_PREVIEW_RECOVERY_VERSION,
    previewGeneratedAt: new Date(storedPreview.updatedAt),
    ...(Number.isInteger(pageCount) && pageCount > 0 ? { pageCount } : {}),
  };
  if (pageIndex === 0) metadataSet.pdfFirstPagePreview = storedPreview;
  else metadataSet.pdfPagePreview = storedPreview;
  await previewMetadataCollection(client, projectName).updateOne(
    { fileId },
    {
      $set: metadataSet,
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
  return descriptor;
}

async function cachedPdfPreview(
  projectName,
  fileId,
  pageIndex,
  { mongoClient, s3 = s3Service } = {},
) {
  const client = mongoClient ?? getClient();
  if (!client) throw new Error('MongoDB is not connected');
  const metadata = await previewMetadataCollection(client, projectName)
    .findOne({ fileId });
  const existingPreview = previewForPage(metadata, pageIndex);

  if (metadata?.pdfSha256) {
    const shared = await loadSharedPreview(client, metadata.pdfSha256, pageIndex);
    if (shared) {
      const storedPreview = storedPreviewFromShared(shared);
      const storedDescriptor = createPreviewDescriptor(
        projectName,
        fileId,
        storedPreview,
      );
      const descriptor = existingPreview?.mongoCacheId === shared._id
        && existingPreview.updatedAt === storedPreview.updatedAt
        ? storedDescriptor
        : await savePreviewMetadata(
          client,
          projectName,
          fileId,
          pageIndex,
          storedPreview,
        );
      return {
        descriptor,
        preview: storedPreview,
        buffer: shared.buffer,
        etag: `\"${shared._id}\"`,
      };
    }
  }

  const descriptor = createPreviewDescriptor(projectName, fileId, existingPreview);
  if (!descriptor || descriptor.pageIndex !== pageIndex || !existingPreview?.s3Key) {
    return { metadata, descriptor: null };
  }
  try {
    const downloaded = await s3.downloadPdfPreviewBuffer(existingPreview.s3Key);
    if (downloaded.buffer.length < MIN_PDF_PREVIEW_BYTES) {
      return { metadata, descriptor: null };
    }
    if (metadata?.pdfSha256) {
      await storeSharedPreview(client, {
        pdfSha256: metadata.pdfSha256,
        pageIndex,
        buffer: downloaded.buffer,
        width: descriptor.width,
        height: descriptor.height,
        s3Key: existingPreview.s3Key,
        updatedAt: descriptor.updatedAt,
      });
    }
    return {
      descriptor,
      preview: existingPreview,
      buffer: downloaded.buffer,
      etag: downloaded.etag,
    };
  } catch (error) {
    if (!isMissingPdfError(error)) throw error;
    return { metadata, descriptor: null };
  }
}

async function generatePdfPreview(
  projectName,
  fileId,
  pageIndex,
  {
    pdfBuffer,
    force = false,
    mongoClient,
    s3 = s3Service,
    render = renderPdfPage,
  } = {},
) {
  const client = mongoClient ?? getClient();
  if (!client) throw new Error('MongoDB is not connected');
  const metadataCollection = previewMetadataCollection(client, projectName);
  const existing = await metadataCollection.findOne({ fileId });
  if (!force && !canAttemptPdfPreview(existing)) return null;
  const existingPreview = previewForPage(existing, pageIndex);
  const existingDescriptor = createPreviewDescriptor(
    projectName,
    fileId,
    existingPreview,
  );
  if (!force && isPreviewCurrent(existingDescriptor, fileId, pageIndex)) {
    try {
      const cached = await cachedPdfPreview(projectName, fileId, pageIndex, {
        mongoClient: client,
        s3,
      });
      if (!cached?.descriptor) throw new Error('Cached preview is missing');
      await client.db(projectName).collection('SaveFile').updateMany(
        { fileId, abovePageIndex: pageIndex },
        { $set: { pdfPagePreview: cached.descriptor } },
      );
      return cached.descriptor;
    } catch {
      // Missing preview objects are regenerated from the durable PDF below.
    }
  }

  if (!force && existing?.pdfSha256) {
    const shared = await loadSharedPreview(client, existing.pdfSha256, pageIndex);
    if (shared) {
      return savePreviewMetadata(
        client,
        projectName,
        fileId,
        pageIndex,
        storedPreviewFromShared(shared),
      );
    }
  }

  const sourceDetails = pdfBuffer
    ? await pdfStorage.storeSharedPdf({
      projectName,
      fileId,
      pdfBuffer,
      identity: await pdfStorage.paperIdentityForFile?.(projectName, fileId, client),
      mongoClient: client,
      s3,
    }).then((stored) => ({ pdfBuffer, ...stored }))
    : await pdfStorage.loadPdfSource({
      projectName,
      fileId,
      mongoClient: client,
      s3,
    });
  const rendered = await render(sourceDetails.pdfBuffer, pageIndex);
  const updatedAt = Date.now();
  const s3Key = sourceDetails.pdfSha256
    ? sharedPreviewS3Key(sourceDetails.pdfSha256, pageIndex)
    : previewS3Key(projectName, fileId, updatedAt);
  await s3.uploadPdfPreview(s3Key, rendered.buffer, 'image/webp');
  await storeSharedPreview(client, {
    pdfSha256: sourceDetails.pdfSha256,
    pageIndex,
    buffer: rendered.buffer,
    width: rendered.width,
    height: rendered.height,
    s3Key,
    updatedAt,
  });
  const storedPreview = {
    version: PDF_PREVIEW_VERSION,
    pageIndex,
    mimeType: 'image/webp',
    s3Key,
    width: rendered.width,
    height: rendered.height,
    updatedAt,
  };
  return savePreviewMetadata(
    client,
    projectName,
    fileId,
    pageIndex,
    storedPreview,
    { pageCount: rendered.pageCount },
  );
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
  const retryable = true;
  console.error(`[PDF preview] Failed ${projectName}/${fileId} page=${pageIndex + 1}:`, message);
  await previewMetadataCollection(client, projectName).updateOne(
    { fileId },
    {
      $set: {
        fileId,
        previewStatus: 'failed',
        previewError: message,
        previewRetryable: retryable,
        previewRecoveryVersion: PDF_PREVIEW_RECOVERY_VERSION,
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
  SHARED_PREVIEW_COLLECTION,
  cachedPdfPreview,
  canAttemptPdfPreview,
  createPreviewDescriptor,
  generatePdfPreview,
  isPreviewCurrent,
  loadSharedPreview,
  markPreviewFailure,
  previewS3Key,
  queuePdfPreview,
  renderPdfPage,
  sharedPreviewId,
  sharedPreviewS3Key,
  storeSharedPreview,
};
