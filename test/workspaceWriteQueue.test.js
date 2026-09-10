const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { once } = require('node:events');
const { createWorkspaceWriteQueue } = require('../src/services/workspaceWriteQueue');

test('a slow recovery PUT commits before a later PATCH, without blocking reads or another board', async t => {
  const app = express();
  let arrived;
  const firstArrival = new Promise(resolve => { arrived = resolve; });
  app.use((req, _res, next) => { if (req.headers['x-test-first']) arrived(); next(); });
  app.use(createWorkspaceWriteQueue());
  app.use(express.json());
  const writes = [];
  app.all('/api/workspaces/:id', (req, res) => {
    if (req.method !== 'GET') writes.push(`${req.params.id}:${req.body.value}`);
    res.json({ value: req.body?.value || 'read' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const slow = http.request(`${base}/api/workspaces/garden`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-first': '1' },
  });
  const slowResponse = once(slow, 'response').then(([res]) => { res.resume(); return once(res, 'end'); });
  slow.write('{"value":');
  await firstArrival;
  const later = fetch(`${base}/api/workspaces/garden`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"value":2}' });
  const other = await fetch(`${base}/api/workspaces/other`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"value":3}' });
  assert.equal(other.status, 200);
  assert.equal((await (await fetch(`${base}/api/workspaces/garden`)).json()).value, 'read');
  assert.deepEqual(writes, ['other:3']);
  slow.end('1}');
  await slowResponse;
  assert.equal((await later).status, 200);
  assert.deepEqual(writes, ['other:3', 'garden:1', 'garden:2']);
});

test('an abandoned queued request cannot release the write ahead of it', async () => {
  const { EventEmitter } = require('node:events');
  const middleware = createWorkspaceWriteQueue();
  const calls = [];
  const responses = [0, 1, 2].map(index => {
    const res = new EventEmitter();
    middleware({ method: 'PUT', path: '/api/workspaces/garden' }, res, () => calls.push(index));
    return res;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [0]);
  responses[1].emit('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [0]);
  responses[0].emit('finish');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [0, 2]);
  responses[2].emit('finish');
});

test('an incomplete upload has a bounded admission window', async () => {
  const { EventEmitter } = require('node:events');
  const middleware = createWorkspaceWriteQueue({ timeoutMs: 15 });
  const res = new EventEmitter();
  let status;
  res.status = code => { status = code; return res; };
  let timedOut;
  const timeout = new Promise(resolve => { timedOut = resolve; });
  res.json = value => { assert.equal(value.code, 'request_timeout'); res.emit('finish'); timedOut(); };
  middleware({ method: 'PUT', path: '/api/workspaces/garden' }, res, () => {});
  // Keep the event loop alive because production queue deadlines are unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await timeout; } finally { clearTimeout(keepAlive); }
  assert.equal(status, 408);
  let admitted = false;
  const next = new EventEmitter();
  middleware({ method: 'PATCH', path: '/api/workspaces/garden' }, next, () => { admitted = true; next.emit('finish'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, true);
});
