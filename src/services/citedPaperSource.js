const { ObjectId } = require('mongodb');
const mongo = require('./mongo');
const { workspaceSnapshotService } = require('./workspaceSnapshots');

/** A stored PDF and a canvas object have independent lifecycles. Never require a
 * legacy SaveFile row to read a PDF that the collection pipeline already stored. */
async function resolveCitedPaperSource(projectName, { paperId, fileId, paperTitle = '', year = '', venue = '' }) {
  if (fileId) return { fileId, paperId: paperId || fileId, title: paperTitle || 'Untitled', year, venue };

  // Older callers may supply only a canvas ID. The atomic snapshot owns those IDs;
  // newly collected UUID objects are never necessarily mirrored into SaveFile.
  let state;
  try { state = await workspaceSnapshotService.load(projectName); }
  catch (error) { if (error.status !== 404) throw error; }
  const paper = state?.objects?.find(o => o.type === 'GX.MAROScientificPaper' &&
    (o.id === paperId || o.persistenceKey === paperId));
  if (paper) {
    if (!paper.fileId) throw Object.assign(Error('Cited paper PDF is not available yet'), { status: 422 });
    return { fileId: paper.fileId, paperId, title: paper.title || paperTitle || 'Untitled',
      year: paper.year || year, venue: paper.venue || venue };
  }
  // An authoritative board must not revive a deleted object from its old mirror.
  if (!state) {
    const ids = [paperId];
    if (ObjectId.isValid(paperId)) ids.push(new ObjectId(paperId));
    const doc = await mongo.getClient().db(projectName).collection('SaveFile').findOne({ _id: { $in: ids } });
    if (doc) return { fileId: String(doc.fileId || doc._id), paperId,
      title: doc.paperName || paperTitle || 'Untitled', year: doc.year || year, venue: doc.publicationVenue || venue };
  }
  throw Object.assign(Error('Cited paper was not found'), { status: 404 });
}

module.exports = { resolveCitedPaperSource };
