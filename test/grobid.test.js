const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTeiToCitationHits } = require('../src/services/grobid');

test('parses citation and page attributes independent of XML attribute order', () => {
  const result = parseTeiToCitationHits(`
    <TEI>
      <teiHeader><ref target="https://example.com/grobid"/></teiHeader>
      <facsimile><surface lry="792" n="1" lrx="612"/></facsimile>
      <listBibl>
        <biblStruct xml:id="b0"><analytic><title level="a">Right paper</title></analytic></biblStruct>
      </listBibl>
      <text><body><p><ref coords="1,100,200,25,12" target="#b0" type="bibr">[1]</ref></p></body></text>
    </TEI>
  `);

  assert.deepEqual(result.pageSizes[1], { widthPt: 612, heightPt: 792 });
  assert.equal(result.citationHits.length, 1);
  assert.deepEqual(result.citationHits[0].refIds, ['b0']);
  assert.deepEqual(result.citationHits[0].boxes, [
    { page: 1, x: 100, y: 200, w: 25, h: 12 },
  ]);
});

test('recovers a missing GROBID target from its displayed reference number', () => {
  const result = parseTeiToCitationHits(`
    <TEI>
      <listBibl>
        <biblStruct xml:id="b0"><title>First paper</title></biblStruct>
        <biblStruct xml:id="b1"><title>Second paper</title></biblStruct>
      </listBibl>
      <text><body><p><ref type="bibr" coords="1,10,20,8,9">2]</ref></p></body></text>
    </TEI>
  `);

  assert.equal(result.citationHits[0].refId, 'b1');
  assert.deepEqual(result.citationHits[0].refIds, ['b1']);
});

test('preserves every reference target in a grouped citation', () => {
  const result = parseTeiToCitationHits(`
    <TEI>
      <listBibl>
        <biblStruct xml:id="b0"><title>First paper</title></biblStruct>
        <biblStruct xml:id="b1"><title>Second paper</title></biblStruct>
      </listBibl>
      <text><body><p><ref type="bibr" target="#b0,#b1">[1, 2]</ref></p></body></text>
    </TEI>
  `);

  assert.deepEqual(result.citationHits[0].refIds, ['b0', 'b1']);
});

test('recovers a targetless author-year marker from bibliography identity', () => {
  const result = parseTeiToCitationHits(`
    <TEI>
      <text>
        <body>
          <p><ref type="bibr" coords="1,100,200,90,12">(Vaswani et al., 2017)</ref></p>
        </body>
        <back><listBibl>
          <biblStruct xml:id="b0">
            <analytic>
              <author><persName><forename>Ashish</forename><surname>Vaswani</surname></persName></author>
              <title level="a">Attention Is All You Need</title>
            </analytic>
            <monogr><imprint><date when="2017"/></imprint></monogr>
          </biblStruct>
        </listBibl></back>
      </text>
    </TEI>
  `);

  assert.deepEqual(result.citationHits[0].refIds, ['b0']);
  assert.equal(result.citationHits[0].refTitle, 'Attention Is All You Need');
});

test('does not mistake an author-year publication year for a numeric reference id', () => {
  const result = parseTeiToCitationHits(`
    <TEI><text><body>
      <p><ref type="bibr" coords="1,10,20,30,8">(Unknown, 2017)</ref></p>
    </body><back><listBibl>
      <biblStruct xml:id="b2016"><title>Unrelated numeric alias</title></biblStruct>
    </listBibl></back></text></TEI>
  `);

  assert.deepEqual(result.citationHits[0].refIds, []);
});

test('keeps raw bibliography identity when GROBID title metadata conflicts', () => {
  const result = parseTeiToCitationHits(`
    <TEI><text><back><listBibl>
      <biblStruct xml:id="b6">
        <analytic>
          <author><persName><forename>Unrelated</forename><surname>Author</surname></persName></author>
          <title level="a">Wrong matched paper</title>
        </analytic>
        <monogr><imprint><date when="2024"/></imprint></monogr>
        <note type="raw_reference">L. Eggli, C. Hsu, G. Elber, and B. Bruderlin. Inferring 3D models from freehand sketches and constraints. Computer-Aided Design, 1997.</note>
      </biblStruct>
    </listBibl></back></text></TEI>
  `);

  assert.equal(
    result.refInfo.b6.title,
    'Inferring 3D models from freehand sketches and constraints',
  );
  assert.equal(result.refInfo.b6.year, '1997');
  assert.equal(result.refInfo.b6.authors[0], 'L. Eggli');
});
