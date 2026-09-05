const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../src/config');
const {
  executeResearchSearch,
  responseSources,
  runWebResearch,
  selectScholarMatch,
} = require('../src/services/research');

const prompt = '공간 컴퓨팅에서 기억 보조 인터페이스의 연구 지형을 조사해줘.';

function scholar(paperId, title, year = 2024) {
  return {
    paperId,
    title,
    authors: ['Verified Author'],
    year,
    venue: 'CHI',
    citationCount: 12,
    url: `https://example.org/${paperId}`,
    abstract: 'A verified Google Scholar snippet.',
  };
}

test('web research uses the Responses web_search tool and preserves consulted sources', async (t) => {
  const previous = config.openai.apiKey;
  config.openai.apiKey = 'test-key';
  t.after(() => { config.openai.apiKey = previous; });
  const result = await runWebResearch(prompt, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, config.openai.researchModel);
      assert.equal(body.reasoning.effort, config.openai.researchReasoningEffort);
      assert.deepEqual(body.tools, [{ type: 'web_search' }]);
      assert.deepEqual(body.include, ['web_search_call.action.sources']);
      assert.equal(body.input[0].content, prompt);
      return {
        ok: true,
        json: async () => ({
          status: 'completed',
          output: [
            { type: 'web_search_call', action: { sources: [
              { url: 'https://doi.org/10.1000/example', title: 'Publisher record' },
            ] } },
            { type: 'message', content: [{
              type: 'output_text',
              text: '조사 보고서',
              annotations: [{ type: 'url_citation', url: 'https://example.org/paper', title: 'Paper page' }],
            }] },
          ],
        }),
      };
    },
  });
  assert.equal(result.report, '조사 보고서');
  assert.deepEqual(result.sources.map((source) => source.url), [
    'https://doi.org/10.1000/example',
    'https://example.org/paper',
  ]);
});

test('streams understandable web-search activity without exposing raw reasoning', async (t) => {
  const previous = config.openai.apiKey;
  config.openai.apiKey = 'test-key';
  t.after(() => { config.openai.apiKey = previous; });
  const events = [
    { type: 'response.created', response: { id: 'resp-test', model: 'gpt-test' } },
    { type: 'response.web_search_call.searching' },
    {
      type: 'response.output_item.done',
      item: {
        type: 'web_search_call',
        action: {
          type: 'search',
          queries: ['spatial memory augmentation papers'],
          sources: [{ url: 'https://doi.org/10.1000/stream', title: 'DOI record' }],
        },
      },
    },
    { type: 'response.reasoning_summary_text.delta', delta: '주요 연구 흐름을 비교했습니다.' },
    { type: 'response.reasoning_summary_text.done' },
    { type: 'response.output_text.delta', delta: '스트리밍 조사 보고서' },
    {
      type: 'response.completed',
      response: {
        id: 'resp-test',
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 50 },
        output: [
          { type: 'web_search_call', action: { sources: [
            { url: 'https://doi.org/10.1000/stream', title: 'DOI record' },
          ] } },
          { type: 'message', content: [{ type: 'output_text', text: '스트리밍 조사 보고서' }] },
        ],
      },
    },
  ];
  const stream = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const activity = [];
  const result = await runWebResearch(prompt, {
    onActivity: (event) => activity.push(event),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      assert.equal(body.reasoning.summary, 'auto');
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(stream));
            controller.close();
          },
        }),
      };
    },
  });
  assert.equal(result.report, '스트리밍 조사 보고서');
  assert.equal(activity.some((event) => event.kind === 'search_query'
    && event.query === 'spatial memory augmentation papers'), true);
  assert.equal(activity.some((event) => event.kind === 'reasoning_summary'
    && /연구 흐름/.test(event.detail)), true);
  assert.equal(activity.some((event) => event.kind === 'response_complete'), true);
});

test('source extraction rejects duplicate and unsafe URLs', () => {
  const sources = responseSources({ output: [{
    action: { sources: [
      { url: 'javascript:alert(1)', title: 'unsafe' },
      { url: 'https://example.org/a', title: 'A' },
      { url: 'https://example.org/a', title: 'duplicate' },
    ] },
  }] });
  assert.deepEqual(sources, [{ url: 'https://example.org/a', title: 'A' }]);
});

test('research and graph inputs are separated by an immutable, verified bundle', async () => {
  const stages = [];
  const result = await executeResearchSearch({
    keyword: prompt,
    excludedPapers: [{ paperId: 'excluded' }],
  }, (progress) => stages.push(progress.stage), {
    webResearcher: async () => ({
      report: 'Paper Alpha는 기반 연구이고 Paper Beta는 후속 연구다.',
      sources: [{ url: 'https://source.test/alpha', title: 'Alpha' }],
    }),
    researchCompiler: async () => ({
      rewrittenResearchPrompt: 'memory augmentation spatial computing literature',
      papers: [
        {
          title: 'Paper Alpha', authors: ['A'], year: 2020, doi: '', url: '',
          sourceUrls: ['https://source.test/alpha', 'https://not-consulted.test'],
          inclusionReason: '기반 연구', supportedClaims: ['기반을 제시했다'],
        },
        {
          title: 'Paper Beta', authors: ['B'], year: 2024, doi: '', url: '',
          sourceUrls: [], inclusionReason: '후속 연구', supportedClaims: [],
        },
        {
          title: 'Unverified Paper', authors: [], year: null, doi: '', url: '',
          sourceUrls: [], inclusionReason: '확인 불가', supportedClaims: [],
        },
      ],
      claims: [{
        text: '후속 연구 흐름이 존재한다.',
        supportingPaperTitles: ['Paper Alpha', 'Paper Beta'],
        contraryPaperTitles: [],
      }],
    }),
    scholarSearch: async (query) => {
      if (query.includes('Alpha')) return { results: [scholar('excluded', 'Paper Alpha', 2020)] };
      if (query.includes('Beta')) return { results: [scholar('beta', 'Paper Beta')] };
      return { results: [] };
    },
  });
  assert.equal(result.searchMode, 'research');
  assert.deepEqual(result.results.map((paper) => paper.paperId), ['beta']);
  assert.equal(result.researchBundle.papers.length, 3);
  assert.equal(result.researchBundle.papers[0].verified, true);
  assert.equal(result.researchBundle.papers[2].verified, false);
  assert.deepEqual(result.researchBundle.papers[0].sourceUrls, ['https://source.test/alpha']);
  assert.deepEqual(result.researchBundle.claims[0].supportingPaperIds, [
    'research-paper-1', 'research-paper-2',
  ]);
  assert.match(result.answer.evidenceBasis, /그래프 생성 단계/);
  assert.deepEqual([...new Set(stages)], [
    'web_research', 'compiling_research', 'verifying_metadata',
  ]);
});

test('Scholar verification requires a strong title match', () => {
  assert.equal(selectScholarMatch({ title: 'Exact Paper', year: 2024 }, [
    scholar('wrong', 'Entirely Different Topic', 2024),
  ]), null);
  assert.equal(selectScholarMatch({ title: 'Exact Paper', year: 2024 }, [
    scholar('right', 'Exact Paper', 2024),
  ]).paperId, 'right');
});
