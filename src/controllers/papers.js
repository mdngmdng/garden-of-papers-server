const { getClient } = require('../services/mongo');
const s3Service = require('../services/s3');
const grobidService = require('../services/grobid');
const { ObjectId } = require('mongodb');

const COLLECTION = 'Papers';
const DB_NAME = 'GardenOfPapers';

function getCollection() {
  return getClient().db(DB_NAME).collection(COLLECTION);
}

// GET /papers
exports.list = async (req, res) => {
  try {
    const papers = await getCollection().find().sort({ createdAt: -1 }).toArray();
    res.json(papers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /papers/:id
exports.getById = async (req, res) => {
  try {
    const paper = await getCollection().findOne({ _id: new ObjectId(req.params.id) });
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    res.json(paper);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /papers
exports.create = async (req, res) => {
  try {
    const result = await getCollection().insertOne({ ...req.body, createdAt: new Date() });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// PATCH /papers/:id
exports.update = async (req, res) => {
  try {
    const result = await getCollection().findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: req.body },
      { returnDocument: 'after' },
    );
    if (!result) return res.status(404).json({ error: 'Paper not found' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// DELETE /papers/:id
exports.remove = async (req, res) => {
  try {
    const result = await getCollection().deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Paper not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /papers/:id/upload-pdf
exports.uploadPdf = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    const paper = await getCollection().findOne({ _id: new ObjectId(req.params.id) });
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    const s3Key = `papers/managed/${req.params.id}/${req.file.originalname}`;
    await s3Service.uploadPdf(s3Key, req.file.buffer);

    await getCollection().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { s3Key } },
    );

    res.json({ message: 'PDF uploaded', s3Key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /papers/:id/parse
exports.parse = async (req, res) => {
  try {
    const paper = await getCollection().findOne({ _id: new ObjectId(req.params.id) });
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    if (!paper.s3Key) return res.status(400).json({ error: 'No PDF uploaded yet' });

    const s3Response = await s3Service.downloadPdf(paper.s3Key);
    const chunks = [];
    for await (const chunk of s3Response.Body) {
      chunks.push(chunk);
    }
    const pdfBuffer = Buffer.concat(chunks);

    const teiXml = await grobidService.parsePdf(pdfBuffer);

    await getCollection().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { grobidParsed: true } },
    );

    res.json({ message: 'Parsed', teiXml });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
