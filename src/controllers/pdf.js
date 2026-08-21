const { getClient } = require('../services/mongo');
const s3Service = require('../services/s3');
const grobidService = require('../services/grobid');
const { enrichReferences } = require('../services/refEnricher');
const syncKeys = require('../services/syncKeys');
const pdfPreviewService = require('../services/pdfPreview');
const pdfStorage = require('../services/pdfStorage');
const {
  extractPdfCitationFallback,
  recoverIncompleteGrobidExtraction,
} = require('../services/pdfCitationFallback');
const {
  citationDocumentMatchesPdfHash,
  isCoordinateCitationDocument,
  pdfContentSha256,
  preferCitationDocument,
} = require('../services/citationState');
const { pipeline } = require('node:stream/promises');

const MAX_PDF_BYTES = 250 * 1024 * 1024;
const MAX_CONCURRENT_CITATION_JOBS = 2;
const CITATION_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const PDF_STREAM_ACQUIRE_TIMEOUT_MS = 30_000;
const citationJobs = new Map();
const citationQueue = [];
let activeCitationJobs = 0;

function isValidFileId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,200}$/.test(value);
}

function getPdfMetaCollection(projectName) {
  return getClient().db(projectName).collection('PdfMeta');
}

function pdfIdentityFromBody(body = {}) {
  const candidate = body.identity ?? body.pdfIdentity;
  if (!candidate) return {};
  if (typeof candidate === 'object') return candidate;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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

function isAbortError(error) {
  return Boolean(
    error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || error?.code === 'ABORT_ERR',
  );
}

async function markCitationFailure(projectName, fileId, error) {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = !isMissingPdfError(error);
  console.error(`[GROBID] Failed to extract citations for ${fileId}:`, message);
  await getPdfMetaCollection(projectName).updateOne(
    { fileId },
    {
      $set: {
        citationStatus: 'failed',
        citationError: message,
        citationRetryable: retryable,
        citationsFailedAt: new Date(),
      },
    },
    { upsert: true },
  ).catch((metadataError) => {
    console.error(`[GROBID] Failed to save failure state for ${fileId}:`, metadataError.message);
  });
  syncKeys.broadcastToProject(projectName, {
    type: 'citations_failed',
    fileId,
    error: message,
  });
}

function drainCitationQueue() {
  while (
    activeCitationJobs < MAX_CONCURRENT_CITATION_JOBS
    && citationQueue.length > 0
  ) {
    const next = citationQueue.shift();
    activeCitationJobs += 1;
    console.log(
      `[GROBID] Starting queued job ${next.jobKey} `
      + `(active=${activeCitationJobs}, queued=${citationQueue.length})`,
    );
    Promise.resolve()
      .then(next.run)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeCitationJobs -= 1;
        drainCitationQueue();
      });
  }
}

function enqueueCitationJob(jobKey, run) {
  return new Promise((resolve, reject) => {
    citationQueue.push({ jobKey, run, resolve, reject });
    drainCitationQueue();
  });
}

function queueCitationExtraction(projectName, fileId, pdfBuffer) {
  const jobKey = `${projectName}/${fileId}`;
  if (citationJobs.has(jobKey)) return false;

  // Do not retain large upload buffers while waiting behind other GROBID jobs.
  const bufferedPdf = activeCitationJobs < MAX_CONCURRENT_CITATION_JOBS
    && citationQueue.length === 0
    ? pdfBuffer
    : undefined;
  const job = enqueueCitationJob(jobKey, async () => {
    const data = bufferedPdf
      ?? await s3Service.downloadPdfBuffer(
        await pdfStorage.resolvePdfS3Key(projectName, fileId),
      );
    await extractAndSaveCitations(projectName, fileId, data);
  })
    .catch((error) => markCitationFailure(projectName, fileId, error))
    .finally(() => {
      citationJobs.delete(jobKey);
    });
  citationJobs.set(jobKey, job);
  return true;
}

function citationRetryState(metadata) {
  if (metadata?.citationStatus !== 'failed') {
    return { blocked: false, permanent: false };
  }
  const permanent = metadata.citationRetryable === false
    || /specified key does not exist|file not found|no such key/i.test(
      metadata.citationError || '',
    );
  const failedAt = metadata.citationsFailedAt
    ? new Date(metadata.citationsFailedAt).getTime()
    : 0;
  return {
    blocked:
      permanent
      || Date.now() - failedAt < CITATION_RETRY_COOLDOWN_MS,
    permanent,
  };
}

function saveFileQuery(fileId) {
  const { ObjectId } = require('mongodb');
  try {
    return { _id: new ObjectId(fileId) };
  } catch {
    return { _id: fileId };
  }
}

async function findCitationState(projectName, fileId) {
  const db = getClient().db(projectName);
  const query = saveFileQuery(fileId);
  const savedPapers = await db.collection('SaveFile').find({
    $or: [query, { fileId }],
  }).toArray();
  const metadata = await getPdfMetaCollection(projectName).findOne({ fileId });
  return {
    db,
    query,
    metadata,
    document: preferCitationDocument([...savedPapers, metadata]),
  };
}

function citationPayload(fileId, document) {
  return {
    fileId,
    citationHits: document.citationHits,
    pageSizes: document.pageSizeList ?? document.pageSizes,
    references: document.referenceList ?? document.references,
    referenceTitleList: document.referenceTitleList,
    extractedAt: document.citationsExtractedAt,
    status: isCoordinateCitationDocument(document) ? 'ready' : 'fallback',
  };
}

async function findReusableCitationDocument(projectName, fileId, pdfSha256) {
  const db = getClient().db(projectName);
  const candidates = [
    ...await db.collection('PdfMeta').find({
      fileId: { $ne: fileId },
      $or: [
        { pdfSha256 },
        { citationRecoveredFrom: pdfSha256 },
        { citationRecoveredFrom: `sha256:${pdfSha256}` },
      ],
    }).toArray(),
    ...await db.collection('SaveFile').find({
      fileId: { $ne: fileId },
      $or: [
        { pdfSha256 },
        { citationRecoveredFrom: pdfSha256 },
        { citationRecoveredFrom: `sha256:${pdfSha256}` },
      ],
    }).toArray(),
  ].filter(
    (candidate) =>
      citationDocumentMatchesPdfHash(candidate, pdfSha256)
      && isCoordinateCitationDocument(candidate),
  );
  return preferCitationDocument(candidates);
}

async function reuseCitationExtraction(projectName, fileId, pdfBuffer) {
  const pdfSha256 = pdfContentSha256(pdfBuffer);
  const reusable = await findReusableCitationDocument(
    projectName,
    fileId,
    pdfSha256,
  );
  if (!reusable) return { pdfSha256, reused: false };

  const db = getClient().db(projectName);
  const query = saveFileQuery(fileId);
  const fields = {
    citationHits: reusable.citationHits,
    pageSizeList: reusable.pageSizeList ?? reusable.pageSizes ?? [],
    referenceList: reusable.referenceList ?? reusable.references ?? [],
    referenceTitleList: reusable.referenceTitleList,
    citationStatus: 'ready',
    pdfSha256,
    citationReusedFrom: reusable.fileId || String(reusable._id || ''),
    citationsExtractedAt: reusable.citationsExtractedAt || new Date(),
  };
  const update = {
    $set: fields,
    $unset: {
      citationError: '',
      citationRetryable: '',
      citationsFailedAt: '',
    },
  };
  await Promise.all([
    db.collection('SaveFile').updateMany(
      { $or: [query, { fileId }] },
      update,
    ),
    getPdfMetaCollection(projectName).updateOne(
      { fileId },
      { ...update, $set: { ...fields, fileId } },
      { upsert: true },
    ),
  ]);
  syncKeys.broadcastToProject(projectName, {
    type: 'references_extraction',
    fileId,
    citationHits: fields.citationHits,
    pageSizeList: fields.pageSizeList,
    referenceList: fields.referenceList,
    referenceTitleList: fields.referenceTitleList,
  });
  console.log(
    `[GROBID] Reused citation coordinates for ${fileId} `
    + `from ${fields.citationReusedFrom}`,
  );
  return {
    pdfSha256,
    reused: true,
    referenceTitleList: fields.referenceTitleList,
  };
}

// GET /pdf_metadata/:projectName/:fileid
exports.getMetadata = async (req, res) => {
  const { projectName, fileid } = req.params;
  const requireCompletion = req.query.requireCompletion === '1';

  const respondWithMetadata = (size, uploadedAt) => {
    const ready = Boolean(size && uploadedAt);
    if (requireCompletion && !ready) {
      res.setHeader('Retry-After', '2');
      return res.status(202).json({
        size,
        ready: false,
        status: 'processing',
      });
    }
    return res.status(200).json({
      size,
      ready,
      uploadedAt: uploadedAt || undefined,
    });
  };

  try {
    // 1. MongoDB 캐시에서 먼저 조회
    const cached = await getPdfMetaCollection(projectName).findOne({ fileId: fileid });
    if (Number.isFinite(cached?.size) && cached.size > 0) {
      return respondWithMetadata(cached.size, cached.uploadedAt);
    }

    // 2. 캐시 미스 → S3에서 조회 후 캐싱
    const metadata = await s3Service.headPdf(
      await pdfStorage.resolvePdfS3Key(projectName, fileid),
    );
    await getPdfMetaCollection(projectName).updateOne(
      { fileId: fileid },
      { $set: { fileId: fileid, size: metadata.size } },
      { upsert: true },
    );
    return respondWithMetadata(metadata.size, cached?.uploadedAt);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Error fetching PDF metadata:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// POST /reuse_pdf/:projectName
// Resolve a paper from the cross-board library before the browser downloads it
// from a publisher again. The target board receives its own lightweight file
// id while every board points at the same content-addressed S3 object.
exports.reusePdf = async (req, res) => {
  const { projectName } = req.params;
  const { fileId } = req.body ?? {};
  const identity = pdfIdentityFromBody(req.body);
  if (!isValidFileId(fileId) || !pdfStorage.paperIdentityKeys(identity).length) {
    return res.status(400).json({ error: 'Invalid shared PDF lookup request' });
  }

  try {
    const reused = await pdfStorage.reusePdfIntoProject({
      projectName,
      fileId,
      identity,
    });
    if (!reused) return res.status(404).json({ reused: false });
    const metadata = reused.metadata ?? {};
    const citationsReady = isCoordinateCitationDocument(metadata);
    if (!citationsReady) {
      await getPdfMetaCollection(projectName).updateOne(
        { fileId },
        { $set: { citationStatus: 'processing' } },
      );
      queueCitationExtraction(projectName, fileId);
    }
    pdfPreviewService.queuePdfPreview(projectName, fileId, 0);
    return res.json({
      reused: true,
      fileId,
      size: reused.size,
      pdfSha256: reused.pdfSha256,
      citationStatus: citationsReady ? 'ready' : 'processing',
      ...(citationsReady ? citationPayload(fileId, metadata) : {}),
    });
  } catch (error) {
    console.error('Error reusing shared PDF:', error);
    return res.status(500).json({ error: 'Could not search the shared PDF library' });
  }
};

// POST /upload_pdf/:projectName
exports.uploadPdf = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file part' });
  }

  const { fileId } = req.body;
  const { projectName } = req.params;
  const pdfData = req.file.buffer;
  const identity = pdfIdentityFromBody(req.body);

  if (!isValidFileId(fileId)) {
    return res.status(400).json({ error: 'Invalid PDF file id' });
  }

  try {
    // Store one content-addressed object shared by every board.
    const stored = await pdfStorage.storeSharedPdf({
      projectName,
      fileId,
      pdfBuffer: pdfData,
      identity,
    });

    // 2. 크기를 MongoDB에 캐싱
    await getPdfMetaCollection(projectName).updateOne(
      { fileId },
      {
        $set: {
          fileId,
          size: stored.size,
          pdfSha256: stored.pdfSha256,
          s3Key: stored.s3Key,
          sharedStorage: true,
          citationStatus: 'processing',
          uploadedAt: new Date(),
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

    await getClient().db(projectName).collection('SaveFile').updateMany(
      { fileId },
      { $unset: { pdfPagePreview: '' } },
    );

    // PDF는 바로 사용할 수 있게 응답하고, 무거운 GROBID 처리는 백그라운드에서 실행한다.
    res.status(201).json({
      message: 'PDF uploaded successfully to S3',
      fileId,
      pdfSha256: stored.pdfSha256,
      citationStatus: 'processing',
    });

    queueCitationExtraction(projectName, fileId, pdfData);
    pdfPreviewService.queuePdfPreview(projectName, fileId, 0, pdfData);
  } catch (error) {
    console.error('Error during upload:', error);
    res.status(500).json({ error: 'An error occurred during the upload process' });
  }
};

// POST /pdf_upload_url/:projectName
// 브라우저가 ngrok 서버를 경유하지 않고 S3에 직접 업로드할 수 있는 일회성 URL.
exports.createUploadUrl = async (req, res) => {
  const { projectName } = req.params;
  const { fileId, contentType, size } = req.body ?? {};
  const fileSize = Number(size);

  if (
    !isValidFileId(fileId) ||
    !Number.isFinite(fileSize) ||
    fileSize <= 0 ||
    fileSize > MAX_PDF_BYTES
  ) {
    return res.status(400).json({ error: 'Invalid PDF upload request' });
  }

  try {
    const normalizedContentType = contentType === 'application/pdf'
      ? contentType
      : 'application/pdf';
    const uploadUrl = await s3Service.createPdfUploadUrl(
      pdfStorage.stagingPdfS3Key(projectName, fileId),
      normalizedContentType,
    );
    res.json({
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': normalizedContentType },
      expiresIn: 900,
    });
  } catch (error) {
    console.error('Error creating PDF upload URL:', error);
    res.status(500).json({ error: 'Could not prepare the PDF upload' });
  }
};

// POST /complete_pdf_upload/:projectName
// 직접 업로드된 S3 객체를 확인한 뒤 즉시 사용 가능하게 하고 인용 추출은 백그라운드 처리.
exports.completePdfUpload = async (req, res) => {
  const { projectName } = req.params;
  const { fileId, size } = req.body ?? {};
  const expectedSize = Number(size);
  const identity = pdfIdentityFromBody(req.body);

  if (
    !isValidFileId(fileId) ||
    !Number.isFinite(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > MAX_PDF_BYTES
  ) {
    return res.status(400).json({ error: 'Invalid PDF completion request' });
  }

  try {
    const stagingKey = pdfStorage.stagingPdfS3Key(projectName, fileId);
    const metadata = await s3Service.headPdf(stagingKey);
    if (metadata.size !== expectedSize) {
      return res.status(409).json({ error: 'Uploaded PDF size does not match' });
    }
    const pdfBuffer = await s3Service.downloadPdfBuffer(stagingKey);
    const stored = await pdfStorage.storeSharedPdf({
      projectName,
      fileId,
      pdfBuffer,
      identity,
    });
    await s3Service.deletePdf(stagingKey).catch(() => {});
    await getPdfMetaCollection(projectName).updateOne(
      { fileId },
      {
        $set: {
          fileId,
          size: stored.size,
          pdfSha256: stored.pdfSha256,
          s3Key: stored.s3Key,
          sharedStorage: true,
          citationStatus: 'processing',
          uploadedAt: new Date(),
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
    await getClient().db(projectName).collection('SaveFile').updateMany(
      { fileId },
      { $unset: { pdfPagePreview: '' } },
    );
    res.status(201).json({
      message: 'PDF uploaded successfully to S3',
      fileId,
      pdfSha256: stored.pdfSha256,
      citationStatus: 'processing',
    });
    queueCitationExtraction(projectName, fileId, pdfBuffer);
    pdfPreviewService.queuePdfPreview(projectName, fileId, 0, pdfBuffer);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Uploaded PDF was not found' });
    }
    console.error('Error completing PDF upload:', error);
    res.status(500).json({ error: 'Could not complete the PDF upload' });
  }
};

// GROBID 본문 인용 + 참고문헌 추출 → MongoDB 저장 → WebSocket 알림
async function extractAndSaveCitations(projectName, fileId, pdfBuffer) {
  try {
    const reusable = await reuseCitationExtraction(
      projectName,
      fileId,
      pdfBuffer,
    );
    if (reusable.reused) {
      return { referenceTitleList: reusable.referenceTitleList };
    }
    console.log(`[GROBID] Extracting citations for ${fileId}...`);
    const grobidExtraction = await grobidService.extractCitations(pdfBuffer);
    let {
      citationHits,
      pageSizes,
      refInfo,
      teiXml,
    } = grobidExtraction;
    const hasPositionedHits = citationHits.some(
      (hit) => Array.isArray(hit.boxes) && hit.boxes.length > 0,
    );
    let citationStatus = 'ready';
    if (
      !citationHits.length
      || !hasPositionedHits
      || !Object.keys(pageSizes).length
      || !Object.keys(refInfo).length
    ) {
      try {
        const fallback = await extractPdfCitationFallback(pdfBuffer);
        const recovered = recoverIncompleteGrobidExtraction(
          grobidExtraction,
          fallback,
        );
        citationHits = recovered.citationHits;
        pageSizes = recovered.pageSizes;
        refInfo = recovered.refInfo;
        citationStatus = recovered.usedFallback ? 'fallback' : 'ready';
        console.warn(
          `[GROBID] Completed incomplete TEI with PDF.js for ${fileId}: `
          + `${citationHits.length} citation hits, ${Object.keys(refInfo).length} references`,
        );
      } catch (fallbackError) {
        citationStatus = hasPositionedHits ? 'ready' : 'fallback';
        console.warn(
          `[GROBID] PDF.js completion failed for ${fileId}: ${fallbackError.message}`,
        );
      }
    }
    console.log(`[GROBID] Found ${citationHits.length} citation hits, ${Object.keys(refInfo).length} references for ${fileId}`);

    // Dictionary → 배열 변환 (Unity JsonUtility 호환)
    const pageSizeList = Object.entries(pageSizes).map(([page, size]) => ({
      page: parseInt(page, 10),
      widthPt: size.widthPt,
      heightPt: size.heightPt,
    }));
    const referenceList = Object.entries(refInfo).map(([refId, info]) => ({
      refId,
      ...info,
    }));

    // referenceTitleList: xml:id → [title, authors]
    // GXSerialDicStrStr 형식으로 변환
    const refKeys = [];
    const refValues = [];
    for (const [xmlId, info] of Object.entries(refInfo)) {
      refKeys.push(xmlId);
      const authorsStr = (info.authors || []).join(', ');
      refValues.push({ array: [info.title || '', authorsStr] });
    }
    const referenceTitleList = { key: refKeys, value: refValues };

    // SaveFile 내 해당 논문 문서에 citation 데이터 저장
    const db = getClient().db(projectName);
    const { ObjectId } = require('mongodb');
    let query;
    try {
      query = { _id: new ObjectId(fileId) };
    } catch {
      query = { _id: fileId };
    }
    await db.collection('SaveFile').updateMany(
      { $or: [query, { fileId }] },
      {
        $set: {
          citationHits,
          pageSizeList,
          referenceList,
          referenceTitleList,
          citationStatus,
          pdfSha256: reusable.pdfSha256,
          citationsExtractedAt: new Date(),
        },
        $unset: {
          citationError: '',
          citationRetryable: '',
          citationsFailedAt: '',
          semanticIndexStatus: '',
          semanticIndexReadyAt: '',
          semanticIndexError: '',
        },
      },
    );
    await getPdfMetaCollection(projectName).updateOne(
      { fileId },
      {
        $set: {
          citationHits,
          pageSizeList,
          referenceList,
          referenceTitleList,
          citationStatus,
          pdfSha256: reusable.pdfSha256,
          citationsExtractedAt: new Date(),
        },
        $unset: {
          citationError: '',
          citationRetryable: '',
          citationsFailedAt: '',
          semanticIndexStatus: '',
          semanticIndexReadyAt: '',
          semanticIndexError: '',
        },
      },
      { upsert: true },
    );
    console.log(`[GROBID] Saved citations + referenceTitleList into SaveFile for ${fileId}`);

    // TEI XML을 S3에 저장 (highlights에서 재사용)
    const teiKey = `tei/${projectName}/${fileId}.xml`;
    await s3Service.uploadTeiXml(teiKey, teiXml);
    console.log(`[GROBID] Saved TEI XML to S3 for ${fileId}`);

    // WebSocket으로 해당 프로젝트의 모든 클라이언트에게 알림
    syncKeys.broadcastToProject(projectName, {
      type: 'references_extraction',
      fileId,
      citationHits,
      pageSizeList,
      referenceList,
      referenceTitleList,
    });
    console.log(`[GROBID] Notified clients for ${fileId}`);

    // Mark extraction ready before paid metadata enrichment. Reference counts
    // and citation overlays therefore appear as soon as GROBID completes.
    // Scholar IDs continue in the same background job and are cached in Mongo.
    const enrichedRefs = await enrichReferences(refInfo);
    const enrichedReferenceList = Object.entries(enrichedRefs).map(
      ([refId, info]) => ({ refId, ...info }),
    );
    await db.collection('SaveFile').updateMany(
      { $or: [query, { fileId }] },
      { $set: { referenceList: enrichedReferenceList, referencesEnrichedAt: new Date() } },
    );
    await getPdfMetaCollection(projectName).updateOne(
      { fileId },
      {
        $set: {
          referenceList: enrichedReferenceList,
          referencesEnrichedAt: new Date(),
        },
      },
    );
    syncKeys.broadcastToProject(projectName, {
      type: 'references_enriched',
      fileId,
      referenceList: enrichedReferenceList,
    });

    return { referenceTitleList };
  } catch (err) {
    try {
      const fallback = await extractPdfCitationFallback(pdfBuffer);
      if (!fallback.referenceList.length) throw err;
      const db = getClient().db(projectName);
      const query = saveFileQuery(fileId);
      const fallbackFields = {
        ...fallback,
        citationStatus: 'fallback',
        pdfSha256: pdfContentSha256(pdfBuffer),
        citationsExtractedAt: new Date(),
        citationError: err instanceof Error ? err.message : String(err),
        citationRetryable: true,
      };
      await Promise.all([
        db.collection('SaveFile').updateMany(
          { $or: [query, { fileId }] },
          { $set: fallbackFields, $unset: { citationsFailedAt: '' } },
        ),
        getPdfMetaCollection(projectName).updateOne(
          { fileId },
          {
            $set: { ...fallbackFields, fileId },
            $unset: { citationsFailedAt: '' },
          },
          { upsert: true },
        ),
      ]);
      syncKeys.broadcastToProject(projectName, {
        type: 'references_extraction',
        fileId,
        ...fallback,
      });
      console.warn(
        `[GROBID] Used PDF.js fallback for ${fileId}: `
        + `${fallback.referenceList.length} references, `
        + `${fallback.citationHits.length} citation markers`,
      );
      return { referenceTitleList: fallback.referenceTitleList };
    } catch (fallbackError) {
      await markCitationFailure(projectName, fileId, fallbackError);
      return null;
    }
  }
}

// GET /citations/:projectName/:fileid
// Unity에서 업로드 후 인용 데이터를 가져갈 때 사용
exports.getCitations = async (req, res) => {
  const { projectName, fileid } = req.params;

  try {
    const { document: doc, metadata } = await findCitationState(
      projectName,
      fileid,
    );

    if (
      !doc
      || !doc.citationHits
      || (
        !isCoordinateCitationDocument(doc)
        && metadata?.citationStatus === 'processing'
      )
      || (
        !isCoordinateCitationDocument(doc)
        && metadata?.citationStatus === 'failed'
      )
    ) {
      const status = metadata?.citationStatus === 'failed'
        ? 'failed'
        : 'processing';
      res.setHeader('Retry-After', '2');
      return res.status(404).json({
        error: status === 'failed'
          ? 'Citation extraction failed'
          : 'Citations not yet extracted',
        status,
      });
    }

    res.json(citationPayload(fileid, doc));
  } catch (err) {
    console.error('Error fetching citations:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// POST /citations/:projectName/:fileid/refresh
// A manual UI refresh only starts GROBID when no completed extraction exists.
exports.refreshCitations = async (req, res) => {
  const { projectName, fileid } = req.params;
  const jobKey = `${projectName}/${fileid}`;
  const force = req.body?.force === true;

  try {
    const {
      document: cached,
      metadata,
    } = await findCitationState(projectName, fileid);
    if (cached && (!force || isCoordinateCitationDocument(cached))) {
      return res.json(citationPayload(fileid, cached));
    }
    if (citationJobs.has(jobKey)) {
      return res.status(202).json({
        fileId: fileid,
        status: 'processing',
        queued: false,
      });
    }

    const retry = citationRetryState(metadata);
    if (retry.permanent || (retry.blocked && !force)) {
      return res.status(404).json({
        fileId: fileid,
        status: 'failed',
        retryable: !retry.permanent,
        error: metadata?.citationError || 'Citation extraction failed',
      });
    }

    try {
      await s3Service.headPdf(
        await pdfStorage.resolvePdfS3Key(projectName, fileid),
      );
    } catch (error) {
      if (isMissingPdfError(error)) {
        res.setHeader('Retry-After', '2');
        return res.status(202).json({
          fileId: fileid,
          status: 'awaiting_pdf',
          queued: false,
        });
      }
      await markCitationFailure(projectName, fileid, error);
      return res.status(404).json({
        fileId: fileid,
        status: 'failed',
        retryable: !isMissingPdfError(error),
        error: isMissingPdfError(error)
          ? 'The PDF is not available in AWS S3'
          : 'Could not access the PDF in AWS S3',
      });
    }

    await getPdfMetaCollection(projectName).updateOne(
      { fileId: fileid },
      {
        $set: {
          fileId: fileid,
          citationStatus: 'processing',
          citationRefreshRequestedAt: new Date(),
        },
        $unset: {
          citationError: '',
          citationRetryable: '',
          citationsFailedAt: '',
        },
      },
      { upsert: true },
    );
    const queued = queueCitationExtraction(projectName, fileid);
    return res.status(202).json({
      fileId: fileid,
      status: metadata?.citationStatus === 'failed'
        ? 'retrying'
        : 'processing',
      queued,
    });
  } catch (err) {
    console.error('Error refreshing citations:', err);
    return res.status(500).json({ error: 'Could not refresh citations' });
  }
};

// GET /list_pdfs/:projectName
exports.listPdfs = async (req, res) => {
  const { projectName } = req.params;

  try {
    const client = getClient();
    const db = client.db(projectName);
    const collection = db.collection('SaveFile');
    const data = await collection.find().toArray();

    // SaveFile에서 논문 타입인 항목의 _id를 fileId 목록으로 반환
    const validFileIds = data
      .filter((item) => item.type === 'GX.MAROScientificPaper' && item._id)
      .map((item) => String(item.fileId || item._id));

    res.json({ fileids: validFileIds });

    // 고아 PDF 정리는 백그라운드로 (응답 차단 안 함)
    const prefix = `papers/${projectName}/`;
    s3Service.listPdfs(prefix).then((keys) => {
      for (const key of keys) {
        const fileId = key.replace(prefix, '').replace('.pdf', '');
        if (!validFileIds.includes(fileId)) {
          s3Service.deletePdf(key)
            .then(() => console.log(`Deleted orphan PDF from S3: ${fileId}`))
            .catch((err) => console.error(`Failed to delete orphan PDF: ${fileId}`, err));
        }
      }
    }).catch((err) => console.error('Orphan cleanup failed:', err));

    const previewPrefix = `previews/${projectName}/`;
    s3Service.listPdfs(previewPrefix).then((keys) => {
      for (const key of keys) {
        const fileId = key.slice(previewPrefix.length).split('/')[0];
        if (!validFileIds.includes(fileId)) {
          s3Service.deletePdf(key)
            .then(() => console.log(`Deleted orphan PDF preview from S3: ${fileId}`))
            .catch((err) => console.error(`Failed to delete orphan PDF preview: ${fileId}`, err));
        }
      }
    }).catch((err) => console.error('Orphan preview cleanup failed:', err));
  } catch (error) {
    console.error('Error listing PDFs:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
};

// GET /download_pdf/:projectName/:fileid
exports.downloadPdf = async (req, res) => {
  const { projectName, fileid } = req.params;
  const startedAt = Date.now();
  const abortController = new AbortController();
  let s3Body;
  const abortStream = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    if (s3Body && typeof s3Body.destroy === 'function') {
      s3Body.destroy();
    }
  };
  const onRequestAborted = () => abortStream();
  const onResponseClosed = () => {
    if (!res.writableEnded) abortStream();
  };
  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClosed);
  const acquireTimeout = setTimeout(
    () => abortController.abort(),
    PDF_STREAM_ACQUIRE_TIMEOUT_MS,
  );
  const slowTimer = setTimeout(() => {
    console.warn(
      `[PDF] Slow S3 stream ${projectName}/${fileid} `
      + `range=${req.headers.range || 'full'} elapsedMs=${Date.now() - startedAt}`,
    );
  }, 5_000);

  try {
    const key = await pdfStorage.resolvePdfS3Key(projectName, fileid);
    const range = typeof req.headers.range === 'string'
      ? req.headers.range
      : undefined;
    const s3Response = await s3Service.downloadPdf(
      key,
      range,
      { abortSignal: abortController.signal },
    );
    clearTimeout(acquireTimeout);
    s3Body = s3Response.Body;
    if (abortController.signal.aborted || req.aborted || res.destroyed) {
      if (typeof s3Body.destroy === 'function') s3Body.destroy();
      return;
    }
    const safeFileId = fileid.replace(/[^a-zA-Z0-9._-]/g, '_');

    res.status(s3Response.ContentRange ? 206 : 200);
    res.setHeader('Content-Type', s3Response.ContentType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeFileId}.pdf"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (s3Response.ContentLength !== undefined) {
      res.setHeader('Content-Length', String(s3Response.ContentLength));
    }
    if (s3Response.ContentRange) {
      res.setHeader('Content-Range', s3Response.ContentRange);
    }
    if (s3Response.ETag) {
      res.setHeader('ETag', s3Response.ETag);
    }
    if (s3Response.LastModified) {
      res.setHeader('Last-Modified', s3Response.LastModified.toUTCString());
    }
    await pipeline(s3Body, res);
  } catch (err) {
    if (
      abortController.signal.aborted
      || req.aborted
      || res.destroyed
      || isAbortError(err)
    ) {
      console.warn(
        `[PDF] Stream aborted ${projectName}/${fileid} `
        + `range=${req.headers.range || 'full'} elapsedMs=${Date.now() - startedAt}`,
      );
      return;
    }
    if (
      err.name === 'InvalidRange' ||
      err.Code === 'InvalidRange' ||
      err.$metadata?.httpStatusCode === 416
    ) {
      return res.status(416).end();
    }
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Error during download:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An error occurred during the download process' });
    } else {
      res.destroy(err);
    }
  } finally {
    clearTimeout(acquireTimeout);
    clearTimeout(slowTimer);
    req.off('aborted', onRequestAborted);
    res.off('close', onResponseClosed);
  }
};

// GET /pdf_preview/:projectName/:fileid
// Streams the current server-rendered page preview without touching PDF.js in the browser.
exports.downloadPdfPreview = async (req, res) => {
  const { projectName, fileid } = req.params;
  const requestedPageIndex = Number(req.query.pageIndex);
  const abortController = new AbortController();
  let s3Body;
  const abortStream = () => {
    if (!abortController.signal.aborted) abortController.abort();
    if (s3Body && typeof s3Body.destroy === 'function') s3Body.destroy();
  };
  const onRequestAborted = () => abortStream();
  const onResponseClosed = () => {
    if (!res.writableEnded) abortStream();
  };
  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClosed);

  try {
    if (!Number.isInteger(requestedPageIndex) || requestedPageIndex < 0) {
      return res.status(400).json({ error: 'Invalid PDF preview page' });
    }
    const metadata = await getPdfMetaCollection(projectName).findOne({ fileId: fileid });
    const preview = metadata?.pdfPagePreview;
    const descriptor = pdfPreviewService.createPreviewDescriptor(
      projectName,
      fileid,
      preview,
    );
    if (
      !descriptor
      || descriptor.pageIndex !== requestedPageIndex
      || typeof preview.s3Key !== 'string'
      || !preview.s3Key
    ) {
      return res.status(404).json({ error: 'PDF preview is not ready' });
    }
    const s3Response = await s3Service.downloadPdfPreview(
      preview.s3Key,
      { abortSignal: abortController.signal },
    );
    s3Body = s3Response.Body;
    if (abortController.signal.aborted || req.aborted || res.destroyed) return;
    res.setHeader('Content-Type', s3Response.ContentType || descriptor.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    if (s3Response.ContentLength !== undefined) {
      res.setHeader('Content-Length', String(s3Response.ContentLength));
    }
    if (s3Response.ETag) res.setHeader('ETag', s3Response.ETag);
    await pipeline(s3Body, res);
  } catch (error) {
    if (
      abortController.signal.aborted
      || req.aborted
      || res.destroyed
      || isAbortError(error)
    ) {
      return;
    }
    if (isMissingPdfError(error)) {
      return res.status(404).json({ error: 'PDF preview is not ready' });
    }
    console.error('Error downloading PDF preview:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Could not download PDF preview' });
    }
    return res.destroy(error);
  } finally {
    req.off('aborted', onRequestAborted);
    res.off('close', onResponseClosed);
  }
};
