const test = require('node:test');
const assert = require('node:assert/strict');
const { researchDeadline } = require('../src/services/researchDeadline');

test('ongoing events renew idle time without extending the overall deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadline = researchDeadline({ timeoutMs: 1000, idleTimeoutMs: 300 });
  for (let index = 0; index < 4; index++) {
    t.mock.timers.tick(200);
    assert.equal(deadline.signal.aborted, false);
    deadline.touch();
  }
  t.mock.timers.tick(200);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason.details.code, 'research_total_timeout');
  deadline.dispose();
});

test('a silent provider stops at the idle deadline even when total time remains', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadline = researchDeadline({ timeoutMs: 1000, idleTimeoutMs: 300 });
  t.mock.timers.tick(250); deadline.touch();
  t.mock.timers.tick(299);
  assert.equal(deadline.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(deadline.signal.reason.details.code, 'research_idle_timeout');
  deadline.dispose();
});

test('explicit user cancellation keeps its reason and completed requests release timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  const cancelled = researchDeadline({ signal: parent.signal, timeoutMs: 1000, idleTimeoutMs: 300 });
  const reason = new Error('Cancelled by the user');
  parent.abort(reason);
  assert.equal(cancelled.signal.reason, reason);
  cancelled.dispose();
  const finished = researchDeadline({ timeoutMs: 1000, idleTimeoutMs: 300 });
  finished.dispose();
  t.mock.timers.tick(2000);
  assert.equal(finished.signal.aborted, false);
});
