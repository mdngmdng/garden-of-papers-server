const axios = require('axios');

const MYMEMORY_TRANSLATE_URL = 'https://api.mymemory.translated.net/get';
const MAX_SEGMENT_BYTES = 450;
const TRANSLATION_CONCURRENCY = 6;

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function splitUtf8(text, maxBytes = MAX_SEGMENT_BYTES) {
  const tokens = String(text || '').match(/\S+\s*/gu) || [];
  const chunks = [];
  let current = '';

  const push = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  for (const token of tokens) {
    if (Buffer.byteLength(current + token, 'utf8') <= maxBytes) {
      current += token;
      continue;
    }
    push();
    if (Buffer.byteLength(token, 'utf8') <= maxBytes) {
      current = token;
      continue;
    }
    for (const character of token) {
      if (Buffer.byteLength(current + character, 'utf8') > maxBytes) push();
      current += character;
    }
  }
  push();
  return chunks;
}

async function translateSegmentToKorean(text) {
  const response = await axios.get(MYMEMORY_TRANSLATE_URL, {
    params: {
      q: text,
      langpair: 'en|ko',
      mt: 1,
    },
    timeout: 6_000,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GardenOfPapers/1.0 Atlas translation',
    },
  });
  const translated = response.data?.responseData?.translatedText;
  if (
    Number(response.data?.responseStatus) !== 200 ||
    typeof translated !== 'string' ||
    !translated.trim()
  ) {
    throw new Error(response.data?.responseDetails || 'MyMemory returned no translation.');
  }
  return decodeHtmlEntities(translated).trim();
}

async function mapWithConcurrency(values, concurrency, worker) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await worker(values[index]);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => consume(),
    ),
  );
  return output;
}

async function translateWithMyMemory(text) {
  const chunks = splitUtf8(text);
  if (!chunks.length) return '';
  const translated = await mapWithConcurrency(
    chunks,
    TRANSLATION_CONCURRENCY,
    translateSegmentToKorean,
  );
  return translated.join(' ');
}

module.exports = {
  MAX_SEGMENT_BYTES,
  decodeHtmlEntities,
  splitUtf8,
  translateWithMyMemory,
};
