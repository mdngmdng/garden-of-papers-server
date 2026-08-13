const express = require('express');
const atlasController = require('../controllers/atlas');

const router = express.Router();
router.post('/resolve-paper', atlasController.resolvePaper);

module.exports = router;
