const { assessClaimEvidence, parseEvidenceInput } = require('../services/claimEvidence');
exports.assess = async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { parseEvidenceInput(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abort);
  try { return res.json(await assessClaimEvidence(req.body, { signal: controller.signal })); }
  catch (error) { if (!res.destroyed) return res.status(502).json({ error: error.message }); }
  finally { res.off('close', abort); }
};
