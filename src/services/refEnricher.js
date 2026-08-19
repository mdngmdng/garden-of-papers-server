const { getClient } = require('./mongo');
const { fetchScholarIdByTitle } = require('./serpapi');

/**
 * SerpAPI 결과만 캐싱 (유료 API 재호출 방지)
 */
const CACHE_DB = 'ScholarCache';
const CACHE_COL = 'serpapi';

/**
 * 레퍼런스 목록을 SerpAPI result_id로 enrichment
 * GROBID key(b0, b1, ...) → googleScholarId(result_id) + citesId 추가
 *
 * @param {Object} refInfo - { b0: { title, doi, authors, ... }, b1: ... }
 * @returns {Object} enriched refInfo
 */
async function enrichReferences(refInfo) {
  if (!refInfo) return {};
  const refs = Object.entries(refInfo);
  const results = {};

  const enrichOne = async ([refId, ref]) => {
    const enriched = { ...ref };

    try {
      if (!ref.title) {
        enriched.source = 'grobid_only';
        results[refId] = enriched;
        return;
      }

      // 캐시 먼저 확인 (유료 API 재호출 방지)
      const cached = await findSerpCache(ref);
      if (cached) {
        Object.assign(enriched, {
          googleScholarId: cached.googleScholarId,
          citesId: cached.citesId,
          scholarMatchVerified: true,
          source: 'google_scholar',
        });
        results[refId] = enriched;
        return;
      }

      // 캐시 미스 → SerpAPI 호출
      const scholarResult = await fetchScholarIdByTitle(ref.title, ref);
      if (scholarResult) {
        Object.assign(enriched, {
          googleScholarId: scholarResult.resultId,
          citesId: scholarResult.citesId,
          scholarMatchVerified: true,
          source: 'google_scholar',
        });
        await saveSerpCache(ref.title, scholarResult);
        results[refId] = enriched;
        return;
      }

      // SerpAPI에서도 못 찾음
      enriched.source = 'grobid_only';
      results[refId] = enriched;
    } catch (err) {
      console.warn(`[Enrich] Error for ${refId} ("${ref.title?.substring(0, 40)}"):`, err.message);
      enriched.source = 'grobid_only';
      results[refId] = enriched;
    }
  };

  // Keep a small concurrency window: substantially faster than Unity's
  // sequential loop, while avoiding a burst of SerpAPI requests.
  const concurrency = 3;
  for (let index = 0; index < refs.length; index += concurrency) {
    await Promise.all(refs.slice(index, index + concurrency).map(enrichOne));
  }

  return results;
}

// ---- SerpAPI 캐시 ----

function titleTokens(value) {
  return new Set(normalize(value).split(/\s+/).filter((token) => token.length > 1));
}

function titleMatchScore(left, right) {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return Math.min(overlap / leftTokens.size, overlap / rightTokens.size);
}

function surnameSet(authors) {
  return new Set((authors || []).flatMap((author) => {
    const tokens = String(author).toLowerCase().match(/[a-z0-9]+/g);
    return tokens?.length ? [tokens.at(-1)] : [];
  }));
}

function cachedReferenceMatches(reference, cached) {
  if (titleMatchScore(reference.title, cached.matchedTitle) < 0.6) return false;
  const expectedYear = Number(String(reference.year || '').match(/\b(?:19|20)\d{2}\b/)?.[0]) || null;
  const matchedYear = Number(cached.matchedYear) || null;
  if (expectedYear && matchedYear && Math.abs(expectedYear - matchedYear) > 1) return false;
  const expectedAuthors = surnameSet(reference.authors);
  const matchedAuthors = surnameSet(cached.matchedAuthors);
  if (
    expectedAuthors.size
    && matchedAuthors.size
    && ![...expectedAuthors].some((surname) => matchedAuthors.has(surname))
  ) {
    return false;
  }
  return true;
}

async function findSerpCache(reference) {
  const cache = getClient().db(CACHE_DB).collection(CACHE_COL);
  const cached = await cache.findOne({
    normalizedTitle: normalize(reference.title),
    matchVersion: 3,
  });
  return cached && cachedReferenceMatches(reference, cached) ? cached : null;
}

async function saveSerpCache(title, scholarResult) {
  const cache = getClient().db(CACHE_DB).collection(CACHE_COL);
  await cache.updateOne(
    { normalizedTitle: normalize(title) },
    {
      $set: {
        normalizedTitle: normalize(title),
        originalTitle: title,
        googleScholarId: scholarResult.resultId,
        citesId: scholarResult.citesId,
        matchedTitle: scholarResult.matchedTitle,
        matchedAuthors: scholarResult.matchedAuthors,
        matchedYear: scholarResult.matchedYear,
        matchVersion: 3,
        cachedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

function normalize(title) {
  if (!title) return '';
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { cachedReferenceMatches, enrichReferences };
