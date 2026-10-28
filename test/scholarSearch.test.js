const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const config = require('../src/config');
const serpapi = require('../src/services/serpapi');

function setup(t, get) {
  const originalKey = config.serpApiKey;
  config.serpApiKey = 'test-key';
  t.after(() => { config.serpApiKey = originalKey; });
  return t.mock.method(axios, 'get', get);
}

const empty = {
  search_metadata: { status: 'Success' },
  error: "Google hasn't returned any results for this query.",
};

test('manual identity search forwards no_cache and keeps the abort signal', async t => {
  const get = setup(t, async () => ({ data: { organic_results: [] } }));
  const signal = new AbortController().signal;
  await serpapi.searchScholar('10.1145/1461551.1461591', 0, 3, { noCache: true, signal });
  const options = get.mock.calls[0].arguments[1];
  assert.equal(options.params.no_cache, 'true');
  assert.equal(options.params.start, 0);
  assert.equal(options.params.num, 3);
  assert.equal(options.signal, signal);
  await serpapi.searchScholar('Sketchpad', 0, 3);
  assert.equal(get.mock.calls[1].arguments[1].params.no_cache, undefined);
});

test('a successful empty identity search is distinct from an upstream failure', async t => {
  setup(t, async () => ({ data: empty }));
  assert.deepEqual(await serpapi.searchScholar('Sketchpad', 0, 3), {
    total: 0, offset: 0, results: [], provider: 'serpapi-google-scholar',
  });
});

test('a successful empty cited-by search returns a zero-sized page', async t => {
  const get = setup(t, async () => ({ data: empty }));
  assert.deepEqual(await serpapi.searchScholarCitations('known-cites', '', 0, 10, { noCache: true }), {
    total: 0, offset: 0, results: [], provider: 'serpapi-google-scholar', relation: 'citations',
  });
  assert.equal(get.mock.calls[0].arguments[1].params.no_cache, 'true');
});

test('quota errors remain failures rather than zero-result searches', async t => {
  setup(t, async () => ({ data: { search_metadata: { status: 'Error' }, error: 'Your account has run out of searches.' } }));
  await assert.rejects(serpapi.searchScholar('Sketchpad'), /run out of searches/);
  await assert.rejects(serpapi.searchScholarCitations('known-cites'), /run out of searches/);
});

test('an unsuccessful empty-looking response remains a failure', async t => {
  setup(t, async () => ({ data: { ...empty, search_metadata: { status: 'Error' } } }));
  await assert.rejects(serpapi.searchScholar('Sketchpad'), /hasn.t returned any results/);
});

test('the controller forwards refresh to identity searches and disables HTTP caching', async t => {
  const calls = [];
  const original = serpapi.searchScholar;
  serpapi.searchScholar = async (...args) => { calls.push(args); return { provider: 'serpapi-google-scholar', total: 0, results: [] }; };
  const controllerPath = require.resolve('../src/controllers/scholar');
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  serpapi.searchScholar = original;
  t.after(() => { delete require.cache[controllerPath]; });
  const headers = {};
  const response = { set: (key, value) => { headers[key] = value; }, json: () => {} };
  await controller.searchScholar({ query: { query: 'Sketchpad', refresh: '1', limit: '3' } }, response);
  assert.deepEqual(calls[0], ['Sketchpad', 0, 3, { noCache: true }]);
  assert.match(headers['Cache-Control'], /no-store/);
  await controller.searchScholar({ query: { query: 'Sketchpad' } }, response);
  assert.deepEqual(calls[1], ['Sketchpad', 0, 10, { noCache: false }]);
});
