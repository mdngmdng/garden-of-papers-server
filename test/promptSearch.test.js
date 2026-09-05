const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../src/config');
const {
  executePromptSearch, filterCandidates, planPromptSearch, renderAssessment, structuredResponse,
} = require('../src/services/promptSearch');
const {
  executeRelatedSearch, createRelatedSearchJob, getRelatedSearchJob, cancelRelatedSearchJob,
} = require('../src/services/relatedSearchJobs');

const prompt = 'VR에서 신체화된 상호작용이 기억을 개선하나요? 캔버스 밖에서 근거 논문을 찾아줘.';
const paper = (paperId, title = `Memory study ${paperId}`) => ({
  paperId, title, authors: ['A Researcher'], year: 2024,
  abstract: 'Active embodied interaction improved spatial recall in the study.',
  citationCount: 20, url: `https://example.org/papers/${paperId}`,
});
const options = {
  promptPlanner: async () => ({ queries: ['embodied virtual reality memory'] }),
  promptScholarSearch: async () => ({ results: [paper('a')] }),
  promptRanker: async () => ({
    papers: [{ paperId: 'a', explanation: '공간 기억 과제를 다룬 검색 결과입니다.' }],
    statements: [{ text: '검색 구절은 공간 기억 향상 가능성을 시사합니다.', paperIds: ['a'] }],
  }),
};

test('prompt intent uses Korean planning, verified Scholar records, and no linked-PDF or Asta pipeline', async () => {
  const stages = [];
  const result = await executeRelatedSearch({
    keyword: prompt, searchIntent: 'prompt_search',
    sourcePapers: [{ id: 'canvas-paper', title: 'A linked paper', projectId: 'board', fileId: 'pdf' }],
  }, (next) => stages.push(next), {
    ...options,
    sourceTextLoader: () => assert.fail('must not download source PDFs'),
    planner: () => assert.fail('must not use Gemini'),
    astaService: { isConfigured: () => assert.fail('must not use Asta') },
    promptPlanner: async (input) => {
      assert.equal(input, prompt);
      return { queries: ['embodied virtual reality memory'] };
    },
    promptScholarSearch: async (query, offset, limit, { signal }) => {
      assert.equal(query, 'embodied virtual reality memory');
      assert.equal(offset, 0);
      assert.equal(limit, 10);
      assert.equal(signal.aborted, false);
      return { results: [paper('a')] };
    },
  });
  assert.equal(result.searchMode, 'prompt_search');
  assert.equal(result.provider, 'openai+serpapi-google-scholar');
  assert.equal(result.keyword, prompt);
  assert.deepEqual(result.answer.citations, [{ paperId: 'a', label: 'A' }]);
  assert.match(result.answer.text, /가능성.*\[A\]/);
  assert.match(result.answer.evidenceBasis, /PDF 본문을 읽은 답변이 아닙니다/);
  assert.match(stages[0].message, /질문을 분석/);
});

test('outside-canvas exclusion matches cloned titles, DOI and URLs while preserving distinct URL queries', () => {
  const excluded = [
    { paperId: 'cloned-canvas-id', title: 'Spatial Memory: A VR Study!' },
    { doi: '10.1000/abc' },
    { url: 'http://www.example.org/document?id=2' },
  ];
  const results = filterCandidates([[
    paper('a', '[PDF] Spatial Memory — A VR Study'),
    { ...paper('b'), url: 'https://doi.org/10.1000/ABC' },
    { ...paper('c'), url: 'https://example.org/document?id=2&utm_source=scholar' },
    { ...paper('d'), url: 'https://example.org/document?id=3' },
    paper('e', 'Unique memory study'),
    paper('f', 'Unique Memory Study!'),
  ]], excluded);
  assert.deepEqual(results.map((item) => item.paperId), ['d', 'e']);
});

test('bounds searches to four, runs at most two concurrently, and filters before model evaluation', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const result = await executePromptSearch({ keyword: prompt, excludedPapers: [{ title: 'Already collected' }] }, () => {}, {
    ...options,
    promptPlanner: async () => ({ queries: ['one query', 'two query', 'three query', 'four query', 'five query'] }),
    promptScholarSearch: async (query) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { results: [paper('a'), paper(query), paper('excluded-id', 'Already collected')] };
    },
    promptRanker: async (_prompt, candidates) => {
      assert.equal(candidates.length, 5);
      assert.equal(candidates.some((item) => item.title === 'Already collected'), false);
      return options.promptRanker();
    },
  });
  assert.equal(calls, 4);
  assert.equal(maxActive, 2);
  assert.equal(result.results.length, 1);
});

test('discards invented IDs and entire statements containing unverified citations', () => {
  const result = renderAssessment('Find memory papers', [paper('a'), paper('b')], {
    papers: [
      { paperId: 'invented', explanation: 'Invented paper' },
      { paperId: 'a', explanation: 'Verified paper' },
      { paperId: 'a', explanation: 'Duplicate' },
    ],
    statements: [
      { text: 'Invented study proves the claim.', paperIds: ['invented'] },
      { text: 'Mixed citation includes an invented claim.', paperIds: ['a', 'invented'] },
      { text: 'The retrieved snippet suggests improved recall.', paperIds: ['a'] },
    ],
  });
  assert.deepEqual(result.results.map((item) => item.paperId), ['a']);
  assert.equal(result.answer.text, 'The retrieved snippet suggests improved recall. [A]');
  assert.deepEqual(result.answer.citations, [{ paperId: 'a', label: 'A' }]);
});

test('degrades clearly for partial Scholar failure and GPT ranking failure, without invented explanations', async () => {
  const result = await executePromptSearch({ keyword: 'Does embodiment help memory?' }, () => {}, {
    ...options,
    promptPlanner: async () => ({ queries: ['failing query', 'working query'] }),
    promptScholarSearch: async (query) => {
      if (query.startsWith('failing')) throw new Error('network error');
      return { results: [paper('a')] };
    },
    promptRanker: async () => { throw new Error('ranking timeout'); },
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.warnings.length, 2);
  assert.match(result.answer.text, /evaluation failed/);
  assert.deepEqual(result.answer.citations, []);
  assert.equal(result.results[0].relevanceExplanation, undefined);
});

test('all failed retrieval is a failure, but no results or excluded-only results return an empty answer', async () => {
  await assert.rejects(executePromptSearch({ keyword: prompt }, () => {}, {
    ...options, promptScholarSearch: async () => { throw new Error('network down'); },
  }), /Google Scholar/);
  for (const testOptions of [
    { ...options, promptScholarSearch: async () => { throw new Error("Google Scholar hasn't returned any results"); } },
    options,
  ]) {
    const result = await executePromptSearch({ keyword: prompt, excludedPapers: [{ paperId: 'a' }] }, () => {}, {
      ...testOptions, promptRanker: async () => assert.fail('must not evaluate empty candidates'),
    });
    assert.deepEqual(result.results, []);
    assert.deepEqual(result.answer.citations, []);
    assert.match(result.answer.text, /새 검색 결과가 없습니다/);
  }
});

test('cancellation interrupts ignored signals and never marks a cancelled job completed', async () => {
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  const jobId = createRelatedSearchJob({ keyword: prompt, searchIntent: 'prompt_search' }, (input, report, { signal }) => executePromptSearch(input, report, {
    ...options, signal,
    promptScholarSearch: async () => {
      started();
      return new Promise(() => {});
    },
    promptRanker: async () => assert.fail('must not rank after cancellation'),
  }));
  await pending;
  assert.equal(cancelRelatedSearchJob(jobId), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getRelatedSearchJob(jobId).status, 'cancelled');
});

test('overall timeout bounds even a stuck planner and prompt validation never uses a linked manuscript fallback', async (t) => {
  // AbortSignal.timeout is unref'ed; emulate the HTTP server's live event loop.
  const keepAlive = setTimeout(() => {}, 1_000);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(executePromptSearch({ keyword: prompt }, () => {}, {
    timeoutMs: 10, promptPlanner: () => new Promise(() => {}),
  }), /timeout/i);
  await assert.rejects(executeRelatedSearch({ keyword: '', searchIntent: 'prompt_search', manuscript: { title: 'A long enough manuscript title' } }), /질문/);
  await assert.rejects(executeRelatedSearch({ keyword: 'x'.repeat(4_001), searchIntent: 'prompt_search' }), /4,000/);
});

test('OpenAI planner uses configured model, strict schema and original Korean prompt; rejects incomplete/refusal output', async (t) => {
  const previous = config.openai.apiKey;
  config.openai.apiKey = 'fake-test-key';
  t.after(() => { config.openai.apiKey = previous; });
  const usage = [];
  const parsed = await planPromptSearch(prompt, {
    onUsage: (record) => usage.push(record),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, config.openai.model);
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.match(body.instructions, /English Google Scholar/);
      assert.equal(JSON.parse(body.input[0].content).prompt, prompt);
      return {
        ok: true,
        json: async () => ({
          model: 'gpt-5.6-sol',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20 },
          output: [{ content: [{ type: 'output_text', text: JSON.stringify({ queries: ['embodiment virtual reality memory'] }) }] }],
        }),
      };
    },
  });
  assert.deepEqual(parsed.queries, ['embodiment virtual reality memory']);
  assert.deepEqual(usage, [{
    stage: 'scholarly_prompt_plan',
    model: 'gpt-5.6-sol',
    usage: { input_tokens: 100, output_tokens: 20 },
    webSearchCalls: 0,
  }]);
  for (const payload of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] },
  ]) {
    await assert.rejects(structuredResponse('test', {}, '', {}, {
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    }), /OpenAI/);
  }
});

test('quota exhaustion is explicit, never retried, and preserves retrieved papers when evaluation runs out of credits', async (t) => {
  const previous = config.openai.apiKey;
  config.openai.apiKey = 'fake-test-key';
  t.after(() => { config.openai.apiKey = previous; });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return {
      ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }),
      json: async () => ({ error: { type: 'insufficient_quota', code: 'credit_balance_exhausted' } }),
    };
  };
  await assert.rejects(executePromptSearch({ keyword: prompt }, () => {}, { fetchImpl }), /크레딧 또는 사용 한도가 소진/);
  assert.equal(calls, 1);
  const result = await executePromptSearch({ keyword: prompt }, () => {}, {
    promptPlanner: options.promptPlanner, promptScholarSearch: options.promptScholarSearch, fetchImpl,
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.results.map((item) => item.paperId), ['a']);
  assert.match(result.answer.text, /크레딧.*검색 결과만 표시/);
  assert.deepEqual(result.answer.citations, []);
});

test('a short Retry-After permits one retry; long rate limits are reported and retries remain cancellable', async (t) => {
  const previous = config.openai.apiKey;
  config.openai.apiKey = 'fake-test-key';
  t.after(() => { config.openai.apiKey = previous; });
  const throttled = (seconds) => ({
    ok: false, status: 429, headers: new Headers({ 'retry-after': seconds }),
    json: async () => ({ error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } }),
  });
  let calls = 0;
  const result = await planPromptSearch(prompt, {
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return throttled('0');
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{
        type: 'output_text', text: JSON.stringify({ queries: ['embodiment VR memory'] }),
      }] }] }) };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.queries, ['embodiment VR memory']);
  calls = 0;
  await assert.rejects(executePromptSearch({ keyword: prompt }, () => {}, {
    fetchImpl: async () => { calls++; return throttled('60'); },
  }), /요청 한도에 도달/);
  assert.equal(calls, 1);

  const controller = new AbortController();
  const pending = planPromptSearch(prompt, {
    signal: controller.signal,
    fetchImpl: async () => {
      setTimeout(() => controller.abort(new Error('cancelled during retry')), 5);
      return throttled('1');
    },
  });
  await assert.rejects(pending, /abort/i);
});
