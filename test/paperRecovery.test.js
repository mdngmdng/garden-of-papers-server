const test = require('node:test');
const assert = require('node:assert/strict');
const { planPaperRecovery } = require('../src/services/paperRecovery');
const { legacyFields } = require('../scripts/recover-threddy');

test('restored reference dictionaries retain the legacy array wrapper', () => {
  const fields = legacyFields({ referenceTitleList: { page1: ['Threddy'] } }, new Date());
  assert.deepEqual(fields.referenceTitleList, { key: ['page1'], value: [{ array: ['Threddy'] }] });
  assert.equal(Object.hasOwn(fields, 'highlightTexts'), false);
});

function inputs() {
  const original = { id: 'paper', type: 'GX.MAROScientificPaper', persistenceKey: 'original', title: 'Threddy',
    fileId: 'original-pdf', x: 50, y: 20, pageCount: 15, highlights: [{ id: 'old' }], pdfExcerpts: [] };
  const damaged = { ...original, persistenceKey: 'wrong', title: 'Interactions', fileId: 'wrong-pdf', x: -100,
    abstract: 'Wrong search result', highlights: [{ id: 'old' }, { id: 'new' }], pdfExcerpts: [{ id: 'new-excerpt' }],
    translations: { en: 'new annotation' }, pageIndex: 4 };
  const current = { id: 'garden', projectName: 'garden', revision: 772, camera: { x: 4, y: 5, scale: 1 },
    objects: [damaged, { id: 'new-note', type: 'GX.MARONote', parentPaperId: 'paper', text: 'Recent work' }] };
  const source = { ...current, revision: 643, objects: [original] };
  return { current, source, paperId: 'paper', expectedRevision: 772, timestamp: '2026-09-08T06:00:00Z' };
}

test('selective recovery retains annotations, recent objects, relationships and camera', () => {
  const input = inputs();
  const { state, paper } = planPaperRecovery(input);
  assert.equal(paper.title, 'Threddy');
  assert.equal(paper.persistenceKey, 'original');
  assert.equal(paper.fileId, 'original-pdf');
  assert.equal(paper.x, 50);
  assert.equal(paper.abstract, undefined);
  for (const field of ['highlights', 'pdfExcerpts', 'translations', 'pageIndex']) {
    assert.deepEqual(paper[field], input.current.objects[0][field]);
  }
  assert.deepEqual(state.objects[1], input.current.objects[1]);
  assert.deepEqual(state.camera, input.current.camera);
  assert.equal(state.revision, 773);
  assert.equal(input.current.objects[0].title, 'Interactions');
});

test('aborts on concurrent edits and ambiguous identities', () => {
  const input = inputs();
  assert.throws(() => planPaperRecovery({ ...input, expectedRevision: 771 }), /changed/);
  input.current.objects.push({ id: 'collision', persistenceKey: 'original' });
  assert.throws(() => planPaperRecovery(input), /already owns/);
});
