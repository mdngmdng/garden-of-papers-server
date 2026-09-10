const assert = require('node:assert/strict');
const test = require('node:test');
const { auditResponseStream } = require('../src/services/openaiStreamAudit');

test('slow recording coalesces pending events and keeps completion behind durable writes', async () => {
  let controller, release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { started = resolve; });
  const batches = [];
  const response = auditResponseStream(new Response(new ReadableStream({ start(c) { controller = c; } })), async (type, data) => {
    if (type !== 'provider.stream') return;
    batches.push(data.events);
    if (batches.length === 1) { started(); await blocked; }
  });
  const encode = value => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
  let delivered = 0, terminalDelivered = false, allDeltasDelivered;
  const deltas = new Promise(resolve => { allDeltasDelivered = resolve; });
  const consumed = (async () => {
    for await (const bytes of response.body) {
      delivered++;
      if (delivered === 6) allDeltasDelivered();
      if (new TextDecoder().decode(bytes).includes('response.completed')) terminalDelivered = true;
    }
  })();
  controller.enqueue(encode({ type: 'response.output_text.delta', index: 0, delta: 'a'.repeat(33000) }));
  await writing;
  for (let index = 1; index < 6; index++) controller.enqueue(encode({ type: 'response.output_text.delta', index, delta: 'b'.repeat(33000) }));
  await deltas;
  controller.enqueue(encode({ type: 'response.completed', response: { status: 'completed', output: [] } }));
  controller.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminalDelivered, false);
  release();
  await consumed;
  assert.equal(terminalDelivered, true);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.flat().filter(e => e.body.type === 'response.output_text.delta').map(e => e.body.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(batches.flat().at(-1).body.type, 'response.completed');
});

test('a failed journal write still prevents delivery of completion', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  const response = auditResponseStream(new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } })), async () => { throw Error('journal unavailable'); });
  await assert.rejects(response.text(), /journal unavailable/);
});
