const test = require('node:test');
const assert = require('node:assert/strict');
const { cachedReferenceMatches } = require('../src/services/refEnricher');

test('rejects a cached Scholar identity that conflicts with extracted metadata', () => {
  const reference = {
    title: 'A mark-based interaction paradigm for free-hand drawing',
    authors: ['T. Baudel'],
    year: '1994',
  };

  assert.equal(cachedReferenceMatches(reference, {
    matchedTitle: 'Interactive techniques for implicit modeling',
    matchedAuthors: ['J. Bloomenthal'],
    matchedYear: 1990,
  }), false);
});

test('accepts a cached Scholar identity only when title, year, and author agree', () => {
  const reference = {
    title: 'Attention is all you need',
    authors: ['Ashish Vaswani'],
    year: '2017',
  };

  assert.equal(cachedReferenceMatches(reference, {
    matchedTitle: 'Attention Is All You Need',
    matchedAuthors: ['A. Vaswani', 'N. Shazeer'],
    matchedYear: 2017,
  }), true);
});
