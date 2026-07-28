const { getClient } = require('../services/mongo');
const s3Service = require('../services/s3');
const grobidService = require('../services/grobid');
const syncKeys = require('../services/syncKeys');

const MAX_PDF_BYTES = 250 * 1024 * 1024;
const citationJobs = new Map();

function s3Key(projectName, fileId) {
  return `papers/${projectName}/${fileId}.pdf`;
}

function isValidFileId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,200}$/.test(value);
}

function getPdfMetaCollection(projectName) {
  return getClient().db(projectName).collection('PdfMeta');
}

async function markCitationFailure(projectName, fileId, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[GROBID] Failed to extract citations for ${fileId}:`, message);
  await getPdfMetaCollection(projectName).updateOne(
    { fileId },
    {
      $set: {
        citationStatus: 'failed',
        citationError: message,
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

function queueCitationExtraction(projectName, fileId, pdfBuffer) {
  const jobKey = `${projectName}/${fileId}`;
  if (citationJobs.has(jobKey)) return;

  const job = new Promise((resolve) => setImmediate(resolve))
    .then(async () => {
      const data = pdfBuffer
        ?? await s3Service.downloadPdfBuffer(s3Key(projectName, fileId));
      await extractAndSaveCitations(projectName, fileId, data);
    })
    .catch((error) => markCitationFailure(projectName, fileId, error))
    .finally(() => {
      citationJobs.delete(jobKey);
    });
  citationJobs.set(jobKey, job);
}

// GET /pdf_metadata/:projectName/:fileid
exports.getMetadata = async (req, res) => {
  const { projectName, fileid } = req.params;

  try {
    // 1. MongoDB 캐시에서 먼저 조회
    const cached = await getPdfMetaCollection(projectName).findOne({ fileId: fileid });
    if (cached) {
      return res.status(200).json({ size: cached.size });
    }

    // 2. 캐시 미스 → S3에서 조회 후 캐싱
    const metadata = await s3Service.headPdf(s3Key(projectName, fileid));
    await getPdfMetaCollection(projectName).updateOne(
      { fileId: fileid },
      { $set: { fileId: fileid, size: metadata.size } },
      { upsert: true },
    );
    res.status(200).json({ size: metadata.size });
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Error fetching PDF metadata:', err);
    res.status(500).json({ error: 'Internal server error' });
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

  try {
    // 1. S3에 PDF 업로드
    const key = s3Key(projectName, fileId);
    await s3Service.uploadPdf(key, pdfData);

    // 2. 크기를 MongoDB에 캐싱
    await getPdfMetaCollection(projectName).updateOne(
      { fileId },
      {
        $set: {
          fileId,
          size: pdfData.length,
          citationStatus: 'processing',
          uploadedAt: new Date(),
        },
      },
      { upsert: true },
    );

    // PDF는 바로 사용할 수 있게 응답하고, 무거운 GROBID 처리는 백그라운드에서 실행한다.
    res.status(201).json({
      message: 'PDF uploaded successfully to S3',
      citationStatus: 'processing',
    });

    queueCitationExtraction(projectName, fileId, pdfData);
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
      s3Key(projectName, fileId),
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

  if (
    !isValidFileId(fileId) ||
    !Number.isFinite(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > MAX_PDF_BYTES
  ) {
    return res.status(400).json({ error: 'Invalid PDF completion request' });
  }

  try {
    const metadata = await s3Service.headPdf(s3Key(projectName, fileId));
    if (metadata.size !== expectedSize) {
      return res.status(409).json({ error: 'Uploaded PDF size does not match' });
    }
    await getPdfMetaCollection(projectName).updateOne(
      { fileId },
      {
        $set: {
          fileId,
          size: metadata.size,
          citationStatus: 'processing',
          uploadedAt: new Date(),
        },
      },
      { upsert: true },
    );
    res.status(201).json({
      message: 'PDF uploaded successfully to S3',
      citationStatus: 'processing',
    });
    queueCitationExtraction(projectName, fileId);
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
    console.log(`[GROBID] Extracting citations for ${fileId}...`);
    const { citationHits, pageSizes, refInfo, teiXml } = await grobidService.extractCitations(pdfBuffer);
    console.log(`[GROBID] Found ${citationHits.length} citation hits, ${Object.keys(refInfo).length} references for ${fileId}`);

    // TODO: 레퍼런스 enrichment (S2 → SerpAPI fallback) — S2 API 키 활성화 후 복원
    // const enrichedRefs = await enrichReferences(refInfo);

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
    await db.collection('SaveFile').updateOne(
      query,
      {
        $set: {
          citationHits,
          pageSizeList,
          referenceList,
          referenceTitleList,
          citationsExtractedAt: new Date(),
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
          citationStatus: 'ready',
          citationsExtractedAt: new Date(),
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

    return { referenceTitleList };
  } catch (err) {
    await markCitationFailure(projectName, fileId, err);
    return null;
  }
}

// GET /citations/:projectName/:fileid
// Unity에서 업로드 후 인용 데이터를 가져갈 때 사용
exports.getCitations = async (req, res) => {
  const { projectName, fileid } = req.params;

  try {
    const db = getClient().db(projectName);
    const { ObjectId } = require('mongodb');
    let query;
    try {
      query = { _id: new ObjectId(fileid) };
    } catch {
      query = { _id: fileid };
    }
    const savedPaper = await db.collection('SaveFile').findOne(query);
    const metadata = await getPdfMetaCollection(projectName).findOne({ fileId: fileid });
    const doc = savedPaper?.citationHits ? savedPaper : metadata;

    if (!doc || !doc.citationHits) {
      res.setHeader('Retry-After', '2');
      return res.status(404).json({ error: 'Citations not yet extracted', status: 'processing' });
    }

    res.json({
      fileId: fileid,
      citationHits: doc.citationHits,
      pageSizes: doc.pageSizeList ?? doc.pageSizes,
      references: doc.referenceList ?? doc.references,
      referenceTitleList: doc.referenceTitleList,
      extractedAt: doc.citationsExtractedAt,
    });
  } catch (err) {
    console.error('Error fetching citations:', err);
    res.status(500).json({ error: 'Internal server error' });
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
      .map((item) => item._id.toString());

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
  } catch (error) {
    console.error('Error listing PDFs:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
};

// GET /download_pdf/:projectName/:fileid
exports.downloadPdf = async (req, res) => {
  const { projectName, fileid } = req.params;

  try {
    const key = s3Key(projectName, fileid);
    const range = typeof req.headers.range === 'string'
      ? req.headers.range
      : undefined;
    const s3Response = await s3Service.downloadPdf(key, range);
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
    res.on('close', () => {
      if (!res.writableEnded && typeof s3Response.Body.destroy === 'function') {
        s3Response.Body.destroy();
      }
    });
    s3Response.Body.on('error', (streamError) => {
      console.error('Error while streaming PDF:', streamError);
      if (!res.headersSent) {
        res.status(500).json({ error: 'An error occurred during the download process' });
      } else {
        res.destroy(streamError);
      }
    });
    s3Response.Body.pipe(res);
  } catch (err) {
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
    res.status(500).json({ error: 'An error occurred during the download process' });
  }
};
