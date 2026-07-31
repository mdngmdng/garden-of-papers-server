const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodeVectors,
  encodeVectors,
  semanticIndexKey,
  sentenceHash,
  shouldUseGeminiFallback,
  withQwenLock,
} = require('../src/services/semanticIndex');

test('semantic index vectors survive compact float32 serialization', () => {
  const embeddings = [
    [0.25, -0.5, 0.75],
    [1, 0, -1],
  ];
  const encoded = encodeVectors(embeddings, 3);
  const decoded = decodeVectors(encoded, 2, 3);

  assert.equal(decoded.length, 6);
  assert.deepEqual(Array.from(decoded), embeddings.flat());
});

test('sentence hashes change when source sentence order changes', () => {
  const first = sentenceHash(['alpha', 'beta']);
  const second = sentenceHash(['beta', 'alpha']);

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});

test('semantic indices are isolated by project and file', () => {
  assert.equal(
    semanticIndexKey('0730', 'paper-123'),
    'semantic-index/0730/paper-123/qwen3-embedding-0.6b-v1.json.gz',
  );
});

test('high-confidence reranker matches do not invoke Gemini for a narrow margin', () => {
  assert.equal(
    shouldUseGeminiFallback({
      rerankError: null,
      confidence: 0.99,
      margin: 0.002,
    }),
    false,
  );
  assert.equal(
    shouldUseGeminiFallback({
      rerankError: null,
      confidence: 0.7,
      margin: 0.002,
    }),
    true,
  );
});

test('serializes complete Qwen retrieval jobs', async () => {
  const events = [];
  let active = 0;
  let maximumActive = 0;
  const task = (id) => withQwenLock(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    events.push(`start-${id}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end-${id}`);
    active -= 1;
  });

  await Promise.all([task(1), task(2), task(3)]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(events, [
    'start-1',
    'end-1',
    'start-2',
    'end-2',
    'start-3',
    'end-3',
  ]);
});
