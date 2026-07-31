const crypto = require('node:crypto');
const qwen = require('./qwen');
const { withQwenLock } = require('./semanticIndex');

const MAX_MANUSCRIPT_CHARACTERS = 18_000;
const MAX_RANKING_JOBS = 100;
const RANKING_JOB_TTL_MS = 15 * 60 * 1_000;
const GENERIC_SEARCH_TERMS = new Set([
  'literature',
  'manuscript',
  'paper',
  'papers',
  'related',
  'research',
  'review',
  'reviews',
  'scholarly',
  'studies',
  'study',
  'work',
  'works',
]);
const rankingJobs = new Map();

function normalizeManuscript(manuscript = {}) {
  const title = String(manuscript.title || '').trim();
  const sections = Array.isArray(manuscript.sections)
    ? manuscript.sections
      .map((section) => ({
        id: String(section?.id || '').trim(),
        heading: String(section?.heading || '').trim(),
        text: String(section?.text || '').trim(),
      }))
      .filter((section) => section.heading || section.text)
    : [];
  return { title, sections };
}

function manuscriptText(manuscript) {
  const normalized = normalizeManuscript(manuscript);
  return [
    normalized.title ? `Title: ${normalized.title}` : '',
    ...normalized.sections.map((section) => [
      section.heading ? `Section: ${section.heading}` : '',
      section.text,
    ].filter(Boolean).join('\n')),
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_MANUSCRIPT_CHARACTERS);
}

function fallbackSearchPlan(manuscript, keyword = '') {
  const normalized = normalizeManuscript(manuscript);
  const focus = String(keyword || '').trim();
  const headings = normalized.sections
    .map((section) => section.heading)
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');
  const searchQuery = (
    focus
    || [normalized.title, headings].filter(Boolean).join(' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
  const researchProfile = manuscriptText(normalized).slice(0, 2_500);
  const paperDescription = focus
    ? [
      `Find academic papers that directly investigate this research need: ${focus}.`,
      normalized.title ? `The linked draft is titled "${normalized.title}".` : '',
      researchProfile ? `Use this draft context to disambiguate the request: ${researchProfile}` : '',
    ].filter(Boolean).join(' ')
    : `Find prior academic work closely related to this draft, including its research problem, methods, and application setting: ${researchProfile}`;
  return {
    searchQuery,
    scholarQuery: compactSearchQuery(searchQuery, focus, 8),
    paperDescription: paperDescription.slice(0, 8_000),
    retrievalQueries: [paperDescription.slice(0, 2_500)],
    researchProfile,
  };
}

function queryTerms(value) {
  return String(value || '')
    .match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [];
}

function compactSearchQuery(query, keyword = '', maxTerms = 10) {
  const focusTerms = queryTerms(keyword);
  const terms = [...focusTerms, ...queryTerms(query)];
  const seen = new Set();
  const compact = [];

  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (
      seen.has(normalized)
      || (GENERIC_SEARCH_TERMS.has(normalized)
        && !focusTerms.some((focus) => focus.toLowerCase() === normalized))
    ) {
      continue;
    }
    seen.add(normalized);
    compact.push(term);
    if (compact.length >= Math.max(2, maxTerms)) break;
  }

  return compact.join(' ').trim();
}

function relatedSearchQueries(primaryQuery, manuscript, keyword = '') {
  const fallback = fallbackSearchPlan(manuscript, keyword).searchQuery;
  return [
    compactSearchQuery(primaryQuery, keyword, 10),
    compactSearchQuery(primaryQuery, keyword, 6),
    compactSearchQuery(fallback, keyword, 6),
  ].filter((query, index, queries) =>
    query.length >= 2 && queries.indexOf(query) === index);
}

function paperDocument(result) {
  const evidence = Array.isArray(result.evidenceSnippets)
    ? result.evidenceSnippets.slice(0, 2).join('\n')
    : '';
  return [
    result.title ? `Title: ${result.title}` : '',
    result.authors?.length ? `Authors: ${result.authors.join(', ')}` : '',
    result.year ? `Year: ${result.year}` : '',
    result.venue ? `Venue: ${result.venue}` : '',
    result.abstract ? `Abstract or search excerpt: ${result.abstract}` : '',
    evidence ? `Matching full-text evidence: ${evidence}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizedTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function candidateIdentity(result) {
  const semanticScholarId = String(result.semanticScholarId || '').trim();
  if (semanticScholarId) return `s2:${semanticScholarId.toLowerCase()}`;
  const title = normalizedTitle(result.title);
  return title ? `title:${title}` : `paper:${String(result.paperId || '')}`;
}

function mergePaperCandidates(candidateGroups) {
  const merged = new Map();
  for (const result of candidateGroups.flat()) {
    if (!result?.title) continue;
    const titleIdentity = `title:${normalizedTitle(result.title)}`;
    const idIdentity = candidateIdentity(result);
    const identity = merged.has(idIdentity)
      ? idIdentity
      : merged.has(titleIdentity)
        ? titleIdentity
        : idIdentity;
    const current = merged.get(identity);
    if (!current) {
      const copy = {
        ...result,
        authors: Array.isArray(result.authors) ? result.authors : [],
        evidenceSnippets: Array.isArray(result.evidenceSnippets)
          ? [...new Set(result.evidenceSnippets)].slice(0, 3)
          : [],
      };
      merged.set(identity, copy);
      if (identity !== titleIdentity && !merged.has(titleIdentity)) {
        merged.set(titleIdentity, copy);
      }
      continue;
    }
    current.semanticScholarId ||= result.semanticScholarId;
    if (
      String(current.paperId || '').startsWith('asta-title:')
      && result.paperId
    ) current.paperId = result.paperId;
    current.abstract ||= result.abstract;
    current.url ||= result.url;
    current.openAccessPdfUrl ||= result.openAccessPdfUrl;
    current.citesId ||= result.citesId;
    current.venue ||= result.venue;
    current.year ||= result.year;
    current.citationCount = Math.max(
      Number(current.citationCount || 0),
      Number(result.citationCount || 0),
    );
    if (!current.authors.length && result.authors?.length) {
      current.authors = result.authors;
    }
    current.evidenceSnippets = [...new Set([
      ...current.evidenceSnippets,
      ...(result.evidenceSnippets || []),
    ])].slice(0, 3);
    const providers = new Set(
      [current.retrievalProvider, result.retrievalProvider]
        .flatMap((provider) => String(provider || '').split('+'))
        .filter(Boolean),
    );
    current.retrievalProvider = [...providers].join('+');
  }
  return [...new Set(merged.values())];
}

function dotProduct(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    throw new Error('Qwen paper embedding dimensions do not match');
  }
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  return score;
}

async function rankRelatedPapers(context, results) {
  if (!Array.isArray(results) || results.length < 2) {
    return {
      provider: results.length ? 'scholar-single-result' : 'scholar',
      results: results.map((result) => ({ ...result })),
    };
  }
  const documents = results.map(paperDocument);
  return withQwenLock(async () => {
    const documentEmbeddings = await qwen.embedPaperDocuments(documents);
    const queryEmbedding = await qwen.embedPaperQuery(context);
    if (documentEmbeddings.dimensions !== queryEmbedding.dimensions) {
      throw new Error('Qwen paper query and document dimensions do not match');
    }
    const embedded = results
      .map((result, index) => ({
        result,
        document: documents[index],
        embeddingScore: dotProduct(
          queryEmbedding.embedding,
          documentEmbeddings.embeddings[index],
        ),
      }))
      .sort((left, right) => right.embeddingScore - left.embeddingScore);
    const reranked = await qwen.rerankPapers(
      context,
      embedded.map((candidate) => candidate.document),
    );
    return {
      provider: 'qwen-reranker',
      results: embedded
        .map((candidate, index) => ({
          ...candidate.result,
          embeddingScore: candidate.embeddingScore,
          relevanceScore: reranked.scores[index],
        }))
        .sort((left, right) => right.relevanceScore - left.relevanceScore),
    };
  });
}

function pruneRankingJobs(now = Date.now()) {
  for (const [jobId, job] of rankingJobs) {
    if (now - job.updatedAt > RANKING_JOB_TTL_MS) {
      rankingJobs.delete(jobId);
    }
  }
  while (rankingJobs.size >= MAX_RANKING_JOBS) {
    const oldestJobId = rankingJobs.keys().next().value;
    if (!oldestJobId) break;
    rankingJobs.delete(oldestJobId);
  }
}

function createRelatedPaperRankingJob(
  context,
  results,
  ranker = rankRelatedPapers,
) {
  if (!Array.isArray(results) || results.length < 2) return '';
  pruneRankingJobs();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  rankingJobs.set(jobId, {
    id: jobId,
    status: 'pending',
    provider: 'qwen-pending',
    results: [],
    createdAt: now,
    updatedAt: now,
  });

  setImmediate(async () => {
    const job = rankingJobs.get(jobId);
    if (!job) return;
    job.status = 'running';
    job.updatedAt = Date.now();
    try {
      const ranked = await ranker(context, results);
      Object.assign(job, {
        status: 'ready',
        provider: ranked.provider,
        results: ranked.results,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.warn(`[RelatedWork] Qwen ranking job failed: ${error.message}`);
      Object.assign(job, {
        status: 'failed',
        provider: 'scholar',
        error: 'Qwen ranking was unavailable; Scholar order was preserved.',
        updatedAt: Date.now(),
      });
    }
  });

  return jobId;
}

function getRelatedPaperRankingJob(jobId) {
  pruneRankingJobs();
  const job = rankingJobs.get(String(jobId || ''));
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    provider: job.provider,
    results: job.status === 'ready' ? job.results : [],
    error: job.error || '',
  };
}

module.exports = {
  normalizeManuscript,
  manuscriptText,
  fallbackSearchPlan,
  compactSearchQuery,
  relatedSearchQueries,
  paperDocument,
  normalizedTitle,
  candidateIdentity,
  mergePaperCandidates,
  dotProduct,
  rankRelatedPapers,
  createRelatedPaperRankingJob,
  getRelatedPaperRankingJob,
};
