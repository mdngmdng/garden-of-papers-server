// Shared Garden-server service. Installed with scripts/install-scholar-authors-server.mjs.
export const AUTHOR_PROVIDER = 'serpapi-google-scholar-author';
const PAGE_SIZE = 20;
const HOUR = 3_600_000;
const idPattern = /^[\w-]{6,64}$/;
const profileHosts = /^scholar\.google\.(com|co\.kr|co\.uk|ca|de|fr|co\.jp)$/;
export function authorIdFromUrl(input) {
  try {
    const url = new URL(input);
    const id = url.searchParams.get('user') || '';
    return url.protocol === 'https:' && profileHosts.test(url.hostname) && url.pathname === '/citations' && idPattern.test(id) ? id : null;
  } catch { return null; }
}
function failure(message, status = 502) { return Object.assign(new Error(message), { status }); }
function validId(id) {
  if (!idPattern.test(String(id || ''))) throw failure('유효한 Scholar 프로필 ID가 필요합니다.', 400);
  return id;
}
function safeImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['scholar.google.com', 'scholar.googleusercontent.com'].includes(url.hostname) &&
      url.port === '' && !url.username && !url.password && !url.pathname.includes('avatar_scholar') ? url.href : null;
  } catch { return null; }
}
function safeHttp(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}

export function createScholarAuthorService({ apiKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const cache = new Map();
  const pending = new Map();
  let active = 0;
  const waiting = [];
  async function limited(fn) {
    if (active >= 2) {
      if (waiting.length >= 20) throw failure('요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429);
      await new Promise(resolve => waiting.push(resolve));
    } else active++;
    try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  async function cached(key, ttl, fn) {
    const item = cache.get(key);
    if (item && item.expires > now()) return item.value;
    if (pending.has(key)) return pending.get(key);
    const task = limited(fn).then(value => {
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: now() + ttl });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  async function request(parameters) {
    if (!apiKey) throw failure('Garden 서버에 SERPAPI_KEY를 설정해 주세요.', 503);
    const url = new URL('https://serpapi.com/search.json');
    for (const [key, value] of Object.entries({ ...parameters, api_key: apiKey, hl: 'en' })) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw failure(response.status === 429 ? '검색 제공자의 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.' : 'Scholar 정보를 가져오지 못했습니다. 다시 시도해 주세요.', response.status === 429 ? 429 : 502);
    const data = await response.json();
    if (data.error) {
      if (/no results|hasn't returned any results/i.test(data.error)) return { organic_results: [] };
      throw failure('Scholar 제공자가 요청을 처리하지 못했습니다. 프로필 공개 여부를 확인하거나 다시 시도해 주세요.');
    }
    return data;
  }
  async function authorPage(authorId, offset = 0) {
    validId(authorId);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw failure('잘못된 페이지입니다.', 400);
    return cached(`author:${authorId}:${offset}`, 24 * HOUR, async () => ({ ...await request({ engine: 'google_scholar_author', author_id: authorId, start: offset, num: PAGE_SIZE }), _fetchedAt: new Date(now()).toISOString() }));
  }
  function profile(authorId, data) {
    if (!data.author?.name) throw failure('공개된 Scholar 프로필을 찾을 수 없습니다.', 404);
    return { version: 1, authorId, name: String(data.author.name), affiliation: String(data.author.affiliations || ''),
      interests: (data.author.interests || []).map(i => String(i.title || '')).filter(Boolean),
      profileUrl: `https://scholar.google.com/citations?user=${authorId}`,
      photoUrl: safeImage(data.author.thumbnail) ? `/api/people/${authorId}/photo` : undefined,
      fetchedAt: data._fetchedAt || new Date(now()).toISOString() };
  }
  async function getProfile(authorId) { return profile(authorId, await authorPage(authorId)); }
  async function search(query) {
    query = String(query || '').trim();
    if (query.length < 2 || query.length > 300) throw failure('이름·소속 또는 Scholar 프로필 URL을 입력해 주세요.', 400);
    if (/^https?:/i.test(query)) {
      const id = authorIdFromUrl(query);
      if (!id) throw failure('Scholar의 citations?user=… 프로필 URL을 입력해 주세요.', 400);
      return { candidates: [{ authorId: id, name: id, profileUrl: `https://scholar.google.com/citations?user=${id}` }], direct: true };
    }
    const data = await cached(`search:${query}`, HOUR, () => request({ engine: 'google', q: `site:scholar.google.com/citations ${query}`, num: 10 }));
    const candidates = new Map();
    for (const item of data.organic_results || []) {
      const authorId = authorIdFromUrl(item.link);
      if (authorId && !candidates.has(authorId)) candidates.set(authorId, {
        authorId, name: String(item.title || '').replace(/\s*[-–—]\s*Google Scholar.*$/i, '').replace(/[‪‬]/g, ''),
        description: String(item.snippet || ''), profileUrl: `https://scholar.google.com/citations?user=${authorId}`,
      });
    }
    return { candidates: [...candidates.values()].slice(0, 10), direct: false };
  }
  async function articles(authorId, offset = 0, query = '') {
    query = String(query).trim().slice(0, 300);
    const data = await authorPage(authorId, offset);
    // Subsequent pages may omit author information.
    const author = await getProfile(authorId);
    const raw = Array.isArray(data.articles) ? data.articles : [];
    const tokens = query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
    const results = raw.flatMap(article => {
      if (!article.title || !article.citation_id) return [];
      const haystack = `${article.title} ${article.publication || ''}`.normalize('NFKC').toLowerCase();
      if (!tokens.every(token => haystack.includes(token))) return [];
      let citesId;
      try { citesId = new URL(article.cited_by?.link).searchParams.get('cites') || undefined; } catch {}
      const citationId = String(article.citation_id);
      return [{ paperId: `scholar-author-work:${citationId}`, title: String(article.title),
        authors: String(article.authors || '').split(/,\s*/).filter(Boolean), year: Number(article.year) || null,
        venue: String(article.publication || ''), citationCount: Number(article.cited_by?.value) || 0,
        url: safeHttp(article.link), abstract: '', citesId, retrievalProvider: AUTHOR_PROVIDER,
        authorSource: { authorId, name: author.name, profileUrl: author.profileUrl, citationId, fetchedAt: author.fetchedAt } }];
    });
    const pagination = data.serpapi_pagination || data.pagination;
    // Missing pagination on a full provider page is not evidence of completion.
    const hasMore = Boolean(pagination?.next || pagination?.next_page_token || (!pagination && raw.length >= PAGE_SIZE));
    return { provider: AUTHOR_PROVIDER, author, results, nextOffset: offset + raw.length,
      hasMore: hasMore && raw.length > 0, scannedCount: offset + raw.length,
      notice: query ? '이 저자의 논문 제목·학술지에서 검색합니다. 다음 페이지에도 결과가 있을 수 있습니다.' : 'Google Scholar 프로필에 등록된 논문입니다.' };
  }
  async function photo(authorId) {
    const data = await authorPage(authorId);
    let url = safeImage(data.author?.thumbnail);
    if (!url) throw failure('등록된 사진이 없습니다.', 404);
    return cached(`photo:${authorId}:${url}`, 7 * 24 * HOUR, async () => {
      for (let redirects = 0; redirects < 4; redirects++) {
        const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        if (response.status >= 300 && response.status < 400) {
          url = safeImage(new URL(response.headers.get('location') || '', url).href);
          if (!url) throw failure('프로필 사진을 불러올 수 없습니다.', 404);
          continue;
        }
        const type = response.headers.get('content-type')?.split(';')[0];
        if (!response.ok || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) throw failure('프로필 사진을 불러올 수 없습니다.', 404);
        if (Number(response.headers.get('content-length')) > 2_000_000) throw failure('프로필 사진이 너무 큽니다.', 413);
        const reader = response.body.getReader();
        const chunks = []; let length = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break;
            length += value.length; if (length > 2_000_000) throw failure('프로필 사진이 너무 큽니다.', 413); chunks.push(value); }
        } finally { await reader.cancel(); }
        const bytes = new Uint8Array(length); let cursor = 0;
        for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
        return { bytes, type };
      }
      throw failure('프로필 사진을 불러올 수 없습니다.', 404);
    });
  }
  return { search, getProfile, articles, photo };
}

export function createScholarAuthorRouter(express, options) {
  const router = express.Router();
  const service = createScholarAuthorService(options);
  router.get('/search', async (req, res) => {
    try { res.json(await service.search(req.query.query)); } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
  });
  router.get('/:authorId/:action', async (req, res) => {
    try {
      if (req.params.action === 'photo') {
        const result = await service.photo(req.params.authorId);
        res.set({ 'content-type': result.type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }).send(Buffer.from(result.bytes));
      } else if (req.params.action === 'articles') res.json(await service.articles(req.params.authorId, Number(req.query.offset || 0), req.query.query || ''));
      else res.status(404).json({ error: 'Unknown action' });
    } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
  });
  router.get('/:authorId', async (req, res) => {
    try { res.json({ profile: await service.getProfile(req.params.authorId) }); } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
  });
  return router;
}
