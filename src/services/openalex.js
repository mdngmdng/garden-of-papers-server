const { setTimeout: delay } = require('node:timers/promises');
const config = require('../config');

const WORKS_URL = 'https://api.openalex.org/works';
const WORK_FIELDS = 'id,doi,title,publication_year,authorships,primary_location,best_oa_location,locations,cited_by_count,abstract_inverted_index';

function normalizedTitle(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function titleScore(left, right) {
  const a = normalizedTitle(left), b = normalizedTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aa = new Set(a.split(' ').filter(w => w.length > 1));
  const bb = new Set(b.split(' ').filter(w => w.length > 1));
  const overlap = [...aa].filter(w => bb.has(w)).length;
  return overlap ? Math.min(overlap / aa.size, overlap / bb.size) : 0;
}

function normalizedDoi(value) {
  let text = String(value || '').trim();
  try { text = decodeURIComponent(text); } catch { return ''; }
  text = text.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
    .replace(/[?#].*$/, '').replace(/[.,;]+$/, '').toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>]+$/u.test(text) ? text : '';
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

// Derive identifiers from paper-specific locators, never from arbitrary source text.
function paperIdentifiers(paper) {
  const identifiers = [];
  const add = (doi, method) => {
    if (doi && !identifiers.some(item => item.doi === doi)) identifiers.push({ doi, method });
  };
  add(normalizedDoi(paper.doi), 'doi');
  for (const value of [paper.url, ...(Array.isArray(paper.sourceUrls) ? paper.sourceUrls : [])]) {
    try {
      const url = new URL(value);
      if (/^(?:dx\.)?doi\.org$/i.test(url.hostname)) add(normalizedDoi(url.href), 'doi');
      if (/^(?:www\.|export\.)?arxiv\.org$/i.test(url.hostname)) {
        const id = url.pathname.match(/^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?(?:\.pdf)?\/?$/i)?.[1];
        if (id) add(normalizedDoi(`10.48550/arxiv.${id}`), 'arxiv');
      }
      if (/^(?:www\.)?aclanthology\.org$/i.test(url.hostname)) {
        const id = url.pathname.match(/^\/((?:19|20)\d{2}\.[a-z0-9-]+\.\d+)(?:\.pdf)?\/?$/i)?.[1];
        if (id) add(normalizedDoi(`10.18653/v1/${id}`), 'doi');
      }
    } catch { /* Missing or invalid locator; title search remains available. */ }
  }
  return identifiers.slice(0, 4);
}

function authorSurnames(authors) {
  return new Set((authors || []).flatMap(name => {
    const raw = String(name || '').trim();
    const surname = raw.includes(',') ? raw.split(',')[0] : raw.split(/\s+/).at(-1);
    const normalized = normalizedTitle(surname).replace(/ /g, '');
    return normalized ? [normalized] : [];
  }));
}

function authorAgreement(paper, result) {
  const expected = authorSurnames(paper.authors), actual = authorSurnames(result.authors);
  const count = [...expected].filter(name => actual.has(name)).length;
  return { known: expected.size > 0 && actual.size > 0, count,
    fraction: count / Math.max(1, Math.min(expected.size, actual.size)) };
}

function metadataMatches(paper, result, identifier = false) {
  if (paper.year && result.year && Math.abs(paper.year - result.year) > (identifier ? 2 : 1)) return false;
  const authors = authorAgreement(paper, result);
  if (authors.known && !authors.count) return false;
  const score = titleScore(paper.title, result.title);
  if (score === 1 || (score >= 0.85 && authors.count > 0)) return true;
  // A DOI/arXiv record may carry a new title. Require corroborating bylines;
  // an unrelated real DOI in a generated citation must not verify that citation.
  return identifier && authors.count >= 2 && authors.fraction >= 0.6;
}

function normalizeOpenAlexWork(work) {
  if (!work || !/^https:\/\/openalex\.org\/W\d+$/u.test(work.id) || !String(work.title || '').trim()) {
    throw new Error('OpenAlex returned an invalid paper record.');
  }
  const doi = normalizedDoi(work.doi);
  const locations = [work.best_oa_location, work.primary_location, ...(work.locations || [])];
  const words = Object.entries(work.abstract_inverted_index || {}).flatMap(([word, positions]) =>
    Array.isArray(positions) ? positions.filter(p => Number.isSafeInteger(p) && p >= 0).map(position => ({ word, position })) : []);
  return {
    paperId: work.id,
    doi,
    title: work.title.trim(),
    authors: (work.authorships || []).map(a => String(a.raw_author_name || a.author?.display_name || '').trim()).filter(Boolean),
    year: Number.isInteger(work.publication_year) ? work.publication_year : null,
    venue: work.primary_location?.source?.display_name || work.primary_location?.raw_source_name || '',
    citationCount: Number.isFinite(work.cited_by_count) ? work.cited_by_count : 0,
    url: (doi ? `https://doi.org/${doi}` : '') || safeHttpUrl(work.primary_location?.landing_page_url) || work.id,
    abstract: words.sort((a, b) => a.position - b.position).map(item => item.word).join(' '),
    openAccessPdfUrl: locations.map(location => safeHttpUrl(location?.pdf_url)).find(Boolean),
    retrievalProvider: 'openalex',
  };
}

function selectTitleMatch(paper, results) {
  const expectedDoi = normalizedDoi(paper.doi);
  return results.filter(result => metadataMatches(paper, result))
    .sort((a, b) => {
      const rank = result => titleScore(paper.title, result.title) * 10
        + (expectedDoi && result.doi === expectedDoi ? 2 : 0)
        + (result.year === paper.year ? 0.2 : 0)
        + (result.doi && !result.doi.startsWith('10.48550/') ? 0.1 : 0);
      return rank(b) - rank(a);
    })[0] || null;
}

function createOpenAlexClient(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const signal = options.signal;
  const sleep = options.sleep || ((ms, waitSignal) => delay(ms, undefined, { signal: waitSignal }));
  const now = options.now || Date.now;
  const apiKey = options.apiKey ?? config.openalex.apiKey;
  const maxRetries = options.maxRetries ?? 3;
  let retryAt = 0;
  async function request(url, singleton) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      while (retryAt > now()) await sleep(retryAt - now(), signal);
      signal?.throwIfAborted();
      let response, payload;
      try {
        response = await fetchImpl(url, {
          headers: { accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(options.requestTimeoutMs || 20_000)]),
        });
        if (singleton && response.status === 404) return null;
        payload = await response.json();
        if (response.ok) return payload;
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt >= maxRetries) throw new Error('OpenAlex request failed or timed out.', { cause: error });
      }
      const retryable = !response || response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        const error = new Error(`OpenAlex request failed (${response?.status || 'network'}).`);
        error.status = response?.status;
        throw error;
      }
      const retryHeader = response?.headers?.get?.('retry-after');
      const headerSeconds = Number(retryHeader) || Math.max(0, (Date.parse(retryHeader) - now()) / 1000);
      const retrySeconds = Number(payload?.retryAfter) || headerSeconds || (response?.status === 429 ? 15 : 2 ** attempt);
      const retryMs = Math.ceil(Math.max(1, retrySeconds) * 1000);
      if (retryMs > 60_000) throw new Error('OpenAlex is rate-limited. Retry the search later.');
      retryAt = Math.max(retryAt, now() + retryMs);
      options.onRetry?.({ seconds: Math.ceil(retryMs / 1000), status: response?.status || 0 });
    }
  }
  return {
    async lookupDoi(doi) {
      const url = `${WORKS_URL}/https://doi.org/${encodeURIComponent(doi)}`;
      const work = await request(url, true);
      return work ? normalizeOpenAlexWork(work) : null;
    },
    async searchTitle(title) {
      const url = new URL(WORKS_URL);
      url.search = new URLSearchParams({ 'search.title': title, corpus: 'all', per_page: '10', select: WORK_FIELDS });
      const payload = await request(url, false);
      if (!Array.isArray(payload?.results) || !Number.isFinite(payload?.meta?.count)) {
        throw new Error('OpenAlex returned invalid search results.');
      }
      return payload.results.map(normalizeOpenAlexWork);
    },
  };
}

async function verifyOpenAlexPaper(paper, { client, signal } = {}) {
  const service = client || createOpenAlexClient({ signal });
  const errors = [];
  const run = async operation => {
    signal?.throwIfAborted();
    try {
      const result = await operation();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(String(error.message || 'OpenAlex request failed.').slice(0, 300));
      return null;
    }
  };
  for (const { doi, method } of paperIdentifiers(paper)) {
    const record = await run(() => service.lookupDoi(doi));
    if (record && record.doi === doi && metadataMatches(paper, record, true)) {
      return { status: 'verified', provider: 'openalex', method, record };
    }
  }
  const results = await run(() => service.searchTitle(paper.title));
  const record = results && selectTitleMatch(paper, results);
  if (record) return { status: 'verified', provider: 'openalex', method: 'title', record };
  return { status: errors.length ? 'error' : 'not_found', provider: 'openalex', errors };
}

module.exports = { createOpenAlexClient, verifyOpenAlexPaper, normalizeOpenAlexWork, paperIdentifiers, selectTitleMatch };
