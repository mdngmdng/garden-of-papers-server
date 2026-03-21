const express = require('express');
const router = express.Router();
const papersController = require('../controllers/papers');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// 메타데이터 CRUD
router.get('/', papersController.list);
router.get('/:id', papersController.getById);
router.post('/', papersController.create);
router.patch('/:id', papersController.update);
router.delete('/:id', papersController.remove);

// PDF 업로드 → S3 저장 + 메타데이터 생성
router.post('/:id/upload-pdf', upload.single('pdf'), papersController.uploadPdf);

// GROBID 파싱 요청
router.post('/:id/parse', papersController.parse);

module.exports = router;
