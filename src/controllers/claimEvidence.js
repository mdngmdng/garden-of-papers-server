const { assessClaimEvidence, parseEvidenceInput, planClaimRetrieval, parseRetrievalInput } = require('../services/claimEvidence');
const { reviewStatementEvidence, parseStatementReview } = require('../services/statementReview');
exports.review = async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { parseStatementReview(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abort);
  try { return res.json(await reviewStatementEvidence(req.body, { signal: controller.signal })); }
  catch (error) { if (!res.destroyed) return res.status(502).json({ error: error.message }); }
  finally { res.off('close', abort); }
};
exports.assess = async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const plan = req.body?.mode === 'retrieval_plan';
  try { (plan ? parseRetrievalInput : parseEvidenceInput)(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abort);
  try { return res.json(await (plan ? planClaimRetrieval : assessClaimEvidence)(req.body, { signal: controller.signal })); }
  catch (error) { if (!res.destroyed) return res.status(502).json({ error: error.message }); }
  finally { res.off('close', abort); }
};
