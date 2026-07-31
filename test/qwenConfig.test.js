const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('does not race background embedding warmups with citation reranking', () => {
  const compose = readFileSync(
    path.join(__dirname, '..', 'docker-compose.yml'),
    'utf8',
  );
  const service = readFileSync(
    path.join(__dirname, '..', 'qwen-service', 'app.py'),
    'utf8',
  );

  assert.match(
    compose,
    /QWEN_WARM_EMBEDDINGS_AFTER_RERANK: \$\{QWEN_WARM_EMBEDDINGS_AFTER_RERANK:-false\}/,
  );
  assert.match(
    service,
    /WARM_EMBEDDINGS_AFTER_RERANK = os\.getenv\(\s*"QWEN_WARM_EMBEDDINGS_AFTER_RERANK",\s*"false"/s,
  );
});
