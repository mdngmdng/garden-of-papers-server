require('dotenv').config();
const fs = require('fs');
const path = require('path');

const configuredResearchEffort = process.env.OPENAI_RESEARCH_REASONING_EFFORT || 'high';

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function resolveGrobidUrl(value) {
  const configured = value || 'http://localhost:8070';
  try {
    const url = new URL(configured);
    // docker-compose service names only resolve from inside the container
    // network. The development server is commonly run directly on macOS.
    if (url.hostname === 'grobid' && !fs.existsSync('/.dockerenv')) {
      url.hostname = '127.0.0.1';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    return configured;
  }
  return configured.replace(/\/$/, '');
}

module.exports = {
  port: process.env.PORT || 5002,
  origin: process.env.ORIGIN || 'http://34.64.85.65:3000',
  mongoUrl: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'ap-northeast-2',
    s3Bucket: process.env.AWS_S3_BUCKET || 'garden-of-papers',
  },
  grobidUrl: resolveGrobidUrl(process.env.GROBID_URL),
  s2ApiKey: process.env.S2_API_KEY || '',
  serpApiKey: process.env.SERPAPI_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  openai: {
    apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-5.6',
    researchModel:
      process.env.OPENAI_RESEARCH_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6',
    researchCompileModel:
      process.env.OPENAI_RESEARCH_COMPILE_MODEL || 'gpt-5.6-luna',
    researchReasoningEffort:
      ['low', 'medium', 'high', 'xhigh'].includes(configuredResearchEffort)
        ? configuredResearchEffort
        : 'high',
    researchBudgetUsd: boundedNumber(
      process.env.OPENAI_RESEARCH_BUDGET_USD,
      2,
      0.25,
      20,
    ),
    researchMaxToolCalls: Math.round(boundedNumber(
      process.env.OPENAI_RESEARCH_MAX_TOOL_CALLS,
      12,
      1,
      50,
    )),
    researchMaxOutputTokens: Math.round(boundedNumber(
      process.env.OPENAI_RESEARCH_MAX_OUTPUT_TOKENS,
      24_000,
      2_000,
      128_000,
    )),
    researchCompileMaxOutputTokens: Math.round(boundedNumber(
      process.env.OPENAI_RESEARCH_COMPILE_MAX_OUTPUT_TOKENS,
      8_000,
      1_000,
      32_000,
    )),
    citationGraphModel:
      process.env.OPENAI_CITATION_GRAPH_MODEL || 'gpt-5.6-sol',
    embeddingModel:
      process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDimensions: Math.max(
      0,
      Number(process.env.OPENAI_EMBEDDING_DIMENSIONS || 1_024),
    ),
  },
  llmWikiRoot:
    process.env.GOP_LLM_WIKI_ROOT
    || path.resolve(__dirname, '../../../gop-llm-wiki'),
  asta: {
    apiKey: process.env.ASTA_TOOL_KEY || '',
    endpoint:
      process.env.ASTA_MCP_ENDPOINT || 'https://asta-tools.allen.ai/mcp/v1',
    requestTimeoutMs: Number(
      process.env.ASTA_REQUEST_TIMEOUT_MS || 120_000,
    ),
    snippetLimit: Number(process.env.ASTA_SNIPPET_LIMIT || 60),
    relevanceLimit: Number(process.env.ASTA_RELEVANCE_LIMIT || 40),
    maxRequestsPerSecond: Math.max(
      1,
      Math.min(10, Number(process.env.ASTA_MAX_REQUESTS_PER_SECOND || 8)),
    ),
    maxConcurrentSearches: Math.max(
      1,
      Number(process.env.ASTA_MAX_CONCURRENT_SEARCHES || 2),
    ),
    maxRetries: Math.max(0, Number(process.env.ASTA_MAX_RETRIES || 5)),
    retryBaseMs: Math.max(
      100,
      Number(process.env.ASTA_RETRY_BASE_MS || 1_000),
    ),
    retryMaxMs: Math.max(
      1_000,
      Number(process.env.ASTA_RETRY_MAX_MS || 15_000),
    ),
  },
};
