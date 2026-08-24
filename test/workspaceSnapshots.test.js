const assert = require('node:assert/strict');
const test = require('node:test');
const { Binary } = require('mongodb');
const {
  INLINE_SNAPSHOT_BYTES,
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
    for (const key of Object.keys(update.$unset || {})) {
      delete this.document[key];
    }
    return structuredClone(this.document);
  }
}

function fixture(onWorkspaceSaved = null) {
  const collection = new MemorySnapshotCollection();
  let timestamp = Date.parse('2026-08-03T00:00:00.000Z');
  const service = createWorkspaceSnapshotService(
    () => collection,
    () => new Date(timestamp += 1_000),
    onWorkspaceSaved,
  );
  return { collection, service };
}

test('triggers Wiki synchronization from every successful canonical save', async () => {
  const synchronized = [];
  const { service } = fixture(async (state) => synchronized.push(state));
  await service.ensure(workspace());
  const edited = workspace();
  edited.objects.push({ id: 'note-1', type: 'GX.MARONote', text: 'saved' });

  await service.save({
    projectName: 'garden',
    baseRevision: 0,
    mutationId: 'writer:wiki-sync',
    state: edited,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(synchronized.length, 1);
  assert.equal(synchronized[0].revision, 1);
  assert.equal(synchronized[0].objects[0].text, 'saved');
});

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

test('applies compact workspace deltas without returning the whole board', async () => {
  const { collection, service } = fixture();
  const initial = workspace();
  initial.objects = [
    { id: 'note-1', type: 'GX.MARONote', text: 'old' },
    { id: 'note-removed', type: 'GX.MARONote', text: 'remove me' },
  ];
  await service.ensure(initial);

  const result = await service.patch({
    projectName: 'garden',
    baseRevision: 0,
    mutationId: 'writer:delta-1',
    delta: {
      schemaVersion: 3,
      camera: { x: 42, y: 10, scale: 0.5 },
      upsertedObjects: [
        { id: 'note-1', type: 'GX.MARONote', text: 'new' },
        { id: 'note-2', type: 'GX.MARONote', text: 'added' },
      ],
      removedObjectIds: ['note-removed'],
    },
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'replayed',
    'revision',
    'updatedAt',
  ]);
  assert.equal(result.revision, 1);
  assert.equal(collection.document.state.camera.x, 42);
  assert.deepEqual(
    collection.document.state.objects.map(({ id, text }) => [id, text]),
    [['note-1', 'new'], ['note-2', 'added']],
  );
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

test('compresses and restores boards that exceed the safe inline Mongo size', async () => {
  const { collection, service } = fixture();
  const largeWorkspace = workspace();
  largeWorkspace.objects.push({
    id: 'large-note',
    type: 'GX.MARONote',
    text: 'large-board-content'.repeat(
      Math.ceil((INLINE_SNAPSHOT_BYTES + 1024) / 19),
    ),
  });

  const saved = await service.ensure(largeWorkspace);

  assert.equal(saved.objects[0].text, largeWorkspace.objects[0].text);
  assert.equal(collection.document.state, undefined);
  assert.equal(collection.document.stateEncoding, 'gzip-json-v1');
  assert.ok(collection.document.statePayload.byteLength < INLINE_SNAPSHOT_BYTES);

  collection.document.statePayload = new Binary(
    collection.document.statePayload,
  );
  const restoredFromMongoBinary = await service.load(largeWorkspace.id);
  assert.equal(
    restoredFromMongoBinary.objects[0].text,
    largeWorkspace.objects[0].text,
  );
});
