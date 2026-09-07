const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfController = require('../controllers/pdf');
const scholarController = require('../controllers/scholar');
const relatedWorkController = require('../controllers/relatedWork');
const researchGraphController = require('../controllers/researchGraph');

const upload = multer({ storage: multer.memoryStorage() });

router.get('/pdf_metadata/:projectName/:fileid', pdfController.getMetadata);
router.post('/pdf_upload_url/:projectName', pdfController.createUploadUrl);
router.post('/complete_pdf_upload/:projectName', pdfController.completePdfUpload);
router.post('/reuse_pdf/:projectName', pdfController.reusePdf);
router.post('/upload_pdf/:projectName', upload.single('file'), pdfController.uploadPdf);
router.get('/list_pdfs/:projectName', pdfController.listPdfs);
router.get('/download_pdf/:projectName/:fileid', pdfController.downloadPdf);
router.get('/pdf_preview/:projectName/:fileid', pdfController.downloadPdfPreview);
router.get('/citations/:projectName/:fileid', pdfController.getCitations);
router.post(
  '/citations/:projectName/:fileid/refresh',
  pdfController.refreshCitations,
);

// Google Scholar search
router.get('/search-scholar', scholarController.searchScholar);
router.post('/claim-evidence/assess', require('../controllers/claimEvidence').assess);
router.post('/claim-evidence/review', require('../controllers/claimEvidence').review);
router.post('/related-search/jobs', relatedWorkController.createJob);
router.get('/related-search/jobs', relatedWorkController.listJobs);
router.get('/related-search/jobs/:jobId', relatedWorkController.getJob);
router.delete('/related-search/jobs/:jobId', relatedWorkController.cancelJob);
router.post('/research-graph/jobs', researchGraphController.createJob);
router.get('/research-graph/jobs', researchGraphController.listJobs);
router.get('/research-graph/jobs/:jobId', researchGraphController.getJob);
router.delete('/research-graph/jobs/:jobId', researchGraphController.cancelJob);

// Google Scholar citedBy
router.post('/fetch_citations/:projectName', scholarController.fetchCitedBy);
router.get('/cited_by/:projectName/:fileid', scholarController.getCitedBy);

module.exports = router;
