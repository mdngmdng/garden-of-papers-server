/**
 * S3에 있는 PDF 크기를 MongoDB PdfMeta 컬렉션에 캐싱
 * 사용법: node scripts/cache-pdf-sizes.js [projectName]
 */

require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const { MongoClient } = require('mongodb');
const { S3Client, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const Bucket = process.env.AWS_S3_BUCKET;

async function main() {
  const targetProject = process.argv[2];

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('MongoDB connected');

  let projects;
  if (targetProject) {
    projects = [targetProject];
  } else {
    const dbList = await client.db().admin().listDatabases();
    const systemDbs = ['admin', 'local', 'config', 'UserNameList'];
    projects = dbList.databases.map((db) => db.name).filter((n) => !systemDbs.includes(n));
  }

  let total = 0;
  for (const project of projects) {
    const prefix = `papers/${project}/`;
    const res = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix }));
    const objects = res.Contents || [];

    if (objects.length === 0) continue;

    console.log(`\n=== ${project}: ${objects.length} files ===`);
    const pdfMeta = client.db(project).collection('PdfMeta');

    for (const obj of objects) {
      const fileId = obj.Key.replace(prefix, '').replace('.pdf', '');
      await pdfMeta.updateOne(
        { fileId },
        { $set: { fileId, size: obj.Size } },
        { upsert: true },
      );
      console.log(`  [ok] ${fileId} → ${(obj.Size / 1024 / 1024).toFixed(1)} MB`);
      total++;
    }
  }

  console.log(`\nDone. Cached ${total} entries.`);
  await client.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
