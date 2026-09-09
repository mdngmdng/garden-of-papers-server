const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { studyRecordingService, hashChunk } = require('./studyRecordings');
const { auditResponseStream } = require('./openaiStreamAudit');

const studyContext = new AsyncLocalStorage();
function parseStudyContext(header) {
  if (typeof header !== 'string' || header.length > 8000) return null;
  try {
    const value = JSON.parse(decodeURIComponent(header));
    for (const key of ['sessionId', 'workspaceId', 'ownerName', 'projectName', 'requestId', 'implementation']) {
      if (typeof value[key] !== 'string' || !value[key] || value[key].length > 256) return null;
    }
    return value;
  } catch { return null; }
}
function studyAuditMiddleware(req, _res, next) {
  studyContext.run(parseStudyContext(req.get('x-gop-study-context')), next);
}
function providerPayload(text) {
  try {
    const value = JSON.parse(text);
    // Retain public model messages/tool results/usage. Private reasoning items
    // are outside the research record's observable-output contract.
    if (Array.isArray(value.output)) value.output = value.output.filter(item => item.type !== 'reasoning');
    for (const candidate of value.candidates || []) {
      if (candidate.content?.parts) candidate.content.parts = candidate.content.parts.filter(part => !part.thought);
    }
    return value;
  } catch { return text; }
}
function safeStudyValue(value) {
  if (typeof value === 'string') return value.replace(/([?&](?:key|api_key|access_token)=)[^&\s"<>]+/gi, '$1[omitted]');
  if (Buffer.isBuffer(value)) return { encoding: 'base64', bytes: value.toString('base64') };
  if (Array.isArray(value)) return value.map(safeStudyValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:api_key|authorization|access_token)$/i.test(key))
    .map(([key, item]) => [key, safeStudyValue(item)]));
  return value;
}

/** Persist service-level results even when a browser never polls the job again. */
async function auditStudyOperation(name, input, operation, output = value => value,
  getContext = () => studyContext.getStore(), storage = studyRecordingService) {
  const context = getContext();
  if (!context) return operation();
  const record = createProviderJournal(context, storage);
  await record('session.started', { source: name, parentSessionId: context.sessionId, parentRequestId: context.requestId });
  await record('provider.request', { operation: name, body: safeStudyValue(input) });
  let result;
  try { result = await operation(); }
  catch (error) {
    await record('provider.failed', { error: safeStudyValue(String(error)), status: error.response?.status,
      details: error.details ? safeStudyValue(error.details) : null,
      body: error.response?.data === undefined ? null : safeStudyValue(providerPayload(JSON.stringify(error.response.data))) });
    await record('session.ended', { source: name });
    throw error;
  }
  await record('provider.response', { body: safeStudyValue(output(result)) });
  await record('session.ended', { source: name });
  return result;
}

function createAuditedAxios(client, getContext = () => studyContext.getStore(), storage = studyRecordingService) {
  const call = (method, url, body, config) => {
    if (!getContext()) return method === 'get' ? client.get(url, config) : client.post(url, body, config);
    const encoded = body?.getBuffer ? { encoding: 'base64-multipart', bytes: body.getBuffer().toString('base64') } : body;
    return auditStudyOperation('http.' + method, { url, body: encoded, params: config?.params },
      () => method === 'get' ? client.get(url, config) : client.post(url, body, config),
      response => ({ status: response.status, body: providerPayload(JSON.stringify(response.data)) }), getContext, storage);
  };
  return { get: (url, config) => call('get', url, undefined, config), post: (url, body, config) => call('post', url, body, config) };
}
function createProviderJournal(context, storage = studyRecordingService) {
  const session = { id: randomUUID(), workspaceId: context.workspaceId, ownerName: context.ownerName,
    projectName: context.projectName, startedAt: new Date().toISOString(), implementation: context.implementation, schemaVersion: 1 };
  let sequence = 0, index = 0, previousHash = '';
  const started = performance.now();
  return async (type, data) => {
    const event = { schemaVersion: 1, sessionId: session.id, sequence: ++sequence, time: new Date().toISOString(),
      elapsedMs: performance.now() - started, type, data,
      ...(sequence === 1 ? { frame: { workspace: { id: context.workspaceId, projectName: context.projectName }, objects: {}, objectOrder: [], ui: {} } } : {}) };
    const raw = JSON.stringify(event) + '\n';
    const chunks = [];
    for (let offset = 0; offset < raw.length; offset += 96 * 1024) {
      const text = raw.slice(offset, offset + 96 * 1024);
      const hash = hashChunk(session.id, index, previousHash, text);
      chunks.push({ sessionId: session.id, index: index++, previousHash, hash, text }); previousHash = hash;
    }
    for (let offset = 0; offset < chunks.length; offset += 8) {
      const batch = { session, chunks: chunks.slice(offset, offset + 8) };
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await storage.append(context.workspaceId, batch); lastError = null; break; }
        catch (error) { lastError = error; }
      }
      if (lastError) throw new Error('Research provider record could not be saved', { cause: lastError });
    }
  };
}
function createAuditedProviderFetch(fetcher, getContext = () => studyContext.getStore(), storage = studyRecordingService) {
  return async (input, init) => {
    const context = getContext();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!context || url.hostname !== 'api.openai.com') return fetcher(input, init);
    const record = createProviderJournal(context, storage);
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : null;
    // Persist the complete effective prompt before issuing a model request.
    // Never persist authorization or any other transport headers.
    await record('session.started', { source: 'provider', parentSessionId: context.sessionId, parentRequestId: context.requestId, url: url.toString() });
    await record('provider.request', { body });
    let response;
    try { response = await fetcher(input, init); }
    catch (error) { await record('provider.failed', { error: String(error) }); throw error; }
    if (response.body && response.headers.get('content-type')?.includes('text/event-stream')) {
      await record('provider.response_headers', { status: response.status, ok: response.ok,
        requestId: response.headers.get('x-request-id') });
      return auditResponseStream(response, record);
    }
    let text;
    try { text = await response.clone().text(); }
    catch (error) { await record('provider.failed', { error: String(error), phase: 'response_body' }); throw error; }
    await record('provider.response', { status: response.status, ok: response.ok, body: providerPayload(text) });
    await record('session.ended', { source: 'provider' });
    return response;
  };
}
module.exports = { parseStudyContext, studyAuditMiddleware, createProviderJournal, createAuditedProviderFetch,
  auditStudyOperation, createAuditedAxios };
