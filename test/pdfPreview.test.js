const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  createPreviewDescriptor,
  canAttemptPdfPreview,
  isPreviewCurrent,
  previewS3Key,
  renderPdfPage,
} = require('../src/services/pdfPreview');
const { readOptions } = require('../scripts/backfill-pdf-previews');

test('creates a compact URL descriptor for a stored preview', () => {
  const descriptor = createPreviewDescriptor('project one', 'file/id', {
    version: 2,
    pageIndex: 4,
    mimeType: 'image/webp',
    s3Key: 'previews/project one/file/id/current-v2-123.webp',
    width: 320,
    height: 440,
    updatedAt: 123,
  });

  assert.deepEqual(descriptor, {
    version: 2,
    sourceId: 'file/id',
    pageIndex: 4,
    mimeType: 'image/webp',
    url: '/pdf_preview/project%20one/file%2Fid?pageIndex=4&v=123',
    width: 320,
    height: 440,
    updatedAt: 123,
  });
  assert.equal(isPreviewCurrent(descriptor, 'file/id', 4), true);
  assert.equal(isPreviewCurrent(descriptor, 'file/id', 3), false);
  assert.equal(JSON.stringify(descriptor).includes('base64'), false);
  assert.equal(
    previewS3Key('project one', 'file/id', 123),
    'previews/project one/file/id/current-v2-123.webp',
  );
});

test('renders a real PDF page to a bounded WebP thumbnail', async () => {
  const pdf = await fs.readFile(path.join(__dirname, '..', 'test.pdf'));
  const preview = await renderPdfPage(pdf, 0);

  assert.equal(preview.width, 320);
  assert.ok(preview.height > 0);
  assert.ok(preview.buffer.length > 1_000);
  assert.equal(preview.buffer.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.ok(preview.pageCount > 1);
});

test('parses safe backfill concurrency options', () => {
  assert.deepEqual(readOptions(['garden', '--force', '--concurrency=3']), {
    projectName: 'garden',
    force: true,
    concurrency: 3,
  });
  assert.equal(readOptions(['--concurrency=99']).concurrency, 4);
  assert.equal(readOptions(['--concurrency=invalid']).concurrency, 2);
});

test('suppresses permanent and recent preview failures', () => {
  const now = Date.now();
  assert.equal(canAttemptPdfPreview(undefined, now), true);
  assert.equal(canAttemptPdfPreview({
    previewStatus: 'failed',
    previewRetryable: false,
    previewFailedAt: new Date(now - 60_000),
  }, now), false);
  assert.equal(canAttemptPdfPreview({
    previewStatus: 'failed',
    previewRetryable: true,
    previewFailedAt: new Date(now - 60_000),
  }, now), false);
  assert.equal(canAttemptPdfPreview({
    previewStatus: 'failed',
    previewRetryable: true,
    previewFailedAt: new Date(now - 11 * 60_000),
  }, now), true);
});
