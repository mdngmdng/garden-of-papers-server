const axios = require('axios');
const config = require('../config');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

/**
 * 문단 텍스트 + 레퍼런스 목록 → 논문 간 관계 분석
 */
async function analyzeRelations(paragraph, references) {
  const refList = references
    .map((r) => `- [${r.refId}] "${r.title}" by ${(r.authors || []).join(', ')}`)
    .join('\n');

  const prompt = `You are a scientific paper analyst. Analyze the following paragraph from a Related Work section and extract the relationships between the cited papers as described by the author.

## Paragraph
${paragraph}

## Referenced Papers
${refList}

## Instructions
1. Identify how the author describes relationships between the cited papers (e.g., extension, contrast, similar approach, builds upon, addresses limitation, etc.)
2. Also identify relationships between cited papers and the current paper (use "self" as the refId for the current paper)
3. Keep labels concise (under 15 words), in the same language as the paragraph
4. Return ONLY valid JSON, no markdown

## Output Format
{
  "relations": [
    { "from": "refId1", "to": "refId2", "label": "concise relationship description", "type": "extension|contrast|similar|builds_upon|addresses_limitation|comparison|application" }
  ]
}`;

  const res = await axios.post(
    `${GEMINI_URL}?key=${config.geminiApiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    },
  );

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  try {
    return JSON.parse(text);
  } catch {
    console.error('[Gemini] Failed to parse response:', text);
    return { relations: [] };
  }
}

/**
 * Layout용 관계 분석 — marker 텍스트([3], [7] 등)를 refId로 사용
 * 관계 type을 반드시 반환하도록 프롬프트 강화
 */
async function analyzeRelationsForLayout(paragraph, references) {
  const refList = references.map((r) => `- ${r.refId}`).join('\n');

  const prompt = `Analyze this academic paragraph and identify relationships between the cited references.

## Paragraph
${paragraph}

## References mentioned
${refList}

## Relationship types (use exactly these):
- similar: papers with similar approaches
- extension: one paper extends another
- builds_upon: one paper builds on another's work
- contrast: papers with contrasting approaches
- comparison: papers being compared
- addresses_limitation: one addresses another's limitation
- application: one applies another's method

## Output: ONLY valid JSON
{
  "relations": [
    { "from": "[3]", "to": "[7]", "label": "concise description", "type": "similar" }
  ]
}`;

  const res = await axios.post(
    `${GEMINI_URL}?key=${config.geminiApiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    },
  );

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  try {
    return JSON.parse(text);
  } catch {
    console.error('[Gemini] Failed to parse layout relations:', text);
    return { relations: [] };
  }
}

/**
 * 텍스트 → Gemini Embedding (768차원 벡터)
 */
const EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

async function getEmbedding(text) {
  // Gemini embedding은 최대 2048 토큰 → 앞부분만 사용
  const truncated = text.slice(0, 8000);
  const res = await axios.post(
    `${EMBED_URL}?key=${config.geminiApiKey}`,
    {
      content: { parts: [{ text: truncated }] },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    },
  );
  return res.data.embedding.values; // number[]
}

/**
 * 여러 텍스트 → 임베딩 배치 (rate limit 고려, 순차 호출)
 */
async function getEmbeddings(texts) {
  const embeddings = [];
  for (const text of texts) {
    const vec = await getEmbedding(text);
    embeddings.push(vec);
  }
  return embeddings;
}

/**
 * 클러스터별 논문 제목 → 그룹 라벨 생성
 * @param {Object} clusterTitles - { "0": ["title1", "title2"], "1": [...] }
 * @returns {Object} - { "0": "Citation Visualization", "1": "Literature Review Tools" }
 */
async function generateClusterLabels(clusterTitles) {
  const clusterList = Object.entries(clusterTitles)
    .map(([id, titles]) => `Cluster ${id}:\n${titles.map((t) => `  - ${t}`).join('\n')}`)
    .join('\n\n');

  const prompt = `You are a research paper analyst. Below are clusters of academic paper titles grouped by similarity. Give each cluster a concise label (2-5 words) that captures the common theme.

${clusterList}

Return ONLY valid JSON, no markdown:
{
  "0": "label for cluster 0",
  "1": "label for cluster 1",
  ...
}`;

  const res = await axios.post(
    `${GEMINI_URL}?key=${config.geminiApiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    },
  );

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  try {
    return JSON.parse(text);
  } catch {
    console.error('[Gemini] Failed to parse cluster labels:', text);
    return {};
  }
}

/**
 * 관련 연구 문단에서 특정 논문에 대한 서술과 관련된 문장을 해당 논문 본문에서 찾기
 * @param {string} paragraph - 관련 연구 문단 텍스트
 * @param {string} marker - 논문 마커 (e.g., "[22]")
 * @param {string[]} sentences - 해당 논문의 GROBID 추출 문장 목록 (번호가 매겨짐)
 * @returns {{ indices: number[] }} - 관련 문장의 인덱스 배열
 */
async function findRelevantSentences(paragraph, marker, paperTitle, sentences) {
  const CHUNK_SIZE = 150; // 한번에 보낼 최대 문장 수

  if (sentences.length <= CHUNK_SIZE) {
    return _findRelevantSentencesChunk(paragraph, marker, paperTitle, sentences, 0);
  }

  // 문장이 많으면 청크로 분할 처리
  console.log(`[Gemini] Splitting ${sentences.length} sentences into chunks of ${CHUNK_SIZE}...`);
  const allIndices = [];
  for (let start = 0; start < sentences.length; start += CHUNK_SIZE) {
    const chunk = sentences.slice(start, start + CHUNK_SIZE);
    const { indices } = await _findRelevantSentencesChunk(
      paragraph, marker, paperTitle, chunk, start,
    );
    allIndices.push(...indices);
  }
  return { indices: allIndices };
}

async function _findRelevantSentencesChunk(paragraph, marker, paperTitle, sentences, offset) {
  const numberedSentences = sentences
    .map((s, i) => `[${offset + i}] ${s}`)
    .join('\n');

  const prompt = `You are a scientific paper analyst. A Related Work section mentions paper ${marker} ("${paperTitle}"). Find sentences in that paper's body text that are relevant to what the Related Work paragraph says about it.

## Related Work paragraph (from another paper)
${paragraph}

## Sentences from paper ${marker} ("${paperTitle}")
${numberedSentences}

## Instructions
1. Identify what the Related Work paragraph says about paper ${marker}
2. Find sentences from the paper's body that support, describe, or are directly related to that description
3. Return ONLY the sentence indices (numbers in brackets)
4. Select 3-10 most relevant sentences
5. Return ONLY valid JSON, no markdown

## Output Format
{
  "indices": [0, 5, 12, 23]
}`;

  const res = await axios.post(
    `${GEMINI_URL}?key=${config.geminiApiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    },
  );

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const totalLen = offset + sentences.length;

  try {
    const result = JSON.parse(text);
    const validIndices = (result.indices || [])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < totalLen);
    return { indices: validIndices };
  } catch {
    console.error('[Gemini] Failed to parse highlight response:', text);
    return { indices: [] };
  }
}

module.exports = { analyzeRelations, analyzeRelationsForLayout, getEmbedding, getEmbeddings, generateClusterLabels, findRelevantSentences };
