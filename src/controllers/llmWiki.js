const {
  LLMWikiError,
  llmWikiService,
} = require('../services/llmWiki');

function sendError(res, error) {
  if (error instanceof LLMWikiError) {
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
    return res.status(200).json(
      await llmWikiService.sync(req.params.id, req.body?.state),
    );
  } catch (error) {
    return sendError(res, error);
  }
};

exports.chat = async (req, res) => {
  try {
    return res.status(200).json(
      await llmWikiService.chat(req.params.id, req.body?.question),
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
