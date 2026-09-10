const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../src/config');
const { analyzeCitationGraph, passageChunksFromSentences, sentenceRecordsFromPages } = require('../src/services/citationGraphAnalysis');
const { discoveryBatches, selectedSentences } = require('../src/services/citationEvidence');
const input = { sourceContext: 'Readers keep provenance [22].', citationContext: 'Readers keep provenance [22].', markerText: '[22]',
  paper: { id: 'p22', title: 'Provenance' }, pages: [{ pageIndex: 0, text: 'We studied how readers track sources. They retain document provenance across multiple tasks.' },
    { pageIndex: 1, text: 'References\n[1] Bibliographic material cannot serve as evidence.' }] };
const review = { summary: '출처를 추적하는 연구로 소개한다.', explanation: '', passages: [{ sentenceIds: ['p1-s2'], correspondence: 'direct', relevance: '문서의 출처를 유지하는 행동에 대응한다.' }] };
function setup(t, values) {
  const previous = config.openai.apiKey; config.openai.apiKey = 'test'; t.after(() => { config.openai.apiKey = previous; });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) });
    const value = values.shift();
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
      usage: { input_tokens: 100, output_tokens: 20 } })); };
  return { calls, fetchImpl };
}
test('Luna reads the entire body, then reviews neighbours and returns the exact source with page boundaries', async t => {
  const { calls, fetchImpl } = setup(t, [{ candidates: [{ sentenceIds: ['p1-s2'] }] }, review]);
  const result = await analyzeCitationGraph(input, { fetchImpl });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.url.endsWith('/responses') && c.body.model === 'gpt-5.6-luna' && c.body.store === false && c.body.text.format.strict));
  assert.deepEqual(calls.map(c => c.body.reasoning.effort), ['low', 'medium']);
  assert.match(JSON.stringify(calls[0].body.input), /We studied how readers/);
  assert.doesNotMatch(JSON.stringify(calls[0].body.input), /Bibliographic material/);
  assert.equal(result.status, 'found');
  assert.equal(result.evidencePassage, 'They retain document provenance across multiple tasks.');
  assert.deepEqual(result.evidencePassages[0].segments, [{ pageNumber: 1, text: result.evidencePassage }]);
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 40 });
});
test('no-evidence is valid at discovery and review; neither fabricates a quotation', async t => {
  for (const values of [[{ candidates: [] }], [{ candidates: [{ sentenceIds: ['p1-s1'] }] }, { summary: '', explanation: '대응하는 근거가 없다.', passages: [] }]]) {
    const { calls, fetchImpl } = setup(t, values);
    const result = await analyzeCitationGraph(input, { fetchImpl });
    assert.equal(result.status, 'no_evidence'); assert.equal(result.evidencePassage, ''); assert.deepEqual(result.evidencePassages, []);
    assert.ok(calls.length <= 2);
  }
});
test('rejects invented and non-contiguous source IDs instead of silently accepting a subset', async t => {
  const { fetchImpl } = setup(t, [{ candidates: [{ sentenceIds: ['p1-s2', 'invented'] }] }]);
  await assert.rejects(analyzeCitationGraph(input, { fetchImpl }), /없는 원문/);
  const sentences = sentenceRecordsFromPages([{ pageIndex: 0, text: 'First sentence is a complete statement. Next sentence gives context. Third sentence gives a condition.' }]);
  assert.throws(() => selectedSentences(['p1-s1', 'p1-s3'], sentences), /이어지지/);
});
test('long-paper discovery covers every sentence, including the end, with bounded overlapping batches', () => {
  const sentences = Array.from({ length: 600 }, (_, i) => ({ id: 's'+i, text: 'Body content '.repeat(35), globalIndex: i }));
  const batches = discoveryBatches(sentences);
  assert.ok(batches.length > 1); assert.equal(new Set(batches.flat().map(s => s.id)).size, sentences.length);
  assert.equal(batches.at(-1).at(-1).id, 's599');
});
test('network errors are surfaced without an automatic paid retry', async t => {
  const { calls, fetchImpl } = setup(t, [new Error('connection interrupted')]);
  await assert.rejects(analyzeCitationGraph(input, { fetchImpl }), /interrupted/); assert.equal(calls.length, 1);
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
