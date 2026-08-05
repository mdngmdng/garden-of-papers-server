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

test('keeps every ranked candidate instead of truncating results at forty', async () => {
  const explainedBatchSizes = [];
  const astaResults = Array.from({ length: 45 }, (_, index) => ({
    paperId: `asta-${index}`,
    title: `Asta Paper ${index}`,
    authors: [],
    citationCount: 0,
    evidenceSnippets: [],
    retrievalProvider: 'asta-snippet',
  }));
  const result = await executeRelatedSearch(
    { manuscript, keyword: '' },
    () => {},
    {
      planner: async () => ({
        paperDescription: 'Find virtual-reality note interaction systems.',
        scholarQuery: 'virtual reality note interaction',
        researchProfile: 'A virtual-reality note interaction system.',
      }),
      astaService: {
        isConfigured: () => true,
        searchRelatedPapers: async () => astaResults,
      },
      scholarRetriever: async () => [],
      ranker: async (_context, papers) => ({
        provider: 'qwen-reranker',
        results: [...papers].reverse(),
      }),
      explainer: async (_profile, _keyword, papers) => {
        explainedBatchSizes.push(papers.length);
        return papers.map(() => ({
          relationship: 'similar',
          text: 'Semantically related.',
        }));
      },
    },
  );

  assert.equal(result.results.length, 45);
  assert.equal(result.total, 45);
  assert.equal(result.results[0].paperId, 'asta-44');
  assert.equal(result.results.at(-1).paperId, 'asta-0');
  assert.deepEqual(explainedBatchSizes, [20, 20, 5]);
  assert.equal(result.results.every((paper) => paper.relationshipLabel === 'similar'), true);
});

test('uses a linked PDF as Qwen context and sends only planned queries to Asta', async () => {
  const sourceText = [
    'The source paper claims that spatial gestures reduce task completion time.',
    'Its controlled experiment reports a significant improvement over controllers.',
  ].join(' ');
  let astaQueries = [];
  let qwenContext = '';
  const result = await executeRelatedSearch(
    {
      manuscript: {},
      keyword: '',
      sourcePapers: [{
        id: 'source-a',
        title: 'Spatial Gesture Notes',
        authors: ['Author A'],
        abstract: 'A study of spatial gesture note interaction.',
        sourceText,
        relationship: 'contract',
        direction: 'incoming',
      }],
    },
    () => {},
    {
      planner: async (document, _keyword, relationships) => {
        assert.match(
          document.sections.map((section) => section.text).join(' '),
          /reduce task completion time/,
        );
        assert.match(relationships, /"contract"/);
        return {
          paperDescription: 'Find evidence opposing the source claim about spatial gestures.',
          retrievalQueries: ['Studies finding no benefit from spatial gestures.'],
          scholarQuery: 'spatial gesture performance contrary evidence',
          researchProfile: 'The source claims spatial gestures improve performance.',
        };
      },
      astaService: {
        isConfigured: () => true,
        searchRelatedPapers: async (queries) => {
          astaQueries = queries;
          return [
            {
              paperId: 'matching-paper',
              title: 'No Benefit from Spatial Gestures',
              authors: [],
              citationCount: 0,
              evidenceSnippets: ['No significant benefit was observed.'],
            },
            {
              paperId: 'unrelated-paper',
              title: 'Unrelated Paper',
              authors: [],
              citationCount: 0,
              evidenceSnippets: [],
            },
          ];
        },
      },
      scholarRetriever: async () => [],
      ranker: async (context, papers) => {
        qwenContext = context;
        return { provider: 'qwen-reranker', results: papers };
      },
      explainer: async () => [
        {
          relationship: 'contract',
          matchesRequestedRelationship: true,
          text: 'The candidate reports a contrary result.',
        },
        {
          relationship: 'related',
          matchesRequestedRelationship: false,
          text: 'The evidence does not establish the requested relationship.',
        },
      ],
    },
  );

  assert.deepEqual(astaQueries, [
    'Find evidence opposing the source claim about spatial gestures.',
    'Studies finding no benefit from spatial gestures.',
  ]);
  assert.equal(astaQueries.some((query) => query.includes(sourceText)), false);
  assert.match(qwenContext, /reduce task completion time/);
  assert.match(qwenContext, /Required semantic relationships/);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].relationshipLabel, 'contract');
  assert.deepEqual(result.results[0].relationshipLabelsBySource, {
    'source-a': 'contract',
  });
});
