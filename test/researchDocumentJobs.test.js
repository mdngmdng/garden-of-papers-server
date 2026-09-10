const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchDocumentJobs } = require('../src/services/researchDocumentJobs');

function collection() {
  const rows = new Map();
  const matches = (row, query) => Object.entries(query).every(([key, value]) => value?.$lt ? row[key] < value.$lt : row[key] === value);
  const update = (row, value) => { Object.assign(row, value.$set); for (const key of Object.keys(value.$unset || {})) delete row[key]; };
  return { rows,
    async createIndex() {},
    async insertOne(row) { if (rows.has(row._id)) throw Object.assign(Error('duplicate'), { code: 11000 }); rows.set(row._id, structuredClone(row)); },
    async findOne(query) { return structuredClone([...rows.values()].find(row => matches(row, query)) || null); },
    async findOneAndUpdate(query, value) { const row = [...rows.values()].find(row => matches(row, query)); if (!row) return null; update(row, value); return structuredClone(row); },
    async updateOne(query, value) { const row = [...rows.values()].find(row => matches(row, query)); if (row) update(row, value); },
    async updateMany(query, value) { for (const row of rows.values()) if (matches(row, query)) update(row, value); },
  };
}
const input = { workspaceId: 'board', requestId: 'request', kind: 'document', purpose: 'research-document', prompt: '연구 문서',
  sources: [{ paperId: 'paper', kind: 'paper', title: 'Paper', text: '[PDF page 1]\nOriginal sentence.' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await tick(); } throw Error('condition not reached'); }

test('acceptance returns before generation; duplicate requests share one durable result across clients', async () => {
  const db = collection(); let calls = 0, finish;
  const jobs = createResearchDocumentJobs({ collection: db, generate: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const [first, duplicate] = await Promise.all([jobs.enqueue(input), jobs.enqueue(input)]);
  assert.equal(first.status, 'queued'); assert.equal(first.jobId, duplicate.jobId);
  await until(() => calls === 1);
  assert.equal((await jobs.get(first.jobId, 'board')).status, 'running');
  await assert.rejects(jobs.get(first.jobId, 'other-board'), { status: 404 });
  await assert.rejects(jobs.enqueue({ ...input, sources: [{ ...input.sources[0], text: '[PDF page 1]\nDifferent text.' }] }), { status: 409 });
  finish({ title: '완성', researchDocument: { version: 2 } });
  await until(async () => (await jobs.get(first.jobId, 'board')).status === 'completed');
  const reloaded = createResearchDocumentJobs({ collection: db, generate: () => { throw Error('must not regenerate'); } });
  assert.equal((await reloaded.enqueue(input)).result.title, '완성');
  await tick(); assert.equal(calls, 1); assert.equal(db.rows.get(first.jobId).input, undefined);
});

test('failed or interrupted paid work is retained instead of silently recharged', async () => {
  const db = collection(); let calls = 0;
  const jobs = createResearchDocumentJobs({ collection: db, generate: async () => { calls++; throw Error('원문 연결 확인 실패'); } });
  const { jobId } = await jobs.enqueue(input);
  await until(async () => (await jobs.get(jobId, 'board')).status === 'failed');
  assert.equal((await jobs.enqueue(input)).error, '원문 연결 확인 실패');
  await tick(); assert.equal(calls, 1);
  Object.assign(db.rows.get(jobId), { status: 'running', leaseUntil: new Date(0) });
  assert.match((await jobs.get(jobId, 'board')).error, /중단/);
  await tick(); assert.equal(calls, 1);
});

test('queue caps simultaneous documents and starts the next after one finishes', async () => {
  const finishes = []; const jobs = createResearchDocumentJobs({ collection: collection(), concurrency: 2,
    generate: () => new Promise(resolve => finishes.push(resolve)) });
  const accepted = await Promise.all([1, 2, 3].map(n => jobs.enqueue({ ...input, requestId: `request-${n}` })));
  await until(() => finishes.length === 2);
  assert.equal((await jobs.get(accepted[2].jobId, 'board')).status, 'queued');
  finishes[0]({ title: 'first' }); await until(() => finishes.length === 3);
  finishes[1]({ title: 'second' }); finishes[2]({ title: 'third' });
  await until(async () => (await jobs.get(accepted[2].jobId, 'board')).status === 'completed');
});

test('question jobs retain every paper, reject changed secondary sources, and reuse completed answers', async () => {
  let calls = 0;
  const db = collection(), jobs = createResearchDocumentJobs({ collection: db, generate: async body => {
    calls++; assert.equal(body.purpose, 'question-outline'); assert.equal(body.sources.length, 2);
    return { title: '질문 답변', questionOutline: { excerpts: [{ sourceId: body.sources[1].paperId }] } };
  } });
  const body = { ...input, purpose: 'question-outline', sources: [...input.sources, { ...input.sources[0], paperId: 'stable-second', title: 'Second' }] };
  const { jobId } = await jobs.enqueue(body);
  await until(async () => (await jobs.get(jobId, 'board')).status === 'completed');
  assert.equal((await jobs.enqueue(body)).result.questionOutline.excerpts[0].sourceId, 'stable-second');
  await assert.rejects(jobs.enqueue({ ...body, sources: [body.sources[0], { ...body.sources[1], text: '[PDF page 1]\nChanged original.' }] }), { status: 409 });
  await tick(); assert.equal(calls, 1);
});
