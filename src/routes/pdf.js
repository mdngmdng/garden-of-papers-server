const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfController = require('../controllers/pdf');
const scholarController = require('../controllers/scholar');

const upload = multer({ storage: multer.memoryStorage() });

router.get('/pdf_metadata/:projectName/:fileid', pdfController.getMetadata);
router.post('/upload_pdf/:projectName', upload.single('file'), pdfController.uploadPdf);
router.get('/list_pdfs/:projectName', pdfController.listPdfs);
router.get('/download_pdf/:projectName/:fileid', pdfController.downloadPdf);
router.get('/citations/:projectName/:fileid', pdfController.getCitations);

// Google Scholar citedBy
router.post('/fetch_citations/:projectName', scholarController.fetchCitedBy);
router.get('/cited_by/:projectName/:fileid', scholarController.getCitedBy);

module.exports = router;
