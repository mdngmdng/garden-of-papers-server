const assert = require('node:assert/strict');
const test = require('node:test');
const {
  doiPdfKey,
  isValidDoi,
  normalizeDoi,
  uploadPdfKey,
} = require('../src/services/pdfStorage');

test('normalizes DOI identifiers into one shared S3 key', () => {
  const plain = '10.1145/1234.5678';
  const url = 'https://doi.org/10.1145/1234.5678';
  assert.equal(normalizeDoi(`DOI: ${plain}.`), plain);
  assert.equal(doiPdfKey(plain), doiPdfKey(url));
  assert.match(doiPdfKey(plain), /^papers\/by-doi\/[a-f0-9]{64}\.pdf$/);
  assert.equal(isValidDoi(plain), true);
});

test('keeps legacy workspace storage for PDFs without a DOI', () => {
  assert.equal(uploadPdfKey('workspace', 'file-id', ''), 'papers/workspace/file-id.pdf');
});
