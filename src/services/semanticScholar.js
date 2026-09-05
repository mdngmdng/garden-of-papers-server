const axios = require('axios');
const config = require('../config');

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const FIELDS = 'externalIds,title,authors,year,citationCount,url';

// API 키 헤더 (rate limit 향상: DOI=10req/s, search=1req/s)
// 키가 403이면 키 없이 시도 (무인증: 100 req/5min)
function getHeaders() {
  const headers = {};
  if (config.s2ApiKey) headers['x-api-key'] = config.s2ApiKey;
  return headers;
}

/**
 * DOI로 Semantic Scholar 논문 조회
 * @returns {{ corpusId, paperId, title, authors, year, citationCount, externalIds, url }} | null
 */
async function lookupByDoi(doi, { signal } = {}) {
  if (!doi) return null;

  try {
    const res = await axios.get(`${S2_BASE}/paper/DOI:${doi}`, {
      params: { fields: FIELDS },
      headers: getHeaders(),
      timeout: 10000,
      signal,
    });
    return normalizePaper(res.data);
  } catch (err) {
    if (err.response?.status === 404) return null;
    // Rate limit (429) → 잠시 대기 후 null 반환
    if (err.response?.status === 429) {
      console.warn('[S2] Rate limited on DOI lookup');
      return null;
    }
    console.warn(`[S2] DOI lookup error (${doi}):`, err.message);
    return null;
  }
}

/**
 * Title로 Semantic Scholar 논문 검색
 * 가장 관련도 높은 1건 반환
 * @returns {{ corpusId, paperId, title, authors, year, citationCount, externalIds, url }} | null
 */
async function searchByTitle(title, { signal } = {}) {
  if (!title) return null;

  try {
    const res = await axios.get(`${S2_BASE}/paper/search`, {
      params: {
        query: title,
        limit: 1,
        fields: FIELDS,
      },
      headers: getHeaders(),
      timeout: 10000,
      signal,
    });

    const papers = res.data?.data || [];
    if (papers.length === 0) return null;

    const paper = papers[0];
    // 제목 유사도 확인 (너무 다르면 무시)
    if (!isTitleMatch(title, paper.title)) {
      return null;
    }

    return normalizePaper(paper);
  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('[S2] Rate limited on title search');
      return null;
    }
    console.warn(`[S2] Title search error ("${title.substring(0, 50)}"):`, err.message);
    return null;
  }
}

/**
 * Return the works explicitly listed in a paper's reference list.
 * These records are suitable for verified graph edges; search relevance is not.
 */
async function fetchReferences(paperId, { limit = 100, signal } = {}) {
  if (!paperId) return [];
  const safeLimit = Math.max(1, Math.min(1_000, Number(limit) || 100));
  try {
    const res = await axios.get(
      `${S2_BASE}/paper/${encodeURIComponent(paperId)}/references`,
      {
        params: { fields: FIELDS, limit: safeLimit },
        headers: getHeaders(),
        timeout: 30_000,
        signal,
      },
    );
    return (res.data?.data || []).flatMap((entry) => {
      const normalized = normalizePaper(entry?.citedPaper);
      return normalized ? [normalized] : [];
    });
  } catch (err) {
    if (err.response?.status === 404) return [];
    const error = new Error(`Semantic Scholar references failed: ${err.message}`);
    error.status = err.response?.status;
    throw error;
  }
}

/**
 * 제목 유사도 확인 (대소문자/특수문자 무시, 70% 이상 일치)
 */
function isTitleMatch(query, result) {
  if (!query || !result) return false;
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const q = normalize(query);
  const r = normalize(result);

  // 짧은 쪽이 긴 쪽에 포함되면 OK
  if (r.includes(q) || q.includes(r)) return true;

  // 단어 겹침 비율
  const qWords = new Set(q.split(/\s+/));
  const rWords = new Set(r.split(/\s+/));
  const overlap = [...qWords].filter((w) => rWords.has(w)).length;
  const ratio = overlap / Math.max(qWords.size, rWords.size);

  return ratio >= 0.7;
}

/**
 * S2 API 응답 → 통일된 포맷
 */
function normalizePaper(data) {
  if (!data) return null;

  return {
    corpusId: data.externalIds?.CorpusId || null,
    paperId: data.paperId || null,
    title: data.title || '',
    authors: (data.authors || []).map((a) => a.name),
    year: data.year || null,
    citationCount: data.citationCount || 0,
    doi: data.externalIds?.DOI || null,
    arxivId: data.externalIds?.ArXiv || null,
    url: data.url || null,
  };
}

module.exports = { fetchReferences, lookupByDoi, searchByTitle };
