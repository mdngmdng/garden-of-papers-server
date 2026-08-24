const {
  WorkspaceSnapshotError,
  workspaceSnapshotService,
} = require('../services/workspaceSnapshots');
const {
  workspaceFreshnessService,
} = require('../services/workspaceFreshness');

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
