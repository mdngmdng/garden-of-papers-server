const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WorkspaceSnapshotError,
  createWorkspaceSnapshotService,
} = require('../src/services/workspaceSnapshots');

function workspace() {
  return {
    schemaVersion: 1,
    id: 'garden',
    ownerName: 'tester',
    projectName: 'garden',
    camera: { x: 0, y: 0, scale: 1 },
    objects: [],
    revision: 0,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

class MemorySnapshotCollection {
  constructor() {
    this.document = null;
    this.beforeAtomicUpdate = null;
  }

  async createIndex() {
    return 'workspace_snapshots_owner_updated';
  }

  find(query) {
    const rows = this.document?.ownerName === query.ownerName
      ? [structuredClone(this.document)]
      : [];
    return {
      sort() {
        return this;
      },
      async toArray() {
        return rows;
      },
    };
  }

  async findOne(query) {
    if (!this.document || this.document._id !== query._id) return null;
    return structuredClone(this.document);
  }

  async updateOne(query, update) {
    if (!this.document) {
      this.document = structuredClone(update.$setOnInsert);
      return { upsertedCount: 1, matchedCount: 0 };
    }
    return { upsertedCount: 0, matchedCount: 1 };
  }

  async findOneAndUpdate(query, update) {
    if (this.beforeAtomicUpdate) {
      const callback = this.beforeAtomicUpdate;
      this.beforeAtomicUpdate = null;
      callback(this);
    }
    if (
      !this.document
      || this.document._id !== query._id
      || this.document.revision !== query.revision
    ) {
      return null;
    }
    Object.assign(this.document, structuredClone(update.$set));
    return structuredClone(this.document);
  }
}

function fixture() {
  const collection = new MemorySnapshotCollection();
  let timestamp = Date.parse('2026-08-03T00:00:00.000Z');
  const service = createWorkspaceSnapshotService(
    () => collection,
    () => new Date(timestamp += 1_000),
  );
  return { collection, service };
}

test('stores and updates a whole workspace as one revisioned document', async () => {
  const { collection, service } = fixture();
  const initial = await service.ensure(workspace());
  assert.equal(initial.revision, 0);

  const edited = workspace();
  edited.camera.x = 42;
  const saved = await service.save({
    projectName: 'garden',
    baseRevision: 0,
    mutationId: 'writer:1',
    state: edited,
  });

  assert.equal(saved.replayed, false);
  assert.equal(saved.state.revision, 1);
  assert.equal(saved.state.camera.x, 42);
  assert.equal(collection.document.revision, 1);
  assert.equal(collection.document.lastMutationId, 'writer:1');
});

test('replays a duplicate mutation without incrementing the revision', async () => {
  const { collection, service } = fixture();
  await service.ensure(workspace());
  const request = {
    projectName: 'garden',
    baseRevision: 0,
    mutationId: 'writer:1',
    state: workspace(),
  };

  await service.save(request);
  const replay = await service.save(request);

  assert.equal(replay.replayed, true);
  assert.equal(replay.state.revision, 1);
  assert.equal(collection.document.revision, 1);
});

test('returns the latest state instead of overwriting a stale revision', async () => {
  const { service } = fixture();
  await service.ensure(workspace());
  await service.save({
    projectName: 'garden',
    baseRevision: 0,
    mutationId: 'other:1',
    state: workspace(),
  });

  await assert.rejects(
    service.save({
      projectName: 'garden',
      baseRevision: 0,
      mutationId: 'writer:1',
      state: workspace(),
    }),
    (error) => {
      assert.ok(error instanceof WorkspaceSnapshotError);
      assert.equal(error.status, 409);
      assert.equal(error.latestState.revision, 1);
      return true;
    },
  );
});

test('the conditional Mongo update rejects a save that races after its read', async () => {
  const { collection, service } = fixture();
  await service.ensure(workspace());
  collection.beforeAtomicUpdate = (target) => {
    target.document.revision = 1;
    target.document.state.revision = 1;
    target.document.state.camera.x = 99;
    target.document.lastMutationId = 'other:1';
  };

  await assert.rejects(
    service.save({
      projectName: 'garden',
      baseRevision: 0,
      mutationId: 'writer:1',
      state: workspace(),
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.latestState.camera.x, 99);
      return true;
    },
  );
});

test('lists snapshot-backed projects for offline-safe discovery', async () => {
  const { service } = fixture();
  await service.ensure(workspace());

  const projects = await service.list('tester');

  assert.deepEqual(projects.map((project) => project.projectName), ['garden']);
});
