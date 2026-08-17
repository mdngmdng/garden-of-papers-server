require('dotenv').config();
const fs = require('fs');
const path = require('path');

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

function resolveLocalServiceUrl(value, dockerHostname, localPort) {
  const configured = value || `http://127.0.0.1:${localPort}`;
  try {
    const url = new URL(configured);
    if (url.hostname === dockerHostname && !fs.existsSync('/.dockerenv')) {
      url.hostname = '127.0.0.1';
      url.port = String(localPort);
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
  qwen: {
    enabled: !['0', 'false', 'no'].includes(
      String(process.env.QWEN_ENABLED || 'true').toLowerCase(),
    ),
    serviceUrl: resolveLocalServiceUrl(
      process.env.QWEN_SERVICE_URL,
      'qwen',
      8071,
    ),
    embeddingModel:
      process.env.QWEN_EMBEDDING_MODEL || 'Qwen/Qwen3-Embedding-0.6B',
    rerankerModel:
      process.env.QWEN_RERANKER_MODEL || 'Qwen/Qwen3-Reranker-0.6B',
    indexName: process.env.QWEN_INDEX_NAME || 'qwen3-embedding-0.6b-v1',
    requestTimeoutMs: Number(process.env.QWEN_REQUEST_TIMEOUT_MS || 600_000),
    requestBatchSize: Number(process.env.QWEN_REQUEST_BATCH_SIZE || 48),
    topK: Number(process.env.QWEN_TOP_K || 12),
    minimumRerankScore: Number(
      process.env.QWEN_MINIMUM_RERANK_SCORE || 0.55,
    ),
    highConfidenceRerankScore: Number(
      process.env.QWEN_HIGH_CONFIDENCE_RERANK_SCORE || 0.9,
    ),
    minimumRerankMargin: Number(
      process.env.QWEN_MINIMUM_RERANK_MARGIN || 0.04,
    ),
    memoryCacheEntries: Number(process.env.QWEN_MEMORY_CACHE_ENTRIES || 12),
  },
};
