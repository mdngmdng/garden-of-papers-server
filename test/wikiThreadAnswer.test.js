const assert = require('node:assert/strict');
const test = require('node:test');
const { outputText } = require('../src/services/openAIResponse');
const { buildQuoteEvidence, renderWikiAnswer, requestWikiThreadAnswer } = require('../src/services/wikiThreadAnswer');

const final = (text, extra = {}) => ({ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }], ...extra });
const payload = (output, extra = {}) => ({ id: 'response-test', status: 'completed', output, ...extra });
const structured = (extra = {}) => JSON.stringify({ summary: '이 논문은 두 단계로 사용자 검증을 진행했습니다.',
  sections: [{ heading: '일주일 동안 사용한 뒤 인터뷰', evidenceIds: ['S1'], explanation: '연구 경험이 있는 참가자를 대상으로 평가했습니다.' }],
  evidenceStatus: 'supported', limitation: '', ...extra });
const paper = { id: 'litsense', title: 'Understanding and Supporting Academic Literature Review Workflows with LitSense',
  sourceText: '[Page 1]\n' + 'This is introductory context. '.repeat(25) + '\n[Page 4]\nWe recruited 12 partici- pants (P1-P12, 8 female) with at least 2 years of research experience to use Litsense for 1-week at their own pace. The study included two interview sessions.' };
const report = { papers: [{ id: paper.id, passages: [{ kind: '저장된 Markdown · 본문', start: 0,
  end: paper.sourceText.length, pageStart: 1, pageEnd: 4, excerpt: paper.sourceText.slice(0, 360) }] }] };
const evidence = () => buildQuoteEvidence([paper], report, ['recruited']);

test('only uses the completed final assistant message, never reasoning or commentary', () => {
  assert.equal(outputText(payload([
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'not an answer' }] },
    final('draft', { phase: 'commentary' }), final('analysis', { channel: 'analysis' }),
    final('older final'), final('완성된 답변', { phase: 'final_answer' }),
  ])), '완성된 답변');
  assert.equal(outputText(payload([final('ordinary Responses message without optional phase') ])), 'ordinary Responses message without optional phase');
});

test('rejects incomplete, missing, non-final and refused output even if it includes text', () => {
  for (const status of ['incomplete', 'failed', 'in_progress', undefined]) {
    assert.throws(() => outputText(payload([final('partial')], { status, incomplete_details: { reason: 'max_output_tokens' } })),
      (error) => error.code === 'openai_incomplete_response' && error.responseId === 'response-test');
  }
  assert.throws(() => outputText(payload([final('draft', { phase: 'commentary' })])), /completed final answer/);
  assert.throws(() => outputText(payload([final('partial', { status: 'in_progress' })])), /completed final answer/);
  assert.throws(() => outputText(payload([final('older answer'), final('partial revision', { status: 'incomplete' })])), /completed final answer/);
  assert.throws(() => outputText(payload([final('', { content: [{ type: 'refusal', refusal: 'No' }] })])),
    (error) => error.code === 'openai_refusal');
});

test('original evidence includes real IDs and page at the sentence, beyond the abbreviated reading report', () => {
  const candidates = evidence();
  assert.match(candidates[0].text, /^We recruited 12 partici- pants/);
  assert.equal(candidates[0].pageIndex, 3);
  const answer = renderWikiAnswer(structured(), candidates, '사용자 검증은 어떻게 했어?');
  assert.equal(answer.quotes.length, 1);
  assert.equal(answer.quotes[0].text, candidates[0].text);
  assert.equal(answer.quotes[0].title, paper.title);
  assert.equal(answer.quotes[0].pageIndex, 3);
  assert.match(answer.text, /### 1\. 일주일/);
  assert.ok(answer.text.indexOf('[[wiki-quote:') < answer.text.indexOf('연구 경험이'));
});

test('never treats a note, summary, unread body range or fabricated ID as original PDF evidence', () => {
  assert.deepEqual(buildQuoteEvidence([paper], { papers: [{ id: paper.id, passages: [{ kind: 'Attached note', start: 0, end: paper.sourceText.length }] }] }), []);
  const limited = buildQuoteEvidence([paper], { papers: [{ id: paper.id, passages: [{ kind: 'PDF full text', start: 0, end: 300 }] }] });
  assert.ok(limited.every((item) => !item.text.includes('recruited')));
  assert.throws(() => renderWikiAnswer(structured({ sections: [{ heading: '제목', evidenceIds: ['wrong-paper'], explanation: '설명' }] }), evidence()), /unknown_evidence/);
  assert.throws(() => renderWikiAnswer(structured({ sections: [] }), evidence()), /missing_evidence/);
  assert.throws(() => renderWikiAnswer(structured({ sections: [{ heading: '제목', evidenceIds: [], explanation: '설명' }] }), evidence()), /missing_evidence/);
});

test('allows eight quotations but rejects an answer that exceeds the display limit', () => {
  const section = { heading: '근거', evidenceIds: ['S1', 'S1'], explanation: '원문에 근거한 설명.' };
  assert.equal(renderWikiAnswer(structured({ sections: Array(4).fill(section) }), evidence()).quotes.length, 8);
  assert.throws(() => renderWikiAnswer(structured({ sections: Array(5).fill(section) }), evidence()), /structure/);
});

test('no invented page when the stored original has no page markers', () => {
  const sourceText = 'The study included two interview sessions.';
  const result = buildQuoteEvidence([{ ...paper, sourceText }], { papers: [{ id: paper.id,
    passages: [{ kind: 'PDF full text', start: 0, end: sourceText.length, pageStart: 99 }] }] });
  assert.equal(result[0].pageIndex, undefined);
});

test('does not offer a cross-page quotation that cannot connect to a single PDF page', () => {
  const sourceText = '[Page 1]\nA sentence begins here and\n[Page 2]\ncontinues on another page. A complete sentence on the second page.';
  const result = buildQuoteEvidence([{ ...paper, sourceText }], { papers: [{ id: paper.id,
    passages: [{ kind: 'PDF full text', start: 0, end: sourceText.length }] }] });
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'A complete sentence on the second page.');
  assert.equal(result[0].pageIndex, 1);
});

test('rejects the reported English draft and catalog-ID excuse without stripping legitimate English quotations', () => {
  for (const summary of ['설명. < 整理 > Wait typo quote tags. Need exact.', '정확한 catalog ID가 없어 인용할 수 없다.',
    '설명.\nLet us think about how this should be written and whether we could perhaps quote something from here and then compose a final proper response.']) {
    assert.throws(() => renderWikiAnswer(structured({ summary }), evidence(), '설명해 줘'), /draft_artifacts|answer_language/);
  }
  assert.equal(renderWikiAnswer(structured(), evidence(), '설명해 줘').quotes[0].text, evidence()[0].text);
  const limitation = renderWikiAnswer(structured({ summary: '제공된 자료로는 확인할 수 없습니다.', sections: [],
    evidenceStatus: 'insufficient', limitation: '참가자 모집 절차가 제공된 본문에 없습니다.' }), []);
  assert.deepEqual(limitation.quotes, []);
});

test('retries incomplete and malformed answers with more room, returns only validated output', async () => {
  const calls = [];
  const answer = await requestWikiThreadAnswer({ input: 'test context', instructions: 'test', question: '사용자 검증은?', evidence: evidence(),
    openAIRequest: async (request) => {
      calls.push(request);
      if (calls.length === 1) return outputText(payload([final('partial')], { status: 'incomplete' }));
      if (calls.length === 2) return 'Wait typo quote tags. Need exact.';
      return structured();
    } });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.maxOutputTokens), [8000, 14000, 20000]);
  assert.equal(calls[0].textFormat.type, 'json_schema');
  assert.equal(answer.quotes.length, 1);
  assert.doesNotMatch(answer.text, /Wait typo/);
  assert.doesNotMatch(calls[2].input, /Wait typo/);
});

test('stops at a bounded failure and never returns the bad generation', async () => {
  let calls = 0;
  await assert.rejects(requestWikiThreadAnswer({ input: '', instructions: '', question: '', evidence: [],
    openAIRequest: async () => { calls += 1; return 'broken'; } }), /Invalid Wiki answer/);
  assert.equal(calls, 3);
});
