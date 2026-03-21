const { getClient } = require('../services/mongo');
const s3Service = require('../services/s3');

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
    const key = s3Key(projectName, fileId);
    await s3Service.uploadPdf(key, pdfData);

    // 크기를 MongoDB에 캐싱
    await getPdfMetaCollection(projectName).updateOne(
      { fileId },
      { $set: { fileId, size: pdfData.length } },
      { upsert: true },
    );

    res.json({ message: 'PDF uploaded successfully to S3' });
  } catch (error) {
    console.error('Error during upload:', error);
    res.status(500).json({ error: 'An error occurred during the upload process' });
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
