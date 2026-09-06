const assert = require('node:assert/strict');
const test = require('node:test');
const { assessClaimEvidence, parseEvidenceInput, executeClaimEvidenceSearch, claimSearchInstructions } = require('../src/services/claimEvidence');
const { executeRelatedSearch } = require('../src/services/relatedSearchJobs');
const passages = [
  { id: 'p0:0', pageIndex: 0, text: 'Participants completed the task faster using the assistant.' },
  { id: 'p1:0', pageIndex: 1, text: 'The improvement was restricted to inexperienced participants.' },
];
const body = { claim: 'AI improves productivity.', paperTitle: 'A controlled study', passages };
const output = { explanation: '효과의 적용 범위를 제한합니다.', evidence: [{ passageId: 'p1:0', relation: 'qualify', rationale: '숙련도에 따라 효과가 달랐습니다.', scope: '초보 참여자' }] };

test('quotes and page numbers come from supplied passages, never generated text', async () => {
  const result = await assessClaimEvidence(body, { respond: async (_name, schema, prompt, input) => {
    assert.deepEqual(schema.properties.evidence.items.properties.passageId.enum, ['p0:0', 'p1:0']);
    assert.match(prompt, /not by themselves contradiction/);
    assert.equal(input.claim, body.claim);
    return { ...output, evidence: [{ ...output.evidence[0], text: 'invented', pageIndex: 99 }] };
  } });
  assert.equal(result.evidence[0].text, passages[1].text);
  assert.equal(result.evidence[0].pageIndex, 1);
});
test('rejects invented and duplicate passage IDs and unsupported labels', async () => {
  for (const item of [{ ...output.evidence[0], passageId: 'invented' }, { ...output.evidence[0], relation: 'similar' }]) {
    await assert.rejects(assessClaimEvidence(body, { respond: async () => ({ ...output, evidence: [item] }) }), /유효하지/);
  }
  await assert.rejects(assessClaimEvidence(body, { respond: async () => ({ ...output, evidence: [output.evidence[0], output.evidence[0]] }) }), /유효하지/);
});
test('allows honest no-evidence results', async () => {
  const result = await assessClaimEvidence(body, { respond: async () => ({ explanation: '관련 주제이지만 직접 근거가 없습니다.', evidence: [] }) });
  assert.deepEqual(result.evidence, []);
});
test('bounds PDF input and rejects malformed or duplicate source records', () => {
  assert.throws(() => parseEvidenceInput({ ...body, passages: [passages[0], passages[0]] }));
  assert.throws(() => parseEvidenceInput({ ...body, passages: [{ ...passages[0], pageIndex: -1 }] }));
  assert.throws(() => parseEvidenceInput({ ...body, claim: 'a' }));
  assert.throws(() => parseEvidenceInput({ ...body, passages: Array.from({ length: 40 }, (_, i) => ({ id: 'p' + i, text: 'x'.repeat(6000), pageIndex: i })) }));
});
const options = () => ({
  webResearcher: async (claim, settings) => {
    assert.equal(claim, body.claim);
    assert.equal(settings.claimSearchInstructions, claimSearchInstructions);
    assert.match(settings.claimSearchInstructions, /neutral.*supporting.*contrary.*boundary/);
    return { report: 'A controlled study investigates the claim.', sources: [] };
  },
  researchCompiler: async () => ({ rewrittenResearchPrompt: body.claim, papers: [{ title: body.paperTitle, authors: ['Author'], year: 2024 }], claims: [] }),
  scholarSearch: async () => ({ results: [{ paperId: 'paper1', title: body.paperTitle, authors: ['Author'], year: 2024, url: 'https://example.org/p', abstract: '' }] }),
  astaService: { isConfigured: () => false },
});
test('claim searches use GPT research and preserve the original claim', async () => {
  const result = await executeClaimEvidenceSearch({ keyword: body.claim }, () => {}, options());
  assert.equal(result.searchMode, 'claim_evidence');
  assert.equal(result.results[0].paperId, 'paper1');
  assert.equal(result.researchBundle.originalPrompt, body.claim);
});
test('the public job dispatcher routes claim_evidence to GPT instead of Gemini', async () => {
  const result = await executeRelatedSearch({ keyword: body.claim, searchIntent: 'claim_evidence' }, () => {}, {
    ...options(), planner: () => { throw new Error('Gemini must not run'); },
  });
  assert.equal(result.searchMode, 'claim_evidence');
});
