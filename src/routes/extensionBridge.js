const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/extensionBridge');
const pdfController = require('../controllers/pdf');
const upload = multer({ storage: multer.memoryStorage() });

router.post('/register', ctrl.register);
router.get('/pending', ctrl.pending);
router.delete('/pending/:fileId', ctrl.remove);
// Stable Bridge endpoint: project names may contain slashes (for example
// "08/13 FullPaperSurvey"), so they must live in the multipart body rather
// than an Express path segment.
router.post(
  '/upload-pdf',
  upload.single('file'),
  (req, res, next) => {
    const projectName = String(req.body?.projectName || '').trim();
    if (!projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }
    req.params.projectName = projectName;
    next();
  },
  pdfController.uploadPdf,
);

module.exports = router;
