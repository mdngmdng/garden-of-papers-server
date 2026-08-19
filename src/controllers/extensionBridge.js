const pdfBridge = require('../services/pdfBridge');
const projectLeases = require('../services/projectLeases');

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
    return res.json(await pdfBridge.pendingRequests(req.query.projectName));
  } catch (error) {
    console.error('[ExtBridge] Pending list failed:', error.message);
    return res.status(503).json({ error: 'Could not load pending PDF requests' });
  }
};

// POST /extension/projects/claim — Atomically claim or renew one project.
exports.claimProject = async (req, res) => {
  try {
    return res.json(await projectLeases.claim(req.body || {}));
  } catch (error) {
    const status = error.status || 503;
    return res.status(status).json({
      ok: false,
      error: status === 503 ? 'Could not claim project' : error.message,
    });
  }
};

// POST /extension/projects/release — Release only the caller's own lease.
exports.releaseProject = async (req, res) => {
  try {
    return res.json(await projectLeases.release(req.body || {}));
  } catch (error) {
    const status = error.status || 503;
    return res.status(status).json({
      ok: false,
      error: status === 503 ? 'Could not release project' : error.message,
    });
  }
};

// DELETE /extension/pending/:fileId — Extension marks request as fulfilled.
// Keep the request pending until the durable AWS S3 completion record exists.
exports.remove = async (req, res) => {
  const { fileId } = req.params;
  try {
    const projectName = String(req.query.projectName || '').trim();
    const force = req.query.force === 'true' || req.query.force === '1';

    if (force) {
      // Renewing the lease is also an atomic ownership check. A different
      // active client receives 409 and cannot discard this project's work.
      await projectLeases.claim({
        projectName,
        clientId: req.query.clientId,
      });
    }

    const result = await pdfBridge.removePendingRequest(fileId, {
      force,
      projectName,
    });
    const status = result.status === 'pending' ? 409 : 200;
    console.log(`[ExtBridge] Remove ${result.deleted ? 'completed' : 'skipped'}: ${fileId}`);
    return res.status(status).json(result);
  } catch (error) {
    console.error(`[ExtBridge] Completion check failed: ${fileId}:`, error.message);
    const status = error.status || 503;
    return res.status(status).json({
      status: status === 409 ? 'conflict' : 'error',
      deleted: false,
      error: status === 503 ? 'Could not remove PDF request' : error.message,
    });
  }
};
