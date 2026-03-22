const { getClient } = require('./mongo');
const s2 = require('./semanticScholar');
const { fetchScholarIdByTitle } = require('./serpapi');

/**
 * SerpAPI 결과만 캐싱 (유료 API 재호출 방지)
 * S2는 무료이므로 캐시하지 않음
 */
const CACHE_DB = 'ScholarCache';
const CACHE_COL = 'serpapi';

/**
 * 레퍼런스 목록을 외부 ID로 enrichment
 *
 * @param {Object} refInfo - { b0: { title, doi, authors, ... }, b1: ... }
 * @returns {Object} enriched refInfo
 */
async function enrichReferences(refInfo) {
  const refs = Object.entries(refInfo);
  const results = {};

  for (const [refId, ref] of refs) {
    const enriched = { ...ref };

    try {
      // 1. S2: DOI로 조회 (무료, 캐시 불필요)
      //    Rate limit: 10 req/sec (with API key)
      if (ref.doi) {
        const s2Paper = await s2.lookupByDoi(ref.doi);
        if (s2Paper) {
          Object.assign(enriched, {
            corpusId: s2Paper.corpusId,
            s2Url: s2Paper.url,
            citationCount: s2Paper.citationCount,
            source: 'semantic_scholar',
          });
          results[refId] = enriched;
          await delay(3100); // 무인증: 100 req/5min ≈ 3sec/req
          continue;
        }
        await delay(3100);
      }

      // 2. S2: title로 검색 (무료, 캐시 불필요)
      //    무인증 rate limit: 100 req / 5min
      if (ref.title) {
        const s2Paper = await s2.searchByTitle(ref.title);
        if (s2Paper) {
          Object.assign(enriched, {
            corpusId: s2Paper.corpusId,
            doi: s2Paper.doi || ref.doi,
            s2Url: s2Paper.url,
            citationCount: s2Paper.citationCount,
            source: 'semantic_scholar',
          });
          results[refId] = enriched;
          await delay(3100);
          continue;
        }
        await delay(3100);
      }

      // 3. SerpAPI: 캐시 먼저 확인 (유료 API이므로)
      if (ref.title) {
        const cached = await findSerpCache(ref.title);
        if (cached) {
          Object.assign(enriched, {
            googleScholarId: cached.googleScholarId,
            citesId: cached.citesId,
            source: 'google_scholar',
          });
          results[refId] = enriched;
          continue;
        }

        // 캐시 미스 → SerpAPI 호출
        const scholarResult = await fetchScholarIdByTitle(ref.title);
        if (scholarResult) {
          Object.assign(enriched, {
            googleScholarId: scholarResult.resultId,
            citesId: scholarResult.citesId,
            source: 'google_scholar',
          });
          // 캐시에 저장 (다음에 같은 논문 안 부르도록)
          await saveSerpCache(ref.title, scholarResult);
          results[refId] = enriched;
          continue;
        }
      }

      // 4. 전부 실패
      enriched.source = 'grobid_only';
      results[refId] = enriched;
    } catch (err) {
      console.warn(`[Enrich] Error for ${refId} ("${ref.title?.substring(0, 40)}"):`, err.message);
      enriched.source = 'grobid_only';
      results[refId] = enriched;
    }
  }

  return results;
}

// ---- SerpAPI 캐시 (유료 API 결과만) ----

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { enrichReferences };
