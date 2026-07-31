const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mergeAstaPapers,
  normalizeToolResult,
  parseJsonText,
} = require('../src/services/asta');

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
