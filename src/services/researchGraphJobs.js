const crypto = require('node:crypto');
const { executeResearchGraph, validateResearchBundle } = require('./researchGraph');

const JOB_TTL_MS = 30 * 60 * 1_000;
const MAX_JOBS = 100;
const jobs = new Map();

function progress(stage, percent, message) {
  return { stage, percent, message };
}

function pruneJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);
}

function updateJob(id, changes) {
  const job = jobs.get(id);
  if (!job || job.status === 'cancelled') return null;
  Object.assign(job, changes, { updatedAt: Date.now() });
  return job;
}

function createResearchGraphJob(input, runner = executeResearchGraph) {
  validateResearchBundle(input?.researchBundle);
  pruneJobs();
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const now = Date.now();
  jobs.set(id, {
    id,
    status: 'queued',
    progress: progress('queued', 0, 'Research graph is queued…'),
    result: null,
    error: '',
    createdAt: now,
    updatedAt: now,
    controller,
  });
  setImmediate(async () => {
    if (!updateJob(id, { status: 'running' })) return;
    try {
      const result = await runner(
        input,
        (nextProgress) => updateJob(id, { progress: nextProgress }),
        { signal: controller.signal },
      );
      updateJob(id, {
        status: 'completed',
        progress: progress('completed', 100, 'Verified research graph is ready.'),
        result,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      updateJob(id, {
        status: 'failed',
        progress: progress('failed', 100, 'Research graph generation failed.'),
        error: error.message || 'Research graph generation failed.',
      });
    }
  });
  return id;
}

function getResearchGraphJob(id) {
  pruneJobs();
  const job = jobs.get(String(id || ''));
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    ...(job.status === 'completed' && job.result ? { graphBundle: job.result } : {}),
  };
}

function cancelResearchGraphJob(id) {
  const job = jobs.get(String(id || ''));
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed') return true;
  job.status = 'cancelled';
  job.progress = progress('cancelled', 100, 'Research graph was cancelled.');
  job.updatedAt = Date.now();
  job.controller.abort(new Error('Research graph was cancelled.'));
  return true;
}

module.exports = {
  cancelResearchGraphJob,
  createResearchGraphJob,
  getResearchGraphJob,
};
