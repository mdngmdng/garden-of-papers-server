const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../src/config');
const {
  analyzeCitationGraph,
  passageChunksFromSentences,
  sentenceRecordsFromPages,
} = require('../src/services/citationGraphAnalysis');

test('retrieves PDF chunks before grounded OpenAI analysis', async (t) => {
  const previous = { ...config.openai };
  Object.assign(config.openai, {
    apiKey: 'test-key',
    citationGraphModel: 'gpt-5.6-sol',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 2,
  });
  t.after(() => Object.assign(config.openai, previous));

  const embeddingBodies = [];
  let responseBody;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/embeddings')) {
      embeddingBodies.push(body);
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: input.map((text, index) => ({
          index,
          embedding: /wheeled vehicles|cars and trucks/i.test(text)
            ? [1, 0]
            : embeddingBodies.length === 1
              ? [1, 0]
              : [0, 1],
        })),
        usage: { prompt_tokens: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    responseBody = body;
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            summary: '인용 논문은 어린이가 자동차 같은 탈것을 선호하는 경향을 보고한 연구로 소개함.',
            selectedSentenceIds: ['p5-s1'],
            relevance: '두 구절 모두 어린이의 탈것 선호 경향을 설명한다.',
          }),
        }],
      }],
      usage: { input_tokens: 900, output_tokens: 80 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await analyzeCitationGraph(
    {
      sourceContext: 'Children tend to prefer vehicles such as cars [7].',
      citationContext: 'Children tend to prefer vehicles such as cars [7].',
      markerText: '[7]',
      pages: [
        {
          pageIndex: 0,
          text: 'This introduction discusses a completely unrelated evaluation protocol and study setup.',
        },
        {
          pageIndex: 4,
          text: 'Children showed a reliable preference for wheeled vehicles, especially cars and trucks. This preference was stable across both study sessions.',
        },
        {
          pageIndex: 7,
          text: 'References\n[1] This bibliography entry must never become evidence for the claim.',
        },
      ],
      paper: {
        id: 'paper-7',
        title: 'Vehicle Preferences in Early Childhood',
        authors: ['A. Researcher'],
        year: '2024',
        venue: 'CHI',
        abstract: 'A study of children and vehicle preferences.',
      },
    },
    { fetchImpl },
  );

  assert.equal(embeddingBodies.length, 2);
  assert.equal(embeddingBodies[0].model, 'text-embedding-3-small');
  assert.equal(embeddingBodies[0].dimensions, 2);
  assert.equal(responseBody.model, 'gpt-5.6-sol');
  assert.deepEqual(responseBody.reasoning, { effort: 'medium' });
  assert.equal(responseBody.store, false);
  assert.equal(responseBody.text.format.type, 'json_schema');
  assert.equal(responseBody.text.format.strict, true);
  assert.doesNotMatch(JSON.stringify(responseBody), /input_file|file_url/);
  assert.match(JSON.stringify(responseBody.input), /p5-s1/);
  assert.doesNotMatch(JSON.stringify(responseBody.input), /bibliography entry/);
  assert.deepEqual(result, {
    model: 'gpt-5.6-sol',
    paperId: 'paper-7',
    summary: '인용 논문은 어린이가 자동차 같은 탈것을 선호하는 경향을 보고한 연구로 소개함.',
    evidencePassage: 'Children showed a reliable preference for wheeled vehicles, especially cars and trucks.',
    relevance: '두 구절 모두 어린이의 탈것 선호 경향을 설명한다.',
    pageNumber: 5,
    usage: { inputTokens: 906, outputTokens: 80 },
  });
});

test('builds bounded overlapping chunks without crossing PDF pages', () => {
  const sentences = sentenceRecordsFromPages([
    {
      pageIndex: 2,
      text: Array.from(
        { length: 30 },
        (_, index) => `Page three sentence ${index + 1} contains enough searchable academic text.`,
      ).join(' '),
    },
    {
      pageIndex: 3,
      text: 'Page four begins a distinct passage that must remain on its own PDF page.',
    },
  ]);
  const chunks = passageChunksFromSentences(sentences);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1_600));
  assert.ok(chunks.every((chunk) =>
    chunk.sentences.every((sentence) => sentence.pageNumber === chunk.pageNumber)));
  assert.equal(chunks.at(-1).pageNumber, 4);
});
