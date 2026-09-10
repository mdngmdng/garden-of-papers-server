const test = require('node:test');
const assert = require('node:assert/strict');
const { citationGraph } = require('../src/controllers/analyze');
const mongo = require('../src/services/mongo');
const storage = require('../src/services/pdfStorage');
const s3 = require('../src/services/s3');
const pdf = require('../src/services/pdfCitationFallback');
const analysis = require('../src/services/citationGraphAnalysis');
const { workspaceSnapshotService } = require('../src/services/workspaceSnapshots');

const request = { projectName: 'board', paperId: 'canvas-uuid', fileId: 'stored-pdf', paperTitle: 'Collected paper', citationContext: 'A citing sentence [41].' };
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function pipeline(t) {
  const read = t.mock.method(storage, 'resolvePdfS3Key', async (project, fileId) => `${project}/${fileId}.pdf`);
  const download = t.mock.method(s3, 'downloadPdfBuffer', async () => Buffer.from('stored PDF'));
  const extract = t.mock.method(pdf, 'extractPdfTextPages', async () => [{ pageIndex: 0, text: 'Exact original.' }]);
  const model = t.mock.method(analysis, 'analyzeCitationGraph', async input => ({ paperId: input.paper.id, status: 'found', model: 'gpt-5.6-luna' }));
  return { read, download, extract, model };
}

test('a collected PDF reaches analysis before either snapshot or SaveFile has saved its canvas object', async t => {
  const { read, model } = pipeline(t);
  t.mock.method(mongo, 'getClient', () => { throw Error('must not require a canvas save'); });
  t.mock.method(workspaceSnapshotService, 'load', async () => { throw Error('must not require a snapshot'); });
  const res = response(); await citationGraph({ body: request }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.paperId, request.paperId);
  assert.deepEqual(read.mock.calls[0].arguments, ['board', 'stored-pdf']);
  assert.deepEqual(model.mock.calls[0].arguments[0].pages, [{ pageIndex: 0, text: 'Exact original.' }]);
});

test('an explicit current PDF wins over an obsolete legacy row and preserves the request canvas ID', async t => {
  const { read } = pipeline(t);
  const legacy = t.mock.fn(async () => ({ _id: 'canvas-uuid', fileId: 'old-pdf' }));
  t.mock.method(mongo, 'getClient', () => ({ db: () => ({ collection: () => ({ findOne: legacy }) }) }));
  const res = response(); await citationGraph({ body: request }, res);
  assert.equal(res.statusCode, 200); assert.equal(read.mock.calls[0].arguments[1], 'stored-pdf');
  assert.equal(legacy.mock.callCount(), 0);
});

test('ID-only callers resolve atomic snapshot objects without a legacy Mongo ID', async t => {
  const { read } = pipeline(t);
  t.mock.method(workspaceSnapshotService, 'load', async () => ({ objects: [{ type: 'GX.MAROScientificPaper', id: 'canvas-uuid', fileId: 'atomic-pdf', title: 'Atomic' }] }));
  const res = response(); await citationGraph({ body: { ...request, fileId: undefined } }, res);
  assert.equal(res.statusCode, 200); assert.equal(read.mock.calls[0].arguments[1], 'atomic-pdf');
});

test('a missing blob fails before any model call and describes PDF availability', async t => {
  const { model } = pipeline(t);
  t.mock.method(s3, 'downloadPdfBuffer', async () => { throw Object.assign(Error('No such key'), { name: 'NoSuchKey' }); });
  const res = response(); await citationGraph({ body: request }, res);
  assert.equal(res.statusCode, 422); assert.match(res.body.error, /PDF 원본/); assert.equal(model.mock.callCount(), 0);
});

test('a deleted atomic object is not revived from a legacy mirror', async t => {
  const { model } = pipeline(t);
  t.mock.method(workspaceSnapshotService, 'load', async () => ({ objects: [] }));
  t.mock.method(mongo, 'getClient', () => { throw Error('must not consult obsolete mirror'); });
  const res = response(); await citationGraph({ body: { ...request, fileId: undefined } }, res);
  assert.equal(res.statusCode, 404); assert.equal(model.mock.callCount(), 0);
});

test('ID-only callers on an unmigrated board still resolve legacy SaveFile IDs', async t => {
  const { read } = pipeline(t);
  t.mock.method(workspaceSnapshotService, 'load', async () => { throw Object.assign(Error('missing'), { status: 404 }); });
  t.mock.method(mongo, 'getClient', () => ({ db: () => ({ collection: () => ({ findOne: async () => ({ _id: 'old-id', fileId: 'legacy-pdf' }) }) }) }));
  const res = response(); await citationGraph({ body: { ...request, fileId: undefined } }, res);
  assert.equal(res.statusCode, 200); assert.equal(read.mock.calls[0].arguments[1], 'legacy-pdf');
});
