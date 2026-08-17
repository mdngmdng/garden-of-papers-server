const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { extractPdfText } = require('../src/services/pdfText');

test('extracts Wiki source text locally when GROBID is unavailable', async () => {
  const buffer = await fs.readFile(path.resolve(__dirname, '../test.pdf'));
  const text = await extractPdfText(buffer);

  assert.match(text, /Page 1/);
  assert.ok(text.length > 20);
});
