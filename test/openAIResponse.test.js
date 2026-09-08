const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../src/config');
const { defaultOpenAIRequest } = require('../src/services/llmWiki');

test('sends the Responses JSON schema and records completion metadata without model content', async (context) => {
  const originalKey = config.openai.apiKey;
  config.openai.apiKey = 'test-key-not-used-on-network';
  context.after(() => { config.openai.apiKey = originalKey; });
  const format = { type: 'json_schema', name: 'test', strict: true, schema: { type: 'object' } };
  context.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const request = JSON.parse(options.body);
    assert.deepEqual(request.text.format, format);
    assert.equal(request.store, false);
    return { ok: true, json: async () => ({ id: 'response-verified', status: 'completed', model: 'configured-model',
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"answer":"done"}' }] }],
      usage: { output_tokens: 42 } }) };
  });
  let metadata;
  const answer = await defaultOpenAIRequest({ instructions: 'Test', input: 'test', textFormat: format,
    onResponse: (value) => { metadata = value; } });
  assert.equal(answer, '{"answer":"done"}');
  assert.deepEqual(metadata, { responseId: 'response-verified', status: 'completed', model: 'configured-model',
    incompleteReason: undefined, outputTokens: 42 });
});
