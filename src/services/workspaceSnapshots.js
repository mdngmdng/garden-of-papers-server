const { preserveEvidenceRequests } = require('./evidenceRequestCompatibility');
const { repairDuplicatePersistenceKeys, repairLegacyIncomingKeys, compatibleFallbackPaperIdentity } = require('./persistenceIdentity');
const { getClient } = require('./mongo');
const { gzipSync, gunzipSync } = require('node:zlib');

const SNAPSHOT_DATABASE = 'GardenOfPapersSystem';
const SNAPSHOT_COLLECTION = 'WorkspaceSnapshots';
const INLINE_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024;
const MAX_STORED_SNAPSHOT_BYTES = 14 * 1024 * 1024;
const SNAPSHOT_ENCODING = 'gzip-json-v1';
const RETIRED_SKETCH_TYPE = 'GX.MAROPtCurve';
const OBJECT_ENCODING = 'gzip-objects-v1';
const objectKey = id => Buffer.from(id, 'utf8').toString('base64url');

function withoutRetiredSketches(state) {
  if (!state || !Array.isArray(state.objects)) return state;
  const objects = state.objects.filter(
    (object) => object?.type !== RETIRED_SKETCH_TYPE,
  );
  return objects.length === state.objects.length
    ? state
    : { ...state, objects };
}

class WorkspaceSnapshotError extends Error {
  constructor(message, status, code, latestState) {
    super(message);
    this.name = 'WorkspaceSnapshotError';
    this.status = status;
    this.code = code;
    this.latestState = latestState;
  }
}

function defaultCollection() {
  const client = getClient();
  if (!client) {
    throw new WorkspaceSnapshotError(
      'MongoDB is not connected',
      503,
      'database_unavailable',
    );
  }
  return client.db(SNAPSHOT_DATABASE).collection(SNAPSHOT_COLLECTION);
}

function requiredString(value, name, maxLength = 256) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) {
    throw new WorkspaceSnapshotError(
      `${name} is invalid`,
      400,
      'invalid_request',
    );
  }
  return normalized;
}

function validateState(state, expectedProjectName) {
  state = withoutRetiredSketches(state);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new WorkspaceSnapshotError(
      'state is required',
      400,
      'invalid_request',
    );
  }
  const projectName = requiredString(state.projectName, 'state.projectName');
  const ownerName = requiredString(state.ownerName, 'state.ownerName');
  const id = requiredString(state.id, 'state.id');
  if (projectName !== expectedProjectName || id !== expectedProjectName) {
    throw new WorkspaceSnapshotError(
      'Workspace identity does not match the request',
      400,
      'invalid_request',
    );
  }
  if (!Array.isArray(state.objects) || !state.camera) {
    throw new WorkspaceSnapshotError(
      'Workspace state is incomplete',
      400,
      'invalid_request',
    );
  }
  validateObjectIdentities(state.objects);
  const serializedState = JSON.stringify(state);
  const bytes = Buffer.byteLength(serializedState, 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new WorkspaceSnapshotError(
      'Workspace snapshot is too large',
      413,
      'snapshot_too_large',
    );
  }
  return { projectName, ownerName, serializedState };
}

function validateObjectIdentities(objects, previousObjects = []) {
  const ids = new Set();
  const identities = new Set();
  const previous = new Map(previousObjects.map((object) => [object.id, object]));
  for (const object of objects) {
    const id = requiredString(object?.id, 'object.id');
    const identity = object.persistenceKey && `${object.type}:${object.persistenceKey}`;
    if (ids.has(id) || (identity && identities.has(identity))) {
      throw new WorkspaceSnapshotError('Duplicate workspace object identity', 400, 'duplicate_object_identity');
    }
    const existing = previous.get(id);
    if (existing?.persistenceKey && object.persistenceKey &&
        (existing.persistenceKey !== object.persistenceKey || existing.type !== object.type) &&
        !compatibleFallbackPaperIdentity(object, existing)) {
      throw new WorkspaceSnapshotError('Workspace object identity changed', 409, 'object_identity_conflict');
    }
    ids.add(id);
    if (identity) identities.add(identity);
  }
}

function decodeStoredState(document) {
  if (document?.stateEncoding === OBJECT_ENCODING) {
    return withoutRetiredSketches({ ...document.stateMeta, objects: document.objectOrder.map(id => {
      const payload = document.objectPayloads?.[objectKey(id)];
      if (!payload) throw new WorkspaceSnapshotError('Workspace object is missing', 503, 'object_missing');
      return JSON.parse(gunzipSync(storedPayloadBuffer(payload)).toString('utf8'));
    }) });
  }
  if (document?.stateEncoding === SNAPSHOT_ENCODING && document.statePayload) {
    const payload = document.statePayload;
    const bytes = Buffer.isBuffer(payload)
      ? payload
      : ArrayBuffer.isView(payload)
        ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
        : ArrayBuffer.isView(payload.buffer)
          ? Buffer.from(
              payload.buffer.buffer,
              payload.buffer.byteOffset,
              payload.buffer.byteLength,
            )
          : Buffer.from(payload.buffer);
    return withoutRetiredSketches(
      JSON.parse(gunzipSync(bytes).toString('utf8')),
    );
  }
  return withoutRetiredSketches(document?.state ?? null);
}

function publicState(document) {
  const state = decodeStoredState(document);
  return state ? { ...state, objects: repairDuplicatePersistenceKeys(state.objects) } : state;
}

function encodeObject(object) {
  const json = JSON.stringify(object);
  const payload = gzipSync(Buffer.from(json), { level: 6 });
  return { payload, meta: { id: object.id, type: object.type, persistenceKey: object.persistenceKey || '',
    bytes: payload.byteLength, jsonBytes: Buffer.byteLength(json) } };
}

function checkObjectStorage(meta, stateMeta, order) {
  const overhead = Buffer.byteLength(JSON.stringify([meta, stateMeta, order])) + order.reduce((n, id) => n + objectKey(id).length + 32, 0);
  if (Object.values(meta).reduce((n, value) => n + value.bytes, overhead) > MAX_STORED_SNAPSHOT_BYTES ||
      Object.values(meta).reduce((n, value) => n + value.jsonBytes, 0) > MAX_SNAPSHOT_BYTES) {
    throw new WorkspaceSnapshotError('Workspace snapshot is too large', 413, 'snapshot_too_large');
  }
}

function stateStorageFields(state, _serializedState, priorMeta = {}) {
  state = withoutRetiredSketches(state);
  const { objects, ...stateMeta } = state;
  const objectOrder = objects.map(object => object.id);
  const objectPayloads = {}, objectMeta = {};
  for (const object of objects) {
    const encoded = encodeObject(object), key = objectKey(object.id);
    objectPayloads[key] = encoded.payload;
    objectMeta[key] = { ...encoded.meta, ...(priorMeta[key]?.legacyPersistenceKey ? { legacyPersistenceKey: priorMeta[key].legacyPersistenceKey } : {}) };
  }
  checkObjectStorage(objectMeta, stateMeta, objectOrder);
  return { set: { stateEncoding: OBJECT_ENCODING, stateMeta, objectOrder, objectPayloads, objectMeta },
    unset: { state: '', statePayload: '' } };
}

function repairIncomingObjects(incoming, document, previous) {
  const compatible = incoming.map(object => {
    const meta = document.objectMeta?.[objectKey(object.id)];
    return meta?.legacyPersistenceKey && object.persistenceKey === meta.legacyPersistenceKey && object.type === meta.type
      ? { ...object, persistenceKey: meta.persistenceKey } : object;
  });
  return repairLegacyIncomingKeys(compatible, previous);
}

function storedPayloadBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (ArrayBuffer.isView(payload?.buffer)) {
    return Buffer.from(
      payload.buffer.buffer,
      payload.buffer.byteOffset,
      payload.buffer.byteLength,
    );
  }
  return Buffer.from(payload?.buffer || payload);
}

function summarizeState(state) {
  state = withoutRetiredSketches(state);
  const counts = {
    objects: state.objects.length,
    papers: 0,
    notes: 0,
    links: 0,
    searches: 0,
  };
  for (const object of state.objects) {
    if (object.type === 'GX.MAROScientificPaper') counts.papers += 1;
    else if (object.type === 'GX.MARONote') counts.notes += 1;
    else if (object.type === 'GX.MAROLink') counts.links += 1;
    else if (object.type === 'GX.MAROBlankPaper') counts.searches += 1;
  }
  return counts;
}

function stateUpdate(set, unset) {
  const update = { $set: set };
  if (Object.keys(unset).length > 0) update.$unset = unset;
  return update;
}

function createWorkspaceSnapshotService(
  getCollection = defaultCollection,
  now = () => new Date(),
  onWorkspaceSaved = null,
) {
  let indexesReady = null;

  async function collection() {
    const value = getCollection();
    if (!indexesReady) {
      indexesReady = Promise.resolve(
        value.createIndex(
          { ownerName: 1, updatedAt: -1 },
          { name: 'workspace_snapshots_owner_updated' },
        ),
      ).catch((error) => {
        indexesReady = null;
        throw error;
      });
    }
    await indexesReady;
    return value;
  }

  function notifyWorkspaceSaved(state) {
    if (typeof onWorkspaceSaved !== 'function') return;
    Promise.resolve()
      .then(() => onWorkspaceSaved(structuredClone(state)))
      .catch((error) => {
        console.error(
          `[LLM Wiki] Automatic sync failed for ${state?.projectName || 'workspace'}:`,
          error?.message || error,
        );
      });
  }

  async function list(ownerNameValue) {
    const ownerName = requiredString(ownerNameValue, 'owner');
    const snapshots = await collection();
    const rows = await snapshots
      .find(
        { ownerName },
        {
          projection: {
            _id: 1,
            ownerName: 1,
            projectName: 1,
            revision: 1,
            updatedAt: 1,
          },
        },
      )
      .sort({ updatedAt: -1 })
      .toArray();
    return rows.map((row) => ({
      id: String(row._id),
      ownerName: row.ownerName,
      projectName: row.projectName,
      revision: row.revision,
      updatedAt: row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt || ''),
    }));
  }

  async function load(projectNameValue) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const snapshots = await collection();
    const document = await snapshots.findOne({ _id: projectName });
    if (!document) {
      throw new WorkspaceSnapshotError(
        'Workspace snapshot not found',
        404,
        'not_found',
      );
    }
    const state = publicState(document);
    if (document.stateEncoding !== OBJECT_ENCODING) {
      const fields = stateStorageFields(state);
      const raw = decodeStoredState(document);
      for (const object of raw.objects) {
        const key = objectKey(object.id), meta = fields.set.objectMeta[key];
        if (meta && object.persistenceKey && meta.persistenceKey !== object.persistenceKey) meta.legacyPersistenceKey = object.persistenceKey;
      }
      const result = await snapshots.updateOne({ _id: projectName, revision: document.revision,
        stateEncoding: document.stateEncoding ?? { $exists: false } }, stateUpdate(fields.set, fields.unset));
      if (result.matchedCount === 0) return load(projectName);
    }
    return state;
  }

  /** Check Wiki freshness without loading or decompressing the canvas payload. */
  async function loadRevision(projectNameValue) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const document = await (await collection()).findOne(
      { _id: projectName },
      { projection: { _id: 0, revision: 1 } },
    );
    if (!document) {
      throw new WorkspaceSnapshotError('Workspace snapshot not found', 404, 'not_found');
    }
    return document.revision;
  }

  async function remove(projectNameValue) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const snapshots = await collection();
    const document = await snapshots.findOne(
      { _id: projectName },
      { projection: { _id: 1, ownerName: 1, projectName: 1 } },
    );
    if (!document) {
      return { deleted: false, projectName, ownerName: '' };
    }
    const snapshotResult = await snapshots.deleteOne({ _id: projectName });
    return {
      deleted: snapshotResult.deletedCount > 0,
      projectName,
      ownerName: String(document.ownerName || ''),
    };
  }

  async function ensure(state) {
    const projectName = requiredString(state?.projectName, 'state.projectName');
    const { ownerName } = validateState(state, projectName);
    const snapshots = await collection();
    const timestamp = now();
    const initialRevision = Number.isInteger(state.revision)
      ? Math.max(0, state.revision)
      : 0;
    const initialState = {
      ...structuredClone(state),
      revision: initialRevision,
      updatedAt: timestamp.toISOString(),
    };
    const { serializedState } = validateState(initialState, projectName);
    const storedState = stateStorageFields(initialState, serializedState);
    const document = {
      _id: projectName,
      schemaVersion: 1,
      ownerName,
      projectName,
      revision: initialRevision,
      summary: summarizeState(initialState),
      camera: structuredClone(initialState.camera),
      ...storedState.set,
      lastMutationId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await snapshots.updateOne(
        { _id: projectName },
        { $setOnInsert: document },
        { upsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    return load(projectName);
  }

  async function save({ projectName: projectNameValue, baseRevision, mutationId: mutationIdValue, state }) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const mutationId = requiredString(mutationIdValue, 'mutationId', 512);
    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      throw new WorkspaceSnapshotError(
        'baseRevision is invalid',
        400,
        'invalid_request',
      );
    }
    const snapshots = await collection();
    const current = await snapshots.findOne({ _id: projectName });
    if (!current) {
      throw new WorkspaceSnapshotError(
        'Workspace snapshot not found',
        404,
        'not_found',
      );
    }
    if (current.lastMutationId === mutationId) {
      const replayedState = publicState(current);
      return { state: replayedState, replayed: true };
    }
    if (Array.isArray(state?.objects)) {
      state = { ...state, objects: repairIncomingObjects(state.objects, current, decodeStoredState(current).objects) };
    }
    validateState(state, projectName);
    if (current.revision !== baseRevision) {
      throw new WorkspaceSnapshotError(
        'Workspace revision conflict',
        409,
        'revision_conflict',
        publicState(current),
      );
    }
    const timestamp = now();
    const nextRevision = current.revision + 1;
    const savedState = {
      ...structuredClone(state),
      objects: (() => {
        const previousObjects = publicState(current).objects;
        validateObjectIdentities(state.objects, previousObjects);
        const old = new Map(previousObjects.map(o => [o.id, o]));
        return state.objects.map(o => preserveEvidenceRequests(old.get(o.id), structuredClone(o)));
      })(),
      ownerName: current.ownerName,
      projectName,
      id: projectName,
      revision: nextRevision,
      updatedAt: timestamp.toISOString(),
    };
    const { serializedState } = validateState(savedState, projectName);
    const storedState = stateStorageFields(savedState, serializedState, current.objectMeta);
    const updated = await snapshots.findOneAndUpdate(
      { _id: projectName, revision: baseRevision },
      stateUpdate(
        {
          revision: nextRevision,
          summary: summarizeState(savedState),
          camera: structuredClone(savedState.camera),
          ...storedState.set,
          lastMutationId: mutationId,
          updatedAt: timestamp,
        },
        storedState.unset,
      ),
      { returnDocument: 'after' },
    );
    if (updated) {
      const savedState = publicState(updated);
      notifyWorkspaceSaved(savedState);
      return { state: savedState, replayed: false };
    }

    const latest = await snapshots.findOne({ _id: projectName });
    if (latest?.lastMutationId === mutationId) {
      return { state: publicState(latest), replayed: true };
    }
    throw new WorkspaceSnapshotError(
      'Workspace revision conflict',
      409,
      'revision_conflict',
      publicState(latest),
    );
  }

  async function patch({ projectName: projectNameValue, baseRevision, mutationId: mutationIdValue, delta }) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const mutationId = requiredString(mutationIdValue, 'mutationId', 512);
    if (!Number.isInteger(baseRevision) || baseRevision < 0 || !delta ||
        !Array.isArray(delta.upsertedObjects) || !Array.isArray(delta.removedObjectIds) ||
        (delta.patchedObjects !== undefined && !Array.isArray(delta.patchedObjects)) || !delta.camera ||
        !['x', 'y', 'scale'].every(key => Number.isFinite(delta.camera[key])) || delta.camera.scale <= 0) {
      throw new WorkspaceSnapshotError('delta is invalid', 400, 'invalid_request');
    }
    const touched = [...delta.upsertedObjects.map(object => requiredString(object?.id, 'object.id')),
      ...(delta.patchedObjects || []).map(object => requiredString(object?.id, 'object.id')),
      ...delta.removedObjectIds.map(id => requiredString(id, 'removedObjectId'))];
    if (new Set(touched).size !== touched.length) throw new WorkspaceSnapshotError('Duplicate object mutation', 400, 'duplicate_object_identity');
    const snapshots = await collection();
    const projection = { _id: 1, revision: 1, stateEncoding: 1, stateMeta: 1, objectOrder: 1, objectMeta: 1,
      lastMutationId: 1, recentMutations: 1, updatedAt: 1, ownerName: 1, projectName: 1 };
    for (const id of touched) projection['objectPayloads.' + objectKey(id)] = 1;
    const current = await snapshots.findOne({ _id: projectName }, { projection });
    if (!current) throw new WorkspaceSnapshotError('Workspace snapshot not found', 404, 'not_found');
    if (current.stateEncoding !== OBJECT_ENCODING) {
      await load(projectName);
      return patch({ projectName, baseRevision, mutationId, delta });
    }
    const fingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify([baseRevision, delta])).digest('hex');
    const receipt = current.recentMutations?.find(item => item.id === mutationId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new WorkspaceSnapshotError('Mutation id reused with different changes', 409, 'mutation_mismatch');
      return { protocolVersion: 2, revision: receipt.revision, updatedAt: receipt.updatedAt, replayed: true };
    }
    if (current.revision !== baseRevision) throw new WorkspaceSnapshotError('Workspace revision conflict', 409,
      'revision_conflict', await load(projectName));
    const decode = id => {
      const payload = current.objectPayloads?.[objectKey(id)];
      return payload ? JSON.parse(gunzipSync(storedPayloadBuffer(payload)).toString('utf8')) : undefined;
    };
    const changed = delta.upsertedObjects.map(object => structuredClone(object));
    for (const patch of delta.patchedObjects || []) {
      const old = decode(patch.id);
      if (!old || !patch.changes || Array.isArray(patch.changes) || typeof patch.changes !== 'object' ||
          !Array.isArray(patch.removedKeys)) throw new WorkspaceSnapshotError('Object patch is invalid', 400, 'invalid_request');
      const keys = [...Object.keys(patch.changes), ...patch.removedKeys];
      if (keys.some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor', 'id', 'type', 'persistenceKey'].includes(key))) {
        throw new WorkspaceSnapshotError('Object patch changes identity', 400, 'invalid_request');
      }
      const object = { ...old, ...structuredClone(patch.changes) };
      for (const key of patch.removedKeys) delete object[key];
      changed.push(object);
    }
    const previous = touched.map(decode).filter(Boolean);
    const repaired = repairIncomingObjects(withoutRetiredSketches({ objects: changed }).objects, current, previous);
    validateObjectIdentities(repaired, previous);
    const removed = new Set(delta.removedObjectIds);
    const objectMeta = { ...current.objectMeta };
    const set = {}, unset = {};
    let order = current.objectOrder.filter(id => !removed.has(id));
    const knownIds = new Set(order);
    for (const id of removed) {
      const key = objectKey(id);
      delete objectMeta[key];
      unset['objectPayloads.' + key] = '';
      unset['objectMeta.' + key] = '';
    }
    for (const incoming of repaired) {
      const object = preserveEvidenceRequests(decode(incoming.id), incoming);
      const key = objectKey(object.id), encoded = encodeObject(object);
      objectMeta[key] = { ...encoded.meta, ...(objectMeta[key]?.legacyPersistenceKey ? { legacyPersistenceKey: objectMeta[key].legacyPersistenceKey } : {}) };
      set['objectPayloads.' + key] = encoded.payload;
      set['objectMeta.' + key] = objectMeta[key];
      if (!knownIds.has(object.id)) { order.push(object.id); knownIds.add(object.id); }
    }
    const identities = new Set();
    for (const meta of Object.values(objectMeta)) {
      if (!meta.persistenceKey) continue;
      const identity = meta.type + ':' + meta.persistenceKey;
      if (identities.has(identity)) throw new WorkspaceSnapshotError('Duplicate workspace object identity', 400, 'duplicate_object_identity');
      identities.add(identity);
    }
    const timestamp = now(), revision = baseRevision + 1, updatedAt = timestamp.toISOString();
    const stateMeta = { ...current.stateMeta, camera: structuredClone(delta.camera), revision, updatedAt,
      schemaVersion: Number.isInteger(delta.schemaVersion) ? delta.schemaVersion : current.stateMeta.schemaVersion };
    checkObjectStorage(objectMeta, stateMeta, order);
    const summary = summarizeState({ objects: Object.values(objectMeta) });
    Object.assign(set, { revision, stateMeta, objectOrder: order, summary, camera: stateMeta.camera,
      lastMutationId: mutationId, updatedAt: timestamp,
      recentMutations: [...(current.recentMutations || []), { id: mutationId, fingerprint, revision, updatedAt }].slice(-32) });
    const result = await snapshots.updateOne({ _id: projectName, revision: baseRevision }, stateUpdate(set, unset));
    if (!result.matchedCount) throw new WorkspaceSnapshotError('Workspace revision conflict', 409,
      'revision_conflict', await load(projectName));
    // Wiki checks the tiny saved revision before reading a board on demand.
    // Autosave must not trigger a full-board read for background Wiki rebuilding.
    return { protocolVersion: 2, revision, updatedAt, replayed: false };
  }

  return {
    ensure,
    list,
    load,
    loadRevision,
    remove,
    patch,
    save,
  };
}

function syncSavedWorkspaceToWiki(state) {
  const { llmWikiService } = require('./llmWiki');
  return llmWikiService.sync(state.id, state);
}

module.exports = {
  INLINE_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_BYTES,
  WorkspaceSnapshotError,
  createWorkspaceSnapshotService,
  workspaceSnapshotService: createWorkspaceSnapshotService(
    defaultCollection,
    () => new Date(),
    syncSavedWorkspaceToWiki,
  ),
};
