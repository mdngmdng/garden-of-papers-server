const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ProjectLeaseError,
  createProjectLeaseService,
} = require('../src/services/projectLeases');

class MemoryLeaseCollection {
  constructor() {
    this.documents = new Map();
  }

  async findOneAndUpdate(query, update) {
    const existing = this.documents.get(query._id);
    const sameClient = existing?.clientId === query.$or[0].clientId;
    const expired = existing?.expiresAt <= query.$or[1].expiresAt.$lte;
    if (existing && !sameClient && !expired) {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    const document = {
      ...(existing || update.$setOnInsert),
      ...structuredClone(update.$set),
      _id: query._id,
    };
    this.documents.set(query._id, document);
    return structuredClone(document);
  }

  async deleteOne(query) {
    const existing = this.documents.get(query._id);
    if (!existing || existing.clientId !== query.clientId) {
      return { deletedCount: 0 };
    }
    this.documents.delete(query._id);
    return { deletedCount: 1 };
  }
}

function fixture() {
  const collection = new MemoryLeaseCollection();
  let timestamp = Date.parse('2026-08-18T00:00:00.000Z');
  const service = createProjectLeaseService(
    () => collection,
    () => new Date(timestamp),
    90_000,
  );
  return {
    collection,
    service,
    advance(milliseconds) { timestamp += milliseconds; },
  };
}

test('blocks a second client from claiming an active project', async () => {
  const { service } = fixture();
  await service.claim({ projectName: 'board-a', clientId: 'client-a' });

  await assert.rejects(
    service.claim({ projectName: 'board-a', clientId: 'client-b' }),
    (error) => error instanceof ProjectLeaseError && error.status === 409,
  );
});

test('lets the owner renew its lease and rejects another client release', async () => {
  const { collection, service, advance } = fixture();
  const first = await service.claim({ projectName: 'board-a', clientId: 'client-a' });
  advance(30_000);
  const renewed = await service.claim({ projectName: 'board-a', clientId: 'client-a' });

  assert.notEqual(renewed.expiresAt, first.expiresAt);
  assert.equal(
    (await service.release({ projectName: 'board-a', clientId: 'client-b' })).released,
    false,
  );
  assert.equal(collection.documents.has('board-a'), true);
});

test('allows another client after release or lease expiration', async () => {
  const { service, advance } = fixture();
  await service.claim({ projectName: 'board-a', clientId: 'client-a' });
  assert.equal(
    (await service.release({ projectName: 'board-a', clientId: 'client-a' })).released,
    true,
  );
  await service.claim({ projectName: 'board-a', clientId: 'client-b' });

  await service.claim({ projectName: 'board-b', clientId: 'client-a' });
  advance(90_001);
  const expiredClaim = await service.claim({
    projectName: 'board-b',
    clientId: 'client-b',
  });
  assert.equal(expiredClaim.ok, true);
});
