const { findCitationEvidence } = require('./citationEvidence');
const MAX_SOURCE_CONTEXT = 30000;
const MAX_CITATION_CONTEXT = 20000;
const MAX_PASSAGE_CHARS = 1600;
const PASSAGE_OVERLAP_SENTENCES = 2;

class CitationGraphAnalysisError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'CitationGraphAnalysisError';
    this.status = status;
  }
}

function cleanText(value, maximum) {
  return typeof value === 'string'
    ? value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function paperMetadata(paper) {
  return [
    `논문 ID: ${paper.id}`,
    `제목: ${paper.title || '제목 없음'}`,
    `저자: ${paper.authors.join(', ') || '미상'}`,
    `연도: ${paper.year || '미상'}`,
    `학술지/학회: ${paper.venue || '미상'}`,
    paper.abstract ? `초록: ${paper.abstract}` : '',
  ].filter(Boolean).join('\n');
}

function normalizePdfText(value) {
  return String(value || '')
    .replace(/\u00ad/g, '')
    .replace(/([\p{L}])-\s*\n\s*([\p{Ll}])/gu, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLongSentence(value, maximum = MAX_PASSAGE_CHARS) {
  const text = normalizePdfText(value);
  if (text.length <= maximum) return text ? [text] : [];
  const pieces = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maximum);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf('. ', end),
        text.lastIndexOf('; ', end),
        text.lastIndexOf(', ', end),
        text.lastIndexOf(' ', end),
      );
      if (boundary > offset + maximum * 0.55) end = boundary + 1;
    }
    const piece = text.slice(offset, end).trim();
    if (piece) pieces.push(piece);
    offset = Math.max(end, offset + 1);
  }
  return pieces;
}

function searchablePageText(value) {
  const text = String(value || '');
  const bibliography = /(?:^|\n)\s*(?:references|bibliography)\s*(?:\n|$)/i.exec(text);
  return {
    text: bibliography ? text.slice(0, bibliography.index) : text,
    bibliographyStarted: Boolean(bibliography),
  };
}

function sentenceRecordsFromPages(pages) {
  const records = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  let bibliographyStarted = false;
  for (const page of pages || []) {
    if (bibliographyStarted) break;
    const searchable = searchablePageText(page?.text);
    bibliographyStarted = searchable.bibliographyStarted;
    const pageText = normalizePdfText(searchable.text);
    if (!pageText) continue;
    const segments = [...segmenter.segment(pageText)].map((entry) => entry.segment);
    let pageSentenceIndex = 0;
    for (const segment of segments) {
      for (const sentence of splitLongSentence(segment)) {
        if (
          sentence.length < 2
          || !/[\p{L}]{2}/u.test(sentence)
          || /^(?:permission to make|copyright |https?:\/\/|doi\s*:)/i.test(sentence)
        ) {
          continue;
        }
        const pageNumber = Math.max(1, Number(page?.pageIndex) + 1 || 1);
        records.push({
          id: `p${pageNumber}-s${pageSentenceIndex + 1}`,
          pageNumber,
          pageSentenceIndex,
          globalIndex: records.length,
          text: sentence,
        });
        pageSentenceIndex += 1;
      }
    }
  }
  return records;
}

function passageChunksFromSentences(sentences) {
  const chunks = [];
  const byPage = new Map();
  for (const sentence of sentences || []) {
    const pageSentences = byPage.get(sentence.pageNumber) || [];
    pageSentences.push(sentence);
    byPage.set(sentence.pageNumber, pageSentences);
  }
  for (const [pageNumber, pageSentences] of byPage) {
    let start = 0;
    let pageChunkIndex = 0;
    while (start < pageSentences.length) {
      let end = start;
      let length = 0;
      while (end < pageSentences.length) {
        const addition = pageSentences[end].text.length + (end > start ? 1 : 0);
        if (end > start && length + addition > MAX_PASSAGE_CHARS) break;
        length += addition;
        end += 1;
      }
      if (end === start) end += 1;
      const selected = pageSentences.slice(start, end);
      chunks.push({
        id: `p${pageNumber}-c${pageChunkIndex + 1}`,
        pageNumber,
        pageChunkIndex,
        sentences: selected,
        text: selected.map((sentence) => sentence.text).join(' '),
      });
      if (end >= pageSentences.length) break;
      start = Math.max(start + 1, end - PASSAGE_OVERLAP_SENTENCES);
      pageChunkIndex += 1;
    }
  }
  return chunks;
}

function normalizeInput(value) {
  const paper = value?.paper && typeof value.paper === 'object' ? value.paper : {};
  const pages = Array.isArray(value?.pages)
    ? value.pages.flatMap((page) => {
        const text = typeof page?.text === 'string'
          ? page.text.replace(/\u0000/g, '').slice(0, 1_000_000)
          : '';
        if (!text.trim()) return [];
        return [{ pageIndex: Math.max(0, Math.floor(Number(page.pageIndex) || 0)), text }];
      })
    : [];
  const input = {
    sourceContext: cleanText(value?.sourceContext, MAX_SOURCE_CONTEXT),
    citationContext: cleanText(value?.citationContext, MAX_CITATION_CONTEXT),
    markerText: cleanText(value?.markerText, 120),
    pages,
    paper: {
      id: cleanText(paper.id, 160),
      title: cleanText(paper.title, 500),
      authors: Array.isArray(paper.authors)
        ? paper.authors.slice(0, 30).map((author) => cleanText(author, 180)).filter(Boolean)
        : [],
      year: cleanText(paper.year, 20),
      venue: cleanText(paper.venue, 300),
      abstract: cleanText(paper.abstract, 12_000),
    },
  };
  if (
    !input.paper.id
    || !input.pages.length
    || !(input.sourceContext || input.citationContext)
  ) {
    throw new CitationGraphAnalysisError(
      '인용 문맥과 수집된 선행연구 PDF 텍스트가 필요합니다.',
      400,
    );
  }
  input.citationContext ||= input.sourceContext;
  input.sourceContext ||= input.citationContext;
  return input;
}


async function analyzeCitationGraph(value, options = {}) {
  const input = normalizeInput(value);
  try { return await findCitationEvidence(input, sentenceRecordsFromPages(input.pages), options); }
  catch (error) { throw new CitationGraphAnalysisError(error.message, error.status || 502); }
}
module.exports = { CitationGraphAnalysisError, analyzeCitationGraph, normalizeInput, passageChunksFromSentences, sentenceRecordsFromPages };
