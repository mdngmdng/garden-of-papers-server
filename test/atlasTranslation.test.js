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

test('translates an Atlas title and abstract together through Gemini 2.5 Flash', async () => {
  const geminiPath = require.resolve('../src/services/gemini');
  const controllerPath = require.resolve('../src/controllers/atlas');
  const gemini = require(geminiPath);
  const originalTranslate = gemini.translatePaperToKorean;
  let received;
  gemini.translatePaperToKorean = async (paper) => {
    received = paper;
    return {
      title: '논문 제목',
      abstract: '논문 초록',
    };
  };
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  const response = responseRecorder();

  try {
    await controller.translatePaper(
      { body: { title: 'Paper title', abstract: 'Paper abstract' } },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, {
      title: 'Paper title',
      abstract: 'Paper abstract',
    });
    assert.deepEqual(response.body, {
      title: '논문 제목',
      abstract: '논문 초록',
      provider: 'gemini-2.5-flash',
      cached: false,
    });
    assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
  } finally {
    gemini.translatePaperToKorean = originalTranslate;
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
