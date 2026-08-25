const {
  WorkspaceSnapshotError,
  workspaceSnapshotService,
} = require('../services/workspaceSnapshots');
const {
  workspaceFreshnessService,
} = require('../services/workspaceFreshness');
const { getClient } = require('../services/mongo');
const { llmWikiService } = require('../services/llmWiki');

const SHARED_DATABASE = '_GardenOfPapersShared';
const SHARED_PDF_COLLECTION = 'PdfLibrary';
const PROTECTED_DATABASES = new Set([
  'admin',
  'config',
  'local',
  'UserNameList',
  'GardenOfPapersSystem',
  SHARED_DATABASE,
]);

function optionalIdentifier(value, maximum = 256) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= maximum ? normalized : '';
}

function sendError(res, error) {
  if (error instanceof WorkspaceSnapshotError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      revision: error.latestState?.revision,
      state: error.latestState,
    });
  }
  console.error('Workspace snapshot request failed:', error);
  return res.status(500).json({
    error: 'Workspace snapshot request failed',
    code: 'internal_error',
  });
}

exports.listProjects = async (req, res) => {
  try {
    return res.status(200).json(
      await workspaceSnapshotService.list(req.query.owner),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.ensureWorkspace = async (req, res) => {
  try {
    const state = await workspaceSnapshotService.ensure(req.body.initialState);
    return res.status(201).json(state);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.deleteWorkspace = async (req, res) => {
  try {
    const projectName = optionalIdentifier(req.query.id);
    const requestedOwner = optionalIdentifier(req.query.owner);
    if (!projectName) {
      return res.status(400).json({
        error: 'id is required',
        code: 'invalid_request',
      });
    }
    if (PROTECTED_DATABASES.has(projectName)) {
      return res.status(400).json({
        error: 'This database cannot be deleted as a workspace',
        code: 'protected_workspace_name',
      });
    }
    const client = getClient();
    if (!client) {
      throw new WorkspaceSnapshotError(
        'MongoDB is not connected',
        503,
        'database_unavailable',
      );
    }
    const atomic = await workspaceSnapshotService.remove(projectName);
    const owners = [atomic.ownerName || requestedOwner].filter(Boolean);
    let legacyDeleted = 0;
    for (const ownerName of owners) {
      const result = await client
        .db('UserNameList')
        .collection(ownerName)
        .deleteMany({ projectName });
      legacyDeleted += result.deletedCount;
    }
    if (!atomic.deleted && legacyDeleted === 0) {
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'not_found',
      });
    }
    await Promise.all([
      llmWikiService.removeWorkspace(projectName),
      client
        .db('GardenOfPapersSystem')
        .collection('PdfBridgeRequests')
        .deleteMany({ projectName }),
      client
        .db('GardenOfPapersSystem')
        .collection('PdfBridgeProjectLeases')
        .deleteMany({ $or: [{ _id: projectName }, { projectName }] }),
      client
        .db(SHARED_DATABASE)
        .collection(SHARED_PDF_COLLECTION)
        .updateMany(
          { 'sourceRefs.projectName': projectName },
          { $pull: { sourceRefs: { projectName } } },
        ),
      // Board aliases and previews live in the board database. Shared PDF
      // originals intentionally remain available to every other board.
      client.db(projectName).dropDatabase(),
    ]);
    return res.status(200).json({
      status: 'ok',
      projectName,
      deleted: true,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.loadWorkspace = async (req, res) => {
  try {
    return res.status(200).json(
      await workspaceSnapshotService.load(req.params.id),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.listWorkspaceHistory = async (req, res) => {
  try {
    return res.status(200).json(
      await workspaceSnapshotService.listHistory(req.params.id),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.createWorkspaceHistorySnapshot = async (req, res) => {
  try {
    return res.status(201).json(
      await workspaceSnapshotService.createHistorySnapshot(
        req.params.id,
        req.body?.snapshotId,
      ),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.getWorkspaceHistoryTransition = async (req, res) => {
  try {
    return res.status(200).json(
      await workspaceSnapshotService.getHistoryTransition(
        req.params.id,
        req.params.fromRevision,
        req.params.toRevision,
      ),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.restoreWorkspaceHistory = async (req, res) => {
  try {
    const result = await workspaceSnapshotService.restoreHistory({
      projectName: req.params.id,
      historyId: req.params.historyId,
      baseRevision: req.body.baseRevision,
      mutationId: req.body.mutationId,
    });
    if (result.replayed) res.set('x-gop-idempotent-replay', 'true');
    return res.status(200).json(result.state);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.workspaceSourceStatus = async (req, res) => {
  try {
    return res.status(200).json(
      await workspaceFreshnessService.sourceStatus(req.params.id),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.saveWorkspace = async (req, res) => {
  try {
    const result = await workspaceSnapshotService.save({
      projectName: req.params.id,
      baseRevision: req.body.baseRevision,
      mutationId: req.body.mutationId,
      state: req.body.state,
    });
    if (result.replayed) res.set('x-gop-idempotent-replay', 'true');
    return res.status(200).json(result.state);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.patchWorkspace = async (req, res) => {
  try {
    const result = await workspaceSnapshotService.patch({
      projectName: req.params.id,
      baseRevision: req.body.baseRevision,
      mutationId: req.body.mutationId,
      delta: req.body.delta,
    });
    if (result.replayed) res.set('x-gop-idempotent-replay', 'true');
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error);
  }
};
