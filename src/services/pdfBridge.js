const { getClient } = require('./mongo');

const DATABASE = 'GardenOfPapersSystem';
const COLLECTION = 'PdfBridgeRequests';
const EXPIRY_MS = 60 * 60 * 1000;

function pendingRequestId(projectName, fileId) {
  return `${Buffer.byteLength(projectName, 'utf8')}:${projectName}:${fileId}`;
}

function bridgeCollection() {
  return getClient().db(DATABASE).collection(COLLECTION);
}

function normalizeRequest(request) {
  return {
    projectName: String(request.projectName || '').trim(),
    fileId: String(request.fileId || '').trim(),
    pdfUrl: String(request.pdfUrl || '').trim(),
    scholarUrl: String(request.scholarUrl || '').trim(),
    paperTitle: String(request.paperTitle || '').trim(),
  };
}

async function registerPendingRequest(request) {
  const normalized = normalizeRequest(request);
  if (!normalized.projectName || !normalized.fileId) {
    const error = new Error('projectName and fileId are required');
    error.status = 400;
    throw error;
  }

  const client = getClient();
  const metadata = await client
    .db(normalized.projectName)
    .collection('PdfMeta')
    .findOne({ fileId: normalized.fileId });
  const requests = bridgeCollection();
  if (metadata?.size && metadata.uploadedAt) {
    await requests.deleteMany({
      projectName: normalized.projectName,
      fileId: normalized.fileId,
    });
    return { status: 'ready' };
  }

  const now = new Date();
  // Remove a legacy, globally keyed document for this same project before
  // writing the project-scoped key. A matching fileId in another project is
  // deliberately left untouched.
  await requests.deleteOne({
    _id: normalized.fileId,
    projectName: normalized.projectName,
  });
  await requests.updateOne(
    { _id: pendingRequestId(normalized.projectName, normalized.fileId) },
    {
      $set: {
        ...normalized,
        status: 'pending',
        updatedAt: now,
        expiresAt: new Date(now.getTime() + EXPIRY_MS),
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return { status: 'ok' };
}

async function pendingRequests(projectNameValue = '') {
  const requests = bridgeCollection();
  const now = new Date();
  await requests.deleteMany({ expiresAt: { $lte: now } });
  const projectName = String(projectNameValue || '').trim();
  const query = { status: 'pending', expiresAt: { $gt: now } };
  if (projectName) query.projectName = projectName;
  const pending = await requests
    .find(query)
    .sort({ updatedAt: 1 })
    .toArray();
  return pending.map((request) => ({
    projectName: request.projectName,
    fileId: request.fileId,
    pdfUrl: request.pdfUrl || '',
    scholarUrl: request.scholarUrl || '',
    paperTitle: request.paperTitle || '',
    timestamp: new Date(request.updatedAt || request.createdAt).getTime(),
  }));
}

async function removePendingRequest(fileIdValue, options = {}) {
  const fileId = String(fileIdValue || '').trim();
  const projectName = String(options.projectName || '').trim();
  const requests = bridgeCollection();
  const query = projectName ? { projectName, fileId } : { fileId };
  const pending = await requests.findOne(query);
  if (!pending) return { status: 'ok', deleted: false };

  if (options.force) {
    const result = await requests.deleteOne({ _id: pending._id });
    return { status: 'ok', deleted: result.deletedCount > 0 };
  }

  const metadata = await getClient()
    .db(pending.projectName)
    .collection('PdfMeta')
    .findOne({ fileId });
  if (!metadata?.size || !metadata.uploadedAt) {
    return {
      status: 'pending',
      deleted: false,
      error: 'PDF upload has not been confirmed in AWS S3',
    };
  }
  const result = await requests.deleteOne({ _id: fileId });
  return { status: 'ok', deleted: result.deletedCount > 0 };
}

module.exports = {
  pendingRequestId,
  pendingRequests,
  registerPendingRequest,
  removePendingRequest,
};
