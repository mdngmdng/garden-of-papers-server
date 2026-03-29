const { getClient } = require('../services/mongo');
const { fetchCitedBy } = require('../services/serpapi');
const { resolveAndStorePaperReferences } = require('../services/refEnricher');
const syncKeys = require('../services/syncKeys');
const { ObjectId } = require('mongodb');

function getQuery(fileId) {
  try {
    return { _id: new ObjectId(fileId) };
  } catch {
    return { _id: fileId };
  }
}

/**
 * POST /fetch_citations/:projectName
 * Body: { fileId, citesId }
 *
 * Unity가 논문을 추가할 때 citesId와 함께 호출
 * → 서버가 SerpAPI로 citedBy 수집 → SaveFile에 저장 → WebSocket 알림
 */
exports.fetchCitedBy = async (req, res) => {
  const { projectName } = req.params;
  const { fileId, citesId } = req.body;

  if (!fileId || !citesId) {
    return res.status(400).json({ error: 'fileId and citesId are required' });
  }

  try {
    const result = await fetchAndSaveCitedBy(projectName, fileId, citesId);
    res.json({
      fileId,
      citationCountWhenSearch: result.totalResults,
      citationTitleList: result.citationTitleList,
    });
  } catch (err) {
    console.error(`[SerpAPI] Failed for ${fileId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /cited_by/:projectName/:fileid
 * 이미 저장된 citedBy 데이터 조회
 */
exports.getCitedBy = async (req, res) => {
  const { projectName, fileid } = req.params;

  try {
    const db = getClient().db(projectName);
    const doc = await db.collection('SaveFile').findOne(getQuery(fileid));

    if (!doc || !doc.citationTitleList) {
      return res.status(404).json({ error: 'CitedBy data not yet fetched', status: 'processing' });
    }

    res.json({
      fileId: fileid,
      citationCountWhenSearch: doc.citationCountWhenSearch,
      citationTitleList: doc.citationTitleList,
      citedByFetchedAt: doc.citedByFetchedAt,
    });
  } catch (err) {
    console.error('Error fetching citedBy:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /resolve_references_intersection/:projectName
 * Body: { blankPaperId, aPaperIds: string[], bCitationIds: string[] }
 *
 * A 논문들의 레퍼런스를 result_id로 완전 변환한 뒤 B의 citation 목록과 교집합.
 *
 * Phase 1: A 논문별 resolvedReferences(MongoDB 캐시) → 즉시 교집합 → HTTP 응답
 * Phase 2: 캐시 미스분 SerpAPI 변환 → 모든 A 완료 시 전체 교집합 → WS "intersection_ready"
 */
exports.resolveReferencesIntersection = async (req, res) => {
  const { projectName } = req.params;
  const { blankPaperId, aPaperIds, bCitationIds } = req.body;

  if (!Array.isArray(aPaperIds) || !Array.isArray(bCitationIds)) {
    return res.status(400).json({ error: 'aPaperIds and bCitationIds are required arrays' });
  }

  const db = getClient().db(projectName);
  const bCitSet = new Set(bCitationIds);

  try {
    // Phase 1: 각 A 논문의 resolvedReferences 수집
    // pendingCount: Phase2가 필요한 A 논문 수 (콜백이 모두 호출되면 WS 전송)
    let pendingCount = 0;
    let cacheHit = false;
    const allImmediate = {}; // result_id → [title, authors], A 논문 전체 합산
    // Phase1에서 이미 클라이언트에 보낸 result_id 집합 (Phase2 WS 중복 방지용)
    const phase1SentIds = new Set();

    // Phase2 완료 콜백 (모든 A 논문의 Phase2가 끝날 때 한 번만 WS 전송)
    const onPhase2Done = async () => {
      pendingCount--;
      if (cacheHit || pendingCount > 0) return; // 캐시 히트이거나 아직 다른 A 논문 pending

      // 모든 Phase2 완료 → A 논문별 최신 resolvedReferences 재조회
      const finalAllResolved = {};
      for (const aPaperId of aPaperIds) {
        const doc = await db.collection('SaveFile').findOne(
          getQuery(aPaperId),
          { projection: { resolvedReferences: 1 } },
        );
        if (doc?.resolvedReferences) {
          Object.assign(finalAllResolved, fromSerialDicStrStr(doc.resolvedReferences));
        }
      }

      const allMatched = {};
      for (const [resultId, titleAuthors] of Object.entries(finalAllResolved)) {
        if (bCitSet.has(resultId)) allMatched[resultId] = titleAuthors;
      }

      // Phase1에서 이미 보낸 것 제외 → 새로 찾은 것만 WS로 전송
      const newMatched = {};
      for (const [resultId, titleAuthors] of Object.entries(allMatched)) {
        if (!phase1SentIds.has(resultId)) newMatched[resultId] = titleAuthors;
      }

      const finalARefCount = Object.keys(finalAllResolved).length;
      console.log(
        `[Intersection] Phase2 all done: ${Object.keys(allMatched).length} total,` +
        ` ${Object.keys(newMatched).length} new (aRef=${finalARefCount}, bCit=${bCitationIds.length})`,
      );

      if (blankPaperId) {
        await db.collection('SaveFile').updateOne(getQuery(blankPaperId), {
          $set: {
            intersectionReferences: toSerialDicStrStr(allMatched),
            intersectionARefCount: finalARefCount,
            intersectionBCitationCount: bCitationIds.length,
            intersectionFetchedAt: new Date(),
          },
        });
      }

      syncKeys.broadcastToProject(projectName, JSON.stringify({
        type: 'intersection_ready',
        blankPaperId,
        matchedReferences: toSerialDicStrStr(newMatched),
      }));
    };

    // 각 A 논문: resolvedReferences 읽어오기 (Phase1) + Phase2 백그라운드 시작
    for (const aPaperId of aPaperIds) {
      const result = await resolveAndStorePaperReferences(db, aPaperId, onPhase2Done);
      if (!result) continue;
      Object.assign(allImmediate, result.resolved);
      if (result.hasPending) pendingCount++;
    }

    const aRefCount = Object.keys(allImmediate).length;
    const hasPending = pendingCount > 0;

    // 교집합 캐시 확인 (aRefCount 확정 후)
    if (blankPaperId) {
      const cached = await db.collection('SaveFile').findOne(
        getQuery(blankPaperId),
        { projection: { intersectionReferences: 1, intersectionBCitationCount: 1, intersectionARefCount: 1 } },
      );
      if (cached?.intersectionReferences &&
          cached.intersectionBCitationCount === bCitationIds.length &&
          cached.intersectionARefCount === aRefCount) {
        console.log(`[Intersection] Cache hit (aRef=${aRefCount}, bCit=${bCitationIds.length}) → skip recompute`);
        cacheHit = true;
        return res.json({ matchedReferences: cached.intersectionReferences, hasPending: false });
      }
      if (cached?.intersectionReferences) {
        console.log(
          `[Intersection] Cache stale: aRef ${cached.intersectionARefCount}→${aRefCount},` +
          ` bCit ${cached.intersectionBCitationCount}→${bCitationIds.length} → recompute`,
        );
      }
    }

    // Phase1 교집합: allImmediate ∩ bCitSet
    const immediate = {};
    for (const [resultId, titleAuthors] of Object.entries(allImmediate)) {
      if (bCitSet.has(resultId)) {
        immediate[resultId] = titleAuthors;
        phase1SentIds.add(resultId); // Phase2 WS 중복 방지용으로 기록
      }
    }

    console.log(
      `[Intersection] ${aRefCount} A-refs × ${bCitationIds.length} B-cites` +
      ` → ${Object.keys(immediate).length} immediate, hasPending=${hasPending} (blankPaper: ${blankPaperId})`,
    );

    res.json({ matchedReferences: toSerialDicStrStr(immediate), hasPending });

    // pending 없으면 Phase1 결과 즉시 저장
    if (!hasPending && blankPaperId) {
      await db.collection('SaveFile').updateOne(getQuery(blankPaperId), {
        $set: {
          intersectionReferences: toSerialDicStrStr(immediate),
          intersectionARefCount: aRefCount,
          intersectionBCitationCount: bCitationIds.length,
          intersectionFetchedAt: new Date(),
        },
      });
    }
  } catch (err) {
    console.error('[Intersection] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /resolve_paper_references/:projectName
 * Body: { paperIds: string[] }
 *
 * 주어진 논문들의 referenceTitleList grobid 키를 SerpAPI result_id로 변환하여
 * MongoDB에 저장하고 반환.
 */
exports.resolvePaperReferences = async (req, res) => {
  const { projectName } = req.params;
  const { paperIds } = req.body;

  if (!Array.isArray(paperIds) || paperIds.length === 0) {
    return res.status(400).json({ error: 'paperIds array is required' });
  }

  const db = getClient().db(projectName);

  try {
    const results = {};

    for (const paperId of paperIds) {
      const result = await resolveAndStorePaperReferences(db, paperId, null);
      if (!result) {
        results[paperId] = { error: 'not found' };
        continue;
      }
      results[paperId] = {
        resolved: toSerialDicStrStr(result.resolved),
        hasPending: result.hasPending,
      };
    }

    res.json({ results });
  } catch (err) {
    console.error('[ResolvePaperRefs] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// GXSerialDicStrStr → plain object 변환
function fromSerialDicStrStr(serialized) {
  const result = {};
  if (!serialized?.key || !serialized?.value) return result;
  for (let i = 0; i < serialized.key.length; i++) {
    result[serialized.key[i]] = serialized.value[i]?.array || [];
  }
  return result;
}

// { resultId: [title, authors] } → GXSerialDicStrStr 형식 변환
function toSerialDicStrStr(dict) {
  const keys = [];
  const values = [];
  for (const [k, v] of Object.entries(dict)) {
    keys.push(k);
    values.push({ array: Array.isArray(v) ? v : [v] });
  }
  return { key: keys, value: values };
}

// SerpAPI 호출 → MongoDB 저장 → 결과 반환
async function fetchAndSaveCitedBy(projectName, fileId, citesId) {
  console.log(`[SerpAPI] Fetching citedBy for ${fileId} (citesId: ${citesId})...`);

  const { totalResults, citationTitleList } = await fetchCitedBy(citesId);
  console.log(`[SerpAPI] Found ${totalResults} citations, ${Object.keys(citationTitleList).length} unique entries for ${fileId}`);

  // Unity의 GXSerialDicStrStr 형식으로 변환하여 저장
  const serialized = toSerialDicStrStr(citationTitleList);

  const db = getClient().db(projectName);
  await db.collection('SaveFile').updateOne(
    getQuery(fileId),
    {
      $set: {
        citationCountWhenSearch: totalResults,
        citationTitleList: serialized,
        citedByFetchedAt: new Date(),
      },
    },
  );
  console.log(`[SerpAPI] Saved citedBy into SaveFile for ${fileId}`);

  return { totalResults, citationTitleList };
}
