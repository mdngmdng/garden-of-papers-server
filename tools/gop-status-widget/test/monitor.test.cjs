const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probe, summarize, normalizeEndpoint, INTERVAL_MS } = require('../monitor.cjs');
const valid = { status: 'ok', capabilities: { workspaceSync: { protocolVersion: 2 } } };
test('polls once per minute', () => assert.equal(INTERVAL_MS, 60_000));
test('validates a real GOP health response', async () => {
  const result = await probe('https://example.test', { fetcher: async () => Response.json(valid) });
  assert.equal(result.ok, true);
});
test('does not mistake HTTP 200 HTML, unrelated JSON, or ngrok errors for a healthy server', async () => {
  for (const response of [new Response('<html>ngrok warning</html>'), Response.json({ status: 'ok' }), new Response('bad gateway', { status: 502 })]) {
    assert.equal((await probe('https://example.test', { fetcher: async () => response })).ok, false);
  }
});
test('times out stalled requests and reports offline connection failures', async () => {
  const fetcher = (_, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  assert.equal((await probe('https://example.test', { fetcher, timeoutMs: 10 })).detail, 'Request timed out');
  assert.equal((await probe('https://example.test', { fetcher: async () => { throw new Error('ENETDOWN'); } })).ok, false);
});
test('distinguishes transient failure, public outage, and recovery without claiming proof the process stopped', () => {
  assert.equal(summarize({ ok: false }, { ok: true }, 1).level, 'warning');
  assert.equal(summarize({ ok: false }, { ok: true }, 2).title, 'Public connection down');
  assert.equal(summarize({ ok: false }, null, 2).title, 'Server unreachable');
  assert.equal(summarize({ ok: true }, { ok: true }, 0).level, 'online');
  assert.equal(summarize({ ok: true }, { ok: false }, 0).level, 'warning');
});
test('rejects credential-bearing and non-HTTPS public endpoints', () => {
  for (const value of ['http://example.com/health', 'file:///etc/passwd', 'https://user:secret@example.com/health', 'https://example.com/health?key=secret', 'https://example.com/#test'])
    assert.throws(() => normalizeEndpoint(value));
  assert.equal(normalizeEndpoint(' https://example.com/garden-server/health '), 'https://example.com/garden-server/health');
});
