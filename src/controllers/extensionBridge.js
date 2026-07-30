// In-memory store for pending PDF requests from Unity
// Map<fileId, { projectName, fileId, pdfUrl, paperTitle, timestamp }>
const { getClient } = require('../services/mongo');

const pendingRequests = new Map();
const EXPIRY_MS = 60 * 60 * 1000; // 60 minutes

// Cleanup expired entries
function cleanExpired() {
  const now = Date.now();
  for (const [key, val] of pendingRequests) {
    if (now - val.timestamp > EXPIRY_MS) {
      pendingRequests.delete(key);
    }
  }
}

// POST /extension/register — Unity registers a pending PDF request
exports.register = async (req, res) => {
  const { projectName, fileId, pdfUrl, scholarUrl, paperTitle } = req.body;
  if (!projectName || !fileId) {
    return res.status(400).json({
      error: 'projectName and fileId are required',
    });
  }

  cleanExpired();

  try {
    const metadata = await getClient()
      .db(projectName)
      .collection('PdfMeta')
      .findOne({ fileId });
    if (metadata?.size && metadata.uploadedAt) {
      pendingRequests.delete(fileId);
      console.log(`[ExtBridge] Already ready: ${fileId}`);
      return res.json({ status: 'ready' });
    }
  } catch (error) {
    console.error(`[ExtBridge] Existing PDF check failed: ${fileId}:`, error.message);
    return res.status(503).json({
      status: 'error',
      error: 'Could not check existing PDF state',
    });
  }

  pendingRequests.set(fileId, {
    projectName,
    fileId,
    pdfUrl: pdfUrl || '',           // 자동 다운로드용 실제 PDF URL
    scholarUrl: scholarUrl || '',   // Open URL 버튼용 Scholar 검색 URL
    paperTitle: paperTitle || '',
    timestamp: Date.now(),
  });

  console.log(`[ExtBridge] Registered: ${fileId} pdf=${(pdfUrl || '').substring(0, 60)} scholar=${(scholarUrl || '').substring(0, 60)}`);
  return res.json({ status: 'ok' });
};

// GET /extension/pending — Extension polls for pending requests
exports.pending = (req, res) => {
  cleanExpired();
  const list = Array.from(pendingRequests.values());
  res.json(list);
};

// DELETE /extension/pending/:fileId — Extension marks request as fulfilled.
// Keep the request pending until the durable AWS S3 completion record exists.
exports.remove = async (req, res) => {
  const { fileId } = req.params;
  const pending = pendingRequests.get(fileId);
  if (!pending) {
    console.log(`[ExtBridge] Remove skipped: ${fileId} (found: false)`);
    return res.json({ status: 'ok', deleted: false });
  }

  try {
    const metadata = await getClient()
      .db(pending.projectName)
      .collection('PdfMeta')
      .findOne({ fileId });
    if (!metadata?.size || !metadata.uploadedAt) {
      console.warn(`[ExtBridge] Completion rejected: ${fileId} (PDF is not durable yet)`);
      return res.status(409).json({
        status: 'pending',
        deleted: false,
        error: 'PDF upload has not been confirmed in AWS S3',
      });
    }
  } catch (error) {
    console.error(`[ExtBridge] Completion check failed: ${fileId}:`, error.message);
    return res.status(503).json({
      status: 'pending',
      deleted: false,
      error: 'Could not verify PDF upload',
    });
  }

  const deleted = pendingRequests.delete(fileId);
  console.log(`[ExtBridge] Removed: ${fileId} (found: ${deleted})`);
  return res.json({ status: 'ok', deleted });
};
