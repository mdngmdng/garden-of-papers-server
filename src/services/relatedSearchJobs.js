const crypto = require('node:crypto');
const asta = require('./asta');
const grobid = require('./grobid');
const s3 = require('./s3');
const pdfStorage = require('./pdfStorage');
const { searchScholar } = require('./serpapi');
const { executePromptSearch } = require('./promptSearch');
const { executeResearchSearch } = require('./research');
const {
  fallbackSearchPlan,
  manuscriptText,
  mergePaperCandidates,
  relatedSearchQueries,
} = require('./relatedWork');
const {
  explainRelatedPaperResults,
  prepareRelatedWorkBrief,
} = require('./gemini');

const JOB_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_JOBS = 200;
const MAX_ACTIVITY_EVENTS = 240;
const jobs = new Map();

function progress(stage, percent, message) {
  return { stage, percent, message };
}

function cleanText(value, maximum = 180_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizeSourcePapers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const id = cleanText(candidate.id, 160);
    const title = cleanText(candidate.title, 500);
    if (!id || !title) return [];
    return [{
      id,
      title,
      authors: Array.isArray(candidate.authors)
        ? candidate.authors.slice(0, 30).map((author) => cleanText(author, 180))
        : [],
      year: cleanText(candidate.year, 20),
      venue: cleanText(candidate.venue, 300),
      abstract: cleanText(candidate.abstract, 12_000),
      sourceText: cleanText(candidate.sourceText),
      projectId: cleanText(candidate.projectId, 240),
      fileId: cleanText(candidate.fileId, 240),
      relationship: cleanText(candidate.relationship, 48),
      direction: candidate.direction === 'outgoing' ? 'outgoing' : 'incoming',
    }];
  });
}

function teiBodyText(teiXml) {
  const body = String(teiXml || '').match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    || String(teiXml || '');
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadStoredSourceText(source, signal) {
  if (source.sourceText.length >= 500 || !source.projectId || !source.fileId) {
    return source.sourceText;
  }
  const teiKey = `tei/${source.projectId}/${source.fileId}.xml`;
  try {
    return teiBodyText(await s3.downloadTeiXml(teiKey));
  } catch {
    const pdfKey = await pdfStorage.resolvePdfS3Key(
      source.projectId,
      source.fileId,
    );
    const pdfBuffer = await s3.downloadPdfBuffer(pdfKey, { abortSignal: signal });
    const teiXml = await grobid.processFulltext(pdfBuffer);
    await s3.uploadTeiXml(teiKey, teiXml);
    return teiBodyText(teiXml);
  }
}

function representativeSourceText(value, maximum = 16_000) {
  const text = cleanText(value, 180_000);
  if (text.length <= maximum) return text;
  const tailSize = Math.floor(maximum * 0.4);
  return `${text.slice(0, maximum - tailSize)}\n\n[Middle omitted]\n\n${text.slice(-tailSize)}`;
}

function sourceSections(source) {
  const metadata = [
    source.authors.length ? `Authors: ${source.authors.join(', ')}` : '',
    source.year ? `Year: ${source.year}` : '',
    source.venue ? `Venue: ${source.venue}` : '',
    source.abstract ? `Abstract: ${source.abstract}` : '',
  ].filter(Boolean).join('\n');
  const text = representativeSourceText(source.sourceText);
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += 3_000) {
    chunks.push(text.slice(offset, offset + 3_000));
  }
  return [
    metadata ? {
      id: `source-${source.id}-metadata`,
      heading: `Source paper: ${source.title}`,
      text: metadata,
    } : null,
    ...chunks.map((chunk, index) => ({
      id: `source-${source.id}-text-${index + 1}`,
      heading: index === 0
        ? `PDF full text: ${source.title}`
        : `PDF full text continued: ${source.title}`,
      text: chunk,
    })),
  ].filter(Boolean);
}

async function prepareSearchInput(input, options = {}) {
  const sources = normalizeSourcePapers(input?.sourcePapers);
  const loader = options.sourceTextLoader || loadStoredSourceText;
  const hydratedSources = await Promise.all(sources.map(async (source) => {
    try {
      return {
        ...source,
        sourceText: await loader(source, options.signal),
      };
    } catch {
      return source;
    }
  }));
  const manuscript = input?.manuscript && typeof input.manuscript === 'object'
    ? input.manuscript
    : {};
  const existingSections = Array.isArray(manuscript.sections)
    ? manuscript.sections
    : [];
  const sourceTitle = hydratedSources.map((source) => source.title).join(' + ');
  return {
    manuscript: {
      ...manuscript,
      title: cleanText(manuscript.title, 500) || sourceTitle || 'AI paper search',
      sections: [
        ...existingSections,
        ...hydratedSources.flatMap(sourceSections),
      ],
    },
    sourcePapers: hydratedSources,
  };
}

function relationshipRequirements(sources) {
  const requirements = sources
    .filter((source) => source.relationship)
    .map((source) =>
      `Candidate papers must have the relationship "${source.relationship}" to source paper "${source.title}".`,
    );
  return requirements.join('\n');
}

function normalizeSearchIntent(value) {
  return ['claim_support', 'claim_evidence', 'prompt_search', 'research'].includes(value) ? value : '';
}

function validateRelatedSearchInput(input) {
  const keyword = cleanText(input?.keyword, 4_000);
  if (input?.searchIntent === 'claim_evidence' || input?.searchIntent === 'prompt_search' || input?.searchIntent === 'research') {
    if (keyword.length < 2) throw new Error('AI 검색할 질문을 입력해 주세요. Enter a research question.');
    if (String(input?.keyword || '').length > 4_000) {
      throw new Error('AI 검색 질문은 4,000자 이내로 입력해 주세요.');
    }
    return;
  }
  const sources = normalizeSourcePapers(input?.sourcePapers);
  if (
    manuscriptText(input?.manuscript || {}).length < 20
    && keyword.length < 2
    && sources.length === 0
  ) {
    throw new Error('Enter a query or link a paper or manuscript to search.');
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
    if (
      !['queued', 'running'].includes(job.status)
      && now - job.updatedAt > JOB_TTL_MS
    ) jobs.delete(jobId);
  }
  while (jobs.size >= MAX_JOBS) {
    const oldestJobId = [...jobs.values()]
      .filter((job) => !['queued', 'running'].includes(job.status))
      .sort((left, right) => left.updatedAt - right.updatedAt)[0]?.id;
    if (!oldestJobId) break;
    jobs.delete(oldestJobId);
  }
}

function normalizeJobMetadata(input) {
  return {
    workspaceId: cleanText(input?.workspaceId, 240),
    sourcePaperId: cleanText(input?.sourcePaperId, 240),
    clientRequestId: cleanText(input?.clientRequestId, 240),
    contextKey: cleanText(input?.contextKey, 2_000),
    query: cleanText(input?.keyword, 4_000),
    searchIntent: cleanText(input?.searchIntent, 80),
  };
}

function mergeCounters(current, incoming, duplicate = false) {
  const next = { ...(current || {}) };
  const additive = new Set(['searchesCompleted', 'pagesOpened', 'papersVerified']);
  for (const [key, rawValue] of Object.entries(incoming || {})) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    next[key] = additive.has(key) && !duplicate
      ? (Number(next[key]) || 0) + value
      : Math.max(Number(next[key]) || 0, value);
  }
  return next;
}

function appendJobActivity(jobId, activity) {
  const job = jobs.get(jobId);
  if (!job || job.status === 'cancelled' || !activity) return null;
  const now = Date.now();
  const normalized = {
    id: crypto.randomUUID(),
    at: new Date(now).toISOString(),
    phase: cleanText(activity.phase, 80) || 'search',
    kind: cleanText(activity.kind, 100) || 'status',
    status: ['active', 'completed', 'error'].includes(activity.status)
      ? activity.status
      : 'active',
    title: cleanText(activity.title, 500),
    detail: cleanText(activity.detail, 2_000),
    query: cleanText(activity.query, 1_000),
    url: cleanText(activity.url, 2_000),
  };
  if (!normalized.title) return null;
  const duplicate = job.events.slice(-12).find((event) =>
    event.kind === normalized.kind
    && event.title === normalized.title
    && event.detail === normalized.detail
    && now - Date.parse(event.at) < 10_000,
  );
  job.counters = mergeCounters(job.counters, activity.counters, Boolean(duplicate));
  job.lastActivityAt = now;
  job.updatedAt = now;
  if (duplicate) return duplicate;
  job.events.push(normalized);
  if (job.events.length > MAX_ACTIVITY_EVENTS) {
    job.events.splice(0, job.events.length - MAX_ACTIVITY_EVENTS);
  }
  return normalized;
}

function updateJobProgress(jobId, nextProgress) {
  const job = updateJob(jobId, { progress: nextProgress });
  if (!job) return null;
  const previous = job.events.at(-1);
  if (
    nextProgress?.message
    && (previous?.kind !== 'progress' || previous.title !== nextProgress.message)
  ) {
    appendJobActivity(jobId, {
      phase: job.metadata.searchIntent === 'research' ? 'research' : 'search',
      kind: 'progress',
      title: nextProgress.message,
      counters: { progressPercent: Number(nextProgress.percent) || 0 },
    });
  }
  return job;
}

function jobSnapshot(job, { includeResult = false, offset = 0, limit = 10 } = {}) {
  const snapshot = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    failureDetails: job.failureDetails,
    workspaceId: job.metadata.workspaceId,
    sourcePaperId: job.metadata.sourcePaperId,
    clientRequestId: job.metadata.clientRequestId,
    contextKey: job.metadata.contextKey,
    query: job.metadata.query,
    searchIntent: job.metadata.searchIntent,
    events: job.events,
    counters: job.counters,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    lastActivityAt: new Date(job.lastActivityAt || job.updatedAt).toISOString(),
  };
  if (!includeResult || job.status !== 'completed' || !job.result) return snapshot;
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 10));
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

async function explainCandidateBatches(
  explainer,
  researchProfile,
  keyword,
  papers,
  relationships,
  warnings,
  searchIntent,
) {
  const assessments = [];
  for (let offset = 0; offset < papers.length; offset += 20) {
    const batch = papers.slice(offset, offset + 20);
    try {
      const explained = await explainer(
        researchProfile,
        keyword,
        batch,
        relationships,
        searchIntent,
      );
      assessments.push(
        ...batch.map((_, index) => explained?.[index] ?? null),
      );
    } catch (error) {
      warnings.push(
        `Result explanations ${offset + 1}-${offset + batch.length} were unavailable: ${error.message}`,
      );
      assessments.push(...batch.map(() => null));
    }
  }
  return assessments;
}

async function executeRelatedSearch(input, onProgress = () => {}, options = {}) {
  validateRelatedSearchInput(input);
  if (input.searchIntent === 'claim_evidence') {
    return require('./claimEvidence').executeClaimEvidenceSearch(input, onProgress, options);
  }
  if (input.searchIntent === 'research') {
    return executeResearchSearch(input, onProgress, options);
  }
  if (input.searchIntent === 'prompt_search') {
    return executePromptSearch(input, onProgress, options);
  }
  const keyword = String(input.keyword || '').trim();
  const searchIntent = normalizeSearchIntent(input.searchIntent);
  const signal = options.signal;
  const warnings = [];
  const prepared = await prepareSearchInput(input, { ...options, signal });
  const manuscript = prepared.manuscript;
  const sourcePapers = prepared.sourcePapers;
  const relationships = relationshipRequirements(sourcePapers);

  onProgress(progress(
    'planning',
    8,
    keyword
      ? 'Turning the focused research description into an evidence search…'
      : 'Reading the linked manuscript and preparing its research profile…',
  ));
  let plan = fallbackSearchPlan(
    manuscript,
    keyword,
    relationships,
    searchIntent,
  );
  try {
    const generated = await (options.planner || prepareRelatedWorkBrief)(
      manuscript,
      keyword,
      relationships,
      searchIntent,
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
      searchMode: searchIntent || (keyword ? 'keyword' : 'manuscript'),
      retrievalQuery: plan.paperDescription,
      scholarQuery: scholarQueries[0] || '',
      researchProfile: plan.researchProfile,
      warnings,
    };
  }

  onProgress(progress(
    'explaining',
    72,
    'Classifying semantic relationships and writing evidence-grounded explanations…',
  ));
  const assessments = await explainCandidateBatches(
    options.explainer || explainRelatedPaperResults,
    plan.researchProfile,
    keyword,
    candidates,
    relationships,
    warnings,
    searchIntent,
  );

  const requestedLabels = [...new Set(
    sourcePapers.map((source) => source.relationship).filter(Boolean),
  )];
  const explainedResults = candidates.flatMap((paper, index) => {
    const assessment = assessments[index];
    const explanation = typeof assessment === 'string'
      ? assessment
      : cleanText(assessment?.text, 500);
    const matchesRequestedRelationship = typeof assessment === 'object'
      ? assessment?.matchesRequestedRelationship
      : undefined;
    if (relationships && matchesRequestedRelationship === false) return [];
    const inferredLabel = cleanText(
      typeof assessment === 'object' ? assessment?.relationship : '',
      48,
    );
    const relationshipLabel = requestedLabels.length === 1
      ? requestedLabels[0]
      : inferredLabel || 'related';
    return [{
      ...paper,
      relevanceExplanation: explanation || paper.relevanceExplanation,
      relationshipLabel,
      relationshipLabelsBySource: Object.fromEntries(
        sourcePapers.map((source) => [
          source.id,
          source.relationship || relationshipLabel,
        ]),
      ),
    }];
  });

  const providers = [
    astaResults.length ? 'asta' : '',
    scholarResults.length
      ? astaResults.length
        ? 'serpapi-google-scholar'
        : 'serpapi-google-scholar-fallback'
      : '',
  ].filter(Boolean);
  return {
    results: explainedResults,
    total: explainedResults.length,
    provider: providers.join('+') || 'related-work',
    searchMode: searchIntent || (keyword ? 'keyword' : 'manuscript'),
    retrievalQuery: plan.paperDescription,
    scholarQuery: scholarQueries[0] || '',
    researchProfile: plan.researchProfile,
    warnings,
  };
}

function createRelatedSearchJob(input, runner = executeRelatedSearch) {
  validateRelatedSearchInput(input);
  pruneJobs();
  const metadata = normalizeJobMetadata(input);
  if (metadata.clientRequestId) {
    const existing = [...jobs.values()].find((job) =>
      job.metadata.clientRequestId === metadata.clientRequestId
      && job.metadata.workspaceId === metadata.workspaceId,
    );
    if (existing) return existing.id;
  }
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const controller = new AbortController();
  jobs.set(jobId, {
    id: jobId,
    status: 'queued',
    progress: progress('queued', 0, 'Related-work search is queued…'),
    result: null,
    error: '',
    failureDetails: null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    metadata,
    events: [],
    counters: {},
    controller,
  });
  appendJobActivity(jobId, {
    phase: metadata.searchIntent === 'research' ? 'research' : 'search',
    kind: 'queued',
    title: metadata.searchIntent === 'research'
      ? 'GPT 논문 조사가 대기열에 들어갔습니다'
      : '논문 검색이 대기열에 들어갔습니다',
    detail: metadata.query,
  });

  setImmediate(async () => {
    const job = updateJob(jobId, { status: 'running' });
    if (!job) return;
    appendJobActivity(jobId, {
      phase: metadata.searchIntent === 'research' ? 'research' : 'search',
      kind: 'started',
      title: metadata.searchIntent === 'research'
        ? '백엔드가 GPT 논문 조사를 시작했습니다'
        : '백엔드가 논문 검색을 시작했습니다',
    });
    try {
      const result = await runner(
        input,
        (nextProgress) => updateJobProgress(jobId, nextProgress),
        {
          signal: controller.signal,
          onActivity: (activity) => appendJobActivity(jobId, activity),
        },
      );
      updateJob(jobId, {
        status: 'completed',
        progress: progress('completed', 100, 'Related papers are ready.'),
        result,
      });
      appendJobActivity(jobId, {
        phase: metadata.searchIntent === 'research' ? 'research' : 'search',
        kind: 'completed',
        status: 'completed',
        title: metadata.searchIntent === 'research'
          ? `검증된 논문 ${result.results?.length || 0}편으로 조사를 완료했습니다`
          : `관련 논문 ${result.results?.length || 0}편을 찾았습니다`,
        counters: { papersReturned: result.results?.length || 0, progressPercent: 100 },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(`[RelatedWork] Search job ${jobId} failed: ${error.message}`);
      updateJob(jobId, {
        status: 'failed',
        progress: progress('failed', 100, 'Related-work search failed.'),
        error: error.message || 'Related-work search failed.',
        failureDetails: error.details || null,
      });
      appendJobActivity(jobId, {
        phase: metadata.searchIntent === 'research' ? 'research' : 'search',
        kind: 'failed',
        status: 'error',
        title: '논문 조사가 완료되지 못했습니다',
        detail: error.message || 'Related-work search failed.',
      });
    }
  });

  return jobId;
}

function getRelatedSearchJob(jobId, offset = 0, limit = 10) {
  pruneJobs();
  const job = jobs.get(String(jobId || ''));
  if (!job) return null;
  return jobSnapshot(job, { includeResult: true, offset, limit });
}

function listRelatedSearchJobs({ workspaceId, sourcePaperId } = {}) {
  pruneJobs();
  const workspace = cleanText(workspaceId, 240);
  const source = cleanText(sourcePaperId, 240);
  if (!workspace) return [];
  return [...jobs.values()]
    .filter((job) =>
      job.metadata.workspaceId === workspace
      && (!source || job.metadata.sourcePaperId === source),
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((job) => jobSnapshot(job));
}

function cancelRelatedSearchJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed') return true;
  job.status = 'cancelled';
  job.progress = progress('cancelled', 100, 'Related-work search was cancelled.');
  job.updatedAt = Date.now();
  job.controller.abort(new Error('Related-work search was cancelled'));
  job.events.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    phase: job.metadata.searchIntent === 'research' ? 'research' : 'search',
    kind: 'cancelled',
    status: 'error',
    title: '사용자가 논문 조사를 취소했습니다',
    detail: '', query: '', url: '',
  });
  return true;
}

module.exports = {
  validateRelatedSearchInput,
  retrieveScholarCandidates,
  executeRelatedSearch,
  createRelatedSearchJob,
  getRelatedSearchJob,
  listRelatedSearchJobs,
  cancelRelatedSearchJob,
};
