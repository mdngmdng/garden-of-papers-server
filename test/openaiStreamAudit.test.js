const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

for (const journalFails of [false, true]) {
  test(`stream cancellation rejection cannot crash the server (journal failure: ${journalFails})`, () => {
    // A subprocess checks Node's real fatal unhandled-rejection behavior without
    // installing a global handler that would hide the production failure.
    const script = `
      const assert = require('node:assert/strict');
      const { auditResponseStream } = require(${JSON.stringify(require.resolve('../src/services/openaiStreamAudit'))});
      const abort = new DOMException('This operation was aborted', 'AbortError');
      let journalFinished = false;
      const response = auditResponseStream(new Response(new ReadableStream({
        cancel() { return Promise.reject(abort); },
      })), async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        journalFinished = true;
        if (${journalFails}) throw Error('journal unavailable');
      });
      (async () => {
        await assert.rejects(response.body.cancel(abort),
          ${journalFails} ? /journal unavailable/ : { name: 'AbortError' });
        assert.equal(journalFinished, true);
        console.log('cancellation handled');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /cancellation handled/);
  });
}
