const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const config = require('../config');

const s3 = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
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

async function downloadPdf(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  return res;
}

async function deletePdf(key) {
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

async function listPdfs(prefix) {
  const res = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix }));
  return (res.Contents || []).map((obj) => obj.Key);
}

async function headPdf(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  return { size: res.ContentLength };
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

module.exports = { uploadPdf, downloadPdf, deletePdf, listPdfs, headPdf, uploadTeiXml, downloadTeiXml };
