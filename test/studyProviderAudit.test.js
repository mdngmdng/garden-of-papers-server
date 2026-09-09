const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAuditedProviderFetch, createAuditedAxios, auditStudyOperation, studyAuditMiddleware } = require('../src/services/studyProviderAudit');
const { hashChunk } = require('../src/services/studyRecordings');
const context = id => ({ sessionId: id, requestId: 'request-' + id, workspaceId: id, projectName: id, ownerName: 'tester', implementation: 'test' });
function storageFixture() {
  const sessions = new Map();
  const storage = { async append(workspace, batch) {
    assert.equal(workspace, batch.session.workspaceId);
    const entry = sessions.get(batch.session.id) || { session: batch.session, chunks: [] };
    for (const chunk of batch.chunks) {
      assert.equal(chunk.hash, hashChunk(chunk.sessionId, chunk.index, chunk.previousHash, chunk.text));
      if (entry.chunks[chunk.index]) assert.deepEqual(entry.chunks[chunk.index], chunk);
      else { assert.equal(chunk.index, entry.chunks.length); entry.chunks.push(structuredClone(chunk)); }
    }
    sessions.set(batch.session.id, entry);
  } };
  const records = () => [...sessions.values()].map(entry => ({ ...entry, events: entry.chunks.map(chunk => chunk.text).join('').trimEnd().split('\n').map(JSON.parse) }));
  return { storage, records };
}

test('provider fetch retries an ambiguous write byte-for-byte, retains large public output and excludes credentials', async () => {
  const { storage, records } = storageFixture(); let attempts = 0;
  const append = storage.append;
  storage.append = async (...args) => { await append(...args); if (++attempts === 1) throw Error('ack lost'); };
  const raw = { output: [{ type: 'message', text: '전체 대답🧪'.repeat(100000) }, { type: 'reasoning', summary: [] }], usage: { input_tokens: 123 } };
  const fetcher = createAuditedProviderFetch(async () => {
    assert.equal(records()[0].events.at(-1).type, 'provider.request'); return Response.json(raw);
  }, () => context('first'), storage);
  const response = await fetcher('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: 'SECRET' }, body: 'exact effective prompt' });
  assert.deepEqual(await response.json(), raw);
  const events = records()[0].events;
  assert.equal(events[2].data.body.output[0].text, raw.output[0].text);
  assert.equal(events[2].data.body.output.length, 1);
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
});

test('Axios records Gemini prompts, every unadopted Scholar result and multipart source bytes', async () => {
  const { storage, records } = storageFixture();
  const output = { candidates: [{ content: { parts: [{ text: 'answer' }, { thought: true, text: 'private' }] } }], organic_results: [{ title: 'ignored', key: 'citation-key-preserved' }] };
  const client = { post: async () => ({ status: 200, data: output }), get: async () => ({ status: 200, data: output }) };
  const axios = createAuditedAxios(client, () => context('test'), storage);
  await axios.post('https://generativelanguage.googleapis.com/model?key=SECRET', { contents: [{ parts: [{ text: 'full prompt' }] }] });
  await axios.get('https://serpapi.com/search', { params: { api_key: 'SECRET', q: 'paper' } });
  await axios.post('http://grobid/api/processFulltextDocument', { getBuffer: () => Buffer.from('%PDF-exact') });
  const all = JSON.stringify(records());
  for (const text of ['full prompt', 'ignored', 'citation-key-preserved', Buffer.from('%PDF-exact').toString('base64')]) assert.ok(all.includes(text));
  assert.ok(!all.includes('SECRET')); assert.ok(!all.includes('private'));
});

test('records background job result after the initiating middleware returns, with isolated request context', async () => {
  const { storage, records } = storageFixture();
  const pending = [];
  for (const id of ['first', 'second']) {
    studyAuditMiddleware({ get: () => encodeURIComponent(JSON.stringify(context(id))) }, null, () => {
      pending.push(new Promise((resolve, reject) => setImmediate(() => {
        auditStudyOperation('job.complete', { id }, async () => ({ result: id }), value => value, undefined, storage).then(resolve, reject);
      })));
    });
  }
  await Promise.all(pending);
  for (const { session, events } of records()) {
    assert.equal(events[0].data.parentSessionId, session.workspaceId);
    assert.equal(events[2].data.body.result, session.workspaceId);
  }
});

test('fails closed before generation, reports a lost provider response write, and records thrown provider failures', async () => {
  let called = false;
  const broken = { append: async () => { throw Error('database unavailable'); } };
  await assert.rejects(createAuditedProviderFetch(async () => { called = true; }, () => context('test'), broken)('https://api.openai.com/v1/responses'));
  assert.equal(called, false);
  const { storage, records } = storageFixture();
  const fetcher = createAuditedProviderFetch(async () => { throw Error('provider aborted'); }, () => context('test'), storage);
  await assert.rejects(fetcher('https://api.openai.com/v1/responses'), /provider aborted/);
  assert.equal(records()[0].events.at(-1).type, 'provider.failed');
  const other = storageFixture(); const append = other.storage.append;
  other.storage.append = async (...args) => { if (args[1].chunks.some(chunk => chunk.text.includes('provider.response'))) throw Error('DB failed after generation'); await append(...args); };
  await assert.rejects(createAuditedProviderFetch(async () => Response.json({ text: 'undeliverable' }), () => context('test'), other.storage)('https://api.openai.com/v1/responses'));
  assert.equal(other.records()[0].events.at(-1).type, 'provider.request');
});
