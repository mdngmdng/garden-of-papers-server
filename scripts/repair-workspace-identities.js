// Targeted, backed-up migration for boards saved by the old clipboard code.
// Default: inspect only. Usage: node scripts/repair-workspace-identities.js
// --project <name> [--apply --backup <absolute .ejson path>]
const fs = require('node:fs/promises');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { MongoClient, BSON } = require('mongodb');
const { repairDuplicatePersistenceKeys } = require('../src/services/persistenceIdentity');

function planRepair(document, rows) {
  const state = document.stateEncoding === 'gzip-json-v1'
    ? JSON.parse(gunzipSync(Buffer.isBuffer(document.statePayload)
      ? document.statePayload : document.statePayload.buffer).toString('utf8'))
    : structuredClone(document.state);
  const all = new Map(state.objects.map(object => [object.id, object]));
  for (const row of rows) {
    if (!row.clientObjectId) continue;
    const id = String(row._id), previous = all.get(id);
    if (previous?.persistenceKey && previous.persistenceKey !== row.clientObjectId) {
      throw new Error(`Stored identities disagree for ${id}; inspect before repairing.`);
    }
    all.set(id, { id, type: row.type, persistenceKey: row.clientObjectId });
  }
  const repaired = new Map(repairDuplicatePersistenceKeys([...all.values()]).map(object => [object.id, object]));
  const legacyChanges = rows.flatMap(row => {
    const next = repaired.get(String(row._id));
    return row.clientObjectId && next && next.persistenceKey !== row.clientObjectId
      ? [{ id: row._id, before: row.clientObjectId, after: next.persistenceKey }] : [];
  });
  const snapshotChanges = [];
  state.objects = state.objects.map(object => {
    const next = repaired.get(object.id);
    if (!next || next.persistenceKey === object.persistenceKey) return object;
    snapshotChanges.push({ id: object.id, before: object.persistenceKey, after: next.persistenceKey });
    return { ...object, persistenceKey: next.persistenceKey };
  });
  return { state, legacyChanges, snapshotChanges };
}

async function main(args) {
  const value = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] || ''; };
  const project = value('--project'), backup = value('--backup'), apply = args.includes('--apply');
  if (!project || project.startsWith('--')) throw new Error('--project is required.');
  if (apply && (!backup || !path.isAbsolute(backup))) throw new Error('--apply requires an absolute --backup path.');
  const config = require('../src/config');
  const client = new MongoClient(config.mongoUrl);
  try {
    await client.connect();
    const snapshots = client.db('GardenOfPapersSystem').collection('WorkspaceSnapshots');
    const legacy = client.db(project).collection('SaveFile');
    const document = await snapshots.findOne({ _id: project });
    if (!document) throw new Error('Workspace snapshot not found.');
    const rows = await legacy.find({}).toArray();
    const plan = planRepair(document, rows);
    console.log(JSON.stringify({ project, apply, revision: document.revision,
      snapshotChanges: plan.snapshotChanges, legacyChanges: plan.legacyChanges }, null, 2));
    if (!apply || (!plan.snapshotChanges.length && !plan.legacyChanges.length)) return;
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.writeFile(backup, BSON.EJSON.stringify({ document, rows }), { flag: 'wx' });
    if (plan.snapshotChanges.length) {
      plan.state.revision = document.revision + 1;
      // Preserve the original content timestamp: a newer legacy board must
      // still win on the next load, including its unsynced conversation.
      const fields = { revision: plan.state.revision, lastMutationId: `identity-repair:${Date.now()}:recovery` };
      if (document.stateEncoding === 'gzip-json-v1') fields.statePayload = gzipSync(Buffer.from(JSON.stringify(plan.state)));
      else fields.state = plan.state;
      const result = await snapshots.updateOne({ _id: project, revision: document.revision,
        lastMutationId: document.lastMutationId }, { $set: fields });
      if (result.matchedCount !== 1) throw new Error('Workspace changed during repair; no snapshot was overwritten.');
    }
    for (const change of plan.legacyChanges) {
      const result = await legacy.updateOne({ _id: change.id, clientObjectId: change.before },
        { $set: { clientObjectId: change.after } });
      if (result.matchedCount !== 1) throw new Error(`Legacy object ${change.id} changed during repair; inspect the backup.`);
    }
    const verified = planRepair(await snapshots.findOne({ _id: project }), await legacy.find({}).toArray());
    if (verified.snapshotChanges.length || verified.legacyChanges.length) throw new Error('Identity repair verification failed.');
    console.log(JSON.stringify({ repaired: true, backup, objectsPreserved: plan.state.objects.length }));
  } finally { await client.close(); }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { planRepair };
