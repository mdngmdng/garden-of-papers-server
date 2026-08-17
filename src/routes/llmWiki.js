const express = require('express');
const controller = require('../controllers/llmWiki');

const router = express.Router();

router.get('/:id', controller.status);
router.put('/:id', controller.sync);
router.post('/:id/chat', controller.chat);
router.delete('/:id/chat', controller.clearChat);
router.get('/:id/logs/latest', controller.latestLog);

module.exports = router;
