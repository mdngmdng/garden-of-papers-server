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

module.exports = { uploadPdf, downloadPdf, deletePdf, listPdfs, headPdf };
