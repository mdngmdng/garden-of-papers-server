const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfController = require('../controllers/pdf');
const scholarController = require('../controllers/scholar');
const relatedWorkController = require('../controllers/relatedWork');

const upload = multer({ storage: multer.memoryStorage() });

router.get('/pdf_metadata/:projectName/:fileid', pdfController.getMetadata);
router.post('/pdf_upload_url/:projectName', pdfController.createUploadUrl);
router.post('/complete_pdf_upload/:projectName', pdfController.completePdfUpload);
router.post('/upload_pdf/:projectName', upload.single('file'), pdfController.uploadPdf);
router.get('/list_pdfs/:projectName', pdfController.listPdfs);
router.get('/download_pdf/:projectName/:fileid', pdfController.downloadPdf);
router.get('/citations/:projectName/:fileid', pdfController.getCitations);
router.post(
  '/citations/:projectName/:fileid/refresh',
  pdfController.refreshCitations,
);

// Google Scholar search
router.get('/search-scholar', scholarController.searchScholar);
router.post('/search-related', relatedWorkController.search);
router.post('/related-search/jobs', relatedWorkController.createJob);
router.get('/related-search/jobs/:jobId', relatedWorkController.getJob);
router.delete('/related-search/jobs/:jobId', relatedWorkController.cancelJob);
router.get('/related-ranking/:jobId', relatedWorkController.ranking);

// Google Scholar citedBy
router.post('/fetch_citations/:projectName', scholarController.fetchCitedBy);
router.get('/cited_by/:projectName/:fileid', scholarController.getCitedBy);

module.exports = router;
