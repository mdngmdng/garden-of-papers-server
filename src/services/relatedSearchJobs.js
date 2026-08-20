const crypto = require('node:crypto');
const asta = require('./asta');
const grobid = require('./grobid');
const s3 = require('./s3');
const pdfStorage = require('./pdfStorage');
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
  return value === 'claim_support' ? 'claim_support' : '';
}

function validateRelatedSearchInput(input) {
  const keyword = cleanText(input?.keyword, 4_000);
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

function rankingContext(
  plan,
  keyword,
  manuscript,
  relationships,
  searchIntent,
) {
  if (searchIntent === 'claim_support' && keyword) {
    return [
      'Task: rank candidate papers as scholarly evidence for a specific manuscript claim.',
      `Claim requiring evidence: ${keyword}`,
      'Highest priority: the paper must report findings, methods, data, or arguments that directly substantiate the claim. Mere topical, domain, or interface similarity is weak relevance and must rank lower.',
      relationships ? `Required semantic relationships:\n${relationships}` : '',
      `Planned evidence target: ${plan.paperDescription || ''}`,
      `Local manuscript context (disambiguation only; do not broaden away from the claim): ${manuscriptText(manuscript)}`,
    ].filter(Boolean).join('\n');
  }
  return [
    keyword ? `Focused research need: ${keyword}` : 'Whole-manuscript related-work search',
    relationships ? `Required semantic relationships:\n${relationships}` : '',
    `Desired papers: ${plan.paperDescription || ''}`,
    `Draft research profile: ${plan.researchProfile || ''}`,
    `Source document evidence: ${manuscriptText(manuscript)}`,
  ].filter(Boolean).join('\n');
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
    'ranking',
    66,
    `Reranking ${candidates.length} candidate papers against the draft with local Qwen…`,
  ));
  let rankedResults = candidates;
  let qwenRanked = false;
  try {
    const ranked = await (options.ranker || rankRelatedPapers)(
      rankingContext(
        plan,
        keyword,
        manuscript,
        relationships,
        searchIntent,
      ),
      candidates,
    );
    rankedResults = ranked.results;
    qwenRanked = ranked.provider === 'qwen-reranker';
  } catch (error) {
    warnings.push(`Qwen reranking was unavailable; retrieval order was preserved: ${error.message}`);
  }

  onProgress(progress(
    'explaining',
    84,
    'Classifying semantic relationships and writing evidence-grounded explanations…',
  ));
  const assessments = await explainCandidateBatches(
    options.explainer || explainRelatedPaperResults,
    plan.researchProfile,
    keyword,
    rankedResults,
    relationships,
    warnings,
    searchIntent,
  );

  const requestedLabels = [...new Set(
    sourcePapers.map((source) => source.relationship).filter(Boolean),
  )];
  rankedResults = rankedResults.flatMap((paper, index) => {
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
    qwenRanked ? 'qwen-reranker' : '',
  ].filter(Boolean);
  return {
    results: rankedResults,
    total: rankedResults.length,
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
