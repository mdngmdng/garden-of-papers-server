const assert = require('node:assert/strict');
const test = require('node:test');
const { gzipSync, gunzipSync } = require('node:zlib');
const { planRepair } = require('../scripts/repair-workspace-identities');

test('identity migration preserves all contents, references and freshness timestamps', () => {
  const state = { revision: 851, updatedAt: '2026-09-08T06:02:26Z', objects: [
    { id: 'a', type: 'GX.MARONote', persistenceKey: 'same', text: 'original' },
    { id: 'b', type: 'GX.MARONote', persistenceKey: 'same', text: 'edited copy', parentPaperId: 'paper' },
  ] };
  const document = { revision: 851, stateEncoding: 'gzip-json-v1', statePayload: gzipSync(Buffer.from(JSON.stringify(state))) };
  const rows = state.objects.map(o => ({ _id: o.id, type: o.type, clientObjectId: o.persistenceKey, textValue: o.text }));
  rows.push({ _id: 'thread', type: 'GX.MAROBlankPaper', textValue: 'new unsynced conversation' });
  const plan = planRepair(document, rows);
  assert.deepEqual(plan.snapshotChanges, [{ id: 'b', before: 'same', after: 'recovered:b' }]);
  assert.deepEqual(plan.legacyChanges, plan.snapshotChanges);
  assert.equal(plan.state.updatedAt, state.updatedAt);
  assert.deepEqual(plan.state.objects[1], { ...state.objects[1], persistenceKey: 'recovered:b' });
  assert.deepEqual(JSON.parse(gunzipSync(document.statePayload)), state);
  assert.equal(rows[1].clientObjectId, 'same');
  assert.equal(rows[2].textValue, 'new unsynced conversation');
});
