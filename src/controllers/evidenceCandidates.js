const { parseCandidateInput, planEvidenceCandidates, assessEvidenceCandidates } = require('../services/evidenceCandidates');
function handler(assessment) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { parseCandidateInput(req.body, assessment); } catch (error) { return res.status(400).json({ error: error.message }); }
    const controller = new AbortController(), abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try { return res.json(await (assessment ? assessEvidenceCandidates : planEvidenceCandidates)(req.body, { signal: controller.signal })); }
    catch (error) { if (!res.destroyed) return res.status(502).json({ error: error.message }); }
    finally { res.off('close', abort); }
  };
}
exports.plan = handler(false);
exports.assess = handler(true);
