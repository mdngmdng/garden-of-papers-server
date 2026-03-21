/**
 * MongoDB (PDF 컬렉션 + GridFS) → AWS S3 마이그레이션 스크립트
 *
 * 사용법: node scripts/migrate-pdf-to-s3.js [projectName]
 *   - projectName 지정 시 해당 프로젝트만 마이그레이션
 *   - 생략 시 모든 프로젝트를 마이그레이션
 */

require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const { MongoClient, GridFSBucket } = require('mongodb');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const mongoUri = process.env.MONGODB_URI;
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const Bucket = process.env.AWS_S3_BUCKET;

// S3에 이미 존재하는지 확인
async function existsInS3(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToS3(key, buffer) {
  await s3.send(new PutObjectCommand({
    Bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf',
  }));
}

// GridFS에서 파일을 Buffer로 읽기
function gridFsToBuffer(bucket, fileId) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = bucket.openDownloadStream(fileId);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function migrateProject(client, projectName) {
  const db = client.db(projectName);
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  // 1. PDF 컬렉션에서 마이그레이션
  const pdfCollection = db.collection('PDF');
  const pdfDocs = await pdfCollection.find({}).toArray();

  for (const doc of pdfDocs) {
    const fileId = doc.fileid;
    if (!fileId) continue;

    const s3Key = `papers/${projectName}/${fileId}.pdf`;

    if (await existsInS3(s3Key)) {
      console.log(`  [skip] ${fileId} — already in S3`);
      skipped++;
      continue;
    }

    try {
      const buffer = Buffer.isBuffer(doc.data) ? doc.data : doc.data.buffer;
      await uploadToS3(s3Key, buffer);
      console.log(`  [ok]   ${fileId} — PDF collection → S3 (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      migrated++;
    } catch (err) {
      console.error(`  [fail] ${fileId} — ${err.message}`);
      failed++;
    }
  }

  // 2. GridFS에서 마이그레이션
  const bucket = new GridFSBucket(db);
  const gridFiles = await bucket.find({}).toArray();

  for (const file of gridFiles) {
    const fileId = file.metadata?.fileid || file.filename;
    if (!fileId) continue;

    const s3Key = `papers/${projectName}/${fileId}.pdf`;

    if (await existsInS3(s3Key)) {
      console.log(`  [skip] ${fileId} — already in S3`);
      skipped++;
      continue;
    }

    try {
      const buffer = await gridFsToBuffer(bucket, file._id);
      await uploadToS3(s3Key, buffer);
      console.log(`  [ok]   ${fileId} — GridFS → S3 (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      migrated++;
    } catch (err) {
      console.error(`  [fail] ${fileId} — ${err.message}`);
      failed++;
    }
  }

  return { migrated, skipped, failed };
}

async function main() {
  const targetProject = process.argv[2];

  console.log('Connecting to MongoDB...');
  const client = new MongoClient(mongoUri);
  await client.connect();
  console.log('Connected.\n');

  let projects;
  if (targetProject) {
    projects = [targetProject];
  } else {
    // 모든 DB 중 PDF 또는 GridFS가 있는 프로젝트만 필터
    const dbList = await client.db().admin().listDatabases();
    const systemDbs = ['admin', 'local', 'config', 'UserNameList'];
    projects = dbList.databases
      .map((db) => db.name)
      .filter((name) => !systemDbs.includes(name));
  }

  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const project of projects) {
    const db = client.db(project);
    const collections = await db.listCollections().toArray();
    const collNames = collections.map((c) => c.name);

    const hasPdf = collNames.includes('PDF');
    const hasGridFs = collNames.includes('fs.files');

    if (!hasPdf && !hasGridFs) continue;

    console.log(`=== ${project} ===`);
    const result = await migrateProject(client, project);
    totalMigrated += result.migrated;
    totalSkipped += result.skipped;
    totalFailed += result.failed;
    console.log(`  → migrated: ${result.migrated}, skipped: ${result.skipped}, failed: ${result.failed}\n`);
  }

  console.log('========== DONE ==========');
  console.log(`Total migrated: ${totalMigrated}`);
  console.log(`Total skipped:  ${totalSkipped}`);
  console.log(`Total failed:   ${totalFailed}`);

  await client.close();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
