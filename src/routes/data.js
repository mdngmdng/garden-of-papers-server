const express = require('express');
const router = express.Router();
const dataController = require('../controllers/data');

router.post('/load-data', dataController.loadData);
router.post('/upload-data', dataController.uploadData);
router.post('/upload-log', dataController.uploadLog);
router.post('/update-data', dataController.updateData);
router.post('/delete-data', dataController.deleteData);

module.exports = router;
