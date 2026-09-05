const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canonicalMatchesPaper,
  executeResearchGraph,
  normalizeGraphPapers,
  referenceMatchesTarget,
} = require('../src/services/researchGraph');
const {
  createResearchGraphJob,
  getResearchGraphJob,
  listResearchGraphJobs,
} = require('../src/services/researchGraphJobs');

const bundle = {
  version: 1,
  id: 'bundle-1',
  originalPrompt: 'Map this field',
  papers: [
    {
      researchPaperId: 'research-a', paperId: 'scholar-a', title: 'Paper A',
      authors: ['A'], year: 2024, doi: '10.1/a', url: 'https://a.test',
      inclusionReason: 'Recent synthesis', supportedClaims: [], verified: true,
    },
    {
      researchPaperId: 'research-b', paperId: 'scholar-b', title: 'Paper B',
      authors: ['B'], year: 2020, doi: '10.1/b', url: 'https://b.test',
      inclusionReason: 'Seminal method', supportedClaims: [], verified: true,
    },
    {
      researchPaperId: 'research-x', paperId: '', title: 'Unverified',
      verified: false,
    },
  ],
};

test('creates only citation edges found in the citing paper reference list', async () => {
  const graph = await executeResearchGraph({ researchBundle: bundle }, () => {}, {
    semanticScholarService: {
      lookupByDoi: async (doi) => ({
        paperId: doi.endsWith('/a') ? 's2-a' : 's2-b',
        title: doi.endsWith('/a') ? 'Paper A' : 'Paper B',
        doi,
      }),
      searchByTitle: async () => null,
      fetchReferences: async (paperId) => paperId === 's2-a'
        ? [{ paperId: 's2-b', title: 'Paper B', doi: '10.1/b' }]
        : [{ paperId: 'outside', title: 'Outside Bundle' }],
    },
  });
  assert.equal(graph.researchBundleId, 'bundle-1');
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges.map((edge) => ({
    source: edge.sourcePaperId,
    target: edge.targetPaperId,
    provider: edge.verificationProvider,
  })), [{
    source: 'scholar-a',
    target: 'scholar-b',
    provider: 'semantic-scholar-reference-list',
  }]);
});

test('paper filtering and edge matching never promote unverified research mentions', () => {
  assert.deepEqual(normalizeGraphPapers(bundle, ['scholar-b']).map((paper) => paper.paperId), ['scholar-b']);
  assert.equal(referenceMatchesTarget(
    { title: 'Paper B' },
    { title: 'Paper B', paperId: 'scholar-b', semanticScholarId: 's2-b', doi: '' },
  ), true);
  assert.equal(referenceMatchesTarget(
    { title: 'Similar sounding paper' },
    { title: 'Different paper', paperId: 'scholar-b', semanticScholarId: 's2-b', doi: '' },
  ), false);
});

test('canonical title resolution must agree on title, year, and an author when available', () => {
  const paper = { title: 'Paper B', year: 2020, authors: ['Ada Lovelace'], doi: '' };
  assert.equal(canonicalMatchesPaper({
    title: 'Paper B', year: 2020, authors: ['Ada Lovelace'], doi: '',
  }, paper), true);
  assert.equal(canonicalMatchesPaper({
    title: 'Paper B', year: 2020, authors: ['Different Person'], doi: '',
  }, paper), false);
  assert.equal(canonicalMatchesPaper({
    title: 'A Different Paper', year: 2020, authors: ['Ada Lovelace'], doi: '',
  }, paper), false);
});

test('research graph runs as a separate asynchronous job', async () => {
  const id = createResearchGraphJob({ researchBundle: bundle }, async (_input, report) => {
    report({ stage: 'verifying_citations', percent: 75, message: 'Checking…' });
    return { version: 1, id: 'graph-1', nodes: [], edges: [] };
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const job = getResearchGraphJob(id);
  assert.equal(job.status, 'completed');
  assert.equal(job.graphBundle.id, 'graph-1');
});

test('research graph jobs remain discoverable by workspace and search paper', async () => {
  const id = createResearchGraphJob({
    researchBundle: bundle,
    workspaceId: 'workspace-graph-recovery',
    sourcePaperId: 'search-paper-graph-recovery',
    clientRequestId: 'graph-request-recovery',
  }, async (_input, report, options) => {
    report({ stage: 'verifying_citations', percent: 75, message: 'Checking references…' });
    options.onActivity({
      kind: 'reference_list', title: 'Checked a reference list',
      counters: { referenceListsChecked: 1 },
    });
    return { version: 1, id: 'graph-recovered', nodes: [], edges: [] };
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const [job] = listResearchGraphJobs({ workspaceId: 'workspace-graph-recovery' });
  assert.equal(job.id, id);
  assert.equal(job.sourcePaperId, 'search-paper-graph-recovery');
  assert.equal(job.status, 'completed');
  assert.equal(job.events.some((event) => event.kind === 'reference_list'), true);
});
