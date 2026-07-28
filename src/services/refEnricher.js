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
      const cached = await findSerpCache(ref.title);
      if (cached) {
        Object.assign(enriched, {
          googleScholarId: cached.googleScholarId,
          citesId: cached.citesId,
          source: 'google_scholar',
        });
        results[refId] = enriched;
        return;
      }

      // 캐시 미스 → SerpAPI 호출
      const scholarResult = await fetchScholarIdByTitle(ref.title);
      if (scholarResult) {
        Object.assign(enriched, {
          googleScholarId: scholarResult.resultId,
          citesId: scholarResult.citesId,
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

async function findSerpCache(title) {
  const cache = getClient().db(CACHE_DB).collection(CACHE_COL);
  return cache.findOne({ normalizedTitle: normalize(title) });
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

module.exports = { enrichReferences };
