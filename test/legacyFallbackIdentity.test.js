const assert = require('node:assert/strict');
const test = require('node:test');
const mongo = require('../src/services/mongo');
const syncKeys = require('../src/services/syncKeys');
const previews = require('../src/services/pdfPreview');

test('legacy updates reconcile only the same paper fallback and retain the persisted UUID', async t => {
  let record;
  let race = false;
  let fallbackWrites = 0;
  const collection = {
    async findOne() { return structuredClone(record); },
    async findOneAndUpdate(query, update) {
      if (query.clientObjectId?.$in) {
        if (!query.clientObjectId.$in.includes(record.clientObjectId)) return null;
      } else {
        fallbackWrites++;
        assert.equal(query.clientObjectId, record.clientObjectId);
        assert.equal(query.type, record.type);
        assert.equal(query.paperName, record.paperName);
        assert.equal(query.copiedOrigianlPaperId, record.copiedOrigianlPaperId);
        if (race) return null;
      }
      Object.assign(record, Object.fromEntries(Object.entries(update.$set).filter(([,value]) => value !== undefined)));
      return structuredClone(record);
    },
  };
  t.mock.method(mongo, 'getClient', () => ({ db: () => ({ collection: () => collection }) }));
  t.mock.method(syncKeys, 'checkKey', () => true);
  t.mock.method(syncKeys, 'rotateKey', () => {});
  t.mock.method(syncKeys, 'debugLog', () => {});
  t.mock.method(previews, 'isPreviewCurrent', () => true);
  const { updateData } = require('../src/controllers/data');
  const request = {
    _projectName: 'test', _id: 'paper-id', clientObjectId: 'paper-id',
    type: 'GX.MAROScientificPaper', paperName: 'Passages: Interacting with Text Across Documents',
    copiedOrigianlPaperId: '', fileId: 'same-pdf-new-alias', pos: { x: 10, y: 20, z: 0 },
    referenceTitleList: null, citationTitleList: null, referenceTextArray: null, highlightTexts: null,
    color: { r: 0, g: 0, b: 0, a: 0 }, ptCurveIds: null, ptArray: null,
  };
  const original = { _id: request._id, clientObjectId: 'original-uuid', type: request.type,
    paperName: request.paperName, copiedOrigianlPaperId: '', fileId: 'original-pdf-alias',
    researchArtifact: { result: { text: 'retained research' } } };
  async function submit(overrides = {}) {
    const response = { status(code) { this.code = code; return this; }, json(value) { this.value = value; } };
    await updateData({ body: { ...request, ...overrides } }, response);
    return response;
  }
  record = structuredClone(original);
  assert.equal((await submit()).code, 200);
  assert.equal(record.clientObjectId, 'original-uuid');
  assert.deepEqual(record.pos, request.pos);
  assert.deepEqual(record.researchArtifact, original.researchArtifact);
  assert.equal(fallbackWrites, 1);
  for (const overrides of [
    { clientObjectId: 'another-uuid' }, { paperName: 'Unrelated paper' },
    { type: 'GX.MARONote' }, { copiedOrigianlPaperId: 'other-copy' },
  ]) {
    record = structuredClone(original);
    const response = await submit(overrides);
    assert.equal(response.code, 409);
    assert.equal(response.value.code, 'object_identity_conflict');
    assert.deepEqual(record, original);
  }
  race = true;
  record = structuredClone(original);
  assert.equal((await submit()).code, 409);
  assert.deepEqual(record, original);
});
