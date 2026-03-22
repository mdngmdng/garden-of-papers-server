const axios = require('axios');
const FormData = require('form-data');
const config = require('../config');

/**
 * GROBID processFulltextDocument 호출
 * teiCoordinates=ref,biblStruct + segmentSentences=1
 * Unity GrobidClient.cs와 동일한 파라미터
 */
async function processFulltext(pdfBuffer) {
  const form = new FormData();
  form.append('input', pdfBuffer, { filename: 'paper.pdf', contentType: 'application/pdf' });
  form.append('teiCoordinates', 'ref');
  form.append('teiCoordinates', 'biblStruct');
  form.append('segmentSentences', '1');

  const res = await axios.post(
    `${config.grobidUrl}/api/processFulltextDocument`,
    form,
    {
      headers: { ...form.getHeaders(), Accept: 'application/xml' },
      timeout: 180000,
    },
  );

  return res.data; // TEI XML string
}

/**
 * TEI XML → CitationHit[] 파싱
 * Unity GrobidClient.ParseTeiToCitationHits()와 동일한 로직
 */
function parseTeiToCitationHits(teiXml) {
  const TEI_NS = 'http://www.tei-c.org/ns/1.0';
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';

  // 간단한 XML 파서 대신 regex 기반으로 처리 (xml2js 의존성 없이)
  // 실제 TEI XML 구조에 맞춤

  // (0) 페이지 크기 파싱: <surface n="1" lrx="612" lry="792">
  const pageSizes = {};
  const surfaceRegex = /<surface\s[^>]*n="(\d+)"[^>]*lrx="([\d.]+)"[^>]*lry="([\d.]+)"/g;
  let surfaceMatch;
  while ((surfaceMatch = surfaceRegex.exec(teiXml)) !== null) {
    const page = parseInt(surfaceMatch[1], 10);
    pageSizes[page] = {
      widthPt: parseFloat(surfaceMatch[2]),
      heightPt: parseFloat(surfaceMatch[3]),
    };
  }

  // (a) biblStruct 맵: xml:id -> { title, raw, doi, year, authors }
  const refInfo = {};
  const biblStructRegex = /<biblStruct[^>]*xml:id="([^"]*)"[^>]*>([\s\S]*?)<\/biblStruct>/g;
  let biblMatch;

  while ((biblMatch = biblStructRegex.exec(teiXml)) !== null) {
    const xmlId = biblMatch[1];
    const block = biblMatch[2];

    // Title: analytic level="a" 우선, 없으면 monogr title
    let title = '';
    const analyticBlock = block.match(/<analytic>([\s\S]*?)<\/analytic>/);
    if (analyticBlock) {
      const aTitleMatch = analyticBlock[1].match(/<title[^>]*level="a"[^>]*>([\s\S]*?)<\/title>/);
      if (aTitleMatch) title = aTitleMatch[1].trim();
    }
    if (!title) {
      const monogrBlock = block.match(/<monogr>([\s\S]*?)<\/monogr>/);
      if (monogrBlock) {
        const mTitleMatch = monogrBlock[1].match(/<title[^>]*>([\s\S]*?)<\/title>/);
        if (mTitleMatch) title = mTitleMatch[1].trim();
      }
    }

    // Raw: note[@type='raw_reference'] 우선
    let raw = '';
    const rawNoteMatch = block.match(/<note\s+type="raw_reference"[^>]*>([\s\S]*?)<\/note>/);
    if (rawNoteMatch) {
      raw = rawNoteMatch[1].trim();
    } else {
      raw = composeBiblStructAsString(block);
    }

    // Authors
    const authors = parseAuthors(block);

    // DOI
    const doiMatch = block.match(/<idno\s+type="DOI"[^>]*>([\s\S]*?)<\/idno>/i);
    const doi = doiMatch ? doiMatch[1].trim() : null;

    // Year
    const dateMatch = block.match(/<date[^>]*when="([^"]*?)"/);
    const year = dateMatch ? dateMatch[1] : null;

    // Journal
    const journalMatch = block.match(/<title[^>]*level="j"[^>]*>([\s\S]*?)<\/title>/);
    const journal = journalMatch ? journalMatch[1].trim() : null;

    refInfo[xmlId] = { title, raw: normalizeWs(raw), authors, doi, year, journal };
  }

  // (b) 본문 인용: <ref type="bibr" coords="..." target="#b0">text</ref>
  //     속성 순서가 일정하지 않으므로 유연하게 파싱
  const citationHits = [];
  const refRegex = /<ref\s+type="bibr"([^>]*)>([\s\S]*?)<\/ref>/g;
  let refMatch;

  while ((refMatch = refRegex.exec(teiXml)) !== null) {
    const attrs = refMatch[1];
    const markerText = (refMatch[2] || '').replace(/<[^>]*>/g, '').trim();

    // 속성에서 target과 coords를 개별 추출
    const targetMatch = attrs.match(/target="([^"]*)"/);
    const coordsMatch = attrs.match(/coords="([^"]*)"/);
    const targetRaw = targetMatch ? targetMatch[1] : '';
    const coordsStr = coordsMatch ? coordsMatch[1] : '';

    // target은 여러 개일 수 있음 → 첫 번째 사용
    const refId = targetRaw
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.replace('#', ''))
      .find(Boolean) || '';

    const info = refInfo[refId] || {};

    const boxes = parseCoordsAttr(coordsStr);

    citationHits.push({
      markerText,
      refId,
      refTitle: info.title || '',
      refRaw: info.raw || '',
      refAuthors: info.authors || [],
      refDoi: info.doi || null,
      refYear: info.year || null,
      refJournal: info.journal || null,
      boxes,
    });
  }

  return { citationHits, pageSizes, refInfo };
}

// ---- biblStruct → 문자열 조합 (fallback, Unity ComposeBiblStructAsString과 동일) ----
function composeBiblStructAsString(block) {
  const authors = parseAuthors(block);
  const authorsStr = authors.join(', ');

  // Title
  let title = '';
  const analyticBlock = block.match(/<analytic>([\s\S]*?)<\/analytic>/);
  if (analyticBlock) {
    const m = analyticBlock[1].match(/<title[^>]*level="a"[^>]*>([\s\S]*?)<\/title>/);
    if (m) title = m[1].trim();
  }
  if (!title) {
    const monogrBlock = block.match(/<monogr>([\s\S]*?)<\/monogr>/);
    if (monogrBlock) {
      const m = monogrBlock[1].match(/<title[^>]*>([\s\S]*?)<\/title>/);
      if (m) title = m[1].trim();
    }
  }

  // Container title (journal)
  const journalMatch = block.match(/<title[^>]*level="j"[^>]*>([\s\S]*?)<\/title>/);
  const containerTitle = journalMatch ? journalMatch[1].trim() : '';

  // Year
  const dateMatch = block.match(/<date[^>]*when="([^"]*?)"/);
  const year = dateMatch ? dateMatch[1] : (block.match(/<date[^>]*>([\s\S]*?)<\/date>/)?.[1]?.trim() || '');

  // Volume, Issue, Pages
  const vol = getBiblScope(block, 'volume');
  const iss = getBiblScope(block, 'issue');
  const pages = getPages(block);

  // DOI
  const doiMatch = block.match(/<idno\s+type="DOI"[^>]*>([\s\S]*?)<\/idno>/i);
  const doi = doiMatch ? doiMatch[1].trim() : '';

  let result = '';
  if (authorsStr) result += `${authorsStr}. `;
  if (year) result += `(${year}). `;
  if (title) result += `${title}. `;
  if (containerTitle) result += containerTitle;

  if (vol || iss) {
    result += ', ';
    if (vol) result += vol;
    if (iss) result += `(${iss})`;
  }
  if (pages) result += `, ${pages}`;
  result += '.';
  if (doi) result += ` DOI: ${doi}`;

  return result;
}

function parseAuthors(block) {
  const authors = [];
  const authorRegex = /<author>([\s\S]*?)<\/author>/g;
  let m;
  while ((m = authorRegex.exec(block)) !== null) {
    const authorBlock = m[1];
    const persNameMatch = authorBlock.match(/<persName[^>]*>([\s\S]*?)<\/persName>/);
    if (persNameMatch) {
      const pn = persNameMatch[1];
      const forenames = [];
      const fnRegex = /<forename[^>]*>([\s\S]*?)<\/forename>/g;
      let fn;
      while ((fn = fnRegex.exec(pn)) !== null) {
        if (fn[1].trim()) forenames.push(fn[1].trim());
      }
      const surnameMatch = pn.match(/<surname>([\s\S]*?)<\/surname>/);
      const surname = surnameMatch ? surnameMatch[1].trim() : '';

      const name = [...forenames, surname].filter(Boolean).join(' ');
      if (name) authors.push(name);
    }
  }
  return authors;
}

function getBiblScope(block, unit) {
  const m = block.match(new RegExp(`<biblScope\\s+unit="${unit}"[^>]*>([\\s\\S]*?)<\\/biblScope>`));
  return m ? m[1].trim() : '';
}

function getPages(block) {
  // from/to attributes
  const fromMatch = block.match(/<biblScope\s+unit="page"[^>]*from="(\d+)"/);
  const toMatch = block.match(/<biblScope\s+unit="page"[^>]*to="(\d+)"/);
  if (fromMatch && toMatch) return `${fromMatch[1]}-${toMatch[1]}`;
  if (fromMatch) return fromMatch[1];
  if (toMatch) return toMatch[1];
  // pp unit
  const ppMatch = block.match(/<biblScope\s+unit="pp"[^>]*>([\s\S]*?)<\/biblScope>/);
  return ppMatch ? ppMatch[1].trim() : '';
}

// ---- coords 파싱 (Unity ParseCoordsAttr와 동일) ----
function parseCoordsAttr(coords) {
  if (!coords) return [];
  const boxes = [];

  for (const chunk of coords.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    if (trimmed.includes(':')) {
      // "page:x,y,w,h"
      const [pageStr, rest] = trimmed.split(':');
      const page = parseInt(pageStr, 10);
      const nums = rest.split(',').map(Number);
      if (nums.length === 4 && !nums.some(isNaN)) {
        boxes.push({ page, x: nums[0], y: nums[1], w: nums[2], h: nums[3] });
      }
    } else {
      // "page,x,y,w,h"
      const parts = trimmed.split(',').map(Number);
      if (parts.length === 5 && !parts.some(isNaN)) {
        boxes.push({ page: parts[0], x: parts[1], y: parts[2], w: parts[3], h: parts[4] });
      }
    }
  }
  return boxes;
}

function normalizeWs(s) {
  if (!s) return s;
  return s.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 메인 API: PDF → GROBID → 파싱된 CitationHit + 페이지 정보
 */
async function extractCitations(pdfBuffer) {
  const teiXml = await processFulltext(pdfBuffer);
  return parseTeiToCitationHits(teiXml);
}

module.exports = { processFulltext, parseTeiToCitationHits, extractCitations };
