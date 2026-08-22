/**
 * Render the first page of every saved paper and store it in S3.
 *
 * Usage:
 *   npm run backfill:pdf-previews -- [projectName] [--force] [--concurrency=2]
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const {
  generatePdfPreview,
  markPreviewFailure,
} = require('../src/services/pdfPreview');

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config', 'UserNameList']);

function readOptions(argv) {
  const projectName = argv.find((value) => !value.startsWith('--'));
  const concurrencyOption = argv.find((value) => value.startsWith('--concurrency='));
  const parsedConcurrency = Number(concurrencyOption?.split('=')[1] || 2);
  const concurrency = Math.max(
    1,
    Math.min(
      4,
      Number.isFinite(parsedConcurrency) ? Math.floor(parsedConcurrency) : 2,
    ),
  );
  return {
    projectName,
    concurrency,
    force: argv.includes('--force'),
  };
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials are required');
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    const projects = options.projectName
      ? [options.projectName]
      : (await client.db().admin().listDatabases()).databases
        .map((database) => database.name)
        .filter((name) => !SYSTEM_DATABASES.has(name));
    let completed = 0;
    let failed = 0;

    for (const projectName of projects) {
      const saveFile = client.db(projectName).collection('SaveFile');
      await saveFile.updateMany(
        { type: 'GX.MAROScientificPaper', 'pdfPagePreview.version': 1 },
        { $unset: { pdfPagePreview: '' } },
      );
      const papers = await saveFile.find(
        {
          type: 'GX.MAROScientificPaper',
          fileId: { $type: 'string', $ne: '' },
        },
        { projection: { fileId: 1, abovePageIndex: 1, paperName: 1 } },
      ).toArray();
      if (!papers.length) continue;
      console.log(`[PDF preview] ${projectName}: ${papers.length} paper(s)`);
      await mapConcurrent(papers, options.concurrency, async (paper) => {
        const fileId = String(paper.fileId);
        const pageIndex = 0;
        try {
          const preview = await generatePdfPreview(projectName, fileId, pageIndex, {
            force: options.force,
            mongoClient: client,
          });
          if (!preview) {
            console.log(`  [skip] ${paper.paperName || fileId} retry is suppressed`);
            return;
          }
          completed += 1;
          console.log(
            `  [ok] ${paper.paperName || fileId} page=${preview.pageIndex + 1}`,
          );
        } catch (error) {
          failed += 1;
          await markPreviewFailure(
            projectName,
            fileId,
            pageIndex,
            error,
            client,
          );
          console.error(
            `  [fail] ${paper.paperName || fileId}: ${error.message}`,
          );
        }
      });
    }
    console.log(`[PDF preview] Done: ${completed} completed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[PDF preview] Backfill failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { mapConcurrent, readOptions };
