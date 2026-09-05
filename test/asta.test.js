const assert = require('node:assert/strict');
const test = require('node:test');
const {
  callToolWithRetry,
  createAstaFetch,
  mergeAstaPapers,
  normalizeGraphReference,
  normalizeToolResult,
  paperRecords,
  parseJsonText,
  parseRetryAfter,
  retryable,
} = require('../src/services/asta');

test('unwraps Asta graph records from structured and text MCP results', () => {
  assert.deepEqual(paperRecords({
    structuredContent: { result: { paperId: 'p1', title: 'Paper One' } },
  }, 'get_paper'), [{ paperId: 'p1', title: 'Paper One' }]);
  assert.deepEqual(paperRecords({
    content: [{
      type: 'text',
      text: '[{"paperId":"p2","title":"Paper Two"}]',
    }],
  }, 'get_paper_batch'), [{ paperId: 'p2', title: 'Paper Two' }]);
});

test('normalizes compact Asta reference-list entries', () => {
  assert.deepEqual(normalizeGraphReference({
    paperId: 'reference-1', title: 'Referenced Paper',
  }), {
    paperId: 'reference-1',
    title: 'Referenced Paper',
    authors: [],
    year: null,
    citationCount: 0,
    doi: '',
    url: '',
  });
});

test('parses JSON embedded in an MCP text content block', () => {
  assert.deepEqual(
    parseJsonText('Asta result:\n{"data":[{"paperId":"p1"}]}'),
    { data: [{ paperId: 'p1' }] },
  );
});

test('normalizes full-text snippet results into paper evidence', () => {
  const papers = normalizeToolResult({
    structuredContent: {
      results: [
        {
          score: 0.92,
          paper: {
            paperId: 'abc123',
            title: 'Bare-Hand Notes in Virtual Reality',
            authors: [{ name: 'A. Author' }],
            year: 2025,
            venue: 'CHI',
          },
          snippet: {
            text: 'Participants manipulated spatial notes with free-hand gestures.',
          },
        },
      ],
    },
    content: [],
  }, 'asta-snippet');

  assert.equal(papers.length, 1);
  assert.equal(papers[0].semanticScholarId, 'abc123');
  assert.deepEqual(papers[0].authors, ['A. Author']);
  assert.match(papers[0].evidenceSnippets[0], /free-hand gestures/);
});

test('merges multiple Asta snippets for the same paper', () => {
  const papers = mergeAstaPapers([
    {
      paperId: 'p1',
      semanticScholarId: 'p1',
      title: 'Spatial Notes',
      authors: [],
      citationCount: 0,
      evidenceSnippets: ['first passage'],
    },
    {
      paperId: 'p1',
      semanticScholarId: 'p1',
      title: 'Spatial Notes',
      authors: ['B. Author'],
      citationCount: 12,
      evidenceSnippets: ['second passage'],
    },
  ]);
  assert.equal(papers.length, 1);
  assert.deepEqual(papers[0].evidenceSnippets, [
    'first passage',
    'second passage',
  ]);
  assert.equal(papers[0].citationCount, 12);
});

test('parses Retry-After seconds and never retries authentication errors', () => {
  assert.equal(parseRetryAfter('2.5'), 2_500);
  assert.equal(retryable({ status: 429 }), true);
  assert.equal(retryable({ status: 503 }), true);
  assert.equal(retryable({ status: 401, message: 'unauthorized' }), false);
});

test('throttled HTTP responses respect Retry-After before retrying', async () => {
  const delays = [];
  let calls = 0;
  const astaFetch = createAstaFetch({
    reserveSlot: async () => {},
    sleep: async (delay) => delays.push(delay),
    random: () => 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '2' },
        });
      }
      return new Response('{}', { status: 200 });
    },
  });
  const response = await astaFetch('https://example.test/mcp');
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2_000]);
});

test('retries tool-level 429 results without retrying invalid requests', async () => {
  let calls = 0;
  const delays = [];
  const client = {
    callTool: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          isError: true,
          content: [{ type: 'text', text: '429 rate limit exceeded' }],
        };
      }
      return { isError: false, structuredContent: { results: [] } };
    },
  };
  const result = await callToolWithRetry(
    client,
    'snippet_search',
    { query: 'virtual reality notes' },
    undefined,
    { sleep: async (delay) => delays.push(delay), random: () => 0 },
  );
  assert.equal(result.isError, false);
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
});
