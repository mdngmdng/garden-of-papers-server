const assert = require('node:assert/strict');
const test = require('node:test');
const { compatiblePdfIdentity } = require('../src/services/paperIdentityCompatibility');
const { reusePdfIntoProject } = require('../src/services/pdfStorage');

test('rejects contradictory and polluted library titles despite a shared DOI', () => {
  const threddy = 'title:threddy|year:2022|author:kang';
  const wrong = 'title:interactions for human ai knowledge extension|year:2022|author:kang';
  assert.equal(compatiblePdfIdentity({ title: 'Interactions for Human-AI Knowledge Extension' }, [threddy]), false);
  assert.equal(compatiblePdfIdentity({ title: 'Threddy' }, [threddy, wrong]), false);
  assert.equal(compatiblePdfIdentity({ title: 'Threddy' }, [threddy]), true);
});

test('a mismatched indexed PDF is never attached or used to pollute the index', async () => {
  const candidate = { pdfSha256: 'sha', s3Key: 'shared.pdf', identityKeys: [
    'doi:10.1145/identity-test', 'title:threddy|year:2022|author:kang',
  ] };
  const mongoClient = { db() { return {
    admin() { return { async listDatabases() { return { databases: [] }; } }; },
    collection() { return {
      async createIndex() {},
      find() { return { sort() { return this; }, limit() { return this; }, async toArray() { return [candidate]; } }; },
      async updateOne() { assert.fail('must not write a mismatched alias'); },
    }; },
  }; } };
  const result = await reusePdfIntoProject({ projectName: 'target', fileId: 'file',
    identity: { doi: '10.1145/identity-test', title: 'Interactions' }, mongoClient,
    s3: { async headPdf() { assert.fail('identity must be checked before accessing S3'); } },
  });
  assert.equal(result, null);
});
