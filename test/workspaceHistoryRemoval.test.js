const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { once } = require('node:events');
const router = require('../src/routes/workspaceSnapshots');
const { workspaceSnapshotService } = require('../src/services/workspaceSnapshots');

test('retired history endpoints return 404 while current workspace reads and deltas remain available', async (t) => {
  const previousLoad = workspaceSnapshotService.load;
  const previousPatch = workspaceSnapshotService.patch;
  workspaceSnapshotService.load = async id => ({ id, revision: 4, objects: [] });
  workspaceSnapshotService.patch = async input => ({ protocolVersion: 2, revision: input.baseRevision + 1, updatedAt: '2026-10-27T12:00:00Z', replayed: false });
  t.after(() => { workspaceSnapshotService.load = previousLoad; workspaceSnapshotService.patch = previousPatch; });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/workspaces/garden`;
  for (const [method, suffix] of [
    ['GET','/history'], ['POST','/history'], ['GET','/history/transitions/1/2'], ['POST','/history/manual/restore'],
  ]) {
    const response = await fetch(base + suffix, { method });
    assert.equal(response.status, 404, `${method} ${suffix}`);
    await response.text();
  }
  const current = await fetch(base);
  assert.deepEqual(await current.json(), { id: 'garden', revision: 4, objects: [] });
  const delta = await fetch(base, { method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({baseRevision:4,mutationId:'edit',delta:{}}) });
  assert.equal(delta.status, 200);
  assert.equal((await delta.json()).revision, 5);
  for (const operation of ['listHistory','createHistorySnapshot','getHistoryTransition','restoreHistory']) {
    assert.equal(workspaceSnapshotService[operation], undefined);
  }
});
