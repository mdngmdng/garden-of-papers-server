const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCitationHits,
  extractAuthorYearReferences,
  extractNumberedReferences,
  recoverIncompleteGrobidExtraction,
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

test('extracts plain numbered references after a bibliography heading', () => {
  const references = extractNumberedReferences([
    {
      pageIndex: 7,
      text: 'References\n1. T. Baudel. A mark-based interaction paradigm for free-hand drawing. 1994.\n2. J. Bloomenthal. Introduction to implicit surfaces. 1997.\n3. J.M. Cohen. An Interface for Sketching 3D Curves. 1999.',
    },
  ]);

  assert.deepEqual(references.map((reference) => reference.refId), ['1', '2', '3']);
  assert.equal(references[0].title, 'A mark-based interaction paradigm for free-hand drawing');
});

test('extracts unnumbered author-year references and links body markers', () => {
  const references = extractAuthorYearReferences([
    {
      pageIndex: 8,
      widthPt: 612,
      heightPt: 792,
      lines: [
        { text: 'References', x: 55, y: 274 },
        { text: 'Josh Achiam, Steven Adler, and Sandhini Agarwal. Gpt-4 technical report.', x: 55, y: 256 },
        { text: 'arXiv preprint arXiv:2303.08774, 2023.', x: 65, y: 244 },
        { text: 'Ashish Vaswani, Noam Shazeer, and Niki Parmar. Attention is all you need.', x: 55, y: 220 },
        { text: 'Advances in Neural Information Processing Systems, 2017.', x: 65, y: 208 },
      ],
    },
  ]);

  assert.equal(references.length, 2);
  assert.equal(references[0].title, 'Gpt-4 technical report');
  assert.equal(references[1].authors[0], 'Ashish Vaswani');
  const hits = detectCitationHits(
    0,
    'Recent systems build on prior work (Achiam et al., 2023; Vaswani et al., 2017).',
    references,
  );
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].refIds, references.map((reference) => reference.refId));
});

test('does not mistake author-year bibliography years for numbered entries', () => {
  assert.deepEqual(
    extractNumberedReferences([
      {
        pageIndex: 8,
        text: 'References\nJosh Achiam. Gpt-4 technical report.\n2023.\nAshish Vaswani. Attention is all you need.\n2017.',
      },
    ]),
    [],
  );
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

test('recovers publisher-spaced and full-width numeric citation markers', () => {
  const text = 'Prior work [ 21 ] is extended by several systems ［ 5 , 14 ］.';
  const hits = detectCitationHits(1, text);

  assert.deepEqual(hits.map((hit) => hit.markerText), [
    '[ 21 ]',
    '［ 5 , 14 ］',
  ]);
  assert.deepEqual(hits.map((hit) => hit.refIds), [
    ['21'],
    ['5', '14'],
  ]);
});

test('extracts bibliography entries with spaced reference brackets', () => {
  const references = extractNumberedReferences([{
    pageIndex: 7,
    text: 'References\n[ 1 ] A. Author. First paper. 2020.\n［ 2 ］ B. Author. Second paper. 2021.',
  }]);

  assert.deepEqual(references.map((reference) => reference.refId), ['1', '2']);
});

test('completes an unpositioned GROBID result with PDF text hits', () => {
  const recovered = recoverIncompleteGrobidExtraction(
    {
      citationHits: [],
      pageSizes: {},
      refInfo: {
        b0: { title: 'First paper', authors: [], raw: '' },
        b20: { title: 'Twenty-first paper', authors: [], raw: '' },
      },
    },
    {
      citationHits: detectCitationHits(1, 'Prior work [ 21 ].'),
      pageSizeList: [{ page: 2, widthPt: 612, heightPt: 792 }],
      referenceList: [],
    },
  );

  assert.equal(recovered.usedFallback, true);
  assert.deepEqual(recovered.citationHits[0].refIds, ['b20']);
  assert.deepEqual(recovered.pageSizes[2], { widthPt: 612, heightPt: 792 });
});
