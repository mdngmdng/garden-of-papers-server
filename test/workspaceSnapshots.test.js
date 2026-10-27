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


function setPath(target, path, value) {
  const keys = path.split('.'); let cursor = target;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] ??= {};
  cursor[keys.at(-1)] = structuredClone(value);
}
function getPath(target, path) { return path.split('.').reduce((value, key) => value?.[key], target); }
function unsetPath(target, path) {
  const keys = path.split('.'); let cursor = target;
  for (const key of keys.slice(0, -1)) { cursor = cursor?.[key]; if (!cursor) return; }
  delete cursor[keys.at(-1)];
}
function readState(document) {
  if (document.state) return document.state;
  const { gunzipSync } = require('node:zlib');
  return { ...document.stateMeta, objects: document.objectOrder.map(id => {
    const value = document.objectPayloads[Buffer.from(id).toString('base64url')];
    return JSON.parse(gunzipSync(Buffer.from(value?.buffer && !ArrayBuffer.isView(value) ? value.buffer : value)).toString());
  }) };
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

  async findOne(query, options = {}) {
    if (!this.document || this.document._id !== query._id) return null;
    if (!options.projection) return structuredClone(this.document);
    const result = {};
    for (const [key, include] of Object.entries(options.projection)) {
      if (include && getPath(this.document, key) !== undefined) setPath(result, key, getPath(this.document, key));
    }
    return result;
  }

  async deleteOne(query) {
    if (!this.document || this.document._id !== query._id) {
      return { deletedCount: 0 };
    }
    this.document = null;
    return { deletedCount: 1 };
  }

  async updateOne(query, update) {
    if (this.beforeAtomicUpdate && update.$set) {
      const callback = this.beforeAtomicUpdate; this.beforeAtomicUpdate = null; callback(this);
    }
    if (!this.document) {
      if (!update.$setOnInsert) return { matchedCount: 0 };
      this.document = structuredClone(update.$setOnInsert);
      return { upsertedCount: 1, matchedCount: 0 };
    }
    if (query.revision !== undefined && this.document.revision !== query.revision) return { matchedCount: 0 };
    if (typeof query.stateEncoding === 'string' && this.document.stateEncoding !== query.stateEncoding) return { matchedCount: 0 };
    for (const [key, value] of Object.entries(update.$set || {})) setPath(this.document, key, value);
    for (const key of Object.keys(update.$unset || {})) unsetPath(this.document, key);
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

test('loads only the canonical revision for Wiki freshness checks without decoding the board', async () => {
  const collection = new MemorySnapshotCollection();
  const reads = [];
  collection.findOne = async (query, options) => {
    reads.push({ query, options });
    return query._id === 'garden' ? { revision: 7 } : null;
  };
  const service = createWorkspaceSnapshotService(() => collection);
  assert.equal(await service.loadRevision('garden'), 7);
  assert.deepEqual(reads[0], { query: { _id: 'garden' }, options: { projection: { _id: 0, revision: 1 } } });
  await assert.rejects(service.loadRevision('missing'), { status: 404 });
});

function fixture(onWorkspaceSaved = null) {
  const collection = new MemorySnapshotCollection();
  let timestamp = Date.parse('2026-08-03T00:00:00.000Z');
  const service = createWorkspaceSnapshotService(
    () => collection,
    () => new Date(timestamp += 1_000),
    onWorkspaceSaved,
  );
  return {
    collection,
    service,
  };
}

test('rejects duplicate object ids and changed client identities without saving', async () => {
  const { service } = fixture();
  const initial = workspace();
  initial.objects = [{ id: 'threddy', type: 'GX.MAROScientificPaper', persistenceKey: 'stable-threddy' }];
  await service.ensure(initial);
  const stored = await service.load('garden');
  const bad = structuredClone(initial);
  bad.objects.push({ ...bad.objects[0], persistenceKey: 'other-paper' });
  await assert.rejects(service.save({ projectName: 'garden', baseRevision: 0, mutationId: 'duplicate', state: bad }),
    error => error.code === 'duplicate_object_identity');
  bad.objects = [bad.objects[1]];
  await assert.rejects(service.save({ projectName: 'garden', baseRevision: 0, mutationId: 'identity', state: bad }),
    error => error.code === 'object_identity_conflict');
  await assert.rejects(service.patch({ projectName: 'garden', baseRevision: 0, mutationId: 'patch-identity',
    delta: { camera: initial.camera, upsertedObjects: bad.objects, removedObjectIds: [] } }),
    error => error.code === 'object_identity_conflict');
  await assert.rejects(service.patch({ projectName: 'garden', baseRevision: 0, mutationId: 'patch-duplicates',
    delta: { camera: initial.camera, upsertedObjects: [...initial.objects, ...initial.objects], removedObjectIds: [] } }),
    error => error.code === 'duplicate_object_identity');
  assert.deepEqual(await service.load('garden'), stored);
});

for (const method of ['save', 'patch']) {
  test(`${method} reconciles a legacy row-id fallback and keeps subsequent recovery saves durable`, async () => {
    const { service } = fixture();
    const initial = workspace();
    initial.objects = [{ id: 'paper', type: 'GX.MAROScientificPaper', persistenceKey: 'paper', title: 'texSketch', x: 1 },
      { id: 'note', type: 'GX.MARONote', text: 'keep my note', parentPaperId: 'paper' }];
    await service.ensure(initial);
    const submit = async (object, revision, mutationId) => service[method]({ projectName: 'garden', baseRevision: revision, mutationId,
      state: { ...initial, objects: [object, initial.objects[1]] },
      delta: { camera: initial.camera, upsertedObjects: [object], removedObjectIds: [] } });
    const upgraded = { ...initial.objects[0], persistenceKey: 'original-client-uuid', x: 20 };
    await submit(upgraded, 0, 'first:recovery');
    assert.equal((await service.load('garden')).objects[0].persistenceKey, 'original-client-uuid');
    // A second old tab still sends its fallback key or no key at all.
    for (const [index, key] of ['paper', undefined].entries()) {
      const incoming = { ...upgraded, persistenceKey: key, x: 30 + index };
      await submit(incoming, index + 1, `old-tab-${index}:canonical`);
      const saved = await service.load('garden');
      assert.equal(saved.objects[0].persistenceKey, upgraded.persistenceKey);
      assert.equal(saved.objects[0].x, incoming.x);
      assert.deepEqual(saved.objects[1], initial.objects[1]);
    }
    const before = await service.load('garden');
    for (const object of [
      { ...upgraded, persistenceKey: 'unrelated-uuid' },
      { ...upgraded, persistenceKey: 'paper', title: 'Different paper' },
      { ...upgraded, persistenceKey: 'paper', type: 'GX.MARONote' },
      { ...upgraded, persistenceKey: 'paper', syncSourceId: 'different-instance' },
    ]) {
      await assert.rejects(submit(object, 3, 'must-not-write'), error => error.code === 'object_identity_conflict');
    }
    assert.deepEqual(await service.load('garden'), before);
  });
}

for (const method of ['save', 'patch']) {
  test(`${method} repairs already-stored pasted notes without removing their content`, async () => {
    const { service, collection } = fixture();
    const initial = workspace();
    await service.ensure(initial);
    const notes = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, type: 'GX.MARONote', persistenceKey: 'copied-key', text: `note ${id}` }));
    collection.document.state = { ...initial, objects: structuredClone(notes) };
    delete collection.document.stateEncoding;
    const loaded = await service.load('garden');
    assert.equal(new Set(loaded.objects.map(o => o.persistenceKey)).size, 5);
    const request = { projectName: 'garden', baseRevision: 0, mutationId: 'repair',
      state: { ...initial, objects: notes }, delta: { camera: initial.camera, upsertedObjects: notes, removedObjectIds: [] } };
    await service[method](request);
    // Replaying an old browser's pre-repair payload must keep the same receipt.
    const replayed = await service[method](request);
    assert.equal(replayed.replayed, true);
    const saved = await service.load('garden');
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.objects.map(o => [o.id, o.text]), notes.map(o => [o.id, o.text]));
    assert.equal(new Set(readState(collection.document).objects.map(o => o.persistenceKey)).size, 5);
    assert.equal(saved.objects[0].persistenceKey, 'copied-key');
    assert.equal(saved.objects[1].persistenceKey, 'recovered:b');
    const newCollision = { ...saved, objects: [...saved.objects, { ...saved.objects[0], id: 'new-copy' }] };
    await assert.rejects(service.save({ ...request, baseRevision: 1, mutationId: 'new-collision', state: newCollision }),
      error => error.code === 'duplicate_object_identity');
  });
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
    'protocolVersion',
    'replayed',
    'revision',
    'updatedAt',
  ]);
  assert.equal(result.revision, 1);
  assert.equal(readState(collection.document).camera.x, 42);
  assert.deepEqual(
    readState(collection.document).objects.map(({ id, text }) => [id, text]),
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
    target.document.stateMeta.revision = 1;
    target.document.stateMeta.camera.x = 99;
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
  assert.equal(collection.document.stateEncoding, 'gzip-objects-v1');
  const key = Buffer.from('large-note').toString('base64url');
  assert.ok(collection.document.objectPayloads[key].byteLength < INLINE_SNAPSHOT_BYTES);

  collection.document.objectPayloads[key] = new Binary(collection.document.objectPayloads[key]);
  const restoredFromMongoBinary = await service.load(largeWorkspace.id);
  assert.equal(
    restoredFromMongoBinary.objects[0].text,
    largeWorkspace.objects[0].text,
  );
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
  assert.deepEqual(readState(collection.document).objects, []);

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
  assert.deepEqual(readState(collection.document).objects, []);
});

test('full and delta saves preserve request arrays omitted by old writers; explicit clearing remains reversible', async () => {
  const collection = new MemorySnapshotCollection(); const service = createWorkspaceSnapshotService(() => collection);
  const initial = workspace();
  initial.objects = [{ id: 'note', type: 'GX.MARONote', claimEvidence: { version: 1, links: [], candidates: [], requests: [{ id: 'request' }] } }];
  await service.ensure(initial);
  const old = structuredClone(initial); delete old.objects[0].claimEvidence.requests;
  const full = await service.save({ projectName: 'garden', baseRevision: 0, mutationId: 'old-full', state: old });
  assert.deepEqual(full.state.objects[0].claimEvidence.requests, [{ id: 'request' }]);
  await service.patch({ projectName: 'garden', baseRevision: 1, mutationId: 'old-patch', delta: { camera: old.camera, upsertedObjects: old.objects, removedObjectIds: [] } });
  const kept = await service.load('garden'); assert.deepEqual(kept.objects[0].claimEvidence.requests, [{ id: 'request' }]);
  kept.objects[0].claimEvidence.requests = [];
  const cleared = await service.save({ projectName: 'garden', baseRevision: 2, mutationId: 'current-clear', state: kept });
  assert.deepEqual(cleared.state.objects[0].claimEvidence.requests, []);
});

test('ordinary field sync reads only touched object payloads and returns a compact receipt', async () => {
  let wikiRebuilds = 0;
  const { service, collection } = fixture(() => { wikiRebuilds++; });
  const initial = workspace();
  initial.objects = ['changed', 'untouched'].map(id => ({ id, persistenceKey: id, type: 'GX.MARONote', x: 0,
    text: 'A large document body'.repeat(100_000) }));
  await service.ensure(initial);
  const key = Buffer.from('untouched').toString('base64url');
  const payload = collection.document.objectPayloads[key];
  collection.document.objectPayloads[key] = Buffer.from('cannot be decompressed');
  const reads = [], writes = [];
  const find = collection.findOne.bind(collection), update = collection.updateOne.bind(collection);
  collection.findOne = (query, options) => { reads.push(options); return find(query, options); };
  collection.updateOne = (query, operation) => { writes.push(operation); return update(query, operation); };
  const receipt = await service.patch({ projectName: 'garden', baseRevision: 0, mutationId: 'move:1',
    delta: { camera: initial.camera, upsertedObjects: [], removedObjectIds: [],
      patchedObjects: [{ id: 'changed', changes: { x: 100 }, removedKeys: [] }] } });
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 120);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].projection.objectPayloads, undefined);
  assert.equal(reads[0].projection['objectPayloads.' + key], undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].$set.objectPayloads, undefined);
  assert.ok(writes[0].$set['objectPayloads.' + Buffer.from('changed').toString('base64url')]);
  await Promise.resolve();
  assert.equal(wikiRebuilds, 0);
  collection.document.objectPayloads[key] = payload;
  const loaded = await service.load('garden');
  assert.equal(loaded.objects[0].x, 100);
  assert.equal(loaded.objects[1].text, initial.objects[1].text);
});

test('a lost acknowledgement can be retried after a later commit without applying the old edit twice', async () => {
  const { service, collection } = fixture();
  const initial = workspace();
  initial.objects = [{ id: 'note', type: 'GX.MARONote', text: 'keep', x: 0 }];
  await service.ensure(initial);
  const first = { projectName: 'garden', baseRevision: 0, mutationId: 'writer:1',
    delta: { camera: initial.camera, upsertedObjects: [], removedObjectIds: [],
      patchedObjects: [{ id: 'note', changes: { x: 1 }, removedKeys: [] }] } };
  await service.patch(first);
  await service.patch({ ...first, baseRevision: 1, mutationId: 'writer:2',
    delta: { ...first.delta, patchedObjects: [{ id: 'note', changes: { x: 2 }, removedKeys: [] }] } });
  const replay = await service.patch(first);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 1);
  assert.equal(collection.document.revision, 2);
  assert.equal((await service.load('garden')).objects[0].x, 2);
  await assert.rejects(service.patch({ ...first, delta: { ...first.delta, camera: { x: 9, y: 0, scale: 1 } } }),
    error => error.code === 'mutation_mismatch');
});

test('a racing delta commits no object changes when its revision check fails', async () => {
  const { service, collection } = fixture();
  const initial = workspace();
  await service.ensure(initial);
  collection.beforeAtomicUpdate = current => {
    current.document.revision = 1;
    current.document.stateMeta.revision = 1;
  };
  await assert.rejects(service.patch({ projectName: 'garden', baseRevision: 0, mutationId: 'race',
    delta: { camera: initial.camera, upsertedObjects: [{ id: 'must-not-exist', type: 'GX.MARONote', text: 'new' }], removedObjectIds: [] } }),
    error => error.code === 'revision_conflict');
  assert.deepEqual((await service.load('garden')).objects, []);
  assert.deepEqual(collection.document.objectPayloads, {});
});

test('legacy inline snapshots migrate once and subsequent saves stay incremental', async () => {
  const { service, collection } = fixture();
  const initial = workspace();
  initial.objects = [{ id: 'note', type: 'GX.MARONote', text: 'original' }];
  collection.document = { _id: 'garden', ownerName: 'tester', revision: 0, state: initial,
    projectName: 'garden', updatedAt: new Date(initial.updatedAt) };
  assert.equal((await service.load('garden')).objects[0].text, 'original');
  assert.equal(collection.document.stateEncoding, 'gzip-objects-v1');
  assert.equal(collection.document.state, undefined);
  const find = collection.findOne.bind(collection);
  collection.findOne = (query, options) => {
    assert.ok(options?.projection, 'a normal delta must never read the entire board');
    return find(query, options);
  };
  await service.patch({ projectName: 'garden', baseRevision: 0, mutationId: 'after-migration',
    delta: { camera: initial.camera, upsertedObjects: [], removedObjectIds: [],
      patchedObjects: [{ id: 'note', changes: { text: 'new' }, removedKeys: [] }] } });
});

test('removes the canonical workspace and reports an already-removed project', async () => {
  const { service, collection } = fixture();
  await service.ensure(workspace());
  assert.equal(collection.document._id, 'garden');
  assert.deepEqual(await service.remove('garden'), { deleted: true, projectName: 'garden', ownerName: 'tester' });
  assert.equal(collection.document, null);
  await assert.rejects(service.load('garden'), { status: 404 });
  assert.deepEqual(await service.remove('garden'), { deleted: false, projectName: 'garden', ownerName: '' });
});
