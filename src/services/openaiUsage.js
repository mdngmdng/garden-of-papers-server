const WEB_SEARCH_CALL_USD = 0.01;
const LONG_CONTEXT_THRESHOLD = 272_000;

const MODEL_PRICING = [
  {
    matches: (model) => model === 'gpt-5.6' || model.startsWith('gpt-5.6-sol'),
    short: { input: 4, cached: 0.4, cacheWrite: 5, output: 20 },
    long: { input: 8, cached: 0.8, cacheWrite: 10, output: 30 },
  },
  {
    matches: (model) => model.startsWith('gpt-5.6-terra'),
    short: { input: 2, cached: 0.2, cacheWrite: 2.5, output: 12 },
    long: { input: 4, cached: 0.4, cacheWrite: 5, output: 18 },
  },
  {
    matches: (model) => model.startsWith('gpt-5.6-luna'),
    short: { input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 1.2 },
    long: { input: 0.4, cached: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
];

// Unknown model ids use a deliberately conservative fallback so the UI never
// understates spend when an environment override changes the configured model.
const FALLBACK_PRICING = {
  short: { input: 10, cached: 1, cacheWrite: 12.5, output: 50 },
  long: { input: 20, cached: 2, cacheWrite: 25, output: 75 },
};

function safeCount(value) {
  return Math.max(0, Number(value) || 0);
}

function responseUsage(payload) {
  const usage = payload?.usage || {};
  const inputTokens = safeCount(usage.input_tokens);
  const outputTokens = safeCount(usage.output_tokens);
  const cachedTokens = Math.min(
    inputTokens,
    safeCount(usage.input_tokens_details?.cached_tokens),
  );
  const cacheWriteTokens = Math.min(
    Math.max(0, inputTokens - cachedTokens),
    safeCount(usage.input_tokens_details?.cache_write_tokens),
  );
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
  };
}

function pricingFor(model, inputTokens) {
  const normalized = String(model || '').trim().toLowerCase();
  const pricing = MODEL_PRICING.find((candidate) => candidate.matches(normalized))
    || FALLBACK_PRICING;
  return inputTokens > LONG_CONTEXT_THRESHOLD ? pricing.long : pricing.short;
}

function estimateResponseCostUsd({ model, usage, webSearchCalls = 0 }) {
  const normalizedUsage = responseUsage({ usage });
  const pricing = pricingFor(model, normalizedUsage.inputTokens);
  const uncachedTokens = Math.max(
    0,
    normalizedUsage.inputTokens
      - normalizedUsage.cachedTokens
      - normalizedUsage.cacheWriteTokens,
  );
  const tokenCost = (
    uncachedTokens * pricing.input
    + normalizedUsage.cachedTokens * pricing.cached
    + normalizedUsage.cacheWriteTokens * pricing.cacheWrite
    + normalizedUsage.outputTokens * pricing.output
  ) / 1_000_000;
  return tokenCost + safeCount(webSearchCalls) * WEB_SEARCH_CALL_USD;
}

function responseWebSearchCalls(payload) {
  return (payload?.output || []).filter((item) => item?.type === 'web_search_call').length;
}

module.exports = {
  estimateResponseCostUsd,
  responseUsage,
  responseWebSearchCalls,
};
