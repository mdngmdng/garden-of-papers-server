const test = require('node:test');
const assert = require('node:assert/strict');

const {
  citationDocumentSummary,
  isCoordinateCitationDocument,
  preferCitationDocument,
} = require('../src/services/citationState');

const fallback = {
  citationStatus: 'ready',
  citationHits: [
    {
      id: 'pdf-13-10-1',
      pageIndex: 13,
      boxes: [],
      source: 'pdf-text',
    },
  ],
  pageSizeList: [],
  referenceList: [{ refId: '1' }],
};

const grobid = {
  citationStatus: 'ready',
  citationHits: [
    {
      id: 'grobid-0',
      pageIndex: 1,
      boxes: [{ page: 2, x: 100, y: 200, w: 20, h: 10 }],
      source: 'grobid',
    },
  ],
  pageSizeList: [{ page: 2, widthPt: 612, heightPt: 792 }],
  referenceList: [{ refId: 'b0' }],
};

test('prefers positioned GROBID data over a longer fallback text scan', () => {
  const longerFallback = {
    ...fallback,
    citationHits: Array.from({ length: 58 }, (_, index) => ({
      id: `pdf-13-${index}-1`,
      pageIndex: 13,
      boxes: [],
      source: 'pdf-text',
    })),
  };
  assert.equal(preferCitationDocument([longerFallback, grobid]), grobid);
});

test('requires both positioned hits and PDF page geometry', () => {
  assert.equal(isCoordinateCitationDocument(grobid), true);
  assert.equal(isCoordinateCitationDocument(fallback), false);
  assert.deepEqual(citationDocumentSummary(grobid), {
    ready: true,
    hits: 1,
    positionedHits: 1,
    grobidHits: 1,
    pageSizes: 1,
    references: 1,
  });
});
