const assert = require('node:assert/strict');
const test = require('node:test');
const {
  paperIdentityKeys,
  resolvePdfS3Key,
  reusePdfIntoProject,
  sharedPdfS3Key,
  storeSharedPdf,
} = require('../src/services/pdfStorage');

function fakeMongo() {
  const updates = [];
  const collections = new Map();
  return {
    updates,
    db(name) {
      return {
        collection(collectionName) {
          const key = `${name}/${collectionName}`;
          if (!collections.has(key)) {
            collections.set(key, {
              async createIndex() {},
              async findOne() { return null; },
              async updateOne(filter, update, options) {
                updates.push({ key, filter, update, options });
              },
            });
          }
          return collections.get(key);
        },
      };
    },
  };
}

test('normalizes stable paper identities across DOI and URL variants', () => {
  const keys = paperIdentityKeys({
    resultId: 'ABC-123',
    doi: 'https://doi.org/10.1145/Example',
    title: '  A Shared—Paper  ',
    authors: ['Ada Researcher'],
    year: '2026',
    pdfSourceUrl: 'https://publisher.example/paper.pdf?utm_source=test',
  });

  assert.ok(keys.includes('result:abc-123'));
  assert.ok(keys.includes('doi:10.1145/example'));
  assert.ok(keys.includes('url:https://publisher.example/paper.pdf'));
  assert.ok(keys.some((key) => key.startsWith('title:a shared paper|year:2026')));
});

test('stores identical PDFs once and points different boards at the same shared key', async () => {
  const mongoClient = fakeMongo();
  const objects = new Set();
  const uploads = [];
  const s3 = {
    async headPdf(key) {
      if (!objects.has(key)) {
        const error = new Error('No such key');
        error.name = 'NoSuchKey';
        throw error;
      }
      return { size: 17 };
    },
    async uploadPdf(key, buffer) {
      objects.add(key);
      uploads.push({ key, size: buffer.length });
    },
  };
  const pdf = Buffer.from('%PDF-1.7\nshared');
  const first = await storeSharedPdf({
    projectName: 'board-a',
    fileId: 'file-a',
    pdfBuffer: pdf,
    identity: { title: 'Shared', year: '2026' },
    mongoClient,
    s3,
  });
  const second = await storeSharedPdf({
    projectName: 'board-b',
    fileId: 'file-b',
    pdfBuffer: pdf,
    identity: { title: 'Shared', year: '2026' },
    mongoClient,
    s3,
  });

  assert.equal(first.s3Key, second.s3Key);
  assert.equal(first.s3Key, sharedPdfS3Key(first.pdfSha256));
  assert.equal(uploads.length, 1);
  const boardMetadataUpdates = mongoClient.updates.filter(
    (update) => update.key.endsWith('/PdfMeta'),
  );
  assert.equal(boardMetadataUpdates.length, 2);
  assert.deepEqual(
    boardMetadataUpdates.map((update) => update.update.$set.s3Key),
    [first.s3Key, first.s3Key],
  );
});

test('resolves a board alias from PdfMeta before falling back to a legacy key', async () => {
  const mongoClient = {
    db() {
      return {
        collection() {
          return {
            async findOne() {
              return { s3Key: 'papers/shared/sha256/library.pdf' };
            },
          };
        },
      };
    },
  };
  assert.equal(
    await resolvePdfS3Key('board-alias', 'file-alias', { mongoClient }),
    'papers/shared/sha256/library.pdf',
  );
});

test('reuses an indexed PDF and its completed citation metadata in a second board', async () => {
  const sharedKey = 'papers/shared/sha256/already-stored.pdf';
  const targetUpdates = [];
  const libraryUpdates = [];
  const candidate = {
    pdfSha256: 'already-stored',
    s3Key: sharedKey,
    size: 2048,
    identityKeys: ['doi:10.1145/shared'],
    sourceRefs: [{ projectName: 'board-a', fileId: 'source-file' }],
  };
  const mongoClient = {
    db(name) {
      return {
        collection(collectionName) {
          if (name === '_GardenOfPapersShared') {
            return {
              async createIndex() {},
              find() {
                return {
                  sort() { return this; },
                  limit() { return this; },
                  async toArray() { return [candidate]; },
                };
              },
              async updateOne(filter, update) {
                libraryUpdates.push({ filter, update });
              },
            };
          }
          if (name === 'board-a' && collectionName === 'PdfMeta') {
            return {
              async findOne() {
                return {
                  fileId: 'source-file',
                  citationStatus: 'ready',
                  citationHits: [{ id: 'hit-1', boxes: [{ page: 1 }] }],
                  pageSizeList: [{ page: 1, widthPt: 612, heightPt: 792 }],
                  referenceList: [{ refId: 'b0', title: 'Reference' }],
                };
              },
            };
          }
          if (name === 'board-b' && collectionName === 'PdfMeta') {
            return {
              async updateOne(filter, update) {
                targetUpdates.push({ filter, update });
              },
            };
          }
          throw new Error(`Unexpected collection ${name}/${collectionName}`);
        },
      };
    },
  };
  const reused = await reusePdfIntoProject({
    projectName: 'board-b',
    fileId: 'target-file',
    identity: { title: 'Shared', year: '2026', doi: '10.1145/shared' },
    mongoClient,
    s3: { async headPdf() { return { size: 2048 }; } },
  });

  assert.equal(reused.s3Key, sharedKey);
  assert.equal(targetUpdates.length, 1);
  assert.equal(targetUpdates[0].update.$set.s3Key, sharedKey);
  assert.equal(targetUpdates[0].update.$set.citationStatus, 'ready');
  assert.deepEqual(
    targetUpdates[0].update.$set.citationHits,
    [{ id: 'hit-1', boxes: [{ page: 1 }] }],
  );
  assert.equal(libraryUpdates.length, 1);
});
