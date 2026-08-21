const MAX_MANUSCRIPT_CHARACTERS = 18_000;
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

function fallbackSearchPlan(
  manuscript,
  keyword = '',
  relationshipRequirements = '',
  searchIntent = '',
) {
  const normalized = normalizeManuscript(manuscript);
  const focus = String(keyword || '').trim();
  const claimSupport = searchIntent === 'claim_support';
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
  const relationshipFocus = String(relationshipRequirements || '').trim();
  const paperDescription = focus
    ? [
      claimSupport
        ? `Find academic papers whose reported findings, methods, or arguments directly support or substantiate this manuscript claim: ${focus}. Papers that merely share its broad topic are not sufficient.`
        : `Find academic papers that directly investigate this research need: ${focus}.`,
      relationshipFocus,
      normalized.title ? `The linked draft is titled "${normalized.title}".` : '',
      manuscriptText(normalized)
        ? `Use the local draft context only to disambiguate the claim's terminology and domain: ${manuscriptText(normalized).slice(0, 1_800)}.`
        : '',
    ].filter(Boolean).join(' ')
    : [
      relationshipFocus,
      `Find prior academic work closely related to this source document's research problem, methods, claims, and application setting: ${searchQuery}.`,
    ].filter(Boolean).join(' ');
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

module.exports = {
  normalizeManuscript,
  manuscriptText,
  fallbackSearchPlan,
  compactSearchQuery,
  relatedSearchQueries,
  normalizedTitle,
  candidateIdentity,
  mergePaperCandidates,
};
