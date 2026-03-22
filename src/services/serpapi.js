const axios = require('axios');
const config = require('../config');

const BASE_URL = 'https://serpapi.com/search';

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

module.exports = { fetchCitedBy, fetchScholarIdByTitle };
