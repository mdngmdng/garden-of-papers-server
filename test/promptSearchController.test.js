const assert = require('node:assert/strict');
const test = require('node:test');
const jobs = require('../src/services/relatedSearchJobs');

test('job controller forwards prompt intent and canvas exclusions into the existing asynchronous endpoint', (t) => {
  let submitted;
  const original = jobs.createRelatedSearchJob;
  jobs.createRelatedSearchJob = (input) => { submitted = input; return 'prompt-job'; };
  const controllerPath = require.resolve('../src/controllers/relatedWork');
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  jobs.createRelatedSearchJob = original;
  t.after(() => { delete require.cache[controllerPath]; });
  let status;
  let response;
  const res = {
    set: () => res,
    status: (value) => { status = value; return res; },
    json: (value) => { response = value; return res; },
  };
  controller.createJob({ body: {
    keyword: '  VR 기억 관련 근거 논문을 찾아줘.  ',
    searchIntent: 'prompt_search',
    excludedPapers: [{ paperId: 'canvas-a', title: 'Already collected' }],
  } }, res);
  assert.equal(status, 202);
  assert.equal(response.jobId, 'prompt-job');
  assert.equal(submitted.searchIntent, 'prompt_search');
  assert.equal(submitted.keyword, 'VR 기억 관련 근거 논문을 찾아줘.');
  assert.deepEqual(submitted.excludedPapers, [{ paperId: 'canvas-a', title: 'Already collected' }]);
  controller.createJob({ body: { keyword: 'A claim', searchIntent: 'claim_support' } }, res);
  assert.equal(submitted.searchIntent, 'claim_support');
});
