const express = require('express');
const router = express.Router();
const analyzeController = require('../controllers/analyze');

router.post('/relations', analyzeController.relations);
router.post('/layout', analyzeController.layout);

module.exports = router;
