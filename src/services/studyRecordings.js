const { createHash } = require('node:crypto');
const { getClient } = require('./mongo');

class StudyRecordingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function hashChunk(sessionId, index, previousHash, text) {
  return createHash('sha256').update(JSON.stringify([sessionId, index, previousHash, text])).digest('hex');
}
function identifier(value) {
  if (typeof value !== 'string' || !value.length || value.length > 256) throw new StudyRecordingError('Invalid recording identity');
  return value;
}
function validateSession(value, workspaceId) {
  if (!value || value.schemaVersion !== 1 || value.workspaceId !== workspaceId || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new StudyRecordingError('Invalid recording session');
  }
  const session = {};
  for (const key of ['id', 'workspaceId', 'ownerName', 'projectName', 'startedAt', 'implementation']) session[key] = identifier(value[key]);
  session.schemaVersion = 1;
  return session;
}
function defaultCollections() {
  const client = getClient();
  if (!client) throw new StudyRecordingError('Recording database unavailable', 503);
  const db = client.db('GardenOfPapersSystem');
  return { sessions: db.collection('StudyRecordingSessions'), chunks: db.collection('StudyRecordingChunks') };
}

/** Independent of autosave, WebSocket leases, and mutable workspace snapshots.
 * Every write is insert-only; duplicate retries must match the original bytes.
 * Chunk IDs enforce sequence uniqueness even across concurrent server processes.
 */
function createStudyRecordingService(getCollections = defaultCollections) {
  let indexes;
  async function collections() {
    const result = getCollections();
    if (!indexes) indexes = Promise.all([
      result.sessions.createIndex({ workspaceId: 1, startedAt: 1, id: 1 }),
      result.chunks.createIndex({ sessionId: 1, index: 1 }, { unique: true }),
    ]).catch(error => { indexes = null; throw error; });
    await indexes;
    return result;
  }
  async function insertMatching(collection, document, matches) {
    try { await collection.insertOne(document); }
    catch (error) {
      if (error.code !== 11000) throw error;
      const previous = await collection.findOne({ _id: document._id });
      if (!previous || !matches(previous)) throw new StudyRecordingError('Recording already exists with different content', 409);
    }
  }
  return {
    async append(workspaceId, value) {
      identifier(workspaceId);
      const session = validateSession(value?.session, workspaceId);
      const chunks = value?.chunks;
      if (!Array.isArray(chunks) || !chunks.length || chunks.length > 8) throw new StudyRecordingError('Invalid recording batch');
      for (const [position, chunk] of chunks.entries()) {
        if (!chunk || chunk.sessionId !== session.id || !Number.isSafeInteger(chunk.index) || chunk.index < 0 ||
            typeof chunk.text !== 'string' || !chunk.text.length || chunk.text.length > 96 * 1024 ||
            typeof chunk.previousHash !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(chunk.previousHash) ||
            chunk.hash !== hashChunk(session.id, chunk.index, chunk.previousHash, chunk.text) ||
            (position && (chunk.index !== chunks[position - 1].index + 1 || chunk.previousHash !== chunks[position - 1].hash))) {
          throw new StudyRecordingError('Invalid recording chunk or checksum');
        }
      }
      const { sessions, chunks: storage } = await collections();
      const first = chunks[0];
      if (first.index === 0) {
        if (first.previousHash !== '') throw new StudyRecordingError('Initial recording chunk has a predecessor');
      } else {
        const previous = await storage.findOne({ _id: `${session.id}:${first.index - 1}` });
        if (!previous || previous.workspaceId !== workspaceId || previous.hash !== first.previousHash) throw new StudyRecordingError('Recording predecessor missing or changed', 409);
      }
      await insertMatching(sessions, { _id: session.id, ...session, receivedAt: new Date().toISOString() }, previous =>
        Object.keys(session).every(key => previous[key] === session[key]));
      for (const chunk of chunks) {
        const document = { _id: `${session.id}:${chunk.index}`, workspaceId,
          sessionId: chunk.sessionId, index: chunk.index, previousHash: chunk.previousHash,
          hash: chunk.hash, text: chunk.text, receivedAt: new Date().toISOString() };
        await insertMatching(storage, document, previous => previous.workspaceId === workspaceId && previous.hash === chunk.hash && previous.text === chunk.text);
      }
      const last = chunks[chunks.length - 1];
      return { nextIndex: last.index + 1, hash: last.hash };
    },
    async list(workspaceId) {
      identifier(workspaceId);
      const { sessions } = await collections();
      return { sessions: await sessions.find({ workspaceId }, { projection: { _id: 0, receivedAt: 0 } }).sort({ startedAt: 1, id: 1 }).toArray() };
    },
    async read(workspaceId, sessionId, afterValue = 0) {
      identifier(workspaceId); identifier(sessionId);
      const after = Number(afterValue);
      if (!Number.isSafeInteger(after) || after < 0) throw new StudyRecordingError('Invalid recording cursor');
      const { sessions, chunks: storage } = await collections();
      if (!await sessions.findOne({ _id: sessionId, workspaceId })) throw new StudyRecordingError('Recording session not found', 404);
      const result = await storage.find({ workspaceId, sessionId, index: { $gte: after } },
        { projection: { _id: 0, workspaceId: 0, receivedAt: 0 } }).sort({ index: 1 }).limit(9).toArray();
      return { chunks: result.slice(0, 8), hasMore: result.length > 8 };
    },
  };
}
module.exports = { StudyRecordingError, hashChunk, createStudyRecordingService, studyRecordingService: createStudyRecordingService() };
