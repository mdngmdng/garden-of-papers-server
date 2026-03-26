const express = require('express');
const router = express.Router();
const analyzeController = require('../controllers/analyze');

router.post('/relations', analyzeController.relations);
router.post('/layout', analyzeController.layout);
router.post('/highlights', analyzeController.highlights);
router.post('/summarize', analyzeController.summarize);
router.post('/storytelling', analyzeController.storytelling);

module.exports = router;
