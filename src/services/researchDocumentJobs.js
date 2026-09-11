const { createHash, randomUUID } = require('node:crypto');
const { parseAIArtifactRequest, generateResearchDocument, generateAIArtifact, parseAIArtifactResult, researchDocumentResultForClient } = require('../generated/researchDocumentPipeline.cjs');
const { studyAuditMiddleware, parseStudyContext } = require('./studyProviderAudit');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 256;
const pdfIdentity = source => {
  if (source.pdfKey?.startsWith('file:')) return source.pdfKey;
  if (!source.pdfUrl) return null;
  const url = new URL(source.pdfUrl);
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/^(?:x-amz-.+|x-goog-.+|awsaccesskeyid|signature|expires|policy|key-pair-id)$/i.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  return url.href;
};
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const publicJob = (job, format) => ({ jobId: job._id, status: job.status, ...(job.result ? { result: researchDocumentResultForClient(job.result, format) } : {}),
  ...(job.error ? { error: job.error } : {}) });

/** Mongo owns request identity and results; HTTP disconnects cannot cancel paid work. */
function createResearchDocumentJobs({ collection, generate, now = () => new Date(), concurrency = 2 }) {
  const active = new Set();
  let draining = false;
  let timer;
  const schedule = () => setImmediate(() => { void drain().catch(error => console.error('Research job queue:', error.message)); });

  async function expireInterrupted() {
    await collection.updateMany({ status: 'running', leaseUntil: { $lt: now() } }, {
      $set: { status: 'failed', error: '분석 서버 작업이 중단되었습니다. 다시 분석해 주세요.', updatedAt: now() },
      $unset: { input: '', auditHeader: '' },
    });
  }

  async function run(job) {
    try {
      const result = await new Promise((resolve, reject) => {
        // Restore the originating recording context even when another request drains this job.
        studyAuditMiddleware({ get: () => job.auditHeader }, null, () => {
          Promise.resolve().then(() => generate(job.input, AbortSignal.timeout(500000))).then(resolve, reject);
        });
      });
      await collection.updateOne({ _id: job._id, status: 'running', runId: job.runId }, {
        $set: { status: 'completed', result, updatedAt: now() }, $unset: { input: '', auditHeader: '', leaseUntil: '' },
      });
    } catch (error) {
      await collection.updateOne({ _id: job._id, status: 'running', runId: job.runId }, {
        $set: { status: 'failed', error: ['AbortError', 'TimeoutError'].includes(error?.name)
          ? '논문 분석 시간이 초과되었습니다. 다시 분석해 주세요.' : String(error?.message || '연구 문서를 생성하지 못했습니다.').slice(0, 2000), updatedAt: now() },
        $unset: { input: '', auditHeader: '', leaseUntil: '' },
      });
    } finally { active.delete(job._id); schedule(); }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      await expireInterrupted();
      while (active.size < concurrency) {
        // CAS also prevents two server processes from executing the same request.
        const job = await collection.findOneAndUpdate({ status: 'queued' }, {
          $set: { status: 'running', runId: randomUUID(), updatedAt: now(), leaseUntil: new Date(+now() + 600000) },
        }, { sort: { createdAt: 1 }, returnDocument: 'after' });
        if (!job) break;
        active.add(job._id);
        void run(job).catch(error => console.error('Research job persistence:', error.message));
      }
    } finally { draining = false; }
  }

  return {
    async start() {
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await collection.createIndex({ status: 1, createdAt: 1 });
      if (!timer) { timer = setInterval(schedule, 5000); timer.unref(); }
      schedule();
    },
    stop() { clearInterval(timer); timer = undefined; },
    async enqueue(body, auditHeader) {
      if (!identifier(body?.workspaceId) || !identifier(body?.requestId)) throw failure('보드와 분석 요청 정보가 필요합니다.');
      const input = parseAIArtifactRequest(body);
      if (input.purpose === 'research-document' && input.sources.some(s => !/^\[PDF page 1\]/.test(s.text))) throw failure('문장 위치를 확인할 PDF 본문이 필요합니다.');
      const _id = hash([body.workspaceId, body.requestId]);
      // PDFJS's generated font IDs, signed URLs, and Mongo paper IDs can change on reload.
      const fingerprint = hash(input.purpose === 'research-document'
        ? [input.kind, input.purpose, input.prompt, input.sources[0].title, input.sources[0].text]
        : [input.kind, input.purpose, input.prompt, input.sources.map(s => [s.paperId, s.kind, s.title, s.text,
          s.pageIndex, s.selectedText, pdfIdentity(s)])]);
      const job = { _id, workspaceId: body.workspaceId, requestId: body.requestId, fingerprint, input, status: 'queued',
        createdAt: now(), updatedAt: now(), expiresAt: new Date(+now() + 7 * 86400000),
        auditHeader: parseStudyContext(auditHeader)?.workspaceId === body.workspaceId ? auditHeader : null };
      try { await collection.insertOne(job); }
      catch (error) {
        if (error.code !== 11000) throw error;
        const existing = await collection.findOne({ _id, workspaceId: body.workspaceId });
        if (!existing || existing.fingerprint !== fingerprint) throw failure('같은 분석 요청의 원문이 변경되었습니다. 다시 분석해 주세요.', 409);
        schedule(); return publicJob(existing, body.researchDocumentFormat);
      }
      schedule(); return publicJob(job, body.researchDocumentFormat);
    },
    async get(id, workspaceId, format) {
      if (!/^[a-f0-9]{64}$/.test(id) || !identifier(workspaceId)) throw failure('분석 작업 정보가 올바르지 않습니다.');
      await expireInterrupted();
      const job = await collection.findOne({ _id: id, workspaceId });
      if (!job) throw failure('분석 작업을 찾을 수 없습니다.', 404);
      if (job.status === 'queued') schedule();
      return publicJob(job, format);
    },
  };
}

async function generate(input, signal) {
  const key = require('../config').openai.apiKey;
  if (!key) throw failure('서버에 AI 생성 키가 설정되지 않았습니다.', 503);
  if (input.purpose !== 'research-document') return generateAIArtifact(input, key, signal);
  const source = input.sources[0];
  const generated = { researchDocument: await generateResearchDocument({ text: source.text, pdfUrl: source.pdfUrl, layout: source.researchLayout, key, signal }) };
  const result = parseAIArtifactResult(generated, input.sources, input.kind, input.purpose);
  if (!result) throw Error('연구 문서 형식이 올바르지 않습니다.');
  return result;
}

let instance;
function researchDocumentJobs() {
  if (!instance) {
    const collection = require('./mongo').getClient().db('GardenOfPapersSystem').collection('ResearchDocumentJobs');
    instance = createResearchDocumentJobs({ collection, generate });
  }
  return instance;
}
module.exports = { createResearchDocumentJobs, researchDocumentJobs };
