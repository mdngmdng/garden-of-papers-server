const assert = require('node:assert/strict');
const test = require('node:test');
const { parseStatementReview, reviewStatementEvidence } = require('../src/services/statementReview');
const { assessClaimEvidence } = require('../src/services/claimEvidence');
const text = 'Benefits were restricted to novice workers.';
const body = { statement: 'Assistance benefits all workers. We compare approaches.', previousStatement: 'Assistance benefits novice workers.',
  relation: 'support', previousEvidence: text, evidence: { text, context: 'Results. ' + text + ' Limitations apply.', pageIndex: 1, paperTitle: 'Study' }, connectedEvidence: [] };
const result = { status: 'reconsider', explanation: '초보자의 결과를 모든 근로자에게 일반화했습니다.', changedText: 'all workers', suggestedRelation: 'qualify' };
test('review exposes advice only, preserves input, and asks about the precise part of a multi-sentence statement', async () => {
  const before = structuredClone(body);
  const output = await reviewStatementEvidence(body, { respond: async (name, schema, prompt, input) => {
    assert.equal(name, 'statement_edge_review');
    assert.match(prompt, /passive review/); assert.match(prompt, /several sentences/);
    assert.match(prompt, /Never create new claims/); assert.match(prompt, /exact short substring/);
    assert.deepEqual(input, body);
    assert.deepEqual(schema.properties.suggestedRelation.enum, ['support', 'qualify', 'contrast', 'background', 'contradict', null]);
    return { ...result, statement: 'Rewrite this', relation: 'qualify', review: 'confirmed' };
  } });
  assert.deepEqual(body, before); assert.equal(output.protocolVersion, 3); assert.equal(output.suggestedRelation, 'qualify');
  assert.equal(output.statement, undefined); assert.equal(output.relation, undefined); assert.equal(output.review, undefined);
});
test('review rejects fabricated changed text, invalid roles and absent rationale', async () => {
  for (const invalid of [{ ...result, changedText: 'invented phrase' }, { ...result, suggestedRelation: 'similar' }, { ...result, explanation: '' }, { ...result, status: 'confirmed' }]) {
    await assert.rejects(reviewStatementEvidence(body, { respond: async () => invalid }), /대조/);
  }
});
test('review validates source context and bounds before calling a model', async () => {
  for (const invalid of [
    { ...body, evidence: { ...body.evidence, context: 'Different source text.' } },
    { ...body, evidence: { ...body.evidence, pageIndex: -1 } },
    { ...body, relation: 'similar' }, { ...body, statement: 'a' },
    { ...body, connectedEvidence: Array(13).fill({ text, paperTitle: 'Study', relation: 'support' }) },
    { ...body, connectedEvidence: Array(4).fill({ text: 'a'.repeat(20000), paperTitle: 'Study', relation: 'support' }) },
  ]) {
    await assert.rejects(reviewStatementEvidence(invalid, { respond: async () => { assert.fail('Invalid input reached the model'); } }));
  }
  assert.equal(parseStatementReview({ ...body, evidence: { ...body.evidence, context: 'Benefits were\nrestricted to novice workers.' } }).evidence.text, text);
});
test('insufficient context remains an explicit non-decision', async () => {
  const output = await reviewStatementEvidence(body, { respond: async () => ({ status: 'insufficient_context', explanation: '제공된 문맥만으로 조건을 판단할 수 없습니다.', changedText: '', suggestedRelation: null }) });
  assert.equal(output.status, 'insufficient_context'); assert.equal(output.suggestedRelation, null);
});
test('initial assessments support five roles for new clients while preserving the legacy schema', async () => {
  const assessmentBody = { claim: body.statement, paperTitle: 'Study', passages: [{ id: 'p1:0', pageIndex: 1, text }] };
  const output = relation => ({ explanation: 'A role for this fragment.', recommendationCheck: { status: 'qualified', explanation: 'A scoped finding.' },
    evidence: [{ passageId: 'p1:0', relation, rationale: 'A relevant context.', scope: 'Novices' }] });
  for (const relation of ['support', 'qualify', 'contrast', 'background', 'contradict']) {
    const response = await assessClaimEvidence({ ...assessmentBody, relationSchemaVersion: 2 }, { respond: async (_name, schema, prompt) => {
      assert.equal(schema.properties.evidence.items.properties.relation.enum.length, 5);
      assert.match(prompt, /multiple sentences|multi-sentence|several sentences/);
      return output(relation);
    } });
    assert.equal(response.evidence[0].relation, relation); assert.equal(response.relationSchemaVersion, 2);
  }
  const legacy = await assessClaimEvidence(assessmentBody, { respond: async (_name, schema) => {
    assert.deepEqual(schema.properties.evidence.items.properties.relation.enum, ['support', 'contradict', 'qualify']);
    return output('support');
  } });
  assert.equal(legacy.relationSchemaVersion, 1);
  await assert.rejects(assessClaimEvidence(assessmentBody, { respond: async () => output('background') }), /유효하지/);
});
