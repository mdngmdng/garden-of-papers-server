const { getClient } = require('./mongo');
const { gzipSync, gunzipSync } = require('node:zlib');

const SNAPSHOT_DATABASE = 'GardenOfPapersSystem';
const SNAPSHOT_COLLECTION = 'WorkspaceSnapshots';
const INLINE_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024;
const MAX_STORED_SNAPSHOT_BYTES = 14 * 1024 * 1024;
const SNAPSHOT_ENCODING = 'gzip-json-v1';

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
    return JSON.parse(gunzipSync(document.statePayload).toString('utf8'));
  }
  return document?.state ?? null;
}

function stateStorageFields(state, serializedState) {
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
    return publicState(document);
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
      return { state: publicState(current), replayed: true };
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

  return { ensure, list, load, patch, save };
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
