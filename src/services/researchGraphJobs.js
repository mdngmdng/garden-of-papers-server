const crypto = require('node:crypto');
const { executeResearchGraph, validateResearchBundle } = require('./researchGraph');

const JOB_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_JOBS = 200;
const MAX_ACTIVITY_EVENTS = 240;
const jobs = new Map();

function progress(stage, percent, message) {
  return { stage, percent, message };
}

function pruneJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (
      !['queued', 'running'].includes(job.status)
      && now - job.updatedAt > JOB_TTL_MS
    ) jobs.delete(id);
  }
  while (jobs.size >= MAX_JOBS) {
    const oldestId = [...jobs.values()]
      .filter((job) => !['queued', 'running'].includes(job.status))
      .sort((left, right) => left.updatedAt - right.updatedAt)[0]?.id;
    if (!oldestId) break;
    jobs.delete(oldestId);
  }
}

function updateJob(id, changes) {
  const job = jobs.get(id);
  if (!job || job.status === 'cancelled') return null;
  Object.assign(job, changes, { updatedAt: Date.now() });
  return job;
}

function clean(value, maximum = 2_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function appendActivity(id, activity) {
  const job = jobs.get(id);
  if (!job || job.status === 'cancelled' || !activity?.title) return;
  const now = Date.now();
  const normalized = {
    id: crypto.randomUUID(),
    at: new Date(now).toISOString(),
    phase: 'graph',
    kind: clean(activity.kind, 100) || 'status',
    status: ['active', 'completed', 'error'].includes(activity.status)
      ? activity.status
      : 'active',
    title: clean(activity.title, 500),
    detail: clean(activity.detail, 2_000),
    query: '',
    url: '',
  };
  const duplicate = job.events.slice(-12).find((event) =>
    event.kind === normalized.kind
    && event.title === normalized.title
    && event.detail === normalized.detail
    && now - Date.parse(event.at) < 10_000,
  );
  const additive = new Set(['graphPapersResolved', 'referencesInspected']);
  for (const [key, rawValue] of Object.entries(activity.counters || {})) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    job.counters[key] = additive.has(key) && !duplicate
      ? (Number(job.counters[key]) || 0) + value
      : Math.max(Number(job.counters[key]) || 0, value);
  }
  job.updatedAt = now;
  job.lastActivityAt = now;
  if (duplicate) return;
  job.events.push(normalized);
  if (job.events.length > MAX_ACTIVITY_EVENTS) {
    job.events.splice(0, job.events.length - MAX_ACTIVITY_EVENTS);
  }
}

function updateProgress(id, nextProgress) {
  const job = updateJob(id, { progress: nextProgress });
  if (!job) return;
  const previous = job.events.at(-1);
  if (nextProgress?.message && previous?.title !== nextProgress.message) {
    appendActivity(id, {
      kind: 'progress', title: nextProgress.message,
      counters: { progressPercent: Number(nextProgress.percent) || 0 },
    });
  }
}

function snapshot(job, includeResult = false) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    failureDetails: job.failureDetails,
    workspaceId: job.workspaceId,
    sourcePaperId: job.sourcePaperId,
    clientRequestId: job.clientRequestId,
    events: job.events,
    counters: job.counters,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    lastActivityAt: new Date(job.lastActivityAt || job.updatedAt).toISOString(),
    ...(includeResult && job.status === 'completed' && job.result
      ? { graphBundle: job.result }
      : {}),
  };
}

function createResearchGraphJob(input, runner = executeResearchGraph) {
  validateResearchBundle(input?.researchBundle);
  pruneJobs();
  const workspaceId = clean(input?.workspaceId, 240);
  const sourcePaperId = clean(input?.sourcePaperId, 240);
  const clientRequestId = clean(input?.clientRequestId, 240);
  if (clientRequestId) {
    const existing = [...jobs.values()].find((job) =>
      job.clientRequestId === clientRequestId
      && job.workspaceId === workspaceId
      && !['failed', 'cancelled'].includes(job.status),
    );
    if (existing) return existing.id;
  }
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const now = Date.now();
  jobs.set(id, {
    id,
    status: 'queued',
    progress: progress('queued', 0, 'Research graph is queued…'),
    result: null,
    error: '',
    failureDetails: null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    workspaceId,
    sourcePaperId,
    clientRequestId,
    events: [],
    counters: {},
    controller,
  });
  appendActivity(id, {
    kind: 'queued',
    title: '인용 그래프 검증이 백엔드 대기열에 들어갔습니다',
  });
  setImmediate(async () => {
    if (!updateJob(id, { status: 'running' })) return;
    appendActivity(id, {
      kind: 'started', title: '백엔드가 인용 그래프 검증을 시작했습니다',
    });
    try {
      const result = await runner(
        input,
        (nextProgress) => updateProgress(id, nextProgress),
        { signal: controller.signal, onActivity: (activity) => appendActivity(id, activity) },
      );
      updateJob(id, {
        status: 'completed',
        progress: progress('completed', 100, 'Verified research graph is ready.'),
        result,
      });
      appendActivity(id, {
        kind: 'completed', status: 'completed',
        title: `논문 ${result.nodes?.length || 0}편과 검증된 인용 ${result.edges?.length || 0}개로 그래프를 완성했습니다`,
        counters: {
          graphNodes: result.nodes?.length || 0,
          citationEdgesVerified: result.edges?.length || 0,
          progressPercent: 100,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      updateJob(id, {
        status: 'failed',
        progress: progress('failed', 100, 'Research graph generation failed.'),
        error: error.message || 'Research graph generation failed.',
        failureDetails: error.details || null,
      });
      appendActivity(id, {
        kind: 'failed', status: 'error',
        title: '인용 그래프 검증이 완료되지 못했습니다',
        detail: error.message || 'Research graph generation failed.',
      });
    }
  });
  return id;
}

function getResearchGraphJob(id) {
  pruneJobs();
  const job = jobs.get(String(id || ''));
  if (!job) return null;
  return snapshot(job, true);
}

function listResearchGraphJobs({ workspaceId, sourcePaperId } = {}) {
  pruneJobs();
  const workspace = clean(workspaceId, 240);
  const source = clean(sourcePaperId, 240);
  if (!workspace) return [];
  return [...jobs.values()]
    .filter((job) =>
      job.workspaceId === workspace && (!source || job.sourcePaperId === source),
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((job) => snapshot(job));
}

function cancelResearchGraphJob(id) {
  const job = jobs.get(String(id || ''));
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed') return true;
  job.status = 'cancelled';
  job.progress = progress('cancelled', 100, 'Research graph was cancelled.');
  job.updatedAt = Date.now();
  job.controller.abort(new Error('Research graph was cancelled.'));
  job.events.push({
    id: crypto.randomUUID(), at: new Date().toISOString(), phase: 'graph',
    kind: 'cancelled', status: 'error', title: '사용자가 인용 그래프 생성을 취소했습니다',
    detail: '', query: '', url: '',
  });
  return true;
}

module.exports = {
  cancelResearchGraphJob,
  createResearchGraphJob,
  getResearchGraphJob,
  listResearchGraphJobs,
};
