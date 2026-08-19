const test = require('node:test');
const assert = require('node:assert/strict');
const { selectScholarResultForReference } = require('../src/services/serpapi');

function scholarResult(resultId, title, author, year) {
  return {
    result_id: resultId,
    title,
    publication_info: {
      authors: [{ name: author }],
      summary: `${author} - Example venue, ${year}`,
    },
  };
}

test('does not bind a GROBID reference to the first unrelated Scholar result', () => {
  const match = selectScholarResultForReference(
    {
      title: 'CiteSense: supporting sensemaking of research literature',
      authors: ['Xiaolong Zhang', 'Yan Qu'],
      year: '2008',
    },
    [
      scholarResult(
        'wrong',
        'Synergi: A mixed-initiative system for scholarly synthesis',
        'HB Kang',
        2023,
      ),
      scholarResult(
        'right',
        'CiteSense: supporting sensemaking of research literature',
        'Xiaolong Zhang',
        2008,
      ),
    ],
  );

  assert.equal(match.candidate.paperId, 'right');
});

test('rejects Scholar results that do not match the GROBID identity', () => {
  const match = selectScholarResultForReference(
    {
      title: 'A Linked Paper',
      authors: ['Ada Lovelace'],
      year: '2025',
    },
    [scholarResult('wrong', 'A Different Paper', 'Other Author', 2020)],
  );

  assert.equal(match, null);
});
