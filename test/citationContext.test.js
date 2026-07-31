const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findCitationHit,
  findCitationHits,
  findMatchingReference,
} = require('../src/services/citationContext');

test('recovers the GROBID reference after papers were linked manually', () => {
  const source = {
    referenceList: [
      {
        refId: 'b11',
        title: 'Apolo: Making Sense of Large Network Data by Combining Rich User Interaction and Machine Learning',
        authors: ['Chau, Duen Horng'],
        year: '2011',
      },
    ],
  };
  const target = {
    paperName:
      'Apolo: making sense of large network data by combining rich user interaction and machine learning',
  };

  assert.equal(findMatchingReference(source, target)?.refId, 'b11');
});

test('prefers a DOI match when title metadata differs', () => {
  const source = {
    referenceList: [
      { refId: 'b2', title: 'A shortened title', doi: '10.1145/123.456' },
      { refId: 'b3', title: 'A similar shortened title' },
    ],
  };
  const target = {
    paperName: 'The complete published paper title',
    resourceLink: 'https://doi.org/10.1145/123.456',
  };

  assert.equal(findMatchingReference(source, target)?.refId, 'b2');
});

test('returns the citation hit associated with the recovered marker', () => {
  const source = {
    citationHits: [
      { id: 'hit-1', refIds: ['b4'], pageIndex: 2 },
      { id: 'hit-2', refIds: ['b11'], pageIndex: 4 },
    ],
  };

  assert.equal(findCitationHit(source, 'b11')?.id, 'hit-2');
});

test('selects the citation occurrence for the requested page or hit id', () => {
  const source = {
    citationHits: [
      {
        id: 'grobid-2',
        refIds: ['b11'],
        boxes: [{ page: 1 }],
      },
      {
        id: 'grobid-101',
        refIds: ['b11'],
        boxes: [{ page: 14 }],
      },
    ],
  };

  assert.deepEqual(
    findCitationHits(source, 'b11').map((hit) => hit.id),
    ['grobid-2', 'grobid-101'],
  );
  assert.equal(
    findCitationHit(source, 'b11', { pageIndex: 13 })?.id,
    'grobid-101',
  );
  assert.equal(
    findCitationHit(source, 'b11', {
      citationHitId: 'grobid-101',
      pageIndex: 0,
    })?.id,
    'grobid-101',
  );
});
