const express = require('express');
const controller = require('../controllers/workspaceSnapshots');

const router = express.Router();

router.get('/projects', controller.listProjects);
router.post('/projects', controller.ensureWorkspace);
router.get('/workspaces/:id/source-status', controller.workspaceSourceStatus);
router.get('/workspaces/:id/history', controller.listWorkspaceHistory);
router.post(
  '/workspaces/:id/history',
  controller.createWorkspaceHistorySnapshot,
);
router.get(
  '/workspaces/:id/history/transitions/:fromRevision/:toRevision',
  controller.getWorkspaceHistoryTransition,
);
router.post(
  '/workspaces/:id/history/:historyId/restore',
  controller.restoreWorkspaceHistory,
);
router.get('/workspaces/:id', controller.loadWorkspace);
router.put('/workspaces/:id', controller.saveWorkspace);
router.patch('/workspaces/:id', controller.patchWorkspace);

module.exports = router;
