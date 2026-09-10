const assert = require('node:assert/strict');
const test = require('node:test');
const mongo = require('../src/services/mongo');
const syncKeys = require('../src/services/syncKeys');

test('legacy paper updates retain the outline analysis independently of removable sheets', async t => {
  const record = { _id: 'paper', type: 'GX.MAROScientificPaper' };
  const collection = { async findOneAndUpdate(query, update) {
    assert.equal(query._id, 'paper');
    Object.assign(record, Object.fromEntries(Object.entries(update.$set).filter(([, value]) => value !== undefined)));
    return record;
  } };
  t.mock.method(mongo, 'getClient', () => ({ db(name) {
    assert.equal(name, 'retention-test');
    return { collection: () => collection };
  } }));
  t.mock.method(syncKeys, 'checkKey', () => true);
  t.mock.method(syncKeys, 'rotateKey', () => {});
  t.mock.method(syncKeys, 'debugLog', () => {});
  const { updateData } = require('../src/controllers/data');
  const artifact = { version: 1, purpose: 'research-document', requestId: 'original-request', status: 'ready',
    sources: [{ paperId: 'paper', pdfKey: 'file:original' }], result: { researchDocument: { title: 'Retained outline' } } };
  const body = { _projectName: 'retention-test', _id: 'paper', type: record.type, pos: { x: 10, y: 20, z: 0 }, researchArtifact: artifact,
    referenceTitleList: null, citationTitleList: null, referenceTextArray: null, highlightTexts: null,
    color: { r: 0, g: 0, b: 0, a: 0 }, ptCurveIds: null, ptArray: null };
  const response = { status(code) { assert.equal(code, 200); return this; }, json(value) { this.value = value; } };
  await updateData({ body }, response);
  assert.deepEqual(record.researchArtifact, artifact);
  // Older clients and ordinary paper moves do not erase the retained analysis.
  delete body.researchArtifact;
  body.pos = { x: 30, y: 40, z: 0 };
  await updateData({ body }, response);
  assert.deepEqual(record.researchArtifact, artifact);
  assert.deepEqual(record.pos, body.pos);
});
