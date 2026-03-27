const mongoose = require('mongoose');
const { getClient } = require('../services/mongo');
const syncKeys = require('../services/syncKeys');

// POST /load-data
exports.loadData = async (req, res) => {
  try {
    const client = getClient();
    const db = client.db(req.body._projectName);
    const collection = db.collection('SaveFile');
    const data = await collection.find().toArray();

    res.status(200).json(data);

    syncKeys.onLoadData(req.body.WebSocketID, req.body._projectName);
    syncKeys.debugLog();
  } catch (error) {
    console.error('Failed to load data:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load data', data: error });
  }
};

// POST /upload-data
exports.uploadData = async (req, res) => {
  const data = req.body;
  if (data._id === null || data._id === '') {
    delete data._id;
  }

  try {
    const client = getClient();
    const db = client.db(data._projectName);
    const collection = db.collection('SaveFile');

    if (!syncKeys.checkKey(data.WebSocketID, data._projectName)) {
      return res.status(202).json();
    }

    const newData = await collection.insertOne(data);
    if (!newData) {
      return res.status(404).json({ status: 'error', message: 'Data not found' });
    }

    res.status(201).json(newData);
    console.log('Data uploaded successfully.');
    syncKeys.rotateKey(data.WebSocketID, data._projectName);
    syncKeys.debugLog();
  } catch (error) {
    console.error('Failed to upload data:', error);
    res.status(500).json({ status: 'error', message: 'Failed to upload data', data: error });
  }
};

// POST /upload-log
exports.uploadLog = async (req, res) => {
  const data = req.body;

  try {
    const client = getClient();
    const db = client.db(data.projectName);
    const collection = db.collection('LogFile');

    if (!syncKeys.checkKey(data.webSocketId, data.projectName)) {
      return res.status(202).json();
    }

    const newData = await collection.insertOne(data);
    if (!newData) {
      return res.status(404).json({ status: 'error', message: 'Data not found' });
    }

    res.status(201).json(newData);
    console.log('Data uploaded successfully.');
  } catch (error) {
    console.error('Failed to upload data:', error);
    res.status(500).json({ status: 'error', message: 'Failed to upload data', data: error });
  }
};

// POST /update-data
exports.updateData = async (req, res) => {
  const {
    WebSocketID, _projectName, _id,
    type, pos, textValue, paperName, year, resourceLink, publicationVenue,
    resultId, citesId, citationCount, referenceTitleList, citationTitleList,
    abovePageIndex, referenceTextArray, highlightTexts, copiedOrigianlPaperId,
    lastPageNavigationTime, paperIndex, parentPaperId, color, noteType,
    textAlignmentIndex, fontSizeIndex, startPaperId, endPaperId, labelPosIndex,
    scaleFactor, ptCurveIds, ptArray, parentPageIndex,
    citationContextParagraph, citationSentenceRangePageIndex,
    citationSentenceRangeStartChar, citationSentenceRangeLength,
    relationshipInfo, referenceText, linkHighlightTexts, summaryNoteId,
    translations,
  } = req.body;

  try {
    const client = getClient();
    const db = client.db(_projectName);
    const collection = db.collection('SaveFile');

    if (!syncKeys.checkKey(WebSocketID, _projectName)) {
      return res.status(202).json();
    }

    const update = {};
    if (type !== '') update.type = type;
    if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) update.pos = pos;
    update.textValue = textValue;
    if (paperName !== '') update.paperName = paperName;
    if (year !== '') update.year = year;
    if (resourceLink !== '') update.resourceLink = resourceLink;
    if (publicationVenue !== '') update.publicationVenue = publicationVenue;
    if (resultId !== '') update.resultId = resultId;
    if (citesId !== '') update.citesId = citesId;
    if (citationCount !== '') update.citationCount = citationCount;
    if (referenceTitleList !== null && referenceTitleList.key.length !== 0) update.referenceTitleList = referenceTitleList;
    if (citationTitleList !== null && citationTitleList.key.length !== 0) update.citationTitleList = citationTitleList;
    update.abovePageIndex = abovePageIndex;
    if (referenceTextArray !== null && referenceTextArray.length !== 0) update.referenceTextArray = referenceTextArray;
    if (highlightTexts !== null && highlightTexts.length !== 0) update.highlightTexts = highlightTexts;
    if (copiedOrigianlPaperId !== '') update.copiedOrigianlPaperId = copiedOrigianlPaperId;
    if (lastPageNavigationTime !== '') update.lastPageNavigationTime = lastPageNavigationTime;
    update.paperIndex = paperIndex;
    if (color.r !== 0 || color.g !== 0 || color.b !== 0 || color.a !== 0) update.color = color;
    if (noteType !== '') update.noteType = noteType;
    update.fontSizeIndex = fontSizeIndex;
    update.textAlignmentIndex = textAlignmentIndex;
    if (startPaperId !== '') update.startPaperId = startPaperId;
    if (endPaperId !== '') update.endPaperId = endPaperId;
    update.labelPosIndex = labelPosIndex;
    update.scaleFactor = scaleFactor;
    if (parentPaperId !== '') update.parentPaperId = parentPaperId;
    if (ptCurveIds !== null && ptCurveIds.length !== 0) update.ptCurveIds = ptCurveIds;
    if (ptArray !== null && ptArray.length !== 0) update.ptArray = ptArray;
    update.parentPageIndex = parentPageIndex;
    if (citationContextParagraph && citationContextParagraph !== '') update.citationContextParagraph = citationContextParagraph;
    if (citationSentenceRangePageIndex !== undefined) update.citationSentenceRangePageIndex = citationSentenceRangePageIndex;
    if (citationSentenceRangeStartChar !== undefined) update.citationSentenceRangeStartChar = citationSentenceRangeStartChar;
    if (citationSentenceRangeLength !== undefined) update.citationSentenceRangeLength = citationSentenceRangeLength;
    if (relationshipInfo && relationshipInfo !== '') update.relationshipInfo = relationshipInfo;
    if (referenceText && referenceText !== '') update.referenceText = referenceText;
    if (linkHighlightTexts !== null && linkHighlightTexts !== undefined && linkHighlightTexts.length !== 0) update.linkHighlightTexts = linkHighlightTexts;
    if (summaryNoteId && summaryNoteId !== '') update.summaryNoteId = summaryNoteId;
    if (translations !== null && translations !== undefined) update.translations = translations;

    try {
      const updatedData = await collection.findOneAndUpdate(
        { _id: new mongoose.Types.ObjectId(_id) },
        { $set: update },
        { returnDocument: 'after' },
      );

      if (!updatedData) {
        return res.status(404).json({ status: 'error', message: 'Data not found' });
      }

      res.status(200).json(updatedData);
      syncKeys.rotateKey(WebSocketID, _projectName);
      syncKeys.debugLog();
    } catch (error) {
      return res.status(404).json({ status: 'error', message: 'Id not found' });
    }
  } catch (error) {
    console.error('Failed to update data:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update data', data: error });
  }
};

// POST /delete-data
exports.deleteData = async (req, res) => {
  const { WebSocketID, _projectName, _id: __id } = req.body;

  try {
    const client = getClient();
    const db = client.db(_projectName);
    const collection = db.collection('SaveFile');

    if (!syncKeys.checkKey(WebSocketID, _projectName)) {
      return res.status(202).json();
    }

    if (!mongoose.Types.ObjectId.isValid(__id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid ID format' });
    }

    const objectId = new mongoose.Types.ObjectId(__id);
    const deletedData = await collection.deleteOne({ _id: objectId });

    if (!deletedData) {
      return res.status(404).json({ status: 'error', message: 'Data not found' });
    }

    res.status(200).json({ status: 'ok', message: 'Data deleted successfully' });
    syncKeys.rotateKey(WebSocketID, _projectName);
    syncKeys.debugLog();
  } catch (error) {
    console.error('Failed to delete data:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete data', data: error });
  }
};
