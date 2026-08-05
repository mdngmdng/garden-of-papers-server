const { getClient } = require('./mongo');

const SNAPSHOT_DATABASE = 'GardenOfPapersSystem';
const SNAPSHOT_COLLECTION = 'WorkspaceSnapshots';
const MAX_SNAPSHOT_BYTES = 15 * 1024 * 1024;

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
  const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new WorkspaceSnapshotError(
      'Workspace snapshot is too large',
      413,
      'snapshot_too_large',
    );
  }
  return { projectName, ownerName };
}

function publicState(document) {
  return document?.state ?? null;
}

function createWorkspaceSnapshotService(
  getCollection = defaultCollection,
  now = () => new Date(),
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
    const document = {
      _id: projectName,
      schemaVersion: 1,
      ownerName,
      projectName,
      revision: initialRevision,
      state: initialState,
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
    validateState(savedState, projectName);
    const updated = await snapshots.findOneAndUpdate(
      { _id: projectName, revision: baseRevision },
      {
        $set: {
          revision: nextRevision,
          state: savedState,
          lastMutationId: mutationId,
          updatedAt: timestamp,
        },
      },
      { returnDocument: 'after' },
    );
    if (updated) return { state: publicState(updated), replayed: false };

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

  return { ensure, list, load, save };
}

module.exports = {
  MAX_SNAPSHOT_BYTES,
  WorkspaceSnapshotError,
  createWorkspaceSnapshotService,
  workspaceSnapshotService: createWorkspaceSnapshotService(),
};
