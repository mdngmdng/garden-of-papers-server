const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compactSearchQuery,
  fallbackSearchPlan,
  manuscriptText,
  relatedSearchQueries,
} = require('../src/services/relatedWork');

const manuscript = {
  title: 'Gesture Notes in Virtual Reality',
  sections: [
    {
      id: 'abstract',
      heading: 'Abstract',
      text: 'We study bare-hand interaction for spatial notes in virtual reality.',
    },
    {
      id: 'related',
      heading: 'Related Work',
      text: 'Prior systems use controllers and mid-air gestures.',
    },
  ],
};

test('builds a broad fallback query from the linked manuscript', () => {
  const plan = fallbackSearchPlan(manuscript);
  assert.match(plan.searchQuery, /Gesture Notes in Virtual Reality/);
  assert.match(plan.searchQuery, /Related Work/);
  assert.match(plan.researchProfile, /bare-hand interaction/);
});

test('uses a search-paper keyword as the primary fallback query', () => {
  const plan = fallbackSearchPlan(
    manuscript,
    'bare hand gesture note manipulation in virtual reality',
  );
  assert.equal(
    plan.searchQuery,
    'bare hand gesture note manipulation in virtual reality',
  );
});

test('makes direct claim support stricter than broad topical similarity', () => {
  const plan = fallbackSearchPlan(
    manuscript,
    'Direct manipulation reduces navigation overhead.',
    '',
    'claim_support',
  );
  assert.match(plan.paperDescription, /directly support or substantiate/);
  assert.match(plan.paperDescription, /merely share its broad topic are not sufficient/);
  assert.match(plan.paperDescription, /local draft context only to disambiguate/);
});

test('preserves manuscript section ids for collection placement', () => {
  const text = manuscriptText(manuscript);
  assert.match(text, /Section: Abstract/);
  assert.match(text, /Section: Related Work/);
});

test('compacts an overlong Scholar query and removes generic terms', () => {
  const compact = compactSearchQuery(
    'related work literature review academic writing research synthesis graph visualization interactive systems paper landscape LLM AI assisted writing',
  );
  assert.equal(
    compact,
    'academic writing synthesis graph visualization interactive systems landscape LLM AI',
  );
  assert.equal(compact.split(' ').length, 10);
});

test('keeps the focused keyword first and creates a shorter fallback query', () => {
  const queries = relatedSearchQueries(
    'academic writing graph visualization LLM knowledge organization',
    manuscript,
    'text direct manipulation',
  );
  assert.equal(
    queries[0],
    'text direct manipulation academic writing graph visualization LLM knowledge organization',
  );
  assert.equal(queries[1], 'text direct manipulation academic writing graph');
});
