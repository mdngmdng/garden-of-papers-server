const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { downloadPdf } = require('../src/controllers/pdf');
const storage = require('../src/services/pdfStorage');
const s3 = require('../src/services/s3');

function requestResponse() {
  const req = Object.assign(new EventEmitter(), { params: { projectName: 'qa', fileid: 'existing' }, headers: {} });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, writableEnded: false, destroyed: false, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.writableEnded = true; return this; },
  });
  return { req, res };
}

test('ends a timed-out stored PDF request even when key lookup does not settle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  t.mock.method(storage, 'resolvePdfS3Key', () => new Promise(resolve => { finish = resolve; }));
  const download = t.mock.method(s3, 'downloadPdf', async () => { throw Error('must not fetch after timeout'); });
  const { req, res } = requestResponse();
  const pending = downloadPdf(req, res);
  t.mock.timers.tick(30_000);
  try {
    assert.equal(res.statusCode, 504);
    assert.equal(res.writableEnded, true);
    assert.match(res.body.error, /timed out/i);
  } finally { finish('existing.pdf'); await pending; }
  assert.equal(download.mock.callCount(), 0);
});

test('ends a timed-out S3 acquisition and destroys a late stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(storage, 'resolvePdfS3Key', async () => 'existing.pdf');
  let finish, destroyed = false;
  t.mock.method(s3, 'downloadPdf', () => new Promise(resolve => { finish = resolve; }));
  const { req, res } = requestResponse();
  const pending = downloadPdf(req, res);
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  try { assert.equal(res.statusCode, 504); assert.equal(res.writableEnded, true); }
  finally { finish({ Body: { destroy() { destroyed = true; } } }); await pending; }
  assert.equal(destroyed, true);
});

test('client cancellation aborts acquisition without writing a response', async t => {
  t.mock.method(storage, 'resolvePdfS3Key', async () => 'existing.pdf');
  let signal;
  t.mock.method(s3, 'downloadPdf', (_key, _range, options) => {
    signal = options.abortSignal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })), { once: true }));
  });
  const { req, res } = requestResponse();
  const pending = downloadPdf(req, res);
  await Promise.resolve(); req.aborted = true; req.emit('aborted'); await pending;
  assert.equal(signal.aborted, true); assert.equal(res.body, undefined);
});
