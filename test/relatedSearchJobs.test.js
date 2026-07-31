const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createRelatedSearchJob,
  executeRelatedSearch,
  getRelatedSearchJob,
} = require('../src/services/relatedSearchJobs');

const manuscript = {
  title: 'Gesture Notes in Virtual Reality',
  sections: [
    {
      id: 'abstract',
      heading: 'Abstract',
      text: 'We study bare-hand interaction for spatial notes in virtual reality.',
    },
  ],
};

test('runs Asta, Scholar enrichment, Qwen ranking, and explanations in order', async () => {
  const stages = [];
  const result = await executeRelatedSearch(
    { manuscript, keyword: 'manipulate notes using bare-hand gestures' },
    (next) => stages.push(next.stage),
    {
      planner: async () => ({
        paperDescription: 'Find systems for manipulating notes with bare-hand gestures in virtual reality.',
        scholarQuery: 'virtual reality bare hand gesture notes manipulation',
        researchProfile: 'A virtual-reality note interaction system.',
      }),
      astaService: {
        isConfigured: () => true,
        searchRelatedPapers: async () => [{
          paperId: 's2-one',
          semanticScholarId: 's2-one',
          title: 'Asta Paper',
          authors: [],
          citationCount: 0,
          evidenceSnippets: ['free-hand manipulation evidence'],
          retrievalProvider: 'asta-snippet',
        }],
      },
      scholarRetriever: async () => [{
        paperId: 'scholar-two',
        title: 'Scholar Paper',
        authors: [],
        citationCount: 5,
        evidenceSnippets: [],
        retrievalProvider: 'serpapi-google-scholar',
      }],
      ranker: async (_context, papers) => ({
        provider: 'qwen-reranker',
        results: [...papers].reverse(),
      }),
      explainer: async () => ['first explanation', 'second explanation'],
    },
  );

  assert.deepEqual(stages, [
    'planning',
    'asta_search',
    'scholar_supplement',
    'ranking',
    'explaining',
  ]);
  assert.equal(result.results[0].title, 'Scholar Paper');
  assert.equal(result.results[0].relevanceExplanation, 'first explanation');
  assert.equal(result.provider, 'asta+serpapi-google-scholar+qwen-reranker');
});

test('stores completed search jobs and pages results ten at a time', async () => {
  const results = Array.from({ length: 12 }, (_, index) => ({
    paperId: `paper-${index}`,
    title: `Paper ${index}`,
  }));
  const jobId = createRelatedSearchJob(
    { manuscript, keyword: '' },
    async (_input, report) => {
      report({ stage: 'ranking', percent: 60, message: 'Ranking…' });
      return { results, total: results.length, provider: 'test' };
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const first = getRelatedSearchJob(jobId, 0, 10);
  assert.equal(first.status, 'completed');
  assert.equal(first.results.length, 10);
  assert.equal(first.hasMore, true);
  const second = getRelatedSearchJob(jobId, 10, 10);
  assert.equal(second.results.length, 2);
  assert.equal(second.hasMore, false);
});
