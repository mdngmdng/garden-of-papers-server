const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { getClient } = require('../services/mongo');
const syncKeys = require('../services/syncKeys');
const pdfPreviewService = require('../services/pdfPreview');

function getIdQuery(id) {
  const value = String(id ?? '');
  if (mongoose.Types.ObjectId.isValid(value)) {
    return {
      $or: [
        { _id: new mongoose.Types.ObjectId(value) },
        { _id: value },
      ],
    };
  }
  return { _id: value };
}

function stableResearchGraphObjectId(projectName, type, clientObjectId) {
  const digest = crypto.createHash('sha256')
    .update(`${projectName}\u001e${type}\u001e${clientObjectId}`)
    .digest('hex')
    .slice(0, 24);
  return new mongoose.Types.ObjectId(digest);
}

// POST /load-data
exports.loadData = async (req, res) => {
  try {
    const client = getClient();
    const db = client.db(req.body._projectName);
    const collection = db.collection('SaveFile');
    // Point-curve ink is retired. Clean legacy rows at the read boundary so
    // old VR clients cannot make removed scribbles reappear on another load.
    await Promise.all([
      collection.deleteMany({ type: 'GX.MAROPtCurve' }),
      collection.updateMany(
        { ptCurveIds: { $exists: true } },
        { $unset: { ptCurveIds: '' } },
      ),
    ]);
    const data = await collection.find().toArray();
    const paperRows = data.filter((row) => row.type === 'GX.MAROScientificPaper');
    const previewRequests = [];
    const metadataFileIds = [
      ...new Set(
        paperRows
          .filter((row) => {
            const fileId = String(row.fileId || row._id || '');
            const pageIndex = 0;
            const hasCitations = row.citationStatus === 'ready'
              && Array.isArray(row.citationHits);
            const hasPreview = pdfPreviewService.isPreviewCurrent(
              row.pdfPagePreview,
              fileId,
              pageIndex,
            );
            return fileId && (!hasCitations || !hasPreview);
          })
          .map((row) => String(row.fileId || row._id || ''))
          .filter(Boolean),
      ),
    ];

    if (metadataFileIds.length) {
      // PdfMeta may contain large extraction/index payloads that are not part
      // of the workspace response. Reading whole metadata documents made a
      // modest board take longer than the browser's load deadline. Fetch only
      // the compatibility fields needed to backfill SaveFile rows and preview
      // descriptors.
      const cachedExtractions = await db.collection('PdfMeta').find(
        { fileId: { $in: metadataFileIds } },
        {
          projection: {
            fileId: 1,
            citationStatus: 1,
            citationHits: 1,
            pageSizeList: 1,
            pageSizes: 1,
            referenceList: 1,
            references: 1,
            referenceTitleList: 1,
            citationsExtractedAt: 1,
            pdfPagePreview: 1,
            previewStatus: 1,
            previewRetryable: 1,
            previewFailedAt: 1,
          },
        },
      ).toArray();
      const cachedByFileId = new Map(
        cachedExtractions.map((entry) => [String(entry.fileId), entry]),
      );
      const backfills = [];

      for (const row of paperRows) {
        const fileId = String(row.fileId || row._id || '');
        const cached = cachedByFileId.get(fileId);
        const rowUpdate = {};
        if (
          cached?.citationStatus === 'ready'
          && Array.isArray(cached.citationHits)
          && !(
            row.citationStatus === 'ready'
            && Array.isArray(row.citationHits)
          )
        ) {
          Object.assign(rowUpdate, {
            citationHits: cached.citationHits,
            pageSizeList: cached.pageSizeList ?? cached.pageSizes ?? [],
            referenceList: cached.referenceList ?? cached.references ?? [],
            citationStatus: 'ready',
            citationsExtractedAt: cached.citationsExtractedAt ?? new Date(),
          });
          if (cached.referenceTitleList !== undefined) {
            rowUpdate.referenceTitleList = cached.referenceTitleList;
          }
        }
        const pageIndex = 0;
        const storedPreview = pdfPreviewService.isPreviewCurrent(
          row.pdfPagePreview,
          fileId,
          pageIndex,
        )
          ? row.pdfPagePreview
          : pdfPreviewService.createPreviewDescriptor(
            req.body._projectName,
            fileId,
            cached?.pdfPagePreview,
          );
        if (
          pdfPreviewService.isPreviewCurrent(
            storedPreview,
            fileId,
            pageIndex,
          )
        ) {
          if (row.pdfPagePreview !== storedPreview) {
            rowUpdate.pdfPagePreview = storedPreview;
          }
        } else if (fileId) {
          if (row.pdfPagePreview != null) rowUpdate.pdfPagePreview = null;
          if (pdfPreviewService.canAttemptPdfPreview(cached)) {
            previewRequests.push({ fileId, pageIndex });
          }
        }
        if (Object.keys(rowUpdate).length) {
          Object.assign(row, rowUpdate);
          backfills.push({
            updateOne: {
              filter: { _id: row._id },
              update: { $set: rowUpdate },
            },
          });
        }
      }

      if (backfills.length) {
        await collection.bulkWrite(backfills);
      }
    }

    res.status(200).json(data);

    // Cold-workspace preview generation must never delay the load response.
    for (const request of previewRequests) {
      pdfPreviewService.queuePdfPreview(
        req.body._projectName,
        request.fileId,
        request.pageIndex,
      );
    }

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

    if (data.type === 'GX.MAROPtCurve') {
      return res.status(204).end();
    }

    // Browser-generated Base64 previews were a temporary compatibility path.
    // Only compact server-owned URL descriptors are allowed into MongoDB now.
    if (data.type === 'GX.MAROScientificPaper') {
      delete data.pdfPagePreview;
    }
    data._gopUpdatedAt = new Date();
    const clientObjectId = String(data.clientObjectId || '').trim();
    const isResearchGraphObject = clientObjectId.startsWith('research-graph:v2:');
    let newData;
    if (isResearchGraphObject) {
      // All tabs derive the same Mongo id for the same graph job/object. The
      // upsert makes a retry safe even when the first response was lost.
      const stableId = stableResearchGraphObjectId(
        data._projectName,
        data.type,
        clientObjectId,
      );
      const storedData = { ...data };
      delete storedData._id;
      const upsert = await collection.updateOne(
        { _id: stableId },
        { $set: storedData },
        { upsert: true },
      );
      newData = {
        acknowledged: upsert.acknowledged,
        insertedId: stableId,
        idempotent: upsert.matchedCount > 0,
      };
    } else {
      newData = await collection.insertOne(data);
    }
    if (!newData) {
      return res.status(404).json({ status: 'error', message: 'Data not found' });
    }

    res.status(201).json(newData);
    console.log('Data uploaded successfully.');
    syncKeys.rotateKey(data.WebSocketID, data._projectName);
    syncKeys.debugLog();
    if (data.type === 'GX.MAROScientificPaper' && data.fileId) {
      pdfPreviewService.queuePdfPreview(
        data._projectName,
        String(data.fileId),
        0,
      );
    }
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
    type, pos, textValue, paperName, year, resourceLink, fileId, pdfSourceUrl, publicationVenue,
    resultId, citesId, citationCount, referenceTitleList, citationTitleList,
    scholarCitationStatus, scholarCitationNextOffset, scholarCitationError,
    abovePageIndex, paperWidth, paperHeight,
    referenceTextArray, highlightTexts, copiedOrigianlPaperId,
    lastPageNavigationTime, paperIndex, parentPaperId, parentOffsetX,
    parentOffsetY, color, noteType, claimEvidence,
    textAlignmentIndex, fontSizeIndex, startPaperId, endPaperId, labelPosIndex,
    scaleFactor, ptCurveIds, ptArray, parentPageIndex,
    citationContextParagraph, citationSentenceRangePageIndex,
    citationSentenceRangeStartChar, citationSentenceRangeLength,
    relationshipInfo, referenceText, citationHitId, citationContexts,
    semanticPreparationStatus, semanticPreparationError,
    citationGraphSelection, citationGraphNoteId, citationGraphModel,
    linkHighlightTexts, summaryNoteId,
    translations, citationHits, pageSizeList, referenceList, citationStatus,
    pdfPagePreview, pdfExcerpts,
  } = req.body;

  try {
    const client = getClient();
    const db = client.db(_projectName);
    const collection = db.collection('SaveFile');

    if (!syncKeys.checkKey(WebSocketID, _projectName)) {
      return res.status(202).json();
    }

    if (type === 'GX.MAROPtCurve') {
      await collection.deleteOne(getIdQuery(_id));
      return res.status(200).json({
        status: 'removed',
        message: 'Freehand canvas ink is no longer supported',
      });
    }

    const update = {};
    const unset = {};
    if (type !== '') update.type = type;
    if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) update.pos = pos;
    update.textValue = textValue;
    if (paperName !== '') update.paperName = paperName;
    if (year !== '') update.year = year;
    if (resourceLink !== '') update.resourceLink = resourceLink;
    if (fileId !== undefined && fileId !== '') update.fileId = fileId;
    if (pdfSourceUrl !== undefined && pdfSourceUrl !== '') update.pdfSourceUrl = pdfSourceUrl;
    if (publicationVenue !== '') update.publicationVenue = publicationVenue;
    if (resultId !== '') update.resultId = resultId;
    if (citesId !== '') update.citesId = citesId;
    if (citationCount !== '') update.citationCount = citationCount;
    if (referenceTitleList !== null && referenceTitleList.key.length !== 0) update.referenceTitleList = referenceTitleList;
    if (citationTitleList !== null && citationTitleList.key.length !== 0) update.citationTitleList = citationTitleList;
    if (scholarCitationStatus !== undefined && scholarCitationStatus !== '') {
      update.scholarCitationStatus = scholarCitationStatus;
    }
    if (Number.isFinite(scholarCitationNextOffset)) {
      update.scholarCitationNextOffset = scholarCitationNextOffset;
    }
    if (scholarCitationError !== undefined) {
      update.scholarCitationError = scholarCitationError;
    }
    update.abovePageIndex = abovePageIndex;
    if (Number.isFinite(paperWidth) && paperWidth > 0) {
      update.paperWidth = paperWidth;
    }
    if (Number.isFinite(paperHeight) && paperHeight > 0) {
      update.paperHeight = paperHeight;
    }
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
    if (claimEvidence !== undefined) update.claimEvidence = claimEvidence;
    if (Array.isArray(pdfExcerpts)) update.pdfExcerpts = pdfExcerpts;
    if (Number.isFinite(parentOffsetX) && Number.isFinite(parentOffsetY)) {
      update.parentOffsetX = parentOffsetX;
      update.parentOffsetY = parentOffsetY;
    } else if (parentOffsetX === null && parentOffsetY === null) {
      unset.parentOffsetX = '';
      unset.parentOffsetY = '';
    }
    if (ptCurveIds !== null && ptCurveIds.length !== 0) update.ptCurveIds = ptCurveIds;
    if (ptArray !== null && ptArray.length !== 0) update.ptArray = ptArray;
    update.parentPageIndex = parentPageIndex;
    if (citationContextParagraph && citationContextParagraph !== '') update.citationContextParagraph = citationContextParagraph;
    if (citationSentenceRangePageIndex !== undefined) update.citationSentenceRangePageIndex = citationSentenceRangePageIndex;
    if (citationSentenceRangeStartChar !== undefined) update.citationSentenceRangeStartChar = citationSentenceRangeStartChar;
    if (citationSentenceRangeLength !== undefined) update.citationSentenceRangeLength = citationSentenceRangeLength;
    if (relationshipInfo && relationshipInfo !== '') update.relationshipInfo = relationshipInfo;
    if (referenceText && referenceText !== '') update.referenceText = referenceText;
    if (citationHitId && citationHitId !== '') update.citationHitId = citationHitId;
    if (Array.isArray(citationContexts)) update.citationContexts = citationContexts;
    if (semanticPreparationStatus) {
      update.semanticPreparationStatus = semanticPreparationStatus;
    }
    if (semanticPreparationError !== undefined) {
      update.semanticPreparationError = semanticPreparationError;
    }
    if (citationGraphSelection && typeof citationGraphSelection === 'object') {
      update.citationGraphSelection = citationGraphSelection;
    }
    if (citationGraphNoteId !== undefined) {
      update.citationGraphNoteId = citationGraphNoteId;
    }
    if (citationGraphModel !== undefined) {
      update.citationGraphModel = citationGraphModel;
    }
    if (linkHighlightTexts !== null && linkHighlightTexts !== undefined && linkHighlightTexts.length !== 0) update.linkHighlightTexts = linkHighlightTexts;
    if (summaryNoteId && summaryNoteId !== '') update.summaryNoteId = summaryNoteId;
    if (translations !== null && translations !== undefined) update.translations = translations;
    if (Array.isArray(citationHits) && citationHits.length !== 0) update.citationHits = citationHits;
    if (Array.isArray(pageSizeList) && pageSizeList.length !== 0) update.pageSizeList = pageSizeList;
    if (Array.isArray(referenceList) && referenceList.length !== 0) update.referenceList = referenceList;
    if (citationStatus === 'ready') {
      update.citationStatus = 'ready';
      update.citationsExtractedAt = new Date();
    }
    if (pdfPagePreview?.version === 1) {
      unset.pdfPagePreview = '';
    }
    update._gopUpdatedAt = new Date();

    try {
      const updatedData = await collection.findOneAndUpdate(
        getIdQuery(_id),
        {
          $set: update,
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        { returnDocument: 'after' },
      );

      if (!updatedData) {
        return res.status(404).json({ status: 'error', message: 'Data not found' });
      }

      res.status(200).json(updatedData);
      syncKeys.rotateKey(WebSocketID, _projectName);
      syncKeys.debugLog();
      if (updatedData.type === 'GX.MAROScientificPaper' && updatedData.fileId) {
        const pageIndex = 0;
        if (!pdfPreviewService.isPreviewCurrent(
          updatedData.pdfPagePreview,
          String(updatedData.fileId),
          pageIndex,
        )) {
          pdfPreviewService.queuePdfPreview(
            _projectName,
            String(updatedData.fileId),
            pageIndex,
          );
        }
      }
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

    const deletedData = await collection.deleteOne(getIdQuery(__id));

    if (!deletedData.deletedCount) {
      return res.status(404).json({ status: 'error', message: 'Data not found' });
    }

    // Keep a workspace-level freshness witness even when the newest change is
    // a deletion. The camera row is written at the end of every successful
    // browser save, so this marker also lets clients distinguish a current
    // legacy mirror from an older atomic safety snapshot.
    await collection.updateOne(
      { type: 'GX.MAROScreenCameraPerson' },
      { $set: { _gopUpdatedAt: new Date() } },
    );

    res.status(200).json({ status: 'ok', message: 'Data deleted successfully' });
    syncKeys.rotateKey(WebSocketID, _projectName);
    syncKeys.debugLog();
  } catch (error) {
    console.error('Failed to delete data:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete data', data: error });
  }
};
