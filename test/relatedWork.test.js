const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compactSearchQuery,
  createRelatedPaperRankingJob,
  dotProduct,
  fallbackSearchPlan,
  getRelatedPaperRankingJob,
  manuscriptText,
  paperDocument,
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

test('creates paper-level ranking documents from Scholar results', () => {
  const document = paperDocument({
    title: 'Spatial Notes',
    authors: ['A. Researcher'],
    year: 2025,
    venue: 'CHI',
    abstract: 'A hand-gesture note system for immersive environments.',
  });
  assert.match(document, /Title: Spatial Notes/);
  assert.match(document, /Abstract or search excerpt:/);
});

test('computes normalized embedding similarity with a dot product', () => {
  assert.equal(dotProduct([1, 0, 0], [0.25, 0.5, 0.75]), 0.25);
  assert.throws(() => dotProduct([1], [1, 2]), /dimensions/);
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

test('completes Qwen ranking outside the initial search request', async () => {
  const results = [
    { paperId: 'a', title: 'A' },
    { paperId: 'b', title: 'B' },
  ];
  const jobId = createRelatedPaperRankingJob(
    'context',
    results,
    async () => ({
      provider: 'qwen-reranker',
      results: [...results].reverse(),
    }),
  );
  assert.match(jobId, /^[0-9a-f-]{36}$/);
  assert.match(
    getRelatedPaperRankingJob(jobId).status,
    /pending|running|ready/,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(getRelatedPaperRankingJob(jobId), {
    id: jobId,
    status: 'ready',
    provider: 'qwen-reranker',
    results: [...results].reverse(),
    error: '',
  });
});
