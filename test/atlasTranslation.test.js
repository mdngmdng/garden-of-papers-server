const test = require('node:test');
const assert = require('node:assert/strict');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('translates an Atlas title and abstract through the free MyMemory API service', async () => {
  const myMemoryPath = require.resolve('../src/services/myMemoryTranslation');
  const controllerPath = require.resolve('../src/controllers/atlas');
  const myMemory = require(myMemoryPath);
  const originalTranslate = myMemory.translateWithMyMemory;
  myMemory.translateWithMyMemory = async (text) => `한국어: ${text}`;
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  const response = responseRecorder();

  try {
    await controller.translatePaper(
      { body: { title: 'Paper title', abstract: 'Paper abstract' } },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      title: '한국어: Paper title',
      abstract: '한국어: Paper abstract',
      provider: 'mymemory',
      cached: false,
    });
    assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
  } finally {
    myMemory.translateWithMyMemory = originalTranslate;
    delete require.cache[controllerPath];
  }
});

test('splits long UTF-8 translation requests below the free API limit', () => {
  const {
    MAX_SEGMENT_BYTES,
    decodeHtmlEntities,
    splitUtf8,
  } = require('../src/services/myMemoryTranslation');
  const chunks = splitUtf8('interaction '.repeat(100));
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(' '), 'interaction '.repeat(100).trim());
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= MAX_SEGMENT_BYTES));
  assert.equal(decodeHtmlEntities('연구 &amp; 개발 &#39;Atlas&#39;'), "연구 & 개발 'Atlas'");
});

test('falls back to Gemini when the free translation service is unavailable', async () => {
  const myMemoryPath = require.resolve('../src/services/myMemoryTranslation');
  const geminiPath = require.resolve('../src/services/gemini');
  const controllerPath = require.resolve('../src/controllers/atlas');
  const myMemory = require(myMemoryPath);
  const gemini = require(geminiPath);
  const originalMyMemory = myMemory.translateWithMyMemory;
  const originalGemini = gemini.translateToKorean;
  myMemory.translateWithMyMemory = async () => {
    throw new Error('free service unavailable');
  };
  gemini.translateToKorean = async (text) => `대체 번역: ${text}`;
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  const response = responseRecorder();

  try {
    await controller.translatePaper(
      { body: { title: 'Unique fallback title', abstract: 'Unique fallback abstract' } },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.provider, 'gemini');
    assert.equal(response.body.title, '대체 번역: Unique fallback title');
    assert.equal(response.body.abstract, '대체 번역: Unique fallback abstract');
  } finally {
    myMemory.translateWithMyMemory = originalMyMemory;
    gemini.translateToKorean = originalGemini;
    delete require.cache[controllerPath];
  }
});

test('rejects an empty Atlas translation request', async () => {
  const controller = require('../src/controllers/atlas');
  const response = responseRecorder();
  await controller.translatePaper({ body: {} }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /제목이나 초록/);
});
