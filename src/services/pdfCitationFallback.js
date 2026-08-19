const numericMarkerPattern = /\[(\d+(?:\s*[-–—,;]\s*\d+)*)\]/g;

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
  const year = raw.match(/\b(?:19|20)\d{2}[a-z]?\b/i)?.[0];
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
    .split(/\s+(?:and|&)\s+|,\s*(?=[A-Z][a-z]+(?:\s|$))/)
    .map((author) => author.trim())
    .filter((author) => author.length > 2)
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
    ...bibliography.matchAll(/(?:^|\n|[ \t])\[(\d{1,4})\]\s*/g),
  ];
  const markers = heading || bracketMarkers.length >= 3
    ? bracketMarkers
    : [...bibliography.matchAll(/(?:^|\n)\s*(\d{1,4})[.)]\s+/g)];
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

function inferBibliographyStart(text) {
  const candidates = [...text.matchAll(/(?:^|\n|[ \t])\[(\d{1,4})\]\s*/g)];
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

function citationContext(text, start, length) {
  const before = text.lastIndexOf('.', Math.max(0, start - 1));
  const after = text.indexOf('.', start + length);
  return text
    .slice(before >= 0 ? before + 1 : Math.max(0, start - 180), after >= 0 ? after + 1 : start + length + 180)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function detectCitationHits(pageIndex, text) {
  const hits = [];
  numericMarkerPattern.lastIndex = 0;
  for (const match of text.matchAll(numericMarkerPattern)) {
    const refIds = expandNumericCitation(match[1]);
    if (!refIds.length) continue;
    const startChar = match.index || 0;
    hits.push({
      id: `pdf-${pageIndex}-${startChar}-${refIds.join('-')}`,
      markerText: match[0],
      refIds,
      pageIndex,
      boxes: [],
      context: citationContext(text, startChar, match[0].length),
      startChar,
      length: match[0].length,
      source: 'pdf-text',
    });
  }
  return hits;
}

async function extractPdfCitationFallback(pdfBuffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const pages = [];
  const citationHits = [];
  const pageSizeList = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = pageTextFromItems(content.items);
      pages.push({ pageIndex: pageNumber - 1, text });
      citationHits.push(...detectCitationHits(pageNumber - 1, text));
      pageSizeList.push({
        page: pageNumber,
        widthPt: viewport.width,
        heightPt: viewport.height,
      });
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  const referenceList = extractNumberedReferences(pages);
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

module.exports = {
  detectCitationHits,
  expandNumericCitation,
  extractNumberedReferences,
  extractPdfCitationFallback,
  parseReferenceLine,
};
