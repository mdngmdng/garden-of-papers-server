const express = require('express');
const atlasController = require('../controllers/atlas');

const router = express.Router();
router.post('/resolve-paper', atlasController.resolvePaper);
router.post('/translate-paper', atlasController.translatePaper);

module.exports = router;
