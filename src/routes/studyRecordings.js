const router = require('express').Router();
const { studyRecordingService } = require('../services/studyRecordings');

router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.post('/:id', async (req, res) => {
  try { res.status(201).json(await studyRecordingService.append(req.params.id, req.body)); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Research recording storage failed' }); }
});
router.get('/:id', async (req, res) => {
  try {
    res.json(req.query.sessionId
      ? await studyRecordingService.read(req.params.id, req.query.sessionId, req.query.after ?? 0)
      : await studyRecordingService.list(req.params.id));
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Research recording retrieval failed' }); }
});
module.exports = router;
