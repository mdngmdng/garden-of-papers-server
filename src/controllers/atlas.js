const { resolveAtlasPaper } = require('../services/atlasImport');
const { translatePaperToKorean } = require('../services/gemini');
const crypto = require('crypto');

const translationCache = new Map();
const MAX_TRANSLATION_CACHE_ENTRIES = 500;

function translationInput(value, field, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) {
    throw new TypeError(`${field} is too long to translate.`);
  }
  return text;
}

function cacheTranslation(key, value) {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > MAX_TRANSLATION_CACHE_ENTRIES) {
    translationCache.delete(translationCache.keys().next().value);
  }
}

exports.resolvePaper = async (req, res) => {
  try {
    const paper = await resolveAtlasPaper(req.body?.paper || req.body || {});
    res.set('Cache-Control', 'private, no-store, max-age=0');
    return res.json({ paper });
  } catch (error) {
    const status = error instanceof TypeError ? 400 : 502;
    console.error('[Atlas] Paper handoff failed:', error.message);
    return res.status(status).json({ error: error.message });
  }
};

exports.translatePaper = async (req, res) => {
  try {
    const title = translationInput(req.body?.title, 'title', 1_000);
    const abstract = translationInput(req.body?.abstract, 'abstract', 20_000);
    if (!title && !abstract) {
      return res.status(400).json({ error: '번역할 제목이나 초록이 없습니다.' });
    }
    const key = crypto
      .createHash('sha256')
      .update(`${title}\n${abstract}`)
      .digest('hex');
    const cached = translationCache.get(key);
    if (cached) {
      res.set('Cache-Control', 'private, no-store, max-age=0');
      return res.json({ ...cached, cached: true });
    }
    const {
      title: translatedTitle,
      abstract: translatedAbstract,
    } = await translatePaperToKorean({ title, abstract });
    if ((title && !translatedTitle) || (abstract && !translatedAbstract)) {
      throw new Error('번역 모델이 결과를 반환하지 않았습니다.');
    }
    const payload = {
      title: translatedTitle || title,
      abstract: translatedAbstract || abstract,
      provider: 'gemini-2.5-flash',
    };
    cacheTranslation(key, payload);
    res.set('Cache-Control', 'private, no-store, max-age=0');
    return res.json({ ...payload, cached: false });
  } catch (error) {
    const status = error instanceof TypeError ? 400 : 502;
    console.error('[Atlas] Paper translation failed:', error.message);
    return res.status(status).json({
      error: status === 400
        ? error.message
        : '한국어 번역에 실패했습니다. 잠시 후 다시 시도해주세요.',
    });
  }
};
