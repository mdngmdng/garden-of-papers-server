const axios = require('axios');
const config = require('../config');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

/**
 * 최대 maxLen자 이내에서 마지막 완전한 문장까지만 남기기
 * 한국어 문장 종결 패턴: ~다. ~요. ~다, 또는 마침표/물음표/느낌표
 */
function truncateToSentence(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  // 마지막 문장 종결 부호 위치 찾기
  const lastDot = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('.'),
    cut.lastIndexOf('다.'),
    cut.lastIndexOf('요.'),
    cut.lastIndexOf('니다.'),
  );
  if (lastDot > 0) {
    // '.' 다음 문자까지 포함
    const end = cut.indexOf('.', lastDot) + 1;
    return cut.slice(0, end).trim();
  }
  // 종결 부호를 못 찾으면 그대로 반환 (프롬프트가 지켰을 것)
  return cut.trim();
}

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
 * paragraph 텍스트가 주어지면 인용 문맥 기반으로 라벨 생성
 *
 * @param {Object} clusterTitles - { "0": ["title1", "title2"], "1": [...] }
 * @param {string} [paragraph] - Related Work 원문 텍스트
 * @param {Object} [clusterMarkers] - { "0": ["[1]", "[3]"], "1": ["[2]"] }
 * @returns {Object} - { "0": "Citation Visualization", "1": "Literature Review Tools" }
 */
async function generateClusterLabels(clusterTitles, paragraph, clusterMarkers) {
  let clusterList;

  if (paragraph && clusterMarkers) {
    // paragraph에서 각 클러스터의 마커가 인용되는 문장들을 추출
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    clusterList = Object.entries(clusterTitles)
      .map(([id, titles]) => {
        const markers = clusterMarkers[id] || [];
        const markerPattern = new RegExp(
          markers.map((m) => m.replace(/[[\]]/g, '\\$&')).join('|'),
        );
        const citingSentences = sentences
          .filter((s) => markerPattern.test(s))
          .slice(0, 5)
          .join(' ');
        return `Cluster ${id}:\n  Papers: ${titles.join('; ')}\n  Context from Related Work: "${citingSentences}"`;
      })
      .join('\n\n');
  } else {
    clusterList = Object.entries(clusterTitles)
      .map(([id, titles]) => `Cluster ${id}:\n${titles.map((t) => `  - ${t}`).join('\n')}`)
      .join('\n\n');
  }

  const prompt = `You are a research paper analyst. Below are clusters of papers from a Related Work section, with the original text context showing how the author described them.

Give each cluster a concise label (2-5 words) that summarizes the research theme as described by the author in the Related Work text.

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

/**
 * 논문 본문 문장 + Related Work 문맥 → 논문 요약 생성
 * @param {string} paragraph - Related Work 문단
 * @param {string} marker - 논문 마커 (e.g., "[22]")
 * @param {string} paperTitle - 논문 제목
 * @param {string[]} sentences - 논문 본문 문장 목록
 * @returns {{ summary: string }}
 */
async function summarizePaper(paragraph, marker, paperTitle, sentences) {
  const bodyText = sentences.slice(0, 200).join(' ');

  const prompt = `You are a scientific paper analyst. Summarize the following paper based on its body text and how it is described in the Related Work paragraph.

## Related Work paragraph (from another paper, mentioning this paper as ${marker})
${paragraph}

## Paper: ${marker} "${paperTitle}"
## Body text (excerpt)
${bodyText}

## Instructions
이 논문에 대해 "배경", "기여", "한계"를 한글로 각각 요약해 주세요.
공손한 존댓말(~합니다, ~됩니다)로 통일해 주세요.
각 항목은 한글 공백 포함 최대 188자 이내로 작성해 주세요.
반드시 완전한 문장(~합니다, ~됩니다, ~있습니다 등)으로 끝나야 합니다. 문장이 중간에 잘리면 안 됩니다.
"[배경]", "[기여]", "[한계]" 태그 없이 내용만 작성해 주세요.
Return ONLY valid JSON, no markdown.

## Output Format
{ "background": "배경 내용 (최대 188자, 완전한 문장)", "contribution": "기여 내용 (최대 188자, 완전한 문장)", "limitation": "한계 내용 (최대 188자, 완전한 문장)" }`;

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
    const result = JSON.parse(text);
    return {
      background: truncateToSentence(result.background || '', 188),
      contribution: truncateToSentence(result.contribution || '', 188),
      limitation: truncateToSentence(result.limitation || '', 188),
    };
  } catch {
    console.error('[Gemini] Failed to parse summary response:', text);
    return { background: '', contribution: '', limitation: '' };
  }
}

/**
 * 여러 논문의 요약/링크 정보 → 연구 변천사 스토리텔링 생성
 * @param {Object[]} papers - [{ title, year, summary }]
 * @param {Object[]} links - [{ from, to, markerText, citance }]
 * @returns {{ story: string }}
 */
async function storytelling(papers, links) {
  const paperList = papers
    .map((p, i) => `${i + 1}. "${p.title}" (${p.year || '연도 미상'})\n   요약: ${p.summary || '없음'}`)
    .join('\n');

  const linkList = links.length > 0
    ? links.map((l) => `- "${l.from}" → "${l.to}" [${l.markerText || ''}]: ${l.citance || ''}`).join('\n')
    : '(링크 정보 없음)';

  const prompt = `You are a scientific paper analyst. Based on the following papers and their citation relationships, write a concise research evolution narrative in Korean.

## Papers
${paperList}

## Citation relationships (from → to, with citation marker and citance sentence)
${linkList}

## Instructions
1. 인용 관계 순서에 따라 연구의 변천사와 논문 간의 관계를 스토리텔링해 주세요.
2. 정확히 6문장으로 작성해 주세요.
3. 공손한 존댓말(~합니다, ~됩니다)로 통일해 주세요.
4. 각 논문의 제목은 큰따옴표로 감싸서 언급해 주세요.
5. 시간순(연도순)으로 연구가 어떻게 발전했는지 흐름을 설명해 주세요.
6. Return ONLY valid JSON, no markdown.

## Output Format
{ "story": "6문장의 연구 변천사 스토리텔링 텍스트" }`;

  const res = await axios.post(
    `${GEMINI_URL}?key=${config.geminiApiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    },
  );

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  try {
    const result = JSON.parse(text);
    return { story: result.story || '' };
  } catch {
    console.error('[Gemini] Failed to parse storytelling response:', text);
    return { story: '' };
  }
}

/**
 * 각 논문의 배치 이유를 설명하는 텍스트 생성
 * @param {string} paragraph - Related Work 문단
 * @param {Object[]} positions - [{ marker, title, year, cluster, clusterLabel }]
 * @param {Object[]} relations - [{ from, to, label, type }]
 * @returns {Object} - { "[3]": "이 논문은...", "[7]": "이 논문은..." }
 */
async function generatePlacementReasons(paragraph, positions, relations) {
  const paperList = positions
    .map((p) => `- ${p.marker} "${p.title}" (${p.year || '연도 미상'}) → 클러스터: "${p.clusterLabel || 'N/A'}"`)
    .join('\n');

  const relList = relations.length > 0
    ? relations.map((r) => `- ${r.from} → ${r.to}: ${r.label} (${r.type})`).join('\n')
    : '(관계 없음)';

  const prompt = `You are a scientific paper analyst. Based on the Related Work paragraph and the layout clustering results, explain why each paper was placed in its position.

## Related Work paragraph
${paragraph}

## Papers and their cluster assignments
${paperList}

## Relations between papers
${relList}

## Instructions
1. 각 논문에 대해, 왜 해당 클러스터에 배치되었는지, 다른 논문과 어떤 관계가 있는지 한글로 설명해 주세요.
2. 공손한 존댓말(~합니다, ~됩니다)로 통일해 주세요.
3. 각 설명은 한글 공백 포함 최대 300자 이내, 반드시 완전한 문장으로 끝나야 합니다.
4. Return ONLY valid JSON, no markdown.

## Output Format
{ "${positions[0]?.marker || '[1]'}": "배치 이유 설명 (최대 300자)", ... }`;

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
      timeout: 60000,
    },
  );

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  try {
    const result = JSON.parse(text);
    // truncate each reason to complete sentence within 300 chars
    const truncated = {};
    for (const [key, val] of Object.entries(result)) {
      truncated[key] = truncateToSentence(val || '', 300);
    }
    return truncated;
  } catch {
    console.error('[Gemini] Failed to parse placement reasons:', text);
    return {};
  }
}

/**
 * 영어 텍스트 → 한글 번역
 * @param {string} englishText
 * @returns {string} translated text
 */
async function translateToKorean(englishText) {
  if (!englishText) return '';

  const prompt = `Translate the following English text to Korean. Keep the translated text length similar to the original text. Output only the translated text without any other words or formatting: "${englishText}"`;

  const res = await axios.post(
    `${GEMINI_URL}?key=${config.geminiApiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    },
  );

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim();
}

module.exports = { analyzeRelations, analyzeRelationsForLayout, getEmbedding, getEmbeddings, generateClusterLabels, findRelevantSentences, summarizePaper, storytelling, generatePlacementReasons, translateToKorean };
