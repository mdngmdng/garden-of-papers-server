const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAuditedProviderFetch, createAuditedAxios, auditStudyOperation, studyAuditMiddleware } = require('../src/services/studyProviderAudit');
const { hashChunk } = require('../src/services/studyRecordings');
const { runWebResearch } = require('../src/services/research');
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

const sseBytes = event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const sseResponse = stream => new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request-stream' } });

test('delivers and records intermediate SSE before the provider finishes', { timeout: 2000 }, async () => {
  const { storage, records } = storageFixture();
  let upstream;
  const source = new ReadableStream({ start(controller) {
    upstream = controller;
    controller.enqueue(sseBytes({ type: 'response.created', response: { id: 'live' } }));
  } });
  const fetcher = createAuditedProviderFetch(async () => sseResponse(source), () => context('live'), storage);
  const response = await fetcher('https://api.openai.com/v1/responses');
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /response.created/);
  await new Promise(resolve => setTimeout(resolve, 650));
  const events = records()[0].events;
  assert.equal(events.find(e => e.type === 'provider.response_headers').data.requestId, 'request-stream');
  assert.equal(events.find(e => e.type === 'provider.stream').data.events[0].body.type, 'response.created');
  assert.ok(!events.some(e => e.type === 'session.ended'));
  upstream.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(records()[0].events.at(-1).type, 'session.ended');
});

test('retains SSE activity and records a timeout during the response body', async () => {
  const { storage, records } = storageFixture();
  let upstream;
  const source = new ReadableStream({ start(controller) {
    upstream = controller;
    controller.enqueue(sseBytes({ type: 'response.web_search_call.searching' }));
  } });
  const response = await createAuditedProviderFetch(async () => sseResponse(source), () => context('timeout'), storage)('https://api.openai.com/v1/responses');
  const reader = response.body.getReader();
  await reader.read();
  upstream.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  await assert.rejects(reader.read(), { name: 'TimeoutError' });
  const events = records()[0].events;
  assert.equal(events.find(e => e.type === 'provider.stream').data.events[0].body.type, 'response.web_search_call.searching');
  const failure = events.find(e => e.type === 'provider.failed');
  assert.equal(failure.data.phase, 'response_stream');
  assert.equal(failure.data.lastEventType, 'response.web_search_call.searching');
  assert.equal(events.at(-1).type, 'session.ended');
});

test('research completes on a recorded terminal SSE without waiting for EOF, preserving UTF-8 and excluding private reasoning', { timeout: 2000 }, async t => {
  const config = require('../src/config');
  const previous = config.openai.apiKey;
  config.openai.apiKey = 'test-key';
  t.after(() => { config.openai.apiKey = previous; });
  const { storage, records } = storageFixture();
  let cancelled = false;
  const final = { type: 'response.completed', response: { id: 'complete', status: 'completed',
    output: [{ type: 'reasoning', content: 'PRIVATE_REASONING' },
      { type: 'message', content: [{ type: 'output_text', text: '한글 보고서🧪' }] }] } };
  const bytes = new Uint8Array(Buffer.concat([
    sseBytes({ type: 'response.reasoning_text.delta', delta: 'PRIVATE_REASONING' }),
    sseBytes({ type: 'response.output_text.delta', delta: '한글 보고서🧪' }), sseBytes(final),
  ]));
  const source = new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
    // Deliberately leave the connection open after response.completed.
  }, cancel() { cancelled = true; } });
  const fetchImpl = createAuditedProviderFetch(async () => sseResponse(source), () => context('complete'), storage);
  const result = await runWebResearch('진단 질문', { fetchImpl, timeoutMs: 1000 });
  assert.equal(result.report, '한글 보고서🧪');
  assert.ok(cancelled);
  const events = records()[0].events;
  assert.ok(!JSON.stringify(events).includes('PRIVATE_REASONING'));
  assert.ok(events.some(e => e.type === 'provider.stream' && e.data.events.some(e => e.body.type === 'response.completed')));
  assert.equal(events.at(-1).data.cancelled, false);
});

test('an SSE journal write failure prevents success and cancels the upstream response', async () => {
  const { storage, records } = storageFixture();
  const append = storage.append;
  storage.append = async (...args) => {
    if (args[1].chunks.some(c => c.text.includes('provider.stream'))) throw Error('stream journal unavailable');
    return append(...args);
  };
  let cancelled = false;
  const source = new ReadableStream({ start(controller) {
    controller.enqueue(sseBytes({ type: 'response.completed', response: { status: 'completed' } }));
  }, cancel() { cancelled = true; } });
  const response = await createAuditedProviderFetch(async () => sseResponse(source), () => context('broken'), storage)('https://api.openai.com/v1/responses');
  await assert.rejects(response.text(), /record could not be saved/);
  assert.ok(cancelled);
  assert.ok(!records()[0].events.some(e => e.type === 'session.ended'));
});
