const assert = require('node:assert/strict');
const test = require('node:test');
const { createOpenAlexClient, verifyOpenAlexPaper, normalizeOpenAlexWork, paperIdentifiers, selectTitleMatch } = require('../src/services/openalex');
const { executeResearchSearch } = require('../src/services/research');
const { normalizeGraphPapers } = require('../src/services/researchGraph');
const fixture = require('./fixtures/research-openalex-20260909.json');

function work(overrides = {}) {
  return { id: 'https://openalex.org/W123', title: 'Exact Paper about Scholarly Writing', doi: 'https://doi.org/10.1234/example',
    publication_year: 2025, authorships: [{ raw_author_name: 'Anna Martin-Boyle', author: { display_name: 'Anna Martin' } }], ...overrides };
}
const paper = { title: 'Exact Paper about Scholarly Writing', authors: ['Anna Martin-Boyle'], year: 2025 };

test('normalization preserves author bylines, DOI, abstract positions and direct PDF URLs without Scholar IDs', () => {
  const normalized = normalizeOpenAlexWork(work({
    abstract_inverted_index: { 'A': [0], 'paper': [1, 3], 'about': [2] },
    best_oa_location: { landing_page_url: 'https://doi.org/10.1234/example', pdf_url: null },
    locations: [{ pdf_url: 'https://example.org/paper.pdf' }], cited_by_count: 8,
  }));
  assert.equal(normalized.paperId, 'https://openalex.org/W123');
  assert.equal(normalized.doi, '10.1234/example');
  assert.deepEqual(normalized.authors, ['Anna Martin-Boyle']);
  assert.equal(normalized.abstract, 'A paper about paper');
  assert.equal(normalized.openAccessPdfUrl, 'https://example.org/paper.pdf');
  assert.equal(normalized.citesId, undefined);
  assert.equal(normalized.retrievalProvider, 'openalex');
  assert.equal(normalizeOpenAlexWork(work()).openAccessPdfUrl, undefined);
});

test('identifier extraction deduplicates DOI variants and strips arXiv versions without reading arbitrary URLs', () => {
  assert.deepEqual(paperIdentifiers({ doi: 'https://doi.org/10.1234/Example',
    url: 'https://arxiv.org/pdf/2508.14273v3.pdf',
    sourceUrls: ['https://doi.org/10.1234/example', 'https://arxiv.org/abs/2508.14273',
      'https://aclanthology.org/2025.acl-demo.47/', 'https://arxiv.org.evil.test/abs/1234.56789'] }), [
    { doi: '10.1234/example', method: 'doi' },
    { doi: '10.48550/arxiv.2508.14273', method: 'arxiv' },
    { doi: '10.18653/v1/2025.acl-demo.47', method: 'doi' },
  ]);
});

test('title matches require author/year corroboration and do not accept a related paper', () => {
  const record = normalizeOpenAlexWork(work());
  assert.equal(selectTitleMatch(paper, [{ ...record, title: 'Citation Accuracy and Scholarly Writing Interfaces' }]), null);
  assert.equal(selectTitleMatch(paper, [{ ...record, authors: ['Other Person'] }]), null);
  assert.equal(selectTitleMatch(paper, [{ ...record, year: 2015 }]), null);
  assert.equal(selectTitleMatch(paper, [record]), record);
});

test('an unrelated DOI record is rejected and title search can recover the correct work', async () => {
  const wrong = normalizeOpenAlexWork(work({ title: 'Entirely Different Paper', authorships: [{ raw_author_name: 'Other Person' }] }));
  const correct = normalizeOpenAlexWork(work({ id: 'https://openalex.org/W456', doi: 'https://doi.org/10.1234/correct' }));
  let searched = false;
  const result = await verifyOpenAlexPaper({ ...paper, doi: '10.1234/example' }, { client: {
    lookupDoi: async () => wrong,
    searchTitle: async () => { searched = true; return [correct]; },
  } });
  assert.equal(searched, true);
  assert.equal(result.record.doi, '10.1234/correct');
  assert.equal(result.method, 'title');
});

test('a revised title resolves through the original arXiv identifier and corroborating authors', async () => {
  const entry = fixture.cases.find(row => row.index === 9);
  const record = normalizeOpenAlexWork(entry.doiRecords[0]);
  const result = await verifyOpenAlexPaper(entry.candidate, { client: {
    lookupDoi: async doi => { assert.equal(doi, '10.48550/arxiv.2508.14273'); return record; },
    searchTitle: async () => assert.fail('A known arXiv identity must not depend on title search'),
  } });
  assert.equal(result.status, 'verified');
  assert.equal(result.method, 'arxiv');
  assert.match(result.record.title, /^Towards AI-Assisted/);
});

test('not found, lookup failure, and cancelled verification remain distinct', async () => {
  const empty = await verifyOpenAlexPaper(paper, { client: { searchTitle: async () => [] } });
  assert.equal(empty.status, 'not_found');
  const error = await verifyOpenAlexPaper({ ...paper, doi: '10.1234/example' }, { client: {
    lookupDoi: async () => { throw new Error('OpenAlex request failed (429).'); }, searchTitle: async () => [],
  } });
  assert.equal(error.status, 'error');
  assert.match(error.errors[0], /429/);
  const controller = new AbortController(), reason = new Error('Cancelled');
  await assert.rejects(verifyOpenAlexPaper(paper, { signal: controller.signal, client: {
    searchTitle: async () => { controller.abort(reason); throw reason; },
  } }), e => e === reason);
});

test('the client retries 429 with the requested delay and keeps the API key out of URLs', async () => {
  let calls = 0;
  let time = 0;
  const sleeps = [];
  const client = createOpenAlexClient({ apiKey: 'test-secret', now: () => time,
    sleep: async ms => { sleeps.push(ms); time += ms; }, fetchImpl: async (url, init) => {
    const query = new URL(url);
    assert.equal(query.origin, 'https://api.openalex.org');
    assert.equal(query.searchParams.get('corpus'), 'all');
    assert.equal(query.searchParams.get('per_page'), '10');
    assert.equal(query.searchParams.get('search.title'), paper.title);
    assert.equal(String(url).includes('test-secret'), false);
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    return ++calls === 1
      ? Response.json({ error: 'Rate limit exceeded', retryAfter: 10 }, { status: 429 })
      : Response.json({ meta: { count: 1 }, results: [work()] });
  } });
  assert.equal((await client.searchTitle(paper.title))[0].doi, '10.1234/example');
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 9000 && sleeps[0] <= 10000);
});

test('a rate-limited request can be cancelled during backoff', async () => {
  const controller = new AbortController();
  const client = createOpenAlexClient({ signal: controller.signal, apiKey: '',
    fetchImpl: async () => Response.json({ retryAfter: 15 }, { status: 429 }),
    onRetry: () => controller.abort(new Error('Stopped while waiting')),
  });
  await assert.rejects(client.searchTitle(paper.title), /Stopped while waiting/);
});

test('persistent throttling, malformed results and authorization failures are errors; singleton 404 is missing', async () => {
  for (const response of [Response.json({ retryAfter: 1 }, { status: 429 }), Response.json({ error: 'Unauthorized' }, { status: 401 }), Response.json({ results: [] })]) {
    const client = createOpenAlexClient({ maxRetries: 0, apiKey: '', fetchImpl: async () => response });
    await assert.rejects(client.searchTitle(paper.title), /OpenAlex/);
  }
  const client = createOpenAlexClient({ apiKey: '', fetchImpl: async url => {
    assert.equal(decodeURIComponent(String(url)), 'https://api.openalex.org/works/https://doi.org/10.1234/example');
    return new Response('', { status: 404 });
  } });
  assert.equal(await client.lookupDoi('10.1234/example'), null);
});

test('the 18 real missed papers survive research results, DOI/title changes, claims, and graph input', async () => {
  const records = new Map(fixture.cases.flatMap(row => [...row.searchResults, ...row.doiRecords]).map(w => [w.doi?.replace('https://doi.org/', ''), w]));
  const fetchImpl = async url => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://api.openalex.org');
    if (endpoint.pathname === '/works') {
      const row = fixture.cases.find(item => item.candidate.title === endpoint.searchParams.get('search.title'));
      assert.ok(row);
      return Response.json({ meta: { count: row.searchResults.length }, results: row.searchResults });
    }
    const doi = decodeURIComponent(endpoint.pathname).replace('/works/https://doi.org/', '');
    return records.has(doi) ? Response.json(records.get(doi)) : new Response('', { status: 404 });
  };
  const sourceUrls = [...new Set(fixture.cases.flatMap(row => row.candidate.sourceUrls))];
  const result = await executeResearchSearch({ keyword: '18편 재현' }, () => {}, {
    webResearcher: async () => ({ report: 'Saved research report.', sources: sourceUrls.map(url => ({ url, title: url })) }),
    researchCompiler: async () => ({ papers: fixture.cases.map(row => row.candidate), claims: [
      { text: 'The title-changed paper supports the claim.', supportingPaperTitles: [fixture.cases[8].candidate.title] },
    ] }),
    openalexFetch: fetchImpl,
  });
  assert.equal(result.results.length, 18);
  assert.equal(result.researchBundle.papers.filter(p => p.verified).length, 18);
  assert.equal(result.provider, 'openai-web-research+openalex');
  assert.equal(result.warnings.length, 0);
  const renamed = result.researchBundle.papers[8];
  assert.match(renamed.title, /^Towards AI-Assisted/);
  assert.equal(renamed.originalTitle, fixture.cases[8].candidate.title);
  assert.equal(renamed.doi, '10.48550/arxiv.2508.14273');
  assert.equal(renamed.verificationMethod, 'arxiv');
  assert.deepEqual(result.researchBundle.claims[0].supportingPaperIds, [renamed.researchPaperId]);
  assert.equal(result.results.find(p => p.paperId === renamed.paperId).doi, renamed.doi);
  assert.equal(result.results.every(p => !p.citesId && p.paperId.startsWith('https://openalex.org/W')), true);
  assert.equal(normalizeGraphPapers(result.researchBundle).length, 18);
});

test('partial lookup errors preserve the report and candidates without marking them not-found', async () => {
  const activity = [];
  const result = await executeResearchSearch({ keyword: '검증 상태 확인' }, () => {}, {
    onActivity: event => activity.push(event),
    webResearcher: async () => ({ report: 'A report to preserve', sources: [] }),
    researchCompiler: async () => ({ papers: [{ title: 'Known paper' }, { title: 'Missing paper' }, { title: 'Lookup error' }], claims: [] }),
    paperVerifier: async candidate => candidate.title.startsWith('Known')
      ? { status: 'verified', method: 'title', record: normalizeOpenAlexWork(work()) }
      : candidate.title.startsWith('Missing') ? { status: 'not_found' } : { status: 'error', errors: ['OpenAlex request failed (429).'] },
  });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.researchBundle.papers.map(p => p.verificationStatus), ['verified', 'not_found', 'error']);
  assert.equal(result.researchBundle.report, 'A report to preserve');
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[1], /조회 오류/);
  assert.match(activity.find(e => e.kind === 'metadata_verification' && /조회 오류/.test(e.title)).detail, /429/);
});
