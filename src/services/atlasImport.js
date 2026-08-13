const semanticScholar = require('./semanticScholar');
const pdfStorage = require('./pdfStorage');

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDoi(value) {
  return pdfStorage.normalizeDoi(asText(value));
}

function normalizeAtlasPaper(input = {}) {
  const doi = normalizeDoi(input.doi || input.url);
  const title = asText(input.title);
  if (!doi && !title) {
    throw new TypeError('A DOI or paper title is required.');
  }
  const authors = Array.isArray(input.authors)
    ? input.authors.map(asText).filter(Boolean)
    : asText(input.authors).split(';').map(asText).filter(Boolean);
  const year = Number(input.year);
  const citationCount = Number(input.citationCount ?? input.citations);
  return {
    paperId: `atlas:${doi || title.toLowerCase()}`,
    doi,
    title,
    authors,
    year: Number.isInteger(year) && year > 1900 ? year : null,
    venue: asText(input.venue),
    citationCount: Number.isFinite(citationCount) && citationCount >= 0
      ? Math.floor(citationCount)
      : 0,
    abstract: asText(input.abstract),
    url: doi ? `https://doi.org/${doi}` : asText(input.url),
    openAccessPdfUrl: asText(input.openAccessPdfUrl),
    retrievalProvider: 'topic-atlas',
  };
}

async function resolveAtlasPaper(input) {
  const atlas = normalizeAtlasPaper(input);
  const resolved = atlas.doi
    ? await semanticScholar.lookupByDoi(atlas.doi)
    : await semanticScholar.searchByTitle(atlas.title);
  const doi = normalizeDoi(resolved?.doi || atlas.doi);
  let pdfCacheHit = false;
  if (doi) {
    try {
      pdfCacheHit = Boolean(await pdfStorage.findDoiPdf(doi));
    } catch (error) {
      console.warn('[Atlas] DOI PDF cache lookup failed:', error.message);
    }
  }
  return {
    ...atlas,
    paperId: resolved?.paperId || atlas.paperId,
    semanticScholarId: resolved?.paperId || undefined,
    doi,
    title: resolved?.title || atlas.title,
    authors: resolved?.authors?.length ? resolved.authors : atlas.authors,
    year: resolved?.year || atlas.year,
    venue: resolved?.venue || atlas.venue,
    citationCount: resolved?.citationCount ?? atlas.citationCount,
    abstract: resolved?.abstract || atlas.abstract,
    url: doi ? `https://doi.org/${doi}` : (resolved?.url || atlas.url),
    openAccessPdfUrl: resolved?.openAccessPdfUrl || atlas.openAccessPdfUrl,
    retrievalProvider: resolved ? 'topic-atlas+semantic-scholar' : 'topic-atlas',
    pdfCacheHit,
  };
}

module.exports = { normalizeAtlasPaper, resolveAtlasPaper };
