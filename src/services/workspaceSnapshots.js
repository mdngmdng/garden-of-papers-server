const { getClient } = require('./mongo');
const { gzipSync, gunzipSync } = require('node:zlib');

const SNAPSHOT_DATABASE = 'GardenOfPapersSystem';
const SNAPSHOT_COLLECTION = 'WorkspaceSnapshots';
const SNAPSHOT_HISTORY_COLLECTION = 'WorkspaceSnapshotHistory';
const SNAPSHOT_HISTORY_DELTA_COLLECTION = 'WorkspaceSnapshotDeltas';
const SNAPSHOT_HISTORY_LIMIT = 10;
const INLINE_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024;
const MAX_STORED_SNAPSHOT_BYTES = 14 * 1024 * 1024;
const SNAPSHOT_ENCODING = 'gzip-json-v1';
const RETIRED_SKETCH_TYPE = 'GX.MAROPtCurve';

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

function defaultHistoryCollection() {
  const client = getClient();
  if (!client) {
    throw new WorkspaceSnapshotError(
      'MongoDB is not connected',
      503,
      'database_unavailable',
    );
  }
  return client.db(SNAPSHOT_DATABASE).collection(SNAPSHOT_HISTORY_COLLECTION);
}

function defaultHistoryDeltaCollection() {
  const client = getClient();
  if (!client) {
    throw new WorkspaceSnapshotError(
      'MongoDB is not connected',
      503,
      'database_unavailable',
    );
  }
  return client
    .db(SNAPSHOT_DATABASE)
    .collection(SNAPSHOT_HISTORY_DELTA_COLLECTION);
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

function publicState(document) {
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

function stateStorageFields(state, serializedState) {
  state = withoutRetiredSketches(state);
  const bytes = Buffer.byteLength(serializedState, 'utf8');
  if (bytes <= INLINE_SNAPSHOT_BYTES) {
    return {
      set: { state },
      unset: { stateEncoding: '', statePayload: '' },
    };
  }

  const statePayload = gzipSync(Buffer.from(serializedState), { level: 6 });
  if (statePayload.byteLength > MAX_STORED_SNAPSHOT_BYTES) {
    throw new WorkspaceSnapshotError(
      'Compressed workspace snapshot is too large',
      413,
      'snapshot_too_large',
    );
  }
  return {
    set: {
      stateEncoding: SNAPSHOT_ENCODING,
      statePayload,
    },
    unset: { state: '' },
  };
}

function historyStorageFields(serializedState) {
  const statePayload = gzipSync(Buffer.from(serializedState), { level: 6 });
  if (statePayload.byteLength > MAX_STORED_SNAPSHOT_BYTES) {
    throw new WorkspaceSnapshotError(
      'Compressed workspace history snapshot is too large',
      413,
      'snapshot_too_large',
    );
  }
  return {
    stateEncoding: SNAPSHOT_ENCODING,
    statePayload,
  };
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

function publicTransition(document) {
  if (
    document?.transitionEncoding !== SNAPSHOT_ENCODING
    || !document.transitionPayload
  ) {
    return document?.transition ?? null;
  }
  return JSON.parse(
    gunzipSync(storedPayloadBuffer(document.transitionPayload)).toString(
      'utf8',
    ),
  );
}

function geometryChanged(left, right) {
  return left.x !== right.x
    || left.y !== right.y
    || left.width !== right.width
    || left.height !== right.height
    || left.zIndex !== right.zIndex;
}

function onlyGeometryChanged(left, right) {
  const omitted = new Set([
    'x',
    'y',
    'width',
    'height',
    'zIndex',
    'updatedAt',
  ]);
  const compact = (object) => Object.fromEntries(
    Object.entries(object).filter(([key]) => !omitted.has(key)),
  );
  return JSON.stringify(compact(left)) === JSON.stringify(compact(right));
}

function buildObjectPatch(previous, next) {
  const changes = {};
  const removedKeys = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  keys.delete('id');
  for (const key of keys) {
    if (!(key in next)) {
      removedKeys.push(key);
      continue;
    }
    if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
    changes[key] = structuredClone(next[key]);
  }
  return { id: next.id, changes, removedKeys };
}

function buildObjectDelta(fromState, toState) {
  const fromById = new Map(
    fromState.objects.map((object) => [object.id, object]),
  );
  const toById = new Map(toState.objects.map((object) => [object.id, object]));
  const upsertedObjects = [];
  const patchedObjects = [];
  const removedObjectIds = [];
  const summary = { created: 0, deleted: 0, moved: 0, updated: 0 };

  for (const object of toState.objects) {
    const previous = fromById.get(object.id);
    if (!previous) {
      upsertedObjects.push(structuredClone(object));
      summary.created += 1;
      continue;
    }
    if (JSON.stringify(previous) === JSON.stringify(object)) continue;
    patchedObjects.push(buildObjectPatch(previous, object));
    if (geometryChanged(previous, object) && onlyGeometryChanged(previous, object)) {
      summary.moved += 1;
    } else {
      summary.updated += 1;
    }
  }
  for (const object of fromState.objects) {
    if (toById.has(object.id)) continue;
    removedObjectIds.push(object.id);
    summary.deleted += 1;
  }

  return {
    schemaVersion: toState.schemaVersion,
    fromRevision: fromState.revision,
    toRevision: toState.revision,
    targetUpdatedAt: toState.updatedAt,
    camera: structuredClone(toState.camera),
    upsertedObjects,
    patchedObjects,
    removedObjectIds,
    summary,
  };
}

function buildHistoryTransition(fromState, toState) {
  return {
    fromRevision: fromState.revision,
    toRevision: toState.revision,
    forward: buildObjectDelta(fromState, toState),
    backward: buildObjectDelta(toState, fromState),
  };
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
  getHistoryCollection = defaultHistoryCollection,
  getHistoryDeltaCollection = defaultHistoryDeltaCollection,
) {
  let indexesReady = null;
  let historyIndexesReady = null;
  let historyDeltaIndexesReady = null;

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

  async function historyCollection() {
    const value = getHistoryCollection();
    if (!historyIndexesReady) {
      historyIndexesReady = Promise.all([
        value.createIndex(
          { projectName: 1, revision: -1 },
          { name: 'workspace_history_project_revision' },
        ),
        value.createIndex(
          { projectName: 1, savedAt: -1 },
          { name: 'workspace_history_project_saved' },
        ),
        value.createIndex(
          { projectName: 1, reason: 1, savedAt: -1 },
          { name: 'workspace_history_manual_saved' },
        ),
      ]).catch((error) => {
        historyIndexesReady = null;
        throw error;
      });
    }
    await historyIndexesReady;
    return value;
  }

  async function historyDeltaCollection() {
    const value = getHistoryDeltaCollection();
    if (!historyDeltaIndexesReady) {
      historyDeltaIndexesReady = Promise.all([
        value.createIndex(
          { projectName: 1, toRevision: -1 },
          { name: 'workspace_delta_project_revision' },
        ),
      ]).catch((error) => {
        historyDeltaIndexesReady = null;
        throw error;
      });
    }
    await historyDeltaIndexesReady;
    return value;
  }

  async function recordTransition(fromState, toState) {
    if (
      !fromState
      || !toState
      || fromState.projectName !== toState.projectName
      || fromState.revision === toState.revision
    ) {
      return null;
    }
    const transition = buildHistoryTransition(fromState, toState);
    const serialized = JSON.stringify(transition);
    const transitionPayload = gzipSync(Buffer.from(serialized), { level: 6 });
    if (transitionPayload.byteLength > MAX_STORED_SNAPSHOT_BYTES) {
      throw new WorkspaceSnapshotError(
        'Compressed workspace history delta is too large',
        413,
        'snapshot_too_large',
      );
    }
    const deltas = await historyDeltaCollection();
    const document = {
      _id: `${toState.projectName}:${fromState.revision}:${toState.revision}`,
      schemaVersion: 2,
      projectName: toState.projectName,
      fromRevision: fromState.revision,
      toRevision: toState.revision,
      transitionEncoding: SNAPSHOT_ENCODING,
      transitionPayload,
      summary: transition.forward.summary,
      createdAt: now(),
    };
    await deltas.updateOne(
      { _id: document._id },
      { $set: document },
      { upsert: true },
    );
    return transition;
  }

  async function recordTransitionSafely(fromState, toState) {
    try {
      return await recordTransition(fromState, toState);
    } catch (error) {
      console.error(
        `[Workspace history] Failed to diff ${toState?.projectName || 'workspace'} r${fromState?.revision ?? '?'}→r${toState?.revision ?? '?'}:`,
        error?.message || error,
      );
      return null;
    }
  }

  async function recordHistory(
    state,
    reason = 'manual',
    restoredFromRevision = null,
    prepared = {},
  ) {
    const projectName = requiredString(state?.projectName, 'state.projectName');
    const validated = prepared.serializedState
      ? {
          ownerName: requiredString(state.ownerName, 'state.ownerName'),
          serializedState: prepared.serializedState,
        }
      : validateState(state, projectName);
    const { ownerName, serializedState } = validated;
    const revision = Number.isInteger(state.revision) ? state.revision : 0;
    const history = await historyCollection();
    const createdAt = now();
    const savedAt = reason === 'manual'
      ? createdAt
      : new Date(state.updatedAt || createdAt);
    const document = {
      _id: prepared.historyId || (reason === 'manual'
        ? `${projectName}:manual:revision-${revision}`
        : `${projectName}:${reason}:${revision}`),
      schemaVersion: 1,
      ownerName,
      projectName,
      revision,
      reason,
      restoredFromRevision: Number.isInteger(restoredFromRevision)
        ? restoredFromRevision
        : null,
      summary: summarizeState(state),
      camera: structuredClone(state.camera),
      ...(prepared.statePayload
        ? {
            stateEncoding: SNAPSHOT_ENCODING,
            statePayload: prepared.statePayload,
          }
        : historyStorageFields(serializedState)),
      savedAt: Number.isFinite(savedAt.getTime()) ? savedAt : createdAt,
      createdAt,
    };
    await history.updateOne(
      { _id: document._id },
      { $setOnInsert: document },
      { upsert: true },
    );
    if (prepared.previousState) {
      await recordTransitionSafely(prepared.previousState, state);
    }

    const expired = await history
      .find(
        { projectName, reason: 'manual' },
        { projection: { _id: 1, revision: 1 } },
      )
      .sort({ savedAt: -1 })
      .skip(SNAPSHOT_HISTORY_LIMIT)
      .toArray();
    if (expired.length) {
      const expiredRevisions = expired
        .map((entry) => entry.revision)
        .filter(Number.isInteger);
      await history.deleteMany({
        _id: { $in: expired.map((entry) => entry._id) },
      });
      if (expiredRevisions.length) {
        const deltas = await historyDeltaCollection();
        await deltas.deleteMany({
          projectName,
          $or: [
            { fromRevision: { $in: expiredRevisions } },
            { toRevision: { $in: expiredRevisions } },
          ],
        });
      }
    }
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
    return publicState(document);
  }

  async function listHistory(projectNameValue) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const snapshots = await collection();
    const current = await snapshots.findOne(
      { _id: projectName },
      {
        projection: {
          _id: 1,
          revision: 1,
          summary: 1,
          camera: 1,
          updatedAt: 1,
        },
      },
    );
    if (!current) {
      throw new WorkspaceSnapshotError(
        'Workspace snapshot not found',
        404,
        'not_found',
      );
    }
    const history = await historyCollection();
    const manualRows = await history
      .find(
        { projectName, reason: 'manual' },
        {
          projection: {
            _id: 1,
            revision: 1,
            reason: 1,
            restoredFromRevision: 1,
            summary: 1,
            camera: 1,
            savedAt: 1,
          },
        },
      )
      .sort({ savedAt: -1 })
      .limit(SNAPSHOT_HISTORY_LIMIT)
      .toArray();
    let currentDocument = null;
    if (!current.summary || !current.camera) {
      currentDocument = await snapshots.findOne({ _id: projectName });
      const currentState = publicState(currentDocument);
      current.summary = summarizeState(currentState);
      current.camera = structuredClone(currentState.camera);
    }
    const currentRow = {
      _id: `${projectName}:current:${current.revision}`,
      revision: current.revision,
      reason: 'current',
      restoredFromRevision: null,
      summary: current.summary,
      camera: current.camera,
      savedAt: now(),
    };
    const rows = [currentRow, ...manualRows];
    const transitionByEntryId = new Map();
    const deltas = await historyDeltaCollection();
    const adjacentPairs = rows.slice(0, -1).map((newerRow, index) => {
      const olderRow = rows[index + 1];
      return {
        newerRow,
        olderRow,
        deltaId: olderRow.revision === newerRow.revision
          ? null
          : `${projectName}:${olderRow.revision}:${newerRow.revision}`,
      };
    });
    for (const pair of adjacentPairs) {
      if (pair.deltaId) continue;
      transitionByEntryId.set(String(pair.newerRow._id), {
        fromRevision: pair.olderRow.revision,
        toRevision: pair.newerRow.revision,
        summary: { created: 0, deleted: 0, moved: 0, updated: 0 },
      });
    }
    const deltaIds = adjacentPairs
      .map((pair) => pair.deltaId)
      .filter(Boolean);
    const deltaDocuments = await deltas
      .find({
        projectName,
        _id: { $in: deltaIds },
      })
      .toArray();
    const deltaById = new Map(
      deltaDocuments.map((document) => [String(document._id), document]),
    );
    const missingPairs = adjacentPairs.filter(
      (pair) => pair.deltaId
        && deltaById.get(pair.deltaId)?.schemaVersion !== 2,
    );
    const manualHistoryIds = [...new Set(missingPairs.flatMap((pair) => [
      pair.olderRow,
      pair.newerRow,
    ])
      .filter((row) => row.reason === 'manual')
      .map((row) => row._id))];
    const historyDocuments = manualHistoryIds.length
      ? await history.find({
        projectName,
        _id: { $in: manualHistoryIds },
      }).toArray()
      : [];
    const historyById = new Map(
      historyDocuments.map((document) => [String(document._id), document]),
    );
    if (missingPairs.some((pair) => pair.newerRow.reason === 'current')) {
      currentDocument ||= await snapshots.findOne({ _id: projectName });
      historyById.set(String(currentRow._id), currentDocument);
    }

    await Promise.all(adjacentPairs.map(async ({
      olderRow,
      newerRow,
      deltaId,
    }) => {
      if (!deltaId) return;
      const deltaDocument = deltaById.get(deltaId);
      let summary = deltaDocument?.summary ?? null;
      if (deltaDocument?.schemaVersion !== 2) {
        const olderDocument = historyById.get(String(olderRow._id));
        const newerDocument = historyById.get(String(newerRow._id));
        if (olderDocument && newerDocument) {
          const transition = await recordTransitionSafely(
            publicState(olderDocument),
            publicState(newerDocument),
          );
          summary = transition?.forward?.summary ?? null;
        }
      }
      if (summary) {
        transitionByEntryId.set(String(newerRow._id), {
          fromRevision: olderRow.revision,
          toRevision: newerRow.revision,
          summary,
        });
      }
    }));
    return {
      currentRevision: current.revision,
      entries: rows.map((row) => ({
        id: String(row._id),
        revision: row.revision,
        reason: row.reason || 'autosave',
        restoredFromRevision: Number.isInteger(row.restoredFromRevision)
          ? row.restoredFromRevision
          : null,
        savedAt: row.savedAt instanceof Date
          ? row.savedAt.toISOString()
          : String(row.savedAt || ''),
        summary: row.summary || {},
        camera: row.camera || null,
        previousRevision:
          transitionByEntryId.get(String(row._id))?.fromRevision ?? null,
        diffFromPrevious:
          transitionByEntryId.get(String(row._id))?.summary ?? null,
      })),
    };
  }

  async function createHistorySnapshot(projectNameValue, snapshotIdValue) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const snapshots = await collection();
    const currentDocument = await snapshots.findOne({ _id: projectName });
    if (!currentDocument) {
      throw new WorkspaceSnapshotError(
        'Workspace snapshot not found',
        404,
        'not_found',
      );
    }
    const currentState = publicState(currentDocument);
    validateState(currentState, projectName);
    const history = await historyCollection();
    const snapshotId = snapshotIdValue == null
      ? `revision-${currentState.revision}`
      : requiredString(snapshotIdValue, 'snapshotId', 512);
    const historyId = `${projectName}:manual:${snapshotId}`;
    const existing = await history.findOne(
      { _id: historyId, projectName, reason: 'manual' },
      { projection: { _id: 1 } },
    );
    if (!existing) {
      const [previousRow] = await history
        .find({ projectName, reason: 'manual' })
        .sort({ savedAt: -1 })
        .limit(1)
        .toArray();
      const previousDocument = previousRow
        ? await history.findOne({ _id: previousRow._id, projectName })
        : null;
      await recordHistory(currentState, 'manual', null, {
        historyId,
        previousState: previousDocument ? publicState(previousDocument) : null,
      });
    }
    return listHistory(projectName);
  }

  async function getHistoryTransition(
    projectNameValue,
    fromRevisionValue,
    toRevisionValue,
  ) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const fromRevision = Number(fromRevisionValue);
    const toRevision = Number(toRevisionValue);
    if (
      !Number.isInteger(fromRevision)
      || !Number.isInteger(toRevision)
      || fromRevision < 0
      || toRevision <= fromRevision
    ) {
      throw new WorkspaceSnapshotError(
        'Workspace history revisions are invalid',
        400,
        'invalid_history_revision',
      );
    }
    const deltas = await historyDeltaCollection();
    const document = await deltas.findOne({
      _id: `${projectName}:${fromRevision}:${toRevision}`,
      projectName,
    });
    const transition = publicTransition(document);
    if (!transition) {
      throw new WorkspaceSnapshotError(
        'Workspace history transition not found',
        404,
        'history_transition_not_found',
      );
    }
    return transition;
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
    validateState(state, projectName);
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
      ownerName: current.ownerName,
      projectName,
      id: projectName,
      revision: nextRevision,
      updatedAt: timestamp.toISOString(),
    };
    const { serializedState } = validateState(savedState, projectName);
    const storedState = stateStorageFields(savedState, serializedState);
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

  async function patch({
    projectName: projectNameValue,
    baseRevision,
    mutationId: mutationIdValue,
    delta,
  }) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const mutationId = requiredString(mutationIdValue, 'mutationId', 512);
    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      throw new WorkspaceSnapshotError(
        'baseRevision is invalid',
        400,
        'invalid_request',
      );
    }
    if (
      !delta
      || typeof delta !== 'object'
      || !Array.isArray(delta.upsertedObjects)
      || !Array.isArray(delta.removedObjectIds)
      || !delta.camera
    ) {
      throw new WorkspaceSnapshotError(
        'delta is invalid',
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
    const currentState = publicState(current);
    if (current.lastMutationId === mutationId) {
      return {
        revision: current.revision,
        updatedAt: currentState.updatedAt,
        replayed: true,
      };
    }
    if (current.revision !== baseRevision) {
      throw new WorkspaceSnapshotError(
        'Workspace revision conflict',
        409,
        'revision_conflict',
        currentState,
      );
    }
    const removed = new Set(
      delta.removedObjectIds.map((id) => requiredString(id, 'removedObjectId')),
    );
    const byId = new Map(
      currentState.objects
        .filter((object) => !removed.has(object.id))
        .map((object) => [object.id, object]),
    );
    for (const object of delta.upsertedObjects) {
      const id = requiredString(object?.id, 'object.id');
      byId.set(id, structuredClone(object));
    }

    const timestamp = now();
    const nextRevision = current.revision + 1;
    const savedState = {
      ...structuredClone(currentState),
      schemaVersion: Number.isInteger(delta.schemaVersion)
        ? delta.schemaVersion
        : currentState.schemaVersion,
      camera: structuredClone(delta.camera),
      objects: [...byId.values()],
      revision: nextRevision,
      updatedAt: timestamp.toISOString(),
    };
    const { serializedState } = validateState(savedState, projectName);
    const storedState = stateStorageFields(savedState, serializedState);
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
      notifyWorkspaceSaved(publicState(updated));
      return {
        revision: nextRevision,
        updatedAt: savedState.updatedAt,
        replayed: false,
      };
    }

    const latest = await snapshots.findOne({ _id: projectName });
    if (latest?.lastMutationId === mutationId) {
      return {
        revision: latest.revision,
        updatedAt: publicState(latest).updatedAt,
        replayed: true,
      };
    }
    throw new WorkspaceSnapshotError(
      'Workspace revision conflict',
      409,
      'revision_conflict',
      publicState(latest),
    );
  }

  async function restoreHistory({
    projectName: projectNameValue,
    historyId: historyIdValue,
    baseRevision,
    mutationId: mutationIdValue,
  }) {
    const projectName = requiredString(projectNameValue, 'projectName');
    const historyId = requiredString(historyIdValue, 'historyId', 512);
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
    if (current.revision !== baseRevision) {
      throw new WorkspaceSnapshotError(
        'Workspace revision conflict',
        409,
        'revision_conflict',
        publicState(current),
      );
    }
    const history = await historyCollection();
    const historical = await history.findOne({
      _id: historyId,
      projectName,
      reason: 'manual',
    });
    if (!historical) {
      throw new WorkspaceSnapshotError(
        'Workspace history snapshot not found',
        404,
        'not_found',
      );
    }
    const historicalState = publicState(historical);
    validateState(historicalState, projectName);
    const currentState = publicState(current);

    const timestamp = now();
    const nextRevision = current.revision + 1;
    const restoredState = {
      ...structuredClone(historicalState),
      ownerName: current.ownerName,
      projectName,
      id: projectName,
      revision: nextRevision,
      createdAt: currentState.createdAt || historicalState.createdAt,
      updatedAt: timestamp.toISOString(),
    };
    const { serializedState } = validateState(restoredState, projectName);
    const storedState = stateStorageFields(restoredState, serializedState);
    const updated = await snapshots.findOneAndUpdate(
      { _id: projectName, revision: baseRevision },
      stateUpdate(
        {
          revision: nextRevision,
          summary: summarizeState(restoredState),
          camera: structuredClone(restoredState.camera),
          ...storedState.set,
          lastMutationId: mutationId,
          updatedAt: timestamp,
        },
        storedState.unset,
      ),
      { returnDocument: 'after' },
    );
    if (!updated) {
      const latest = await snapshots.findOne({ _id: projectName });
      throw new WorkspaceSnapshotError(
        'Workspace revision conflict',
        409,
        'revision_conflict',
        publicState(latest),
      );
    }
    const savedState = publicState(updated);
    notifyWorkspaceSaved(savedState);
    return { state: savedState, replayed: false };
  }

  return {
    createHistorySnapshot,
    ensure,
    getHistoryTransition,
    list,
    listHistory,
    load,
    patch,
    restoreHistory,
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
  SNAPSHOT_HISTORY_LIMIT,
  WorkspaceSnapshotError,
  createWorkspaceSnapshotService,
  workspaceSnapshotService: createWorkspaceSnapshotService(
    defaultCollection,
    () => new Date(),
    syncSavedWorkspaceToWiki,
    defaultHistoryCollection,
  ),
};
