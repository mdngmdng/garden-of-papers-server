#!/usr/bin/env node

const { MongoClient } = require('mongodb');
const { gzipSync, gunzipSync } = require('node:zlib');
const config = require('../src/config');

const SYSTEM_DATABASE = 'GardenOfPapersSystem';
const SNAPSHOT_ENCODING = 'gzip-json-v1';
const RETIRED_SKETCH_TYPE = 'GX.MAROPtCurve';
const workspaceId = String(process.argv[2] || '').trim();
const apply = process.argv.includes('--apply');

if (!workspaceId) {
  console.error('Usage: node scripts/remove-workspace-sketches.js <workspace> [--apply]');
  process.exit(1);
}

function payloadBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (ArrayBuffer.isView(payload?.buffer)) {
    return Buffer.from(
      payload.buffer.buffer,
      payload.buffer.byteOffset,
      payload.buffer.byteLength,
    );
  }
  return Buffer.from(payload?.buffer || payload);
}

function documentState(document) {
  if (!document) return null;
  if (document.stateEncoding === SNAPSHOT_ENCODING && document.statePayload) {
    return JSON.parse(
      gunzipSync(payloadBuffer(document.statePayload)).toString('utf8'),
    );
  }
  return document.state || null;
}

function summarize(state) {
  const summary = { objects: state.objects.length, papers: 0, notes: 0, links: 0, searches: 0 };
  for (const object of state.objects) {
    if (object.type === 'GX.MAROScientificPaper') summary.papers += 1;
    else if (object.type === 'GX.MARONote') summary.notes += 1;
    else if (object.type === 'GX.MAROLink') summary.links += 1;
    else if (object.type === 'GX.MAROBlankPaper') summary.searches += 1;
  }
  return summary;
}

function sanitizedState(document, { bumpRevision = false } = {}) {
  const state = documentState(document);
  if (!state?.objects) return { state, removed: 0 };
  const objects = state.objects.filter(
    (object) => object?.type !== RETIRED_SKETCH_TYPE,
  );
  const removed = state.objects.length - objects.length;
  if (!removed) return { state, removed };
  const timestamp = new Date().toISOString();
  return {
    removed,
    state: {
      ...state,
      objects,
      ...(bumpRevision
        ? { revision: Math.max(document.revision || 0, state.revision || 0) + 1 }
        : {}),
      updatedAt: bumpRevision ? timestamp : state.updatedAt,
    },
  };
}

function stateUpdate(state) {
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, 'utf8') <= 12 * 1024 * 1024) {
    return {
      $set: { state },
      $unset: { stateEncoding: '', statePayload: '' },
    };
  }
  return {
    $set: {
      stateEncoding: SNAPSHOT_ENCODING,
      statePayload: gzipSync(Buffer.from(serialized), { level: 6 }),
    },
    $unset: { state: '' },
  };
}

async function run() {
  const client = new MongoClient(config.mongoUrl);
  await client.connect();
  try {
    const legacy = client.db(workspaceId).collection('SaveFile');
    const system = client.db(SYSTEM_DATABASE);
    const snapshots = system.collection('WorkspaceSnapshots');
    const history = system.collection('WorkspaceSnapshotHistory');
    const deltas = system.collection('WorkspaceSnapshotDeltas');
    const [legacyCount, current, historyDocuments, deltaCount] = await Promise.all([
      legacy.countDocuments({ type: RETIRED_SKETCH_TYPE }),
      snapshots.findOne({ _id: workspaceId }),
      history.find({ projectName: workspaceId }).toArray(),
      deltas.countDocuments({ projectName: workspaceId }),
    ]);
    const currentSanitized = sanitizedState(current, { bumpRevision: true });
    const historySanitized = historyDocuments.map((document) => ({
      document,
      ...sanitizedState(document),
    }));
    const historyCurveCount = historySanitized.reduce(
      (total, item) => total + item.removed,
      0,
    );
    const report = {
      workspaceId,
      apply,
      legacyCurves: legacyCount,
      currentSnapshotCurves: currentSanitized.removed,
      historySnapshotCurves: historyCurveCount,
      historyDocumentsChanged: historySanitized.filter((item) => item.removed).length,
      deltaDocumentsToRebuild: currentSanitized.removed || historyCurveCount ? deltaCount : 0,
    };
    if (!apply) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (legacyCount) {
      await legacy.deleteMany({ type: RETIRED_SKETCH_TYPE });
    }
    await legacy.updateMany(
      { ptCurveIds: { $exists: true } },
      { $unset: { ptCurveIds: '' } },
    );
    if (currentSanitized.removed) {
      const timestamp = new Date();
      const update = stateUpdate(currentSanitized.state);
      update.$set.revision = currentSanitized.state.revision;
      update.$set.summary = summarize(currentSanitized.state);
      update.$set.camera = currentSanitized.state.camera;
      update.$set.updatedAt = timestamp;
      update.$set.lastMutationId = `remove-sketches:${timestamp.toISOString()}`;
      await snapshots.updateOne({ _id: workspaceId }, update);
    }
    for (const item of historySanitized) {
      if (!item.removed) continue;
      const update = stateUpdate(item.state);
      update.$set.summary = summarize(item.state);
      update.$set.camera = item.state.camera;
      await history.updateOne({ _id: item.document._id }, update);
    }
    if (currentSanitized.removed || historyCurveCount) {
      await deltas.deleteMany({ projectName: workspaceId });
    }
    console.log(JSON.stringify({ ...report, status: 'cleaned' }, null, 2));
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
