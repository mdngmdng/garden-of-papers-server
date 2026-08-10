const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTotalResults } = require('../src/services/serpapi');

test('normalizes SerpAPI Scholar total result counts', () => {
  assert.equal(normalizeTotalResults(700, 30), 700);
  assert.equal(normalizeTotalResults('About 12,345 results', 30), 12345);
  assert.equal(normalizeTotalResults(undefined, 30), 30);
});
