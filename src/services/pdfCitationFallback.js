// Some publisher PDFs encode the brackets and every number as separate text
// runs. PDF.js reconstructs those markers as "[ 21 ]" or "[ 5 , 14 ]".
// Accept whitespace (including line breaks) and full-width brackets so the
// fallback is not tied to one publisher's text encoding.
const numericMarkerPattern = /(?:\[|［)\s*(\d+(?:\s*[-–—,;]\s*\d+)*)\s*(?:\]|］)/g;
const authorYearPattern =
  /\(([^()]{1,300}?\b(?:19|20)\d{2}[a-z]?[^()]{0,120})\)/gi;
const narrativeAuthorYearPattern =
  /\b([A-Z][\p{L}'’.-]+(?:\s+(?:et\s+al\.|and\s+[A-Z][\p{L}'’.-]+))?)\s*\(\s*((?:19|20)\d{2}[a-z]?)\s*\)/gu;

function bibliographyHeadingStart(text) {
  const heading = /(?:^|\n)[ \t]*(?:(?:(?:\d+(?:\.\d+)*)|(?:[ivxlcdm]+))\.?[ \t]+)?(?:references|bibliography)[ \t]*(?=\n|(?:\[|［)\s*\d|$)/iu.exec(
    String(text || ''),
  );
  if (!heading) return -1;
  return (heading.index || 0) + (heading[0].startsWith('\n') ? 1 : 0);
}

function findBibliographyBoundary(pages) {
  const trailingPages = (pages || []).slice(Math.max(0, pages.length - 12));
  for (const page of trailingPages) {
    const startChar = bibliographyHeadingStart(page.text);
    if (startChar >= 0) {
      return { pageIndex: page.pageIndex, startChar, inferred: false };
    }
  }

  const joined = trailingPages.map((page) => page.text).join('\n');
  const inferredStart = inferBibliographyStart(joined);
  if (inferredStart < 0) return null;
  let cursor = 0;
  for (const page of trailingPages) {
    const end = cursor + page.text.length;
    if (inferredStart <= end) {
      return {
        pageIndex: page.pageIndex,
        startChar: Math.max(0, inferredStart - cursor),
        inferred: true,
      };
    }
    cursor = end + 1;
  }
  return null;
}

function expandNumericCitation(value) {
  const ids = new Set();
  for (const part of String(value || '').split(/[,;]/)) {
    const range = part.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from <= 25) {
        for (let number = from; number <= to; number += 1) {
          ids.add(String(number));
        }
      }
      continue;
    }
    const number = part.match(/\d+/)?.[0];
    if (number) ids.add(String(Number(number)));
  }
  return [...ids];
}

function parseReferenceLine(id, raw) {
  const doi = raw.match(/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+\b/i)?.[0];
  const year = [...raw.matchAll(/\b(?:19|20)\d{2}[a-z]?\b/gi)].at(-1)?.[0];
  const protectedInitials = raw.replace(
    /\b([A-Z])\.(?=\s+[A-Z])/g,
    '$1<gop-initial>',
  );
  const sentenceParts = protectedInitials
    .split(/\.\s+/)
    .map((part) => part.replaceAll('<gop-initial>', '.').trim());
  const title = raw.match(/[“"]([^”"]{8,300})[”"]/)?.[1]
    || sentenceParts.find(
      (part, index) => index > 0
        && part.length > 12
        && !/^(?:vol|pp|doi|https?:|(?:19|20)\d{2}[a-z]?)\b/i.test(part),
    )
    || '';
  const authorChunk = sentenceParts[0] || '';
  const authors = authorChunk
    .split(/\s+(?:and|&)\s+|,\s*(?=(?:[A-ZÀ-Þ][\p{L}'’.-]+|[A-Z]\.)\s)/u)
    .map((author) => author.trim())
    .filter((author) => author.length > 2 && !/^et\s+al\.?$/i.test(author))
    .slice(0, 12);
  return {
    refId: id,
    id,
    title: title.replace(/\s+/g, ' ').trim(),
    authors,
    year,
    doi,
    raw,
    scholarMatchVerified: false,
  };
}

function extractNumberedReferences(pages) {
  const joined = pages
    .slice(Math.max(0, pages.length - 12))
    .map((page) => page.text)
    .join('\n');
  const heading = /(?:^|\n)\s*(?:references|bibliography)\s*(?=\n|\[\d+\]|$)/i.exec(
    joined,
  );
  const inferredStart = heading ? -1 : inferBibliographyStart(joined);
  if (!heading && inferredStart < 0) return [];
  const bibliography = heading
    ? joined.slice((heading.index || 0) + heading[0].length)
    : joined.slice(inferredStart);
  const bracketMarkers = [
    ...bibliography.matchAll(
      /(?:^|\n|[ \t])(?:\[|［)\s*(\d{1,4})\s*(?:\]|］)\s*/g,
    ),
  ];
  const plainCandidates = [
    ...bibliography.matchAll(/(?:^|\n)[ \t]*(\d{1,4})[.)][ \t]+/g),
  ];
  const plainMarkers = [];
  let expectedPlainId = 1;
  for (const candidate of plainCandidates) {
    const candidateId = Number(candidate[1]);
    if (candidateId !== expectedPlainId) continue;
    plainMarkers.push(candidate);
    expectedPlainId += 1;
  }
  const markers = bracketMarkers.length >= (heading ? 1 : 3)
    ? bracketMarkers
    : plainMarkers.length >= 3 ? plainMarkers : [];
  const references = new Map();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const id = String(Number(marker[1]));
    const start = (marker.index || 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? bibliography.length;
    const raw = bibliography
      .slice(start, end)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1600);
    if (raw.length < 4) continue;
    const parsed = parseReferenceLine(id, raw);
    const previous = references.get(id);
    if (!previous || parsed.raw.length > previous.raw.length) {
      references.set(id, parsed);
    }
  }
  return [...references.values()];
}

function normalizeReferenceText(value) {
  return String(value || '')
    .replace(/([A-Za-zÀ-ž])[-‐]\s+([a-zà-ž])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function referenceLooksComplete(raw) {
  const normalized = normalizeReferenceText(raw);
  return /\b(?:19|20)\d{2}[a-z]?\b/i.test(normalized)
    && normalized.split(/\.\s+/).length >= 2;
}

function looksLikeReferenceStart(value) {
  const text = String(value || '').trim();
  return /^[A-ZÀ-Þ][\p{L}'’.-]+(?:\s|,)/u.test(text)
    && !/^(?:Appendix|Acknowledg(?:e)?ments?|References|Bibliography)\b/i.test(text);
}

function pageColumnBases(page) {
  const width = Number(page.widthPt) || 612;
  const height = Number(page.heightPt) || 792;
  const candidates = (page.lines || []).filter(
    (line) => line.text?.trim()
      && Number.isFinite(line.x)
      && Number.isFinite(line.y)
      && line.y < height * 0.92
      && !/^\d+$/.test(line.text.trim()),
  );
  const left = candidates.filter((line) => line.x < width / 2 - 5);
  const right = candidates.filter((line) => line.x >= width / 2 - 5);
  return {
    width,
    left: left.length ? Math.min(...left.map((line) => line.x)) : null,
    right: right.length ? Math.min(...right.map((line) => line.x)) : null,
  };
}

function extractAuthorYearReferences(pages) {
  const headingPageIndex = pages.findIndex((page) =>
    (page.lines || []).some((line) => /^\s*(?:references|bibliography)\s*$/i.test(line.text)),
  );
  if (headingPageIndex < 0) return [];

  const entries = [];
  let buffer = '';
  let started = false;
  let stopped = false;
  const flush = () => {
    const raw = normalizeReferenceText(buffer).slice(0, 4000);
    buffer = '';
    if (raw.length >= 12 && referenceLooksComplete(raw)) entries.push(raw);
  };

  for (let pageIndex = headingPageIndex; pageIndex < pages.length && !stopped; pageIndex += 1) {
    const page = pages[pageIndex];
    const bases = pageColumnBases(page);
    for (const line of page.lines || []) {
      const text = String(line.text || '').trim();
      if (!started) {
        if (/^(?:references|bibliography)$/i.test(text)) started = true;
        continue;
      }
      if (/^(?:appendix|appendices)$/i.test(text)) {
        flush();
        stopped = true;
        break;
      }
      if (!text || /^\d+$/.test(text)) continue;
      if (
        line.y > (Number(page.heightPt) || 792) * 0.92
        && /\bTEDDY\b/i.test(text)
      ) {
        continue;
      }
      const isRight = line.x >= bases.width / 2 - 5;
      const base = isRight ? bases.right : bases.left;
      const atColumnStart = base !== null && line.x <= base + 3;
      if (
        buffer
        && atColumnStart
        && referenceLooksComplete(buffer)
        && looksLikeReferenceStart(text)
      ) {
        flush();
      }
      buffer += `${buffer ? ' ' : ''}${text}`;
    }
  }
  flush();

  const references = [];
  const usedIds = new Set();
  for (const raw of entries) {
    const parsed = parseReferenceLine('', raw);
    if (!parsed.title || !parsed.authors.length || !parsed.year) continue;
    const surname = normalizeReferenceText(parsed.authors[0])
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-')
      .at(-1) || 'reference';
    const baseId = `ay-${surname}-${String(parsed.year).toLowerCase()}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    references.push({ ...parsed, id, refId: id });
  }
  return references;
}

function inferBibliographyStart(text) {
  const candidates = [
    ...text.matchAll(
      /(?:^|\n|[ \t])(?:\[|［)\s*(\d{1,4})\s*(?:\]|］)\s*/g,
    ),
  ];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (Number(candidates[index][1]) !== 1) continue;
    const followingIds = new Set(
      candidates.slice(index).map((candidate) => Number(candidate[1])),
    );
    let contiguous = 1;
    while (followingIds.has(contiguous + 1)) contiguous += 1;
    if (contiguous >= 3) return candidates[index].index || 0;
  }
  return -1;
}

function pageTextFromItems(items) {
  return items
    .filter((item) => typeof item?.str === 'string')
    .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
    .join('')
    .replace(/[ \t]+\n/g, '\n');
}

function pageLinesFromItems(items) {
  const lines = [];
  let text = '';
  let x = null;
  let y = null;
  const flush = () => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized && x !== null && y !== null) lines.push({ text: normalized, x, y });
    text = '';
    x = null;
    y = null;
  };
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    if (x === null && item.str.trim()) {
      x = Number(item.transform?.[4]) || 0;
      y = Number(item.transform?.[5]) || 0;
    }
    text += `${text && item.str ? ' ' : ''}${item.str}`;
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

function citationContext(text, start, length) {
  const before = text.lastIndexOf('.', Math.max(0, start - 1));
  const after = text.indexOf('.', start + length);
  return text
    .slice(before >= 0 ? before + 1 : Math.max(0, start - 180), after >= 0 ? after + 1 : start + length + 180)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function normalizedAuthorToken(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function referenceFirstAuthorSurname(reference) {
  const author = reference?.authors?.[0];
  const lead = author || String(reference?.raw || '').split(/[,.;]/, 1)[0];
  return normalizedAuthorToken(lead).split(/\s+/).at(-1) || '';
}

function authorYearReferenceIds(markerText, references) {
  const marker = normalizedAuthorToken(markerText);
  const candidates = (references || []).flatMap((reference) => {
    const year = String(reference.year || '').match(/\b(?:19|20)\d{2}[a-z]?\b/i)?.[0];
    const surname = referenceFirstAuthorSurname(reference);
    return year
      && surname
      && marker.includes(normalizedAuthorToken(year))
      && marker.includes(surname)
      ? [{
        id: reference.refId || reference.id,
        group: `${surname}:${String(year).toLowerCase()}`,
        authorMatches: new Set((reference.authors || [])
          .map((author) => normalizedAuthorToken(author).split(/\s+/).at(-1))
          .filter((author) => author && marker.includes(author))).size,
      }]
      : [];
  });
  return candidates
    .filter((candidate) => {
      const bestAuthorMatch = Math.max(
        ...candidates
          .filter((other) => other.group === candidate.group)
          .map((other) => other.authorMatches),
      );
      return bestAuthorMatch <= 1 || candidate.authorMatches === bestAuthorMatch;
    })
    .map((candidate) => candidate.id);
}

function detectCitationHits(pageIndex, text, references = []) {
  const bibliographyStart = bibliographyHeadingStart(text);
  const bodyText = bibliographyStart >= 0
    ? text.slice(0, bibliographyStart)
    : text;
  const hits = [];
  numericMarkerPattern.lastIndex = 0;
  for (const match of bodyText.matchAll(numericMarkerPattern)) {
    const refIds = expandNumericCitation(match[1]);
    if (!refIds.length) continue;
    const startChar = match.index || 0;
    hits.push({
      id: `pdf-${pageIndex}-${startChar}-${refIds.join('-')}`,
      markerText: match[0],
      refIds,
      pageIndex,
      boxes: [],
      context: citationContext(bodyText, startChar, match[0].length),
      startChar,
      length: match[0].length,
      source: 'pdf-text',
    });
  }
  const addAuthorYearHits = (pattern) => {
    pattern.lastIndex = 0;
    for (const match of bodyText.matchAll(pattern)) {
      const refIds = [...new Set(authorYearReferenceIds(match[0], references))];
      if (!refIds.length) continue;
      const startChar = match.index || 0;
      hits.push({
        id: `pdf-${pageIndex}-${startChar}-${refIds.join('-')}`,
        markerText: match[0],
        refIds,
        pageIndex,
        boxes: [],
        context: citationContext(bodyText, startChar, match[0].length),
        startChar,
        length: match[0].length,
        source: 'pdf-text',
      });
    }
  };
  addAuthorYearHits(authorYearPattern);
  addAuthorYearHits(narrativeAuthorYearPattern);
  return hits;
}

async function extractPdfTextPages(pdfBuffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = pageTextFromItems(content.items);
      pages.push({
        pageIndex: pageNumber - 1,
        text,
        lines: pageLinesFromItems(content.items),
        widthPt: viewport.width,
        heightPt: viewport.height,
      });
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return pages;
}

async function extractPdfCitationFallback(pdfBuffer) {
  const pages = await extractPdfTextPages(pdfBuffer);
  const pageSizeList = pages.map((page) => ({
    page: page.pageIndex + 1,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
  }));
  const numberedReferences = extractNumberedReferences(pages);
  const referenceList = numberedReferences.length
    ? numberedReferences
    : extractAuthorYearReferences(pages);
  const bibliographyBoundary = findBibliographyBoundary(pages);
  const citationHits = pages.flatMap((page) => {
    if (
      bibliographyBoundary &&
      page.pageIndex > bibliographyBoundary.pageIndex
    ) {
      return [];
    }
    const bodyText = bibliographyBoundary?.pageIndex === page.pageIndex
      ? page.text.slice(0, bibliographyBoundary.startChar)
      : page.text;
    return detectCitationHits(page.pageIndex, bodyText, referenceList);
  });
  const refKeys = referenceList.map((reference) => reference.refId);
  const refValues = referenceList.map((reference) => ({
    array: [reference.title || '', ...(reference.authors || [])],
  }));
  return {
    citationHits,
    pageSizeList,
    referenceList,
    referenceTitleList: { key: refKeys, value: refValues },
  };
}

function referenceInfoFromFallback(referenceList) {
  return Object.fromEntries((referenceList || []).map((reference) => [
    String(reference.refId || reference.id || ''),
    {
      title: reference.title || '',
      raw: reference.raw || '',
      authors: Array.isArray(reference.authors) ? reference.authors : [],
      doi: reference.doi || null,
      year: reference.year || null,
      journal: reference.journal || reference.venue || null,
    },
  ]).filter(([id]) => id));
}

function referenceAlias(referenceId, refInfo) {
  const normalized = String(referenceId || '').replace(/^#/, '');
  if (refInfo[normalized]) return normalized;
  const printedNumber = Number(normalized);
  if (!Number.isInteger(printedNumber) || printedNumber < 1) return normalized;
  return [
    `b${printedNumber - 1}`,
    `bib${printedNumber - 1}`,
    `b${printedNumber}`,
    `bib${printedNumber}`,
  ].find((candidate) => refInfo[candidate]) || normalized;
}

function alignFallbackHitsToReferences(citationHits, refInfo) {
  return (citationHits || []).map((hit) => {
    const refIds = [...new Set(
      (hit.refIds || []).map((refId) => referenceAlias(refId, refInfo)),
    )];
    return {
      ...hit,
      refId: refIds[0] || '',
      refIds,
    };
  });
}

function recoverIncompleteGrobidExtraction(grobid, fallback) {
  const grobidRefInfo = grobid?.refInfo || {};
  const fallbackRefInfo = referenceInfoFromFallback(fallback?.referenceList);
  const refInfo = Object.keys(grobidRefInfo).length
    ? { ...grobidRefInfo }
    : fallbackRefInfo;
  const grobidPageSizes = grobid?.pageSizes || {};
  const fallbackPageSizes = Object.fromEntries(
    (fallback?.pageSizeList || []).map((size) => [
      String(size.page),
      { widthPt: size.widthPt, heightPt: size.heightPt },
    ]),
  );
  const pageSizes = Object.keys(grobidPageSizes).length
    ? grobidPageSizes
    : fallbackPageSizes;
  const grobidHits = Array.isArray(grobid?.citationHits)
    ? grobid.citationHits
    : [];
  const positionedGrobidHits = grobidHits.filter(
    (hit) => Array.isArray(hit.boxes) && hit.boxes.length > 0,
  );
  const fallbackHits = alignFallbackHitsToReferences(
    fallback?.citationHits,
    refInfo,
  );
  const needsFallbackHits = !grobidHits.length
    || !positionedGrobidHits.length
    || !Object.keys(grobidPageSizes).length;
  const useFallbackHits = needsFallbackHits && fallbackHits.length > 0;

  return {
    citationHits: useFallbackHits ? fallbackHits : grobidHits,
    pageSizes,
    refInfo,
    usedFallback: needsFallbackHits
      || useFallbackHits
      || !Object.keys(grobidRefInfo).length
      || !Object.keys(grobidPageSizes).length,
  };
}

module.exports = {
  alignFallbackHitsToReferences,
  bibliographyHeadingStart,
  detectCitationHits,
  expandNumericCitation,
  extractAuthorYearReferences,
  extractNumberedReferences,
  extractPdfCitationFallback,
  extractPdfTextPages,
  findBibliographyBoundary,
  parseReferenceLine,
  recoverIncompleteGrobidExtraction,
};
