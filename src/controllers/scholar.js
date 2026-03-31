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
