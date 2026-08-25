const assert = require('node:assert/strict');
const test = require('node:test');
const { Binary } = require('mongodb');
const {
  INLINE_SNAPSHOT_BYTES,
  SNAPSHOT_HISTORY_LIMIT,
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

class MemoryHistoryCollection {
  constructor() {
    this.documents = new Map();
  }

  async createIndex() {
    return 'workspace_history_index';
  }

  async updateOne(query, update) {
    if (update.$set) {
      const matched = this.documents.has(query._id);
      this.documents.set(query._id, structuredClone(update.$set));
      return {
        upsertedCount: matched ? 0 : 1,
        matchedCount: matched ? 1 : 0,
      };
    }
    if (!this.documents.has(query._id)) {
      this.documents.set(
        query._id,
        structuredClone(update.$setOnInsert),
      );
      return { upsertedCount: 1, matchedCount: 0 };
    }
    return { upsertedCount: 0, matchedCount: 1 };
  }

  async findOne(query) {
    const document = this.documents.get(query._id);
    if (!document || (
      query.projectName && document.projectName !== query.projectName
    ) || (query.reason && document.reason !== query.reason)) {
      return null;
    }
    return structuredClone(document);
  }

  find(query) {
    const allowedIds = new Set(query._id?.$in ?? []);
    let rows = [...this.documents.values()]
      .filter((row) => (
        (!query.projectName || row.projectName === query.projectName)
        && (!query.reason || row.reason === query.reason)
        && (!allowedIds.size || allowedIds.has(row._id))
      ))
      .map((row) => structuredClone(row));
    let skip = 0;
    let limit = Number.POSITIVE_INFINITY;
    return {
      sort(specification) {
        const direction = specification.revision ?? specification.savedAt ?? -1;
        const field = specification.revision ? 'revision' : 'savedAt';
        rows.sort((left, right) => {
          const leftValue = field === 'savedAt'
            ? new Date(left.savedAt).getTime()
            : left.revision;
          const rightValue = field === 'savedAt'
            ? new Date(right.savedAt).getTime()
            : right.revision;
          return (leftValue - rightValue) * direction;
        });
        return this;
      },
      skip(value) {
        skip = value;
        return this;
      },
      limit(value) {
        limit = value;
        return this;
      },
      async toArray() {
        return rows.slice(skip, skip + limit);
      },
    };
  }

  async deleteMany(query) {
    const ids = new Set(query._id?.$in ?? []);
    const revisionSets = (query.$or ?? [])
      .flatMap((condition) => [
        ...((condition.fromRevision?.$in ?? []).map((revision) => ({
          field: 'fromRevision',
          revision,
        }))),
        ...((condition.toRevision?.$in ?? []).map((revision) => ({
          field: 'toRevision',
          revision,
        }))),
      ]);
    let deletedCount = 0;
    for (const [id, document] of this.documents) {
      const deleteById = ids.has(id);
      const deleteByRevision = (
        !query.projectName || document.projectName === query.projectName
      ) && revisionSets.some(
        ({ field, revision }) => document[field] === revision,
      );
      if ((deleteById || deleteByRevision) && this.documents.delete(id)) {
        deletedCount += 1;
      }
    }
    return { deletedCount };
  }
}

function fixture(onWorkspaceSaved = null) {
  const collection = new MemorySnapshotCollection();
  const historyCollection = new MemoryHistoryCollection();
  const historyDeltaCollection = new MemoryHistoryCollection();
  let timestamp = Date.parse('2026-08-03T00:00:00.000Z');
  const service = createWorkspaceSnapshotService(
    () => collection,
    () => new Date(timestamp += 1_000),
    onWorkspaceSaved,
    () => historyCollection,
    () => historyDeltaCollection,
  );
  return {
    collection,
    historyCollection,
    historyDeltaCollection,
    service,
  };
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

test('keeps autosaves live while retaining only the latest ten manual snapshots', async () => {
  const { historyCollection, historyDeltaCollection, service } = fixture();
  let state = await service.ensure(workspace());
  for (let index = 0; index < SNAPSHOT_HISTORY_LIMIT + 3; index += 1) {
    state.camera.x = index + 1;
    const saved = await service.save({
      projectName: 'garden',
      baseRevision: state.revision,
      mutationId: `writer:history-${index}`,
      state,
    });
    state = saved.state;
    await service.createHistorySnapshot('garden');
  }

  const history = await service.listHistory('garden');
  assert.equal(history.entries.length, SNAPSHOT_HISTORY_LIMIT + 1);
  assert.equal(history.entries[0].reason, 'current');
  assert.deepEqual(
    history.entries.slice(1).map((entry) => entry.revision),
    [13, 12, 11, 10, 9, 8, 7, 6, 5, 4],
  );
  assert.equal(historyCollection.documents.size, SNAPSHOT_HISTORY_LIMIT);
  assert.equal(
    historyDeltaCollection.documents.size,
    SNAPSHOT_HISTORY_LIMIT - 1,
  );
});

test('does not create history snapshots during ordinary autosaves', async () => {
  const { historyCollection, service } = fixture();
  let state = await service.ensure(workspace());
  state.camera.x = 12;
  state = (await service.save({
    projectName: 'garden',
    baseRevision: state.revision,
    mutationId: 'writer:autosave-only',
    state,
  })).state;

  const history = await service.listHistory('garden');
  assert.equal(state.revision, 1);
  assert.deepEqual(history.entries.map((entry) => entry.reason), ['current']);
  assert.equal(historyCollection.documents.size, 0);
});

test('rejects retired freehand curves from canonical saves and delta updates', async () => {
  const { collection, service } = fixture();
  const initial = workspace();
  initial.objects = [{
    id: 'legacy-stroke',
    type: 'GX.MAROPtCurve',
    points: [{ x: 10, y: 20 }],
  }];

  const ensured = await service.ensure(initial);
  assert.deepEqual(ensured.objects, []);
  assert.deepEqual(collection.document.state.objects, []);

  await service.patch({
    projectName: 'garden',
    baseRevision: ensured.revision,
    mutationId: 'writer:retired-stroke',
    delta: {
      schemaVersion: 1,
      camera: ensured.camera,
      upsertedObjects: [{
        id: 'new-stroke',
        type: 'GX.MAROPtCurve',
        points: [{ x: 30, y: 40 }],
      }],
      removedObjectIds: [],
    },
  });

  const loaded = await service.load('garden');
  assert.deepEqual(loaded.objects, []);
  assert.deepEqual(collection.document.state.objects, []);
});

test('keeps distinct manual snapshots created at the same live revision', async () => {
  const { historyCollection, service } = fixture();
  await service.ensure(workspace());
  await service.createHistorySnapshot('garden', 'first-branch');
  await service.createHistorySnapshot('garden', 'second-branch');

  const history = await service.listHistory('garden');
  assert.deepEqual(
    history.entries.slice(1).map((entry) => entry.id),
    ['garden:manual:second-branch', 'garden:manual:first-branch'],
  );
  assert.deepEqual(
    history.entries.slice(0, 2).map((entry) => entry.diffFromPrevious),
    [
      { created: 0, deleted: 0, moved: 0, updated: 0 },
      { created: 0, deleted: 0, moved: 0, updated: 0 },
    ],
  );
  assert.equal(historyCollection.documents.size, 2);
});

test('precomputes reversible object deltas for timeline scrubbing', async () => {
  const { service } = fixture();
  let state = workspace();
  state.objects = [{
    id: 'note-1',
    type: 'GX.MARONote',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 1,
    text: 'same',
    updatedAt: '2026-08-03T00:00:00.000Z',
  }];
  state = await service.ensure(state);
  await service.createHistorySnapshot('garden');
  state.objects[0].x = 40;
  state.objects[0].updatedAt = '2026-08-03T00:00:01.000Z';
  state.objects.push({
    id: 'note-2',
    type: 'GX.MARONote',
    x: 120,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 2,
    text: 'new',
    updatedAt: '2026-08-03T00:00:01.000Z',
  });
  state = (await service.save({
    projectName: 'garden',
    baseRevision: state.revision,
    mutationId: 'writer:diff',
    state,
  })).state;
  await service.createHistorySnapshot('garden');

  const history = await service.listHistory('garden');
  const revisionOne = history.entries.find(
    (entry) => entry.revision === 1 && entry.reason === 'manual',
  );
  assert.deepEqual(revisionOne.diffFromPrevious, {
    created: 1,
    deleted: 0,
    moved: 1,
    updated: 0,
  });
  assert.equal(revisionOne.previousRevision, 0);
  assert.equal(revisionOne.transitionFromPrevious, undefined);
  assert.equal(revisionOne.transitionToPrevious, undefined);
  const transition = await service.getHistoryTransition('garden', 0, 1);
  assert.deepEqual(
    transition.forward.upsertedObjects.map((object) => object.id),
    ['note-2'],
  );
  assert.deepEqual(transition.forward.patchedObjects, [{
    id: 'note-1',
    changes: {
      x: 40,
      updatedAt: '2026-08-03T00:00:01.000Z',
    },
    removedKeys: [],
  }]);
  assert.deepEqual(transition.backward.removedObjectIds, ['note-2']);
  assert.equal(transition.backward.patchedObjects[0].changes.x, 0);
});

test('restores a manual snapshot as a new live revision', async () => {
  const { service } = fixture();
  let state = await service.ensure(workspace());
  state.camera.x = 10;
  state = (await service.save({
    projectName: 'garden',
    baseRevision: 0,
    mutationId: 'writer:first',
    state,
  })).state;
  await service.createHistorySnapshot('garden');
  state.camera.x = 99;
  state = (await service.save({
    projectName: 'garden',
    baseRevision: 1,
    mutationId: 'writer:second',
    state,
  })).state;
  const before = await service.listHistory('garden');
  const revisionOne = before.entries.find(
    (entry) => entry.revision === 1 && entry.reason === 'manual',
  );

  const restored = await service.restoreHistory({
    projectName: 'garden',
    historyId: revisionOne.id,
    baseRevision: 2,
    mutationId: 'writer:restore',
  });

  assert.equal(restored.state.revision, 3);
  assert.equal(restored.state.camera.x, 10);
  const after = await service.listHistory('garden');
  assert.equal(after.entries[0].revision, 3);
  assert.equal(after.entries[0].reason, 'current');
  assert.equal(after.entries[0].restoredFromRevision, null);
  assert.deepEqual(
    after.entries.slice(1).map((entry) => entry.revision),
    [1],
  );
});
