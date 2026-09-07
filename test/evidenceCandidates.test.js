const test = require('node:test'), assert = require('node:assert/strict');
const { parseCandidateInput, planEvidenceCandidates, assessEvidenceCandidates } = require('../src/services/evidenceCandidates');
const { preserveEvidenceRequests } = require('../src/services/evidenceRequestCompatibility');
const passages = [
  { id: 'p0:0', pageIndex: 0, startChar: 0, text: 'The effect was restricted to novice workers.' },
  { id: 'p0:44', pageIndex: 0, startChar: 44, text: 'Experienced participants showed no improvement.' },
].map(p => ({ ...p, length: p.text.length }));
const input = { protocolVersion: 1, kind: 'statement', statement: 'Assistance improves productivity for all workers.', requestedRelation: 'support', paperTitle: 'Study A', passages };
const result = { status: 'ready', explanation: '조건을 확인하세요.', candidates: [{ passageIds: ['p0:0'], proposedRelation: 'qualify', rationale: '초보자에게 제한됩니다.', scope: '초보자' }] };
test('requested support remains a hypothesis while AI can propose qualify using only supplied IDs', async () => {
  const response = await assessEvidenceCandidates(input, { respond: async (_name, schema, prompt, body) => {
    assert.match(prompt, /USER HYPOTHESIS/); assert.equal(body.requestedRelation, 'support');
    assert.deepEqual(schema.properties.candidates.items.properties.passageIds.items.enum, ['p0:0', 'p0:44']); return result;
  } });
  assert.equal(response.protocolVersion, 1); assert.equal(response.candidates[0].proposedRelation, 'qualify');
});
test('rejects invalid role, IDs, overlapping candidates, cross-page and distant range merges', async () => {
  assert.throws(() => parseCandidateInput({ ...input, requestedRelation: 'proves' }));
  for (const candidates of [[{ ...result.candidates[0], passageIds: ['invented'] }], [result.candidates[0], result.candidates[0]], [{ ...result.candidates[0], passageIds: ['p0:44', 'p0:0'] }]]) {
    await assert.rejects(assessEvidenceCandidates(input, { respond: async () => ({ ...result, candidates }) }));
  }
  await assert.rejects(assessEvidenceCandidates({ ...input, passages: [passages[0], { ...passages[1], pageIndex: 1 }] }, { respond: async () => ({ ...result, candidates: [{ ...result.candidates[0], passageIds: ['p0:0', 'p0:44'] }] }) }));
});
test('supports short contiguous excerpts but never fills quotas for absent or insufficient evidence', async () => {
  const paired = await assessEvidenceCandidates(input, { respond: async () => ({ ...result, candidates: [{ ...result.candidates[0], passageIds: ['p0:0', 'p0:44'] }] }) });
  assert.equal(paired.candidates[0].passageIds.length, 2);
  for (const status of ['no_candidate', 'insufficient_context']) {
    const response = await assessEvidenceCandidates(input, { respond: async () => ({ status, explanation: '원문 부족', candidates: [] }) }); assert.equal(response.candidates.length, 0);
    await assert.rejects(assessEvidenceCandidates(input, { respond: async () => ({ ...result, status }) }));
  }
});
test('citation input preserves grouped refs and returns correspondence, with no statement or support inference', async () => {
  const body = { protocolVersion: 1, kind: 'citation', paperTitle: 'Study A', passages, citation: { text: 'Earlier work [1,2] found benefits.', context: 'Earlier work [1,2] found benefits. We report our own results.', marker: '[1,2]', refIds: ['a', 'b'], targetRefIds: ['a'], citingPaperTitle: 'Study C' } };
  const response = await assessEvidenceCandidates(body, { respond: async (_name, schema, prompt, data) => {
    assert.equal(data.statement, undefined); assert.deepEqual(data.citation.refIds, ['a', 'b']); assert.match(prompt, /grouped citation/);
    assert.equal(schema.properties.candidates.items.properties.proposedRelation, undefined);
    return { ...result, candidates: [{ passageIds: ['p0:0'], correspondence: 'partial', rationale: '일부 대응', scope: 'A의 조건만 해당' }] };
  } });
  assert.equal(response.candidates[0].correspondence, 'partial');
  assert.throws(() => parseCandidateInput({ ...body, citation: { ...body.citation, context: 'Unrelated words.' } }));
  assert.throws(() => parseCandidateInput({ ...body, citation: { ...body.citation, targetRefIds: ['absent'] } }));
});
test('planning expands queries inside the chosen PDF without searching for new papers', async () => {
  const response = await planEvidenceCandidates(input, { respond: async (_n, _s, prompt) => { assert.match(prompt, /No external literature search/); return { queries: ['novice benefit', 'experienced workers', 'limitations'] }; } });
  assert.equal(response.queries.length, 3);
});
test('older canonical writes retain requests while explicit empty arrays permit Undo and clearing', () => {
  for (const type of ['GX.MAROLink', 'GX.MARONote']) {
    const prev = type === 'GX.MAROLink' ? { type, evidenceRequests: [{ id: 'request' }] } : { type, claimEvidence: { requests: [{ id: 'request' }], links: [] } };
    const old = type === 'GX.MAROLink' ? { type } : { type, claimEvidence: { links: [] } };
    assert.deepEqual(preserveEvidenceRequests(prev, old), prev);
    const cleared = type === 'GX.MAROLink' ? { type, evidenceRequests: [] } : { type, claimEvidence: { requests: [], links: [] } };
    assert.deepEqual(preserveEvidenceRequests(prev, structuredClone(cleared)), cleared);
  }
});
