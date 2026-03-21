const { getClient } = require('../services/mongo');
const s3Service = require('../services/s3');

function s3Key(projectName, fileId) {
  return `papers/${projectName}/${fileId}.pdf`;
}

// GET /pdf_metadata/:projectName/:fileid
exports.getMetadata = async (req, res) => {
  const { projectName, fileid } = req.params;

  try {
    const metadata = await s3Service.headPdf(s3Key(projectName, fileid));
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
    const prefix = `papers/${projectName}/`;
    const keys = await s3Service.listPdfs(prefix);

    // S3 키에서 fileId 추출: papers/{projectName}/{fileId}.pdf → fileId
    const fileids = keys.map((key) => {
      const filename = key.replace(prefix, '');
      return filename.replace('.pdf', '');
    });

    res.json({ fileids });

    // 고아 PDF 정리: SaveFile에 없는 PDF를 S3에서 삭제
    const client = getClient();
    const db = client.db(projectName);
    const collection = db.collection('SaveFile');
    const data = await collection.find().toArray();

    const validFileIds = data
      .filter((item) => item.type === 'GX.MAROScientificPaper' && item._id)
      .map((item) => item._id.toString());

    for (const key of keys) {
      const fileId = key.replace(prefix, '').replace('.pdf', '');
      if (!validFileIds.includes(fileId)) {
        try {
          await s3Service.deletePdf(key);
          console.log(`Deleted orphan PDF from S3: ${fileId}`);
        } catch (err) {
          console.error(`Failed to delete orphan PDF: ${fileId}`, err);
        }
      }
    }
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
