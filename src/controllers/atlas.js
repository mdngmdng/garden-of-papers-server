const { resolveAtlasPaper } = require('../services/atlasImport');

exports.resolvePaper = async (req, res) => {
  try {
    const paper = await resolveAtlasPaper(req.body?.paper || req.body || {});
    res.set('Cache-Control', 'private, no-store, max-age=0');
    return res.json({ paper });
  } catch (error) {
    const status = error instanceof TypeError ? 400 : 502;
    console.error('[Atlas] Paper handoff failed:', error.message);
    return res.status(status).json({ error: error.message });
  }
};
