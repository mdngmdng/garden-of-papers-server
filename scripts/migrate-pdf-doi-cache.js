/**
 * Promote legacy per-workspace PDFs into the DOI-addressed shared S3 cache.
 * Safe default: dry run. Pass --apply to copy objects and update PdfMeta.
 * Legacy S3 objects are retained so rollback remains possible.
 */
const { connect, getClient } = require('../src/services/mongo');
const pdfStorage = require('../src/services/pdfStorage');
const s3 = require('../src/services/s3');

const apply = process.argv.includes('--apply');
const SYSTEM_DATABASES = new Set(['admin', 'config', 'local']);

async function main() {
  await connect();
  const client = getClient();
  const databases = await client.db().admin().listDatabases();
  let candidates = 0;
  let copied = 0;
  let reused = 0;

  for (const { name } of databases.databases || []) {
    if (SYSTEM_DATABASES.has(name)) continue;
    const db = client.db(name);
    const papers = await db.collection('SaveFile').find({
      type: 'GX.MAROScientificPaper',
      doi: { $type: 'string', $ne: '' },
    }).project({ _id: 1, fileId: 1, doi: 1 }).toArray();
    for (const paper of papers) {
      const fileId = String(paper.fileId || paper._id || '');
      const doi = pdfStorage.normalizeDoi(paper.doi);
      if (!fileId || !pdfStorage.isValidDoi(doi)) continue;
      const metadata = await db.collection('PdfMeta').findOne({ fileId });
      if (!metadata?.size) continue;
      const sourceKey = metadata.storageKey
        || pdfStorage.legacyPdfKey(name, fileId);
      const destinationKey = pdfStorage.doiPdfKey(doi);
      candidates += 1;

      let exists = false;
      try {
        await s3.headPdf(destinationKey);
        exists = true;
      } catch (error) {
        if (error?.name !== 'NoSuchKey' && error?.$metadata?.httpStatusCode !== 404) {
          throw error;
        }
      }
      if (exists) reused += 1;
      else if (apply) {
        await s3.copyPdf(sourceKey, destinationKey);
        copied += 1;
      }
      if (apply) {
        await db.collection('PdfMeta').updateOne(
          { fileId },
          { $set: { doi, storageKey: destinationKey } },
        );
      }
      console.log(`${apply ? '[apply]' : '[dry-run]'} ${name}/${fileId} -> ${destinationKey}`);
    }
  }
  console.log(JSON.stringify({ apply, candidates, copied, reused }));
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
