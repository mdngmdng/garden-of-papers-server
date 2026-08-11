const axios = require('axios');
const config = require('../config');

const BASE_URL = 'https://serpapi.com/search';

function normalizeTotalResults(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  const parsed = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : Math.max(0, Number(fallback) || 0);
}

function extractYear(summary) {
  const matches = String(summary || '').match(/\b(?:19|20)\d{2}\b/g);
  if (!matches?.length) return null;
  return Number(matches.at(-1));
}

function extractVenue(summary) {
  const parts = String(summary || '')
    .split(' - ')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return '';
  const candidate = parts.length >= 3 ? parts.at(-2) : parts.at(-1);
  return String(candidate || '').replace(/,?\s*(?:19|20)\d{2}\s*$/, '').trim();
}

function extractDoi(...values) {
  const text = values.filter(Boolean).join(' ');
  return text.match(/(?:doi\.org\/|\/doi\/|doi[:\s]+)(10\.\d{4,9}\/[^?#\s]+)/i)?.[1]
    ?.replace(/[.,;]+$/g, '')
    .toLowerCase();
}

function normalizeScholarResult(result) {
  const publicationInfo = result.publication_info || {};
  const resource = (result.resources || []).find(
    (candidate) =>
      String(candidate.file_format || '').toUpperCase() === 'PDF' &&
      candidate.link,
  );

  return {
    paperId: result.result_id || result.inline_links?.cited_by?.cites_id || '',
    doi: extractDoi(result.link, resource?.link, result.snippet),
    title: result.title || 'Untitled paper',
    authors: (publicationInfo.authors || [])
      .map((author) => author.name)
      .filter(Boolean),
    year: extractYear(publicationInfo.summary),
    venue: extractVenue(publicationInfo.summary),
    citationCount: Number(result.inline_links?.cited_by?.total || 0),
    url: result.link || resource?.link || '',
    abstract: result.snippet || '',
    openAccessPdfUrl: resource?.link,
    citesId: result.inline_links?.cited_by?.cites_id,
  };
}

/**
 * Google Scholar 일반 검색.
 * SerpAPI의 organic_results를 웹 클라이언트의 ScholarResult 형식으로 정규화한다.
 */
async function searchScholar(query, offset = 0, limit = 10) {
  if (!query || String(query).trim().length < 2) {
    throw new Error('query must contain at least two characters');
  }
  if (!config.serpApiKey) throw new Error('SERPAPI_KEY not configured');

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 10));
  const response = await axios.get(BASE_URL, {
    params: {
      engine: 'google_scholar',
      api_key: config.serpApiKey,
      q: String(query).trim(),
      start: safeOffset,
      num: safeLimit,
      hl: 'en',
    },
    timeout: 30000,
  });
  if (response.data?.error) {
    throw new Error(response.data.error);
  }

  const results = (response.data?.organic_results || [])
    .map(normalizeScholarResult)
    .filter((result) => result.paperId && result.title)
    .slice(0, safeLimit);

  const totalResults = normalizeTotalResults(
    response.data?.search_information?.total_results,
    results.length,
  );
  return {
    total: totalResults,
    totalResults,
    offset: safeOffset,
    results,
    provider: 'serpapi-google-scholar',
  };
}

/**
 * Google Scholar cited-by search with optional keyword filtering.
 * Results stay paged in groups of at most ten so a canvas search never
 * expands into the eager, token-heavy full citation crawl.
 */
async function searchScholarCitations(
  citesId,
  query = '',
  offset = 0,
  limit = 10,
  { sortByDate = false, noCache = false } = {},
) {
  if (!citesId) throw new Error('citesId is required');
  if (!config.serpApiKey) throw new Error('SERPAPI_KEY not configured');

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 10));
  const params = {
    engine: 'google_scholar',
    api_key: config.serpApiKey,
    cites: String(citesId),
    start: safeOffset,
    num: safeLimit,
    hl: 'en',
  };
  const normalizedQuery = String(query || '').trim();
  if (normalizedQuery) params.q = normalizedQuery;
  if (sortByDate) params.scisbd = 2;
  if (noCache) params.no_cache = 'true';

  const response = await axios.get(BASE_URL, {
    params,
    timeout: 30000,
  });
  if (response.data?.error) {
    throw new Error(response.data.error);
  }

  const results = (response.data?.organic_results || [])
    .map(normalizeScholarResult)
    .filter((result) => result.paperId && result.title)
    .slice(0, safeLimit);

  const totalResults = normalizeTotalResults(
    response.data?.search_information?.total_results,
    results.length,
  );
  return {
    total: totalResults,
    totalResults,
    offset: safeOffset,
    results,
    provider: 'serpapi-google-scholar',
    relation: 'citations',
  };
}

/**
 * Google Scholar citedBy 검색
 * Unity의 searchCitationsAboutScientificPaper()와 동일한 로직
 *
 * @param {string} citesId - Google Scholar의 cites ID
 * @returns {{ totalResults: number, citationTitleList: Object<string, [string, string]> }}
 */
async function fetchCitedBy(citesId) {
  if (!citesId) throw new Error('citesId is required');
  if (!config.serpApiKey) throw new Error('SERPAPI_KEY not configured');

  // 1. 첫 번째 호출 → total_results 확인
  const firstRes = await axios.get(BASE_URL, {
    params: {
      engine: 'google_scholar',
      api_key: config.serpApiKey,
      cites: citesId,
    },
    timeout: 30000,
  });

  const totalResults = firstRes.data.search_information?.total_results || 0;
  const citationTitleList = {};

  // 첫 페이지 결과 수집
  collectResults(firstRes.data.organic_results, citationTitleList);

  // 2. 페이지네이션 (10개씩)
  const totalPages = Math.floor(totalResults / 10);
  const requests = [];

  for (let i = 1; i <= totalPages; i++) {
    requests.push(
      axios.get(BASE_URL, {
        params: {
          engine: 'google_scholar',
          api_key: config.serpApiKey,
          cites: citesId,
          start: i * 10,
        },
        timeout: 30000,
      }).catch((err) => {
        console.warn(`[SerpAPI] Page ${i} failed:`, err.message);
        return null;
      }),
    );
  }

  // 병렬 실행 (동시 요청 5개씩 제한)
  const batchSize = 5;
  for (let i = 0; i < requests.length; i += batchSize) {
    const batch = requests.slice(i, i + batchSize);
    const responses = await Promise.all(batch);
    for (const res of responses) {
      if (res?.data?.organic_results) {
        collectResults(res.data.organic_results, citationTitleList);
      }
    }
  }

  return { totalResults, citationTitleList };
}

/**
 * organic_results에서 result_id, title, authors 수집
 * Unity의 citationTitleList와 동일한 구조: { result_id: [title, authorsString] }
 */
function collectResults(results, citationTitleList) {
  if (!results) return;

  for (const result of results) {
    if (!result.result_id) continue;
    if (citationTitleList[result.result_id]) continue; // 중복 방지

    const authors = (result.publication_info?.authors || [])
      .map((a) => a.name)
      .join(', ');

    citationTitleList[result.result_id] = [result.title || '', authors];
  }
}

/**
 * Title로 Google Scholar에서 논문 검색 → result_id, citesId 반환
 * refEnricher의 fallback으로 사용 (SerpAPI 1회 호출)
 *
 * @param {string} title - 논문 제목
 * @returns {{ resultId: string, citesId: string|null }} | null
 */
async function fetchScholarIdByTitle(title) {
  if (!title) return null;
  if (!config.serpApiKey) return null;

  try {
    const res = await axios.get(BASE_URL, {
      params: {
        engine: 'google_scholar',
        api_key: config.serpApiKey,
        q: `"${title}"`, // 정확한 제목 매칭을 위해 따옴표
      },
      timeout: 30000,
    });

    const results = res.data.organic_results || [];
    if (results.length === 0) return null;

    // 첫 번째 결과에서 ID 추출
    const top = results[0];
    return {
      resultId: top.result_id || null,
      citesId: top.inline_links?.cited_by?.cites_id || null,
    };
  } catch (err) {
    console.warn(`[SerpAPI] Title search error ("${title.substring(0, 50)}"):`, err.message);
    return null;
  }
}

module.exports = {
  extractDoi,
  normalizeTotalResults,
  fetchCitedBy,
  fetchScholarIdByTitle,
  normalizeScholarResult,
  searchScholar,
  searchScholarCitations,
};
