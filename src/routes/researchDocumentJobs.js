const router = require('express').Router();
const { researchDocumentJobs } = require('../services/researchDocumentJobs');

router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.post('/', async (req, res) => {
  try { res.status(202).json(await researchDocumentJobs().enqueue(req.body, req.get('x-gop-study-context'))); }
  catch (error) { res.status(error.status || 400).json({ error: error.message || '분석 요청을 접수하지 못했습니다.' }); }
});
router.get('/:id', async (req, res) => {
  try { res.json(await researchDocumentJobs().get(req.params.id, req.query.workspaceId, req.query.researchDocumentFormat)); }
  catch (error) { res.status(error.status || 502).json({ error: error.message || '분석 상태를 조회하지 못했습니다.' }); }
});
module.exports = router;
