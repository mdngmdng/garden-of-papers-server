// In-memory store for pending PDF requests from Unity
// Map<fileId, { projectName, fileId, pdfUrl, paperTitle, timestamp }>
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
exports.register = (req, res) => {
  const { projectName, fileId, pdfUrl, scholarUrl, paperTitle } = req.body;
  if (!projectName || !fileId) {
    return res.status(400).json({
      error: 'projectName and fileId are required',
    });
  }

  cleanExpired();

  pendingRequests.set(fileId, {
    projectName,
    fileId,
    pdfUrl: pdfUrl || '',           // 자동 다운로드용 실제 PDF URL
    scholarUrl: scholarUrl || '',   // Open URL 버튼용 Scholar 검색 URL
    paperTitle: paperTitle || '',
    timestamp: Date.now(),
  });

  console.log(`[ExtBridge] Registered: ${fileId} pdf=${(pdfUrl || '').substring(0, 60)} scholar=${(scholarUrl || '').substring(0, 60)}`);
  res.json({ status: 'ok' });
};

// GET /extension/pending — Extension polls for pending requests
exports.pending = (req, res) => {
  cleanExpired();
  const list = Array.from(pendingRequests.values());
  res.json(list);
};

// DELETE /extension/pending/:fileId — Extension marks request as fulfilled
exports.remove = (req, res) => {
  const { fileId } = req.params;
  const deleted = pendingRequests.delete(fileId);
  console.log(`[ExtBridge] Removed: ${fileId} (found: ${deleted})`);
  res.json({ status: 'ok', deleted });
};
