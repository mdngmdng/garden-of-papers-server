const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStudyRecordingService, hashChunk } = require('../src/services/studyRecordings');

class Collection {
  rows = new Map();
  async createIndex() {}
  async insertOne(row) {
    if (this.rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    this.rows.set(row._id, structuredClone(row));
  }
  async findOne(query) { return [...this.rows.values()].find(row => Object.entries(query).every(([key, value]) => row[key] === value)) || null; }
  find(query) {
    let rows = [...this.rows.values()].filter(row => Object.entries(query).every(([key, value]) =>
      value && typeof value === 'object' ? row[key] >= value.$gte : row[key] === value));
    return {
      sort(keys) { rows.sort((a, b) => { for (const key of Object.keys(keys)) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1; return 0; }); return this; },
      limit(count) { rows = rows.slice(0, count); return this; },
      async toArray() { return structuredClone(rows); },
    };
  }
}
function fixture() {
  const collections = { sessions: new Collection(), chunks: new Collection() };
  const service = createStudyRecordingService(() => collections);
  const session = { id: 'session', workspaceId: 'study', ownerName: 'tester', projectName: 'study',
    startedAt: '2026-09-09T00:00:00.000Z', implementation: '2026-09-09.1', schemaVersion: 1 };
  const chunks = [];
  for (let index = 0; index < 20; index++) {
    const previousHash = chunks[index - 1]?.hash || '';
    const text = JSON.stringify({ sequence: index + 1, text: `보존할 사건 ${index}` }) + '\n';
    chunks.push({ sessionId: session.id, index, previousHash, text, hash: hashChunk(session.id, index, previousHash, text) });
  }
  return { service, collections, session, chunks };
}

test('insert-only recording supports idempotent and concurrent retries without loss or duplicates', async () => {
  const { service, collections, session, chunks } = fixture();
  const batch = { session, chunks: chunks.slice(0, 8) };
  const results = await Promise.all([service.append('study', batch), service.append('study', batch)]);
  assert.deepEqual(results[0], { nextIndex: 8, hash: chunks[7].hash });
  assert.deepEqual(results[0], results[1]);
  assert.equal(collections.chunks.rows.size, 8);
  await service.append('study', { session, chunks: chunks.slice(8, 16) });
  await service.append('study', { session, chunks: chunks.slice(16) });
  assert.equal(collections.chunks.rows.size, 20);
  const first = await service.read('study', session.id);
  assert.equal(first.hasMore, true); assert.equal(first.chunks.length, 8);
  const last = await service.read('study', session.id, 16);
  assert.equal(last.hasMore, false); assert.equal(last.chunks.length, 4);
  assert.equal((await service.list('study')).sessions.length, 1);
});

test('rejects overwritten data even when caller recomputes its checksum', async () => {
  const { service, session, chunks } = fixture();
  await service.append('study', { session, chunks: [chunks[0]] });
  const changed = { ...chunks[0], text: 'rewritten past' };
  changed.hash = hashChunk(session.id, 0, '', changed.text);
  await assert.rejects(service.append('study', { session, chunks: [changed] }), { status: 409 });
  await assert.rejects(service.append('study', { session: { ...session, ownerName: 'different' }, chunks: [chunks[0]] }), { status: 409 });
});

test('rejects missing predecessors, changed checksums, wrong workspaces and malformed batches', async () => {
  const { service, session, chunks } = fixture();
  await assert.rejects(service.append('study', { session, chunks: [chunks[1]] }), { status: 409 });
  await assert.rejects(service.append('study', { session, chunks: [{ ...chunks[0], text: 'corrupt' }] }), { status: 400 });
  await assert.rejects(service.append('other', { session, chunks: [chunks[0]] }), { status: 400 });
  await assert.rejects(service.append('study', { session, chunks: chunks.slice(0, 9) }), { status: 400 });
  await service.append('study', { session, chunks: [chunks[0]] });
  await assert.rejects(service.read('other', session.id), { status: 404 });
  await assert.rejects(service.read('study', session.id, '-1'), { status: 400 });
});

test('partial write failure can resume with the identical batch', async () => {
  const { service, collections, session, chunks } = fixture();
  const insert = collections.chunks.insertOne.bind(collections.chunks);
  let failed = false;
  collections.chunks.insertOne = async row => {
    if (row.index === 3 && !failed) { failed = true; throw new Error('connection lost'); }
    return insert(row);
  };
  const batch = { session, chunks: chunks.slice(0, 8) };
  await assert.rejects(service.append('study', batch), /connection lost/);
  assert.equal(collections.chunks.rows.size, 3);
  assert.deepEqual(await service.append('study', batch), { nextIndex: 8, hash: chunks[7].hash });
  assert.equal(collections.chunks.rows.size, 8);
});
