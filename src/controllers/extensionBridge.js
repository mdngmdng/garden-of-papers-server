const pdfBridge = require('../services/pdfBridge');

// POST /extension/register — Unity registers a pending PDF request
exports.register = async (req, res) => {
  try {
    const result = await pdfBridge.registerPendingRequest(req.body || {});
    const { fileId = '', pdfUrl = '', scholarUrl = '' } = req.body || {};
    console.log(
      `[ExtBridge] ${result.status === 'ready' ? 'Already ready' : 'Registered'}: ${fileId} `
      + `pdf=${String(pdfUrl).substring(0, 60)} scholar=${String(scholarUrl).substring(0, 60)}`,
    );
    return res.json(result);
  } catch (error) {
    console.error('[ExtBridge] Registration failed:', error.message);
    return res.status(error.status || 503).json({
      status: 'error',
      error: error.status === 400 ? error.message : 'Could not register PDF request',
    });
  }
};

// GET /extension/pending — Extension polls for pending requests
exports.pending = async (req, res) => {
  try {
    return res.json(await pdfBridge.pendingRequests());
  } catch (error) {
    console.error('[ExtBridge] Pending list failed:', error.message);
    return res.status(503).json({ error: 'Could not load pending PDF requests' });
  }
};

// DELETE /extension/pending/:fileId — Extension marks request as fulfilled.
// Keep the request pending until the durable AWS S3 completion record exists.
exports.remove = async (req, res) => {
  const { fileId } = req.params;
  try {
    const result = await pdfBridge.removePendingRequest(fileId);
    const status = result.status === 'pending' ? 409 : 200;
    console.log(`[ExtBridge] Remove ${result.deleted ? 'completed' : 'skipped'}: ${fileId}`);
    return res.status(status).json(result);
  } catch (error) {
    console.error(`[ExtBridge] Completion check failed: ${fileId}:`, error.message);
    return res.status(503).json({
      status: 'pending',
      deleted: false,
      error: 'Could not verify PDF upload',
    });
  }
};
