const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeManuscriptDraft, requestWikiManuscriptDraft } = require('../src/services/wikiManuscriptDraft');
const source = { paperId: 'memo', paperKey: 'stable-memo', title: '연구 메모', text: '공간적 배치로 연구 자료의 맥락을 유지한다.' };

test('accepts long memo attachments separately from the question and rejects malformed, empty and excessive material', () => {
  assert.equal(normalizeManuscriptDraft(undefined), null);
  assert.equal(normalizeManuscriptDraft({ sources: [{ ...source, text: '가'.repeat(12000) }] }).sources[0].text.length, 12000);
  for (const value of [{}, { sources: [] }, { sources: [null] }, { sources: [{ ...source, text: '' }] },
    { sources: [source, source] }, { sources: [{ ...source, text: '가'.repeat(120001) }] }]) assert.throws(() => normalizeManuscriptDraft(value));
});

test('requests insertable manuscript prose from all memo snapshots without imposing the paper Q&A format', async () => {
  const calls = [];
  const text = '첫 문단입니다.\n\n둘째 문단입니다.';
  const answer = await requestWikiManuscriptDraft({ question: '원고 본문 써줘', manuscriptDraft: { sources: [source] },
    openAIRequest: async (request) => { calls.push(request); return JSON.stringify({ text, error: '' }); } });
  assert.equal(answer.text, text);
  assert.deepEqual(answer.quotes, []);
  assert.ok(calls[0].input.includes(source.text));
  assert.equal(calls[0].textFormat.name, 'wiki_manuscript_draft');
  assert.match(calls[0].instructions, /untrusted source material/);
  assert.doesNotMatch(calls[0].instructions, /evidenceIds|1-3 sentences/);
});

test('does not turn insufficient material or incomplete responses into an insertable block', async () => {
  const answer = await requestWikiManuscriptDraft({ question: '정량 결과를 써줘', manuscriptDraft: { sources: [source] },
    openAIRequest: async () => JSON.stringify({ text: '', error: '측정 결과가 메모에 없습니다.' }) });
  assert.equal(answer.answerStatus, 'failed');
  let calls = 0;
  const recovered = await requestWikiManuscriptDraft({ question: '원고 써줘', manuscriptDraft: { sources: [source] },
    openAIRequest: async () => { if (++calls === 1) throw Object.assign(new Error('incomplete'), { code: 'openai_incomplete_response' });
      return JSON.stringify({ text: '완성된 본문', error: '' }); } });
  assert.equal(calls, 2);
  assert.equal(recovered.text, '완성된 본문');
});
