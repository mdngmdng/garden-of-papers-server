const {
  cancelResearchGraphJob,
  createResearchGraphJob,
  getResearchGraphJob,
  listResearchGraphJobs,
} = require('../services/researchGraphJobs');

function noStore(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
}

exports.createJob = (req, res) => {
  try {
    const jobId = createResearchGraphJob({
      researchBundle: req.body?.researchBundle,
      paperIds: Array.isArray(req.body?.paperIds) ? req.body.paperIds : [],
      workspaceId: String(req.body?.workspaceId || '').trim(),
      sourcePaperId: String(req.body?.sourcePaperId || '').trim(),
      clientRequestId: String(req.body?.clientRequestId || '').trim(),
    });
    noStore(res);
    return res.status(202).json({
      jobId,
      status: 'queued',
      progress: { stage: 'queued', percent: 0, message: 'Research graph is queued…' },
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

exports.listJobs = (req, res) => {
  noStore(res);
  const workspaceId = String(req.query.workspaceId || '').trim();
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required.' });
  return res.json({ jobs: listResearchGraphJobs({
    workspaceId,
    sourcePaperId: String(req.query.sourcePaperId || '').trim(),
  }) });
};

exports.getJob = (req, res) => {
  noStore(res);
  const job = getResearchGraphJob(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'missing', error: 'This research graph job has expired.' });
  return res.json(job);
};

exports.cancelJob = (req, res) => {
  noStore(res);
  if (!cancelResearchGraphJob(req.params.jobId)) {
    return res.status(404).json({ status: 'missing', error: 'This research graph job has expired.' });
  }
  return res.json({ status: 'cancelled' });
};
