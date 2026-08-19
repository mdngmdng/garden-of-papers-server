const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCitationHits,
  extractNumberedReferences,
} = require('../src/services/pdfCitationFallback');

test('recovers compact LITFORAGER bibliography metadata without GROBID', () => {
  const references = extractNumberedReferences([
    {
      pageIndex: 8,
      text: 'ACKNOWLEDGMENTS\nREFERENCES [1] B. W. Ammar and O. Etzioni. Construction of the literature graph in Semantic Scholar. NAACL. 2018.',
    },
    {
      pageIndex: 9,
      text: '[31]E. Landhuis. Scientific literature: Information overload. Nature, 535(7612):457-458, July 2016. doi: 10.1038/nj7612-457a 1,6 [32] J. J. LaViola Jr. 3D user interfaces: theory and practice. Addison-Wesley Professional, 2017.',
    },
  ]);
  const landhuis = references.find((reference) => reference.refId === '31');

  assert.deepEqual(
    {
      title: landhuis.title,
      authors: landhuis.authors,
      year: landhuis.year,
      doi: landhuis.doi,
    },
    {
      title: 'Scientific literature: Information overload',
      authors: ['E. Landhuis'],
      year: '2016',
      doi: '10.1038/nj7612-457a',
    },
  );
});

test('does not use body markers as bibliography metadata', () => {
  assert.deepEqual(
    extractNumberedReferences([
      {
        pageIndex: 0,
        text: 'Literature review remains challenging [31]. Each year [1, 4].',
      },
    ]),
    [],
  );
});

test('infers a trailing bibliography when PDF.js omits its heading', () => {
  const references = extractNumberedReferences([
    {
      pageIndex: 9,
      text: 'Body citation [1]. More prose [31]. [1] A. Author. First paper title. 2020. [2] B. Author. Second paper title. 2021. [3] C. Author. Third paper title. 2022.',
    },
  ]);

  assert.deepEqual(references.map((reference) => reference.refId), ['1', '2', '3']);
  assert.equal(references[0].title, 'First paper title');
});

test('keeps fallback citation markers linked to their exact reference ids', () => {
  const text = 'Literature review remains challenging [31]. Each year [1, 4-5].';
  const hits = detectCitationHits(0, text);

  assert.deepEqual(hits.map((hit) => hit.refIds), [
    ['31'],
    ['1', '4', '5'],
  ]);
  assert.equal(hits[0].context, 'Literature review remains challenging [31].');
});
