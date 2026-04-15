const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/extensionBridge');

router.post('/register', ctrl.register);
router.get('/pending', ctrl.pending);
router.delete('/pending/:fileId', ctrl.remove);

module.exports = router;
