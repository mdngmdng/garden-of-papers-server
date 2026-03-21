const mongoose = require('mongoose');

const paperSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    googleScholarId: { type: String, unique: true, sparse: true },
    authors: [String],
    abstract: String,
    year: Number,
    venue: String,
    citationCount: Number,
    s3Key: String,
    pdfUrl: String,
    grobidParsed: { type: Boolean, default: false },
    tags: [String],
  },
  { timestamps: true }
);

module.exports = paperSchema;
