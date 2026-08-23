const assert = require('node:assert/strict');
const test = require('node:test');
const { ObjectId } = require('mongodb');
const {
  createWorkspaceFreshnessService,
} = require('../src/services/workspaceFreshness');

test('reports when a legacy workspace mirror is newer than its atomic snapshot', async () => {
  const newestLegacyId = ObjectId.createFromTime(
    Math.floor(Date.parse('2026-08-23T07:34:48.000Z') / 1_000),
  );
  const snapshots = {
    async findOne() {
      return {
        revision: 12,
        updatedAt: new Date('2026-08-21T16:29:59.797Z'),
        lastMutationId: 'writer:12:canonical',
      };
    },
  };
  const legacy = {
    async findOne(query) {
      if (query._gopUpdatedAt) return null;
      return { _id: newestLegacyId };
    },
  };
  const service = createWorkspaceFreshnessService(() => ({
    snapshots,
    legacy: () => legacy,
  }));

  const status = await service.sourceStatus('LLMWiki');

  assert.equal(status.atomicRevision, 12);
  assert.equal(status.atomicStage, 'canonical');
  assert.equal(status.atomicUpdatedAt, '2026-08-21T16:29:59.797Z');
  assert.equal(status.legacyUpdatedAt, '2026-08-23T07:34:48.000Z');
});
