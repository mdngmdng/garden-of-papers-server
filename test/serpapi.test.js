const test = require('node:test');
const assert = require('node:assert/strict');

const { extractDoi, normalizeTotalResults } = require('../src/services/serpapi');

test('normalizes SerpAPI Scholar total result counts', () => {
  assert.equal(normalizeTotalResults(700, 30), 700);
  assert.equal(normalizeTotalResults('About 12,345 results', 30), 12345);
  assert.equal(normalizeTotalResults(undefined, 30), 30);
});

test('extracts DOI identifiers from Scholar links', () => {
  assert.equal(
    extractDoi('https://dl.acm.org/doi/10.1145/1234.5678?download=true'),
    '10.1145/1234.5678',
  );
});
