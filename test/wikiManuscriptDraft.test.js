const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeManuscriptDraft, requestWikiManuscriptDraft } = require('../src/services/wikiManuscriptDraft');

test('rewrites an existing passage without attachments, preserving its own citation keys and placeholders', async () => {
  const rewrite = { title: '원고', heading: '서론', text: '원래 본문 \\cite{original_key} [x]', before: '앞 문맥', after: '뒤 문맥' };
  const manuscriptDraft = normalizeManuscriptDraft({ sources: [], rewrite });
  assert.deepEqual(manuscriptDraft.rewrite, rewrite);
  const answer = await requestWikiManuscriptDraft({ question: '간결하게', manuscriptDraft, openAIRequest: async request => {
    assert.match(request.instructions, /Rewrite only the selected manuscript passage/);
    assert.match(request.input, /앞 문맥/);
    assert.match(request.instructions, /never include neighboring passages/);
    return JSON.stringify({ text: '짧은 본문 \\cite{original_key} [x]', error: '' });
  } });
  assert.equal(answer.text, '짧은 본문 \\cite{original_key} [x]');
  for (const text of ['', 'a'.repeat(40001)]) assert.throws(() => normalizeManuscriptDraft({ sources: [], rewrite: { ...rewrite, text } }));
  assert.throws(() => normalizeManuscriptDraft({ sources: [], rewrite: { ...rewrite, before: 'a'.repeat(4001) } }));
});

test('rejects rewrites that drop original citations, add invented references, or remove citation placeholders', async () => {
  for (const text of ['빠진 인용 [x]', '새 인용 \\cite{unknown} [x]', '빠진 표시 \\cite{original_key}']) {
    let calls = 0;
    await assert.rejects(requestWikiManuscriptDraft({ question: '간결하게', manuscriptDraft: { sources: [],
      rewrite: { title: '', heading: '', text: '원래 본문 \\cite{original_key} [x]', before: '', after: '' } },
      openAIRequest: async () => { calls++; return JSON.stringify({ text, error: '' }); } }), { code: 'invalid_manuscript_citations' });
    assert.equal(calls, 2);
  }
});
const source = { paperId: 'memo', paperKey: 'stable-memo', title: '문서', text: '공간적 배치로 연구 자료의 맥락을 유지한다.' };
const citedSource = { ...source, text: '<!--gop-quote:q1-->\n> 공간적 배치로 연구 자료의 맥락을 유지한다.', citations: [
  { key: 'memo_ref_1', paperId: 'pdf', paperKey: 'stable-pdf', title: 'Spatial Research', authors: ['Jane Kim'], year: '2024',
    quotes: [{ id: 'q1', text: source.text, pageIndex: 2 }] },
] };

test('preserves source-paper catalogs and rejects stale markers, conflicting keys and malformed metadata', () => {
  assert.deepEqual(normalizeManuscriptDraft({ sources: [citedSource] }), { sources: [citedSource] });
  for (const broken of [
    { ...citedSource, text: 'The quote was removed' },
    { ...citedSource, citations: [{ ...citedSource.citations[0], key: 'invented' }] },
    { ...citedSource, citations: [{ ...citedSource.citations[0], quotes: [{ id: 'q1', text: 'quote', pageIndex: -1 }] }] },
    { ...citedSource, citations: [{ ...citedSource.citations[0], authors: [42] }] },
  ]) assert.throws(() => normalizeManuscriptDraft({ sources: [broken] }));
  const second = { ...citedSource, paperId: 'other-memo', paperKey: 'other-memo', citations: [{ ...citedSource.citations[0], paperKey: 'other-pdf' }] };
  assert.throws(() => normalizeManuscriptDraft({ sources: [citedSource, second] }), /인용 키/);
  assert.doesNotThrow(() => normalizeManuscriptDraft({ sources: [citedSource, { ...citedSource, paperId: 'other-memo', paperKey: 'other-memo' }] }));
});

test('generates cite syntax from known quote sources and leaves numbering and References to the editor', async () => {
  let sent;
  const text = '공간적 배치는 연구 맥락을 유지한다 \\cite{memo_ref_1}.';
  const answer = await requestWikiManuscriptDraft({ question: '인용 포함해서 원고 써줘', manuscriptDraft: normalizeManuscriptDraft({ sources: [citedSource] }),
    openAIRequest: async (request) => { sent = request; return JSON.stringify({ text, error: '' }); } });
  assert.equal(answer.text, text);
  assert.ok(sent.instructions.includes('\\cite{key}'));
  assert.ok(sent.instructions.includes('editor assigns numbers'));
  assert.ok(sent.input.includes('Spatial Research'));
  assert.ok(sent.input.includes('memo_ref_1'));
  assert.ok(sent.input.includes('gop-quote:q1'));
});

test('retries omitted or hallucinated citations without appending unrelated references', async () => {
  for (const invalid of ['본문만 생성했습니다.', '잘못된 인용 \\cite{invented}.', '빈 인용 \\cite{}.']) {
    const calls = [];
    const answer = await requestWikiManuscriptDraft({ question: '원고 써줘', manuscriptDraft: { sources: [citedSource] },
      openAIRequest: async (request) => { calls.push(request); return JSON.stringify({ text: calls.length === 1 ? invalid : '완성된 본문 \\cite{memo_ref_1}.', error: '' }); } });
    assert.equal(calls.length, 2);
    assert.ok(calls[1].instructions.includes('previous response'));
    assert.equal(answer.text, '완성된 본문 \\cite{memo_ref_1}.');
  }
  await assert.rejects(() => requestWikiManuscriptDraft({ question: '원고 써줘', manuscriptDraft: { sources: [citedSource] },
    openAIRequest: async () => JSON.stringify({ text: '본문 \\cite{unknown}.', error: '' }) }), { code: 'invalid_manuscript_citations' });
});

test('accepts long document attachments separately from the question and rejects malformed, empty and excessive material', () => {
  assert.equal(normalizeManuscriptDraft(undefined), null);
  assert.equal(normalizeManuscriptDraft({ sources: [{ ...source, text: '가'.repeat(12000) }] }).sources[0].text.length, 12000);
  for (const value of [{}, { sources: [] }, { sources: [null] }, { sources: [{ ...source, text: '' }] },
    { sources: [source, source] }, { sources: [{ ...source, text: '가'.repeat(120001) }] }]) assert.throws(() => normalizeManuscriptDraft(value));
});

test('requests insertable manuscript prose from all document snapshots without imposing the paper Q&A format', async () => {
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
    openAIRequest: async () => JSON.stringify({ text: '', error: '측정 결과가 문서에 없습니다.' }) });
  assert.equal(answer.answerStatus, 'failed');
  let calls = 0;
  const recovered = await requestWikiManuscriptDraft({ question: '원고 써줘', manuscriptDraft: { sources: [source] },
    openAIRequest: async () => { if (++calls === 1) throw Object.assign(new Error('incomplete'), { code: 'openai_incomplete_response' });
      return JSON.stringify({ text: '완성된 본문', error: '' }); } });
  assert.equal(calls, 2);
  assert.equal(recovered.text, '완성된 본문');
});
