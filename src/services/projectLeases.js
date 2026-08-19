const { getClient } = require('./mongo');

const DATABASE = 'GardenOfPapersSystem';
const COLLECTION = 'PdfBridgeProjectLeases';
const DEFAULT_LEASE_MS = 90 * 1000;

class ProjectLeaseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProjectLeaseError';
    this.status = status;
  }
}

function requiredString(value, name, maxLength = 160) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new ProjectLeaseError(`${name} is required`);
  if (normalized.length > maxLength) {
    throw new ProjectLeaseError(`${name} is too long`);
  }
  return normalized;
}

function leaseCollection() {
  return getClient().db(DATABASE).collection(COLLECTION);
}

function createProjectLeaseService(
  collectionProvider = leaseCollection,
  now = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
) {
  async function claim(values = {}) {
    const projectName = requiredString(values.projectName, 'projectName');
    const clientId = requiredString(values.clientId, 'clientId');
    const claimedAt = now();
    const expiresAt = new Date(claimedAt.getTime() + leaseMs);

    try {
      const lease = await collectionProvider().findOneAndUpdate(
        {
          _id: projectName,
          $or: [
            { clientId },
            { expiresAt: { $lte: claimedAt } },
          ],
        },
        {
          $set: {
            projectName,
            clientId,
            updatedAt: claimedAt,
            expiresAt,
          },
          $setOnInsert: { createdAt: claimedAt },
        },
        { upsert: true, returnDocument: 'after' },
      );

      if (!lease) {
        throw new ProjectLeaseError(
          'This project is already in use by another PDF Bridge client.',
          409,
        );
      }

      return {
        ok: true,
        projectName,
        expiresAt: expiresAt.toISOString(),
        leaseMs,
      };
    } catch (error) {
      // A competing upsert on the same _id is MongoDB's atomic conflict signal.
      if (error?.code === 11000) {
        throw new ProjectLeaseError(
          'This project is already in use by another PDF Bridge client.',
          409,
        );
      }
      throw error;
    }
  }

  async function release(values = {}) {
    const projectName = requiredString(values.projectName, 'projectName');
    const clientId = requiredString(values.clientId, 'clientId');
    const result = await collectionProvider().deleteOne({
      _id: projectName,
      clientId,
    });
    return {
      ok: true,
      projectName,
      released: result.deletedCount > 0,
    };
  }

  return { claim, release };
}

module.exports = {
  DEFAULT_LEASE_MS,
  ProjectLeaseError,
  createProjectLeaseService,
  ...createProjectLeaseService(),
};
