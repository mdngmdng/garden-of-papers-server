const { getClient } = require('../services/mongo');
const { fetchCitedBy } = require('../services/serpapi');
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

  // 즉시 응답 (백그라운드에서 처리)
  res.json({ message: 'Citation fetch started', fileId, citesId });

  // 백그라운드 실행
  fetchAndSaveCitedBy(projectName, fileId, citesId);
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

// 백그라운드: SerpAPI 호출 → MongoDB 저장 → WebSocket 알림
async function fetchAndSaveCitedBy(projectName, fileId, citesId) {
  try {
    console.log(`[SerpAPI] Fetching citedBy for ${fileId} (citesId: ${citesId})...`);

    const { totalResults, citationTitleList } = await fetchCitedBy(citesId);
    console.log(`[SerpAPI] Found ${totalResults} citations, ${Object.keys(citationTitleList).length} unique entries for ${fileId}`);

    // SaveFile 내 해당 논문 문서에 저장
    const db = getClient().db(projectName);
    await db.collection('SaveFile').updateOne(
      getQuery(fileId),
      {
        $set: {
          citationCountWhenSearch: totalResults,
          citationTitleList,
          citedByFetchedAt: new Date(),
        },
      },
    );
    console.log(`[SerpAPI] Saved citedBy into SaveFile for ${fileId}`);

    // WebSocket으로 클라이언트에게 알림
    syncKeys.broadcastToProject(projectName, {
      type: 'cited_by_ready',
      fileId,
      citationCountWhenSearch: totalResults,
      citationTitleList,
    });
    console.log(`[SerpAPI] Notified clients for ${fileId}`);
  } catch (err) {
    console.error(`[SerpAPI] Failed for ${fileId}:`, err.message);

    syncKeys.broadcastToProject(projectName, {
      type: 'cited_by_failed',
      fileId,
      error: err.message,
    });
  }
}
