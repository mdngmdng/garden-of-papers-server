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
].join(',');

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
    const timer = setTimeout(resolve, milliseconds);
    if (typeof timer.unref === 'function') timer.unref();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Asta search was cancelled'));
    }, { once: true });
  });
}

function retryable(error) {
  return /429|rate limit|timed? ?out|timeout|502|503|504|connection|fetch failed/i
    .test(String(error?.message || ''));
}

async function callToolWithRetry(client, name, args, signal) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await client.callTool(
        { name, arguments: args },
        { timeout: config.asta.requestTimeoutMs, signal },
      );
    } catch (error) {
      lastError = error;
      if (attempt > 0 || !retryable(error) || signal?.aborted) throw error;
      await wait(750, signal);
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
  return withClient(async (client) => {
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
  });
}

module.exports = {
  isConfigured,
  parseJsonText,
  toolPayloads,
  collectCandidates,
  normalizePaperCandidate,
  normalizeToolResult,
  mergeAstaPapers,
  searchRelatedPapers,
};
