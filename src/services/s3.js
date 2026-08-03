const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const https = require('node:https');
const config = require('../config');

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 30_000,
});

const s3 = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
  requestHandler: new NodeHttpHandler({
    httpsAgent,
    connectionTimeout: 5_000,
    socketTimeout: 30_000,
    requestTimeout: 120_000,
    throwOnRequestTimeout: true,
    socketAcquisitionWarningTimeout: 5_000,
  }),
});

const Bucket = config.aws.s3Bucket;

async function uploadPdf(key, buffer) {
  await s3.send(new PutObjectCommand({
    Bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf',
  }));
  return key;
}

async function uploadPdfPreview(key, buffer, contentType = 'image/webp') {
  await s3.send(new PutObjectCommand({
    Bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'private, max-age=31536000, immutable',
  }));
  return key;
}

async function createPdfUploadUrl(key, contentType = 'application/pdf') {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 15 * 60 },
  );
}

async function downloadPdf(key, range, { abortSignal } = {}) {
  const input = { Bucket, Key: key };
  if (range) input.Range = range;
  const res = await s3.send(
    new GetObjectCommand(input),
    abortSignal ? { abortSignal } : undefined,
  );
  return res;
}

async function downloadPdfBuffer(key, { abortSignal } = {}) {
  const res = await downloadPdf(key, undefined, { abortSignal });
  const chunks = [];
  try {
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (error) {
    if (typeof res.Body.destroy === 'function') res.Body.destroy();
    throw error;
  }
}

async function downloadPdfPreview(key, { abortSignal } = {}) {
  return s3.send(
    new GetObjectCommand({ Bucket, Key: key }),
    abortSignal ? { abortSignal } : undefined,
  );
}

async function deletePdf(key) {
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

async function listPdfs(prefix) {
  const res = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix }));
  return (res.Contents || []).map((obj) => obj.Key);
}

async function headPdf(key) {
  const res = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
  return { size: res.ContentLength };
}

async function headPdfPreview(key) {
  const res = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
  return {
    size: res.ContentLength,
    contentType: res.ContentType,
  };
}

async function uploadTeiXml(key, xmlString) {
  await s3.send(new PutObjectCommand({
    Bucket,
    Key: key,
    Body: Buffer.from(xmlString, 'utf-8'),
    ContentType: 'application/xml',
  }));
  return key;
}

async function downloadTeiXml(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function uploadSemanticIndex(key, buffer) {
  await s3.send(new PutObjectCommand({
    Bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/json',
    ContentEncoding: 'gzip',
  }));
  return key;
}

async function downloadSemanticIndex(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = {
  uploadPdf,
  uploadPdfPreview,
  createPdfUploadUrl,
  downloadPdf,
  downloadPdfBuffer,
  downloadPdfPreview,
  deletePdf,
  listPdfs,
  headPdf,
  headPdfPreview,
  uploadTeiXml,
  downloadTeiXml,
  uploadSemanticIndex,
  downloadSemanticIndex,
};
