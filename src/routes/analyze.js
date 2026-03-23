const express = require('express');
const router = express.Router();
const analyzeController = require('../controllers/analyze');

router.post('/relations', analyzeController.relations);
router.post('/layout', analyzeController.layout);
router.post('/highlights', analyzeController.highlights);

module.exports = router;
