const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAtlasPaper } = require('../src/services/atlasImport');

test('normalizes a Topic Atlas record for the GOP board', () => {
  assert.deepEqual(
    normalizeAtlasPaper({
      doi: 'https://doi.org/10.1145/1234.5678',
      title: 'A Seed Paper',
      authors: 'Ada Lovelace; Alan Turing',
      year: 2022,
      venue: 'CHI',
      citations: 17,
    }),
    {
      paperId: 'atlas:10.1145/1234.5678',
      doi: '10.1145/1234.5678',
      title: 'A Seed Paper',
      authors: ['Ada Lovelace', 'Alan Turing'],
      year: 2022,
      venue: 'CHI',
      citationCount: 17,
      abstract: '',
      url: 'https://doi.org/10.1145/1234.5678',
      openAccessPdfUrl: '',
      retrievalProvider: 'topic-atlas',
    },
  );
});

test('rejects an Atlas handoff without a DOI or title', () => {
  assert.throws(() => normalizeAtlasPaper({}), /DOI or paper title/);
});
