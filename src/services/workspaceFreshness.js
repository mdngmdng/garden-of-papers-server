const { getClient } = require('./mongo');
const {
  WorkspaceSnapshotError,
} = require('./workspaceSnapshots');

const SNAPSHOT_DATABASE = 'GardenOfPapersSystem';
const SNAPSHOT_COLLECTION = 'WorkspaceSnapshots';

function requiredProjectName(value) {
  const projectName = typeof value === 'string' ? value.trim() : '';
  if (!projectName || projectName.length > 256) {
    throw new WorkspaceSnapshotError(
      'projectName is invalid',
      400,
      'invalid_request',
    );
  }
  return projectName;
}

function timestamp(value) {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : new Date(value || 0).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function objectIdTimestamp(value) {
  if (value && typeof value.getTimestamp === 'function') {
    return timestamp(value.getTimestamp());
  }
  const text = String(value || '');
  if (!/^[0-9a-f]{24}$/iu.test(text)) return 0;
  return Number.parseInt(text.slice(0, 8), 16) * 1_000;
}

function createWorkspaceFreshnessService(
  getDatabases = () => {
    const client = getClient();
    if (!client) {
      throw new WorkspaceSnapshotError(
        'MongoDB is not connected',
        503,
        'database_unavailable',
      );
    }
    return {
      snapshots: client
        .db(SNAPSHOT_DATABASE)
        .collection(SNAPSHOT_COLLECTION),
      legacy(projectName) {
        return client.db(projectName).collection('SaveFile');
      },
    };
  },
) {
  async function sourceStatus(projectNameValue) {
    const projectName = requiredProjectName(projectNameValue);
    const databases = getDatabases();
    const legacy = databases.legacy(projectName);
    const [atomic, explicitlyUpdated, newestObject] = await Promise.all([
      databases.snapshots.findOne(
        { _id: projectName },
        { projection: { revision: 1, updatedAt: 1, lastMutationId: 1 } },
      ),
      legacy.findOne(
        { _gopUpdatedAt: { $exists: true } },
        {
          sort: { _gopUpdatedAt: -1 },
          projection: { _gopUpdatedAt: 1 },
        },
      ),
      legacy.findOne(
        { _id: { $type: 'objectId' } },
        { sort: { _id: -1 }, projection: { _id: 1 } },
      ),
    ]);
    const legacyUpdatedAt = Math.max(
      timestamp(explicitlyUpdated?._gopUpdatedAt),
      objectIdTimestamp(newestObject?._id),
    );
    return {
      projectName,
      atomicRevision: Number.isInteger(atomic?.revision)
        ? atomic.revision
        : null,
      atomicUpdatedAt: timestamp(atomic?.updatedAt)
        ? new Date(timestamp(atomic.updatedAt)).toISOString()
        : null,
      legacyUpdatedAt: legacyUpdatedAt
        ? new Date(legacyUpdatedAt).toISOString()
        : null,
      atomicStage: String(atomic?.lastMutationId || '').endsWith(':canonical')
        ? 'canonical'
        : String(atomic?.lastMutationId || '').endsWith(':recovery')
          ? 'recovery'
          : 'unknown',
    };
  }

  return { sourceStatus };
}

module.exports = {
  createWorkspaceFreshnessService,
  workspaceFreshnessService: createWorkspaceFreshnessService(),
};
