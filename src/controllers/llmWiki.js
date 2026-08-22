const {
  LLMWikiError,
  llmWikiService,
} = require('../services/llmWiki');
const {
  WorkspaceSnapshotError,
  workspaceSnapshotService,
} = require('../services/workspaceSnapshots');

function sendError(res, error) {
  if (error instanceof LLMWikiError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
    });
  }
  if (error instanceof WorkspaceSnapshotError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
    });
  }
  console.error('LLM Wiki request failed:', error);
  return res.status(500).json({
    error: 'LLM Wiki request failed',
    code: 'internal_error',
  });
}

exports.status = async (req, res) => {
  try {
    return res.status(200).json(await llmWikiService.status(req.params.id));
  } catch (error) {
    return sendError(res, error);
  }
};

exports.sync = async (req, res) => {
  try {
    const state = req.body?.state
      || await workspaceSnapshotService.load(req.params.id);
    const requestedRevision = Number(req.body?.revision);
    if (
      Number.isInteger(requestedRevision)
      && requestedRevision > Number(state?.revision)
    ) {
      throw new LLMWikiError(
        'The saved workspace revision is not ready yet',
        409,
        'workspace_not_ready',
      );
    }
    return res.status(202).json(
      llmWikiService.requestSync(req.params.id, state),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.chat = async (req, res) => {
  try {
    return res.status(202).json(
      await llmWikiService.enqueueChat(
        req.params.id,
        req.body?.question,
        req.body?.requestId,
        req.body?.contextPaperIds,
      ),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.clearChat = async (req, res) => {
  try {
    return res.status(200).json(
      await llmWikiService.clearChat(req.params.id),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.latestLog = async (req, res) => {
  try {
    const log = await llmWikiService.latestLog(req.params.id);
    res.set({
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `inline; filename="${log.fileName}"`,
      'cache-control': 'private, no-store',
    });
    return res.status(200).send(log.markdown);
  } catch (error) {
    return sendError(res, error);
  }
};
