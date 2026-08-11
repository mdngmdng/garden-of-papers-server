const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const config = require('../config');

const PAPER_FIELDS = [
  'abstract',
  'authors',
  'year',
  'venue',
  'url',
  'isOpenAccess',
  'journal',
  'tldr',
  'externalIds',
].join(',');

let nextAstaRequestAt = 0;
let rateReservationTail = Promise.resolve();
let activeSearches = 0;
const pendingSearches = [];

function isConfigured() {
  return Boolean(config.asta.apiKey && config.asta.endpoint);
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJsonText(value) {
  const text = asText(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const firstObject = text.indexOf('{');
    const firstArray = text.indexOf('[');
    const start = [firstObject, firstArray]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    if (start === undefined) return null;
    const end = text[start] === '{' ? text.lastIndexOf('}') : text.lastIndexOf(']');
    if (end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function toolPayloads(result) {
  const payloads = [];
  if (result?.structuredContent) payloads.push(result.structuredContent);
  for (const content of result?.content || []) {
    if (content?.type === 'text') {
      const parsed = parseJsonText(content.text);
      if (parsed !== null) payloads.push(parsed);
    }
  }
  return payloads;
}

function looksLikePaperCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const paper = value.paper && typeof value.paper === 'object'
    ? value.paper
    : value;
  return Boolean(
    paper.paperId
    || paper.paper_id
    || paper.corpusId
    || paper.title
    || value.snippet
    || value.snippetText
    || value.text,
  );
}

function collectCandidates(value, output = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (looksLikePaperCandidate(item)) output.push(item);
      else collectCandidates(item, output, seen);
    }
    return output;
  }
  if (looksLikePaperCandidate(value)) output.push(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      collectCandidates(nested, output, seen);
    }
  }
  return output;
}

function authorNames(authors) {
  if (!Array.isArray(authors)) return [];
  return authors
    .map((author) => typeof author === 'string' ? author : author?.name)
    .map((author) => asText(author))
    .filter(Boolean);
}

function firstText(...values) {
  return values.map(asText).find(Boolean) || '';
}

function normalizePaperCandidate(candidate, source) {
  const nestedSnippet = candidate?.snippet && typeof candidate.snippet === 'object'
    ? candidate.snippet
    : null;
  const paper = candidate?.paper && typeof candidate.paper === 'object'
    ? candidate.paper
    : nestedSnippet?.paper && typeof nestedSnippet.paper === 'object'
      ? nestedSnippet.paper
      : candidate;
  const snippet = firstText(
    typeof candidate?.snippet === 'string' ? candidate.snippet : '',
    nestedSnippet?.text,
    nestedSnippet?.snippet,
    nestedSnippet?.content,
    candidate?.snippetText,
    candidate?.text,
    candidate?.content,
    candidate?.passage,
  );
  const paperId = firstText(
    paper?.paperId,
    paper?.paper_id,
    paper?.id,
    paper?.corpusId ? `CorpusId:${paper.corpusId}` : '',
    candidate?.paperId,
    candidate?.paper_id,
  );
  const title = firstText(
    paper?.title,
    candidate?.paperTitle,
    candidate?.paper_title,
  );
  if (!paperId && !title) return null;
  const tldr = typeof paper?.tldr === 'object' ? paper.tldr.text : paper?.tldr;
  const journal = typeof paper?.journal === 'object'
    ? paper.journal.name
    : paper?.journal;
  const openAccessPdf = typeof paper?.openAccessPdf === 'object'
    ? paper.openAccessPdf.url
    : paper?.openAccessPdf;
  return {
    paperId: paperId || `asta-title:${title.toLowerCase()}`,
    semanticScholarId: paperId,
    doi: firstText(
      paper?.externalIds?.DOI,
      paper?.externalIds?.doi,
      paper?.doi,
      candidate?.doi,
    ).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase(),
    title: title || 'Untitled paper',
    authors: authorNames(paper?.authors || candidate?.authors),
    year: Number(paper?.year || candidate?.year) || null,
    venue: firstText(paper?.venue, journal, candidate?.venue),
    citationCount: Number(
      paper?.citationCount
      || paper?.citation_count
      || candidate?.citationCount
      || 0,
    ),
    url: firstText(paper?.url, candidate?.url),
    abstract: firstText(paper?.abstract, tldr, snippet),
    openAccessPdfUrl: firstText(openAccessPdf, candidate?.openAccessPdfUrl),
    evidenceSnippets: snippet ? [snippet.slice(0, 4_000)] : [],
    retrievalProvider: source,
    astaScore: Number(candidate?.score ?? candidate?.relevanceScore) || undefined,
  };
}

function paperIdentity(paper) {
  const id = asText(paper.semanticScholarId || paper.paperId).toLowerCase();
  if (id && !id.startsWith('asta-title:')) return `id:${id}`;
  return `title:${asText(paper.title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')}`;
}

function mergeAstaPapers(papers) {
  const merged = new Map();
  for (const paper of papers) {
    if (!paper) continue;
    const identity = paperIdentity(paper);
    const current = merged.get(identity);
    if (!current) {
      merged.set(identity, paper);
      continue;
    }
    current.abstract ||= paper.abstract;
    current.doi ||= paper.doi;
    current.url ||= paper.url;
    current.openAccessPdfUrl ||= paper.openAccessPdfUrl;
    current.venue ||= paper.venue;
    current.year ||= paper.year;
    current.citationCount = Math.max(current.citationCount, paper.citationCount);
    if (!current.authors.length) current.authors = paper.authors;
    current.evidenceSnippets = [...new Set([
      ...current.evidenceSnippets,
      ...paper.evidenceSnippets,
    ])].slice(0, 3);
    if (paper.astaScore !== undefined) {
      current.astaScore = Math.max(current.astaScore ?? -Infinity, paper.astaScore);
    }
  }
  return [...merged.values()];
}

function normalizeToolResult(result, source) {
  if (result?.isError) {
    const detail = (result.content || [])
      .filter((content) => content?.type === 'text')
      .map((content) => content.text)
      .join(' ')
      .trim();
    throw new Error(detail || `Asta ${source} reported an error`);
  }
  const candidates = toolPayloads(result)
    .flatMap((payload) => collectCandidates(payload));
  return mergeAstaPapers(
    candidates.map((candidate) => normalizePaperCandidate(candidate, source)),
  );
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Asta search was cancelled'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Asta search was cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.data?.status,
    error?.data?.statusCode,
    error?.cause?.status,
    error?.cause?.statusCode,
  ];
  return candidates.map(Number).find(Number.isFinite) || 0;
}

function retryable(error) {
  const status = errorStatus(error);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (status >= 400 && status <= 499) return false;
  return /429|too many requests|rate limit|temporar|timed? ?out|timeout|502|503|504|connection|fetch failed|socket/i
    .test(String(error?.message || error || ''));
}

function parseRetryAfter(value, now = Date.now()) {
  const normalized = String(value || '').trim();
  if (!normalized) return 0;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(normalized);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function retryAfterFromError(error) {
  const explicit = Number(
    error?.retryAfterMs
    || error?.data?.retryAfterMs
    || error?.cause?.retryAfterMs,
  );
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const headers = error?.response?.headers || error?.data?.headers;
  if (headers?.get) return parseRetryAfter(headers.get('retry-after'));
  if (headers && typeof headers === 'object') {
    return parseRetryAfter(headers['retry-after'] || headers['Retry-After']);
  }
  const match = String(error?.message || '').match(
    /retry[- ]after[^0-9]*([0-9]+(?:\.[0-9]+)?)/i,
  );
  return match ? Math.ceil(Number(match[1]) * 1_000) : 0;
}

function retryDelay(attempt, retryAfterMs = 0, random = Math.random) {
  const exponential = Math.min(
    config.asta.retryMaxMs,
    config.asta.retryBaseMs * (2 ** attempt),
  );
  const jittered = exponential * (0.5 + Math.max(0, Math.min(1, random())) * 0.5);
  return Math.ceil(Math.max(retryAfterMs, jittered));
}

async function reserveAstaRequestSlot(
  signal,
  { now = Date.now, sleep = wait } = {},
) {
  let releaseReservation;
  const previous = rateReservationTail;
  rateReservationTail = new Promise((resolve) => {
    releaseReservation = resolve;
  });
  await previous;
  try {
    if (signal?.aborted) {
      throw signal.reason || new Error('Asta search was cancelled');
    }
    const current = now();
    const spacing = Math.ceil(1_000 / config.asta.maxRequestsPerSecond);
    const reservedAt = Math.max(current, nextAstaRequestAt);
    nextAstaRequestAt = reservedAt + spacing;
    if (reservedAt > current) await sleep(reservedAt - current, signal);
  } finally {
    releaseReservation();
  }
}

function releaseSearchSlot() {
  const next = pendingSearches.shift();
  if (next) {
    next.signal?.removeEventListener('abort', next.onAbort);
    next.resolve(releaseSearchSlot);
    return;
  }
  activeSearches = Math.max(0, activeSearches - 1);
}

function acquireSearchSlot(signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('Asta search was cancelled'));
  }
  if (activeSearches < config.asta.maxConcurrentSearches) {
    activeSearches += 1;
    return Promise.resolve(releaseSearchSlot);
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, onAbort: null };
    entry.onAbort = () => {
      const index = pendingSearches.indexOf(entry);
      if (index >= 0) pendingSearches.splice(index, 1);
      reject(signal.reason || new Error('Asta search was cancelled'));
    };
    signal?.addEventListener('abort', entry.onAbort, { once: true });
    pendingSearches.push(entry);
  });
}

async function withSearchSlot(signal, callback) {
  const release = await acquireSearchSlot(signal);
  try {
    return await callback();
  } finally {
    release();
  }
}

function createAstaFetch({
  fetchImpl = fetch,
  reserveSlot = reserveAstaRequestSlot,
  sleep = wait,
  random = Math.random,
  onRetry = () => {},
} = {}) {
  return async (input, init = {}) => {
    const signal = init.signal || input?.signal;
    let lastError;
    for (let attempt = 0; attempt <= config.asta.maxRetries; attempt += 1) {
      await reserveSlot(signal);
      try {
        const response = await fetchImpl(input, init);
        if (
          response.status !== 429
          && (response.status < 500 || response.status > 599)
        ) return response;
        if (attempt >= config.asta.maxRetries) return response;
        const retryAfterMs = parseRetryAfter(
          response.headers?.get?.('retry-after'),
        );
        const delay = retryDelay(attempt, retryAfterMs, random);
        onRetry({ attempt: attempt + 1, delay, status: response.status });
        if (response.body?.cancel) {
          await response.body.cancel().catch(() => {});
        }
        await sleep(delay, signal);
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt >= config.asta.maxRetries || !retryable(error)) {
          throw error;
        }
        const delay = retryDelay(attempt, retryAfterFromError(error), random);
        onRetry({ attempt: attempt + 1, delay, status: errorStatus(error) });
        await sleep(delay, signal);
      }
    }
    throw lastError || new Error('Asta request failed after retries');
  };
}

function toolErrorDetail(result) {
  if (!result?.isError) return '';
  return (result.content || [])
    .filter((content) => content?.type === 'text')
    .map((content) => content.text)
    .join(' ')
    .trim();
}

async function callToolWithRetry(
  client,
  name,
  args,
  signal,
  { sleep = wait, random = Math.random } = {},
) {
  let lastError;
  for (let attempt = 0; attempt <= config.asta.maxRetries; attempt += 1) {
    try {
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: config.asta.requestTimeoutMs, signal },
      );
      const detail = toolErrorDetail(result);
      if (detail && retryable(new Error(detail))) {
        const error = new Error(detail);
        error.astaToolLevel = true;
        if (/429|too many requests|rate limit/i.test(detail)) error.status = 429;
        throw error;
      }
      return result;
    } catch (error) {
      lastError = error;
      const retryLimit = error?.astaToolLevel
        ? config.asta.maxRetries
        : Math.min(1, config.asta.maxRetries);
      if (
        attempt >= retryLimit
        || !retryable(error)
        || signal?.aborted
      ) throw error;
      const delay = retryDelay(attempt, retryAfterFromError(error), random);
      console.warn(
        `[Asta] ${name} temporarily unavailable; retry ${attempt + 1}/${retryLimit} in ${delay}ms`,
      );
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

async function withClient(callback) {
  if (!isConfigured()) {
    throw new Error('ASTA_TOOL_KEY not configured');
  }
  const transport = new StreamableHTTPClientTransport(
    new URL(config.asta.endpoint),
    {
      requestInit: {
        headers: {
          accept: 'application/json, text/event-stream',
          'x-api-key': config.asta.apiKey,
        },
      },
      fetch: createAstaFetch({
        onRetry: ({ attempt, delay, status }) => {
          console.warn(
            `[Asta] HTTP ${status || 'network'}; retry ${attempt}/${config.asta.maxRetries} in ${delay}ms`,
          );
        },
      }),
    },
  );
  const client = new Client({
    name: 'garden-of-papers-server',
    version: '1.0.0',
  });
  client.onerror = (error) => {
    console.warn(`[Asta] MCP transport warning: ${error.message}`);
  };
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function searchRelatedPapers(descriptions, { signal } = {}) {
  const queries = (Array.isArray(descriptions) ? descriptions : [descriptions])
    .map((description) => asText(description).slice(0, 8_000))
    .filter((description, index, values) =>
      description.length >= 2 && values.indexOf(description) === index)
    .slice(0, 2);
  if (!queries.length) return [];
  return withSearchSlot(signal, () => withClient(async (client) => {
    const snippetResult = await callToolWithRetry(client, 'snippet_search', {
      query: queries[0],
      limit: Math.max(1, Math.min(100, config.asta.snippetLimit)),
    }, signal);
    const relevanceResult = await callToolWithRetry(
      client,
      'search_papers_by_relevance',
      {
        keyword: queries[0],
        fields: PAPER_FIELDS,
        limit: Math.max(1, Math.min(100, config.asta.relevanceLimit)),
      },
      signal,
    );
    let papers = mergeAstaPapers([
      ...normalizeToolResult(snippetResult, 'asta-snippet'),
      ...normalizeToolResult(relevanceResult, 'asta-relevance'),
    ]);
    if (papers.length < 20 && queries[1]) {
      const supplemental = await callToolWithRetry(client, 'snippet_search', {
        query: queries[1],
        limit: Math.max(1, Math.min(50, config.asta.snippetLimit)),
      }, signal);
      papers = mergeAstaPapers([
        ...papers,
        ...normalizeToolResult(supplemental, 'asta-snippet'),
      ]);
    }
    return papers;
  }));
}

module.exports = {
  isConfigured,
  parseJsonText,
  toolPayloads,
  collectCandidates,
  normalizePaperCandidate,
  normalizeToolResult,
  mergeAstaPapers,
  errorStatus,
  retryable,
  parseRetryAfter,
  retryDelay,
  reserveAstaRequestSlot,
  createAstaFetch,
  callToolWithRetry,
  searchRelatedPapers,
};
