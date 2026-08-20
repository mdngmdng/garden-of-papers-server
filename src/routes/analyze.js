const express = require('express');
const router = express.Router();
const analyzeController = require('../controllers/analyze');
const relatedWorkController = require('../controllers/relatedWork');

router.post('/relations', analyzeController.relations);
router.post('/layout', analyzeController.layout);
router.post('/highlights', analyzeController.highlights);
router.post('/citation-graph', analyzeController.citationGraph);
router.post('/closest-sentence', analyzeController.closestSentence);
router.post('/summarize', analyzeController.summarize);
router.post('/storytelling', analyzeController.storytelling);
router.post('/collect-related', relatedWorkController.collect);

module.exports = router;
