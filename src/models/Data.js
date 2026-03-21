const mongoose = require('mongoose');

const dataSchema = new mongoose.Schema({
  type: String,
  pos: {
    x: Number,
    y: Number,
    z: Number,
  },
  textValue: String,
  paperName: String,
  year: String,
  resourceLink: String,
  publicationVenue: String,
  resultId: String,
  citesId: String,
  citationCount: String,
  referenceTitleList: {
    key: [String],
    value: [{ array: [String] }],
  },
  citationTitleList: {
    key: [String],
    value: [{ array: [String] }],
  },
  abovePageIndex: Number,
  referenceTextArray: [String],
  highlightTexts: [{
    item1: [Number],
    item2: [Number],
    item3: [{ r: Number, g: Number, b: Number, a: Number }],
  }],
  lastPageNavigationTime: String,
  parentPaperId: String,
  paperIndex: Number,
  fontSizeIndex: Number,
  textAlignmentIndex: Number,
  color: { r: Number, g: Number, b: Number, a: Number },
  noteType: String,
  startPaperId: String,
  endPaperId: String,
  labelPosIndex: { item1: Number, item2: Number },
  scaleFactor: Number,
  ptArray: [{ x: Number, y: Number }],
  parentPageIndex: Number,
  ptCurveIds: [String],
}, { versionKey: false });

module.exports = dataSchema;
