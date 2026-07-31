const crypto = require('node:crypto');
const asta = require('./asta');
const { searchScholar } = require('./serpapi');
const {
  fallbackSearchPlan,
  manuscriptText,
  mergePaperCandidates,
  rankRelatedPapers,
  relatedSearchQueries,
} = require('./relatedWork');
const {
  explainRelatedPaperResults,
  prepareRelatedWorkBrief,
} = require('./gemini');

const JOB_TTL_MS = 30 * 60 * 1_000;
const MAX_JOBS = 100;
const jobs = new Map();

function progress(stage, percent, message) {
  return { stage, percent, message };
}

function validateRelatedSearchInput(input) {
  if (manuscriptText(input?.manuscript || {}).length < 20) {
    throw new Error('The linked manuscript does not contain enough text to search.');
  }
}

function updateJob(jobId, changes) {
  const job = jobs.get(jobId);
  if (!job || job.status === 'cancelled') return null;
  Object.assign(job, changes, { updatedAt: Date.now() });
  return job;
}

function pruneJobs(now = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(jobId);
  }
  while (jobs.size >= MAX_JOBS) {
    const oldestJobId = jobs.keys().next().value;
    if (!oldestJobId) break;
    jobs.delete(oldestJobId);
  }
}

function isNoResultsError(error) {
  return /hasn't returned any results|no results/i.test(String(error?.message || ''));
}

async function retrieveScholarCandidates(queries, stopAfterFirst, signal) {
  const pages = [];
  let lastError = null;
  for (const query of queries) {
    if (signal?.aborted) throw signal.reason || new Error('Search was cancelled');
    try {
      const page = await searchScholar(query, 0, 10);
      pages.push(page.results.map((paper) => ({
        ...paper,
        retrievalProvider: 'serpapi-google-scholar',
      })));
      if (stopAfterFirst && page.results.length) break;
    } catch (error) {
      lastError = error;
      if (!isNoResultsError(error)) throw error;
    }
  }
  if (!pages.length && lastError && !isNoResultsError(lastError)) throw lastError;
  return mergePaperCandidates(pages);
}

function rankingContext(plan, keyword) {
  return [
    keyword ? `Focused research need: ${keyword}` : 'Whole-manuscript related-work search',
    `Desired papers: ${plan.paperDescription || ''}`,
    `Draft research profile: ${plan.researchProfile || ''}`,
  ].filter(Boolean).join('\n');
}

async function executeRelatedSearch(input, onProgress = () => {}, options = {}) {
  validateRelatedSearchInput(input);
  const manuscript = input.manuscript || {};
  const keyword = String(input.keyword || '').trim();
  const signal = options.signal;
  const warnings = [];

  onProgress(progress(
    'planning',
    8,
    keyword
      ? 'Turning the focused research description into an evidence search…'
      : 'Reading the linked manuscript and preparing its research profile…',
  ));
  let plan = fallbackSearchPlan(manuscript, keyword);
  try {
    const generated = await (options.planner || prepareRelatedWorkBrief)(
      manuscript,
      keyword,
    );
    if (generated.paperDescription?.length >= 10) {
      plan = { ...plan, ...generated };
    }
  } catch (error) {
    warnings.push(`Gemini search planning fell back to the draft: ${error.message}`);
  }
  if (signal?.aborted) throw signal.reason || new Error('Search was cancelled');

  let astaResults = [];
  let astaAttempted = false;
  if ((options.astaService || asta).isConfigured()) {
    astaAttempted = true;
    onProgress(progress(
      'asta_search',
      25,
      'Searching Asta’s scientific full-text corpus with the complete research description…',
    ));
    try {
      astaResults = await (options.astaService || asta).searchRelatedPapers(
        [plan.paperDescription, ...(plan.retrievalQueries || [])],
        { signal },
      );
    } catch (error) {
      warnings.push(`Asta search was unavailable: ${error.message}`);
    }
  } else {
    warnings.push('ASTA_TOOL_KEY is not configured; Google Scholar fallback was used.');
  }

  onProgress(progress(
    'scholar_supplement',
    astaResults.length ? 48 : 30,
    astaResults.length
      ? 'Adding Google Scholar metadata and coverage…'
      : 'Using Google Scholar while Asta is unavailable…',
  ));
  const scholarQueries = relatedSearchQueries(
    plan.scholarQuery || plan.searchQuery,
    manuscript,
    keyword,
  );
  let scholarResults = [];
  try {
    scholarResults = await (options.scholarRetriever || retrieveScholarCandidates)(
      scholarQueries,
      Boolean(astaResults.length),
      signal,
    );
  } catch (error) {
    warnings.push(`Google Scholar supplement was unavailable: ${error.message}`);
  }

  const candidates = mergePaperCandidates([astaResults, scholarResults]);
  if (signal?.aborted) throw signal.reason || new Error('Search was cancelled');
  if (!candidates.length) {
    return {
      results: [],
      total: 0,
      provider: astaAttempted ? 'asta+scholar-no-results' : 'scholar-fallback-no-results',
      searchMode: keyword ? 'keyword' : 'manuscript',
      retrievalQuery: plan.paperDescription,
      scholarQuery: scholarQueries[0] || '',
      researchProfile: plan.researchProfile,
      warnings,
    };
  }

  onProgress(progress(
    'ranking',
    66,
    `Reranking ${candidates.length} candidate papers against the draft with local Qwen…`,
  ));
  let rankedResults = candidates;
  let qwenRanked = false;
  try {
    const ranked = await (options.ranker || rankRelatedPapers)(
      rankingContext(plan, keyword),
      candidates,
    );
    rankedResults = ranked.results;
    qwenRanked = ranked.provider === 'qwen-reranker';
  } catch (error) {
    warnings.push(`Qwen reranking was unavailable; retrieval order was preserved: ${error.message}`);
  }

  const cappedResults = rankedResults.slice(0, 40);
  onProgress(progress(
    'explaining',
    84,
    'Writing evidence-grounded relevance explanations for the highest-ranked papers…',
  ));
  try {
    const explanations = await (options.explainer || explainRelatedPaperResults)(
      plan.researchProfile,
      keyword,
      cappedResults,
    );
    cappedResults.forEach((paper, index) => {
      if (explanations[index]) paper.relevanceExplanation = explanations[index];
    });
  } catch (error) {
    warnings.push(`Result explanations were unavailable: ${error.message}`);
  }

  const providers = [
    astaResults.length ? 'asta' : '',
    scholarResults.length
      ? astaResults.length
        ? 'serpapi-google-scholar'
        : 'serpapi-google-scholar-fallback'
      : '',
    qwenRanked ? 'qwen-reranker' : '',
  ].filter(Boolean);
  return {
    results: cappedResults,
    total: cappedResults.length,
    provider: providers.join('+') || 'related-work',
    searchMode: keyword ? 'keyword' : 'manuscript',
    retrievalQuery: plan.paperDescription,
    scholarQuery: scholarQueries[0] || '',
    researchProfile: plan.researchProfile,
    warnings,
  };
}

function createRelatedSearchJob(input, runner = executeRelatedSearch) {
  validateRelatedSearchInput(input);
  pruneJobs();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const controller = new AbortController();
  jobs.set(jobId, {
    id: jobId,
    status: 'queued',
    progress: progress('queued', 0, 'Related-work search is queued…'),
    result: null,
    error: '',
    createdAt: now,
    updatedAt: now,
    controller,
  });

  setImmediate(async () => {
    const job = updateJob(jobId, { status: 'running' });
    if (!job) return;
    try {
      const result = await runner(
        input,
        (nextProgress) => updateJob(jobId, { progress: nextProgress }),
        { signal: controller.signal },
      );
      updateJob(jobId, {
        status: 'completed',
        progress: progress('completed', 100, 'Related papers are ready.'),
        result,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(`[RelatedWork] Search job ${jobId} failed: ${error.message}`);
      updateJob(jobId, {
        status: 'failed',
        progress: progress('failed', 100, 'Related-work search failed.'),
        error: error.message || 'Related-work search failed.',
      });
    }
  });

  return jobId;
}

function getRelatedSearchJob(jobId, offset = 0, limit = 10) {
  pruneJobs();
  const job = jobs.get(String(jobId || ''));
  if (!job) return null;
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 10));
  const snapshot = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
  };
  if (job.status !== 'completed' || !job.result) return snapshot;
  const results = job.result.results.slice(safeOffset, safeOffset + safeLimit);
  return {
    ...snapshot,
    ...job.result,
    offset: safeOffset,
    limit: safeLimit,
    results,
    total: job.result.results.length,
    nextOffset: safeOffset + results.length,
    hasMore: safeOffset + results.length < job.result.results.length,
  };
}

function cancelRelatedSearchJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed') return true;
  job.status = 'cancelled';
  job.progress = progress('cancelled', 100, 'Related-work search was cancelled.');
  job.updatedAt = Date.now();
  job.controller.abort(new Error('Related-work search was cancelled'));
  return true;
}

module.exports = {
  validateRelatedSearchInput,
  retrieveScholarCandidates,
  executeRelatedSearch,
  createRelatedSearchJob,
  getRelatedSearchJob,
  cancelRelatedSearchJob,
};
