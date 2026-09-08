#!/usr/bin/env node
// Incident-scoped repair. Dry-run by default; all writes share one transaction.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { MongoClient, ObjectId, BSON } = require('mongodb');
const { planPaperRecovery } = require('../src/services/paperRecovery');

const BOARD = 'GardenOfPapers';
const PAPER_ID = '6a9f8bffe7c57ac12d904b61';
const HISTORY_ID = `${BOARD}:manual:0e3f3df3-4ce0-494a-bbc8-02e5d99f888f`;
const ORIGINAL_KEY = '03d27e85-2357-4d30-814d-10422a1cb8ff';
const WRONG_KEY = '6794ac2c-772b-4ede-b24b-098fe9c157b0';
const SHA = 'cf89aa7ba3b8c29e2d56bd25898f26722824dcdf797ac1631a75f1fdb951e5b5';
const BAD_ALIASES = ['ca127940-3595-4155-b7c9-7134b400fc69', '4b2d9ff2-20a4-4892-8469-b9f34de07c52'];
const BAD_KEYS = [
  'result:-pqvynh4jvoj',
  'url:https://hita-k.github.io/assets/papers/research-agenda.pdf',
  'title:interactions for human ai knowledge extension|year:2022|author:hyeonsu b kang',
];
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };

function decode(document) {
  if (document?.state) return document.state;
  if (document?.stateEncoding !== 'gzip-json-v1') throw new Error('Unsupported snapshot encoding');
  return JSON.parse(gunzipSync(Buffer.from(document.statePayload.buffer)).toString('utf8'));
}

function legacyFields(paper, timestamp) {
  return {
    clientObjectId: paper.persistenceKey, paperName: paper.title, authors: paper.authors,
    year: paper.year, doi: paper.doi || '', bibtex: paper.bibtex || '',
    bibtexSource: paper.bibtexSource || '', bibtexStatus: paper.bibtexStatus || '',
    resourceLink: paper.resourceLink || '', pdfSourceUrl: paper.pdfSourceUrl || '',
    fileId: paper.fileId, resultId: paper.resultId || '', publicationVenue: paper.venue,
    pos: { x: paper.x, y: -paper.y, z: 0 }, paperWidth: paper.width, paperHeight: paper.height,
    citationHits: paper.citationHits || [], pageSizeList: paper.pageSizeList || [],
    referenceTitleList: { key: Object.keys(paper.referenceTitleList || {}),
      value: Object.values(paper.referenceTitleList || {}).map(array => ({ array })) },
    referenceList: Object.entries(paper.references || {}).map(([refId, ref]) => ({
      refId, title: ref.title, authors: ref.authors, year: ref.year, journal: ref.venue,
      doi: ref.doi, raw: ref.raw, googleScholarId: ref.resultId, citesId: ref.citesId,
      scholarMatchVerified: ref.scholarMatchVerified,
    })),
    citationStatus: paper.citationExtractionStatus || 'idle', _gopUpdatedAt: timestamp,
  };
}

async function main() {
  const expectedRevision = Number(arg('--expected-revision'));
  const backupDirectory = arg('--backup-dir');
  if (!Number.isInteger(expectedRevision) || !backupDirectory) {
    throw new Error('Usage: node scripts/recover-threddy.js --expected-revision <revision> --backup-dir <directory> [--apply]');
  }
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const session = client.startSession();
  try {
    const system = client.db('GardenOfPapersSystem');
    const snapshots = system.collection('WorkspaceSnapshots');
    const history = system.collection('WorkspaceSnapshotHistory');
    const legacy = client.db(BOARD).collection('SaveFile');
    const metadata = client.db(BOARD).collection('PdfMeta');
    const library = client.db('_GardenOfPapersShared').collection('PdfLibrary');
    const read = options => Promise.all([
      snapshots.findOne({ _id: BOARD }, options),
      history.findOne({ _id: HISTORY_ID, projectName: BOARD }, options),
      legacy.findOne({ _id: new ObjectId(PAPER_ID) }, options),
      metadata.find({ fileId: { $in: [...BAD_ALIASES, '9ee7bb90-7a25-47da-aae4-a76c9482c5e5'] } }, options).toArray(),
      library.findOne({ pdfSha256: SHA }, options),
    ]);
    // Read-only backup includes the exact documents that will be changed.
    const before = await read({});
    const [snapshot, historical, legacyPaper, aliases, indexed] = before;
    const current = decode(snapshot);
    if (current.objects.find(o => o.id === PAPER_ID)?.persistenceKey === ORIGINAL_KEY &&
        current.objects.find(o => o.id === PAPER_ID)?.title.startsWith('Threddy:')) {
      console.log(JSON.stringify({ applied: false, alreadyRecovered: true, revision: current.revision }));
      return;
    }
    const affected = current.objects.find(o => o.id === PAPER_ID);
    if (affected?.persistenceKey !== WRONG_KEY || affected?.title !== 'Interactions for Human-AI Knowledge Extension' ||
        legacyPaper?.clientObjectId !== ORIGINAL_KEY) throw new Error('Incident signature changed; refusing repair');
    if (current.objects.some(o => o.id !== PAPER_ID && BAD_ALIASES.includes(o.fileId))) {
      throw new Error('An affected PDF alias is now used by another object');
    }
    if (!indexed || aliases.some(alias => alias.pdfSha256 !== SHA)) throw new Error('PDF identity changed');
    const timestamp = new Date();
    const plan = planPaperRecovery({ current, source: decode(historical), paperId: PAPER_ID,
      expectedRevision, timestamp: timestamp.toISOString() });
    const directory = path.resolve(backupDirectory);
    fs.mkdirSync(directory, { recursive: true });
    const backupPath = path.join(directory, `before-${timestamp.toISOString().replace(/[:.]/g, '-')}.ejson`);
    fs.writeFileSync(backupPath, BSON.EJSON.stringify({ snapshot, historical, legacyPaper, aliases, indexed }, { relaxed: false }), { flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'planned-state.json'), JSON.stringify(plan.state));
    const report = { applied: false, beforeRevision: current.revision, afterRevision: plan.state.revision,
      paperId: PAPER_ID, title: plan.paper.title, changedFields: plan.changedFields,
      retainedObjects: current.objects.length - 1, retainedNotes: current.objects.filter(o => o.parentPaperId === PAPER_ID).length,
      retainedHighlights: plan.paper.highlights.length, invalidatedAliases: BAD_ALIASES, backupPath };
    if (!process.argv.includes('--apply')) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const payload = gzipSync(Buffer.from(JSON.stringify(plan.state)), { level: 6 });
    if (payload.length > 14 * 1024 * 1024) throw new Error('Recovery snapshot exceeds storage limit');
    await session.withTransaction(async () => {
      // Transaction reads are sequential (Mongo sessions do not support parallel operations).
      for (const [collection, filter, expected] of [
        [snapshots, { _id: BOARD }, snapshot], [history, { _id: HISTORY_ID }, historical],
        [legacy, { _id: new ObjectId(PAPER_ID) }, legacyPaper], [library, { pdfSha256: SHA }, indexed],
      ]) {
        const latest = await collection.findOne(filter, { session });
        if (BSON.EJSON.stringify(latest) !== BSON.EJSON.stringify(expected)) throw new Error('Data changed after backup; rerun dry-run');
      }
      const latestAliases = await metadata.find({ fileId: { $in: aliases.map(a => a.fileId) } }, { session }).toArray();
      if (BSON.EJSON.stringify(latestAliases) !== BSON.EJSON.stringify(aliases)) throw new Error('PDF metadata changed after backup');
      const saved = await snapshots.updateOne({ _id: BOARD, revision: expectedRevision }, {
        $set: { stateEncoding: 'gzip-json-v1', statePayload: payload, revision: plan.state.revision,
          updatedAt: timestamp, lastMutationId: `repair:threddy:${timestamp.toISOString()}` },
        $unset: { state: '' },
      }, { session });
      if (saved.matchedCount !== 1) throw new Error('Workspace revision conflict');
      await legacy.updateOne({ _id: new ObjectId(PAPER_ID), clientObjectId: ORIGINAL_KEY }, {
        $set: legacyFields(plan.paper, timestamp), $unset: { pdfPagePreview: '', abstract: '' },
      }, { session });
      await library.updateOne({ pdfSha256: SHA }, {
        $set: { updatedAt: timestamp },
        $pull: { identityKeys: { $in: BAD_KEYS }, sourceRefs: { projectName: BOARD, fileId: { $in: BAD_ALIASES } } },
      }, { session });
      await metadata.deleteMany({ fileId: { $in: BAD_ALIASES }, pdfSha256: SHA }, { session });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    const verified = decode(await snapshots.findOne({ _id: BOARD }));
    if (JSON.stringify(verified) !== JSON.stringify(plan.state)) throw new Error('Post-repair state differs from plan');
    report.applied = true;
    fs.writeFileSync(path.join(directory, 'recovery-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await session.endSession(); await client.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { decode, legacyFields };
