const { getClient } = require('../services/mongo');
const s3Service = require('../services/s3');
const grobidService = require('../services/grobid');
const syncKeys = require('../services/syncKeys');

function s3Key(projectName, fileId) {
  return `papers/${projectName}/${fileId}.pdf`;
}

function getPdfMetaCollection(projectName) {
  return getClient().db(projectName).collection('PdfMeta');
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
      { $set: { fileId, size: pdfData.length } },
      { upsert: true },
    );

    // 3. GROBID로 인용 추출 + referenceTitleList 생성
    const grobidResult = await extractAndSaveCitations(
      projectName, fileId, pdfData);

    res.json({
      message: 'PDF uploaded successfully to S3',
      referenceTitleList: grobidResult
        ? grobidResult.referenceTitleList : null,
    });
  } catch (error) {
    console.error('Error during upload:', error);
    res.status(500).json({ error: 'An error occurred during the upload process' });
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
    console.log(`[GROBID] Saved citations + referenceTitleList into SaveFile for ${fileId}`);

    // TEI XML을 S3에 저장 (highlights에서 재사용)
    const teiKey = `tei/${projectName}/${fileId}.xml`;
    await s3Service.uploadTeiXml(teiKey, teiXml);
    console.log(`[GROBID] Saved TEI XML to S3 for ${fileId}`);

    // WebSocket으로 해당 프로젝트의 모든 클라이언트에게 알림
    syncKeys.broadcastToProject(projectName, {
      type: 'citations_ready',
      fileId,
      citationHits,
      pageSizeList,
      referenceList,
    });
    console.log(`[GROBID] Notified clients for ${fileId}`);

    return { referenceTitleList };
  } catch (err) {
    console.error(`[GROBID] Failed to extract citations for ${fileId}:`, err.message);

    // 실패도 알림 (Unity에서 fallback 처리 가능)
    syncKeys.broadcastToProject(projectName, {
      type: 'citations_failed',
      fileId,
      error: err.message,
    });
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
    const doc = await db.collection('SaveFile').findOne(query);

    if (!doc || !doc.citationHits) {
      return res.status(404).json({ error: 'Citations not yet extracted', status: 'processing' });
    }

    res.json({
      fileId: fileid,
      citationHits: doc.citationHits,
      pageSizes: doc.pageSizes,
      references: doc.references,
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
    const s3Response = await s3Service.downloadPdf(key);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fileid}.pdf`);
    s3Response.Body.pipe(res);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Error during download:', err);
    res.status(500).json({ error: 'An error occurred during the download process' });
  }
};
