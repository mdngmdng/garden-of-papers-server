const mongoose = require('mongoose');
const { getClient } = require('../services/mongo');
const { translateToKorean } = require('../services/gemini');

// POST /translate
exports.translate = async (req, res) => {
  const { _projectName, paperId, pageIndex, paragraphs } = req.body;

  if (!paperId || pageIndex === undefined || !paragraphs || !paragraphs.length) {
    return res.status(400).json({ error: 'paperId, pageIndex, paragraphs required' });
  }

  try {
    const client = getClient();
    const db = client.db(_projectName);
    const collection = db.collection('SaveFile');

    // 1. MongoDB에서 기존 번역 확인
    const doc = await collection.findOne(
      { _id: new mongoose.Types.ObjectId(paperId) },
      { projection: { translations: 1 } },
    );

    if (doc && doc.translations && doc.translations.pages) {
      const cached = doc.translations.pages.find(
        (p) => p.pageIndex === pageIndex,
      );
      if (cached && cached.entries && cached.entries.length > 0) {
        console.log(`[Translate] Cache hit: ${paperId} page ${pageIndex} (${cached.entries.length} entries)`);
        return res.json({ entries: cached.entries, cached: true });
      }
    }

    // 2. Gemini 번역 요청
    console.log(`[Translate] Translating ${paragraphs.length} paragraphs for ${paperId} page ${pageIndex}...`);
    const entries = [];
    for (const para of paragraphs) {
      try {
        const translated = await translateToKorean(para.text);
        if (translated) {
          entries.push({
            text: translated,
            boundsX: para.boundsX,
            boundsY: para.boundsY,
            boundsW: para.boundsW,
            boundsH: para.boundsH,
            startIndex: para.startIndex,
            endIndex: para.endIndex,
          });
        }
      } catch (err) {
        console.error(`[Translate] Failed for paragraph: ${err.message}`);
      }
    }

    // 3. MongoDB에 저장
    const pageData = { pageIndex, entries };

    if (doc && doc.translations && doc.translations.pages) {
      // 기존 translations에 이 페이지 추가/교체
      const existingIdx = doc.translations.pages.findIndex(
        (p) => p.pageIndex === pageIndex,
      );
      if (existingIdx >= 0) {
        await collection.updateOne(
          { _id: new mongoose.Types.ObjectId(paperId) },
          { $set: { [`translations.pages.${existingIdx}`]: pageData } },
        );
      } else {
        await collection.updateOne(
          { _id: new mongoose.Types.ObjectId(paperId) },
          { $push: { 'translations.pages': pageData } },
        );
      }
    } else {
      // translations 필드 자체가 없으면 새로 생성
      await collection.updateOne(
        { _id: new mongoose.Types.ObjectId(paperId) },
        { $set: { translations: { pages: [pageData] } } },
      );
    }

    console.log(`[Translate] Done: ${entries.length} entries saved for ${paperId} page ${pageIndex}`);
    return res.json({ entries, cached: false });
  } catch (error) {
    console.error('[Translate] Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
