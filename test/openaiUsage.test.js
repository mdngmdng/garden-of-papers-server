const assert = require('node:assert/strict');
const test = require('node:test');
const {
  estimateResponseCostUsd,
  responseUsage,
  responseWebSearchCalls,
} = require('../src/services/openaiUsage');

test('prices GPT-5.6 Sol tokens and web-search calls at the configured public rates', () => {
  const cost = estimateResponseCostUsd({
    model: 'gpt-5.6-sol',
    usage: { input_tokens: 115_683, output_tokens: 10_000 },
    webSearchCalls: 8,
  });
  assert.equal(cost, 0.742732);
});

test('uses cached-token details and counts only web-search output items as calls', () => {
  const payload = {
    usage: {
      input_tokens: 10_000,
      output_tokens: 1_000,
      input_tokens_details: { cached_tokens: 4_000 },
    },
    output: [
      { type: 'web_search_call' },
      { type: 'message' },
      { type: 'web_search_call' },
    ],
  };
  assert.deepEqual(responseUsage(payload), {
    inputTokens: 10_000,
    outputTokens: 1_000,
    cachedTokens: 4_000,
    cacheWriteTokens: 0,
  });
  assert.equal(responseWebSearchCalls(payload), 2);
  assert.equal(estimateResponseCostUsd({
    model: 'gpt-5.6',
    usage: payload.usage,
    webSearchCalls: 2,
  }), 0.0656);
});
