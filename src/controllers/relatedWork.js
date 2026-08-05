const {
  getRelatedPaperRankingJob,
  manuscriptText,
} = require('../services/relatedWork');
const {
  cancelRelatedSearchJob,
  createRelatedSearchJob,
  executeRelatedSearch,
  getRelatedSearchJob,
} = require('../services/relatedSearchJobs');
const { generateCollectedPaperContext } = require('../services/gemini');

function safeOffset(value) {
  return Math.max(0, Number(value) || 0);
}

function safeLimit(value) {
  return Math.max(1, Math.min(10, Number(value) || 10));
}

function noStore(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
}

exports.createJob = (req, res) => {
  try {
    const jobId = createRelatedSearchJob({
      manuscript: req.body?.manuscript || {},
      sourcePapers: Array.isArray(req.body?.sourcePapers)
        ? req.body.sourcePapers
        : [],
      keyword: String(req.body?.keyword || '').trim(),
      searchIntent: req.body?.searchIntent === 'claim_support'
        ? 'claim_support'
        : '',
    });
    noStore(res);
    return res.status(202).json({
      jobId,
      status: 'queued',
      progress: {
        stage: 'queued',
        percent: 0,
        message: 'Related-work search is queued…',
      },
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

exports.getJob = (req, res) => {
  noStore(res);
  const job = getRelatedSearchJob(
    req.params.jobId,
    safeOffset(req.query.offset),
    safeLimit(req.query.limit),
  );
  if (!job) {
    return res.status(404).json({
      status: 'missing',
      error: 'This related-work search has expired.',
    });
  }
  return res.json(job);
};

exports.cancelJob = (req, res) => {
  noStore(res);
  if (!cancelRelatedSearchJob(req.params.jobId)) {
    return res.status(404).json({
      status: 'missing',
      error: 'This related-work search has expired.',
    });
  }
  return res.json({ status: 'cancelled' });
};

exports.ranking = (req, res) => {
  noStore(res);
  const job = getRelatedPaperRankingJob(req.params.jobId);
  if (!job) {
    return res.json({
      status: 'missing',
      rankingProvider: 'scholar',
      results: [],
      error: 'This ranking job has expired.',
    });
  }
  return res.json({
    status: job.status,
    rankingProvider: job.provider,
    results: job.results,
    error: job.error,
  });
};

// Compatibility endpoint for older clients. New clients use createJob/getJob
// so long-running corpus retrieval is never tied to one proxy request.
exports.search = async (req, res) => {
  try {
    const result = await executeRelatedSearch({
      manuscript: req.body?.manuscript || {},
      sourcePapers: Array.isArray(req.body?.sourcePapers)
        ? req.body.sourcePapers
        : [],
      keyword: String(req.body?.keyword || '').trim(),
      searchIntent: req.body?.searchIntent === 'claim_support'
        ? 'claim_support'
        : '',
    });
    const offset = safeOffset(req.body?.offset);
    const limit = safeLimit(req.body?.limit);
    const page = result.results.slice(offset, offset + limit);
    noStore(res);
    return res.json({
      ...result,
      offset,
      results: page,
      total: result.results.length,
      nextOffset: offset + page.length,
      hasMore: offset + page.length < result.results.length,
    });
  } catch (error) {
    console.error('[RelatedWork] Compatibility search failed:', error.message);
    return res.status(502).json({ error: error.message });
  }
};

exports.collect = async (req, res) => {
  const manuscript = req.body?.manuscript || {};
  const keyword = String(req.body?.keyword || '').trim();
  const paper = req.body?.paper || {};
  if (manuscriptText(manuscript).length < 20) {
    return res.status(400).json({ error: 'A linked manuscript is required.' });
  }
  if (!String(paper.title || '').trim()) {
    return res.status(400).json({ error: 'A collected paper is required.' });
  }

  try {
    const generated = await generateCollectedPaperContext(
      manuscript,
      keyword,
      paper,
    );
    return res.json(generated);
  } catch (error) {
    console.error('[RelatedWork] Collection text failed:', error.message);
    return res.status(502).json({ error: error.message });
  }
};
