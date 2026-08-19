function citationDocumentSummary(document) {
  const hits = Array.isArray(document?.citationHits)
    ? document.citationHits
    : [];
  const pageSizes = Array.isArray(document?.pageSizeList)
    ? document.pageSizeList
    : Array.isArray(document?.pageSizes)
      ? document.pageSizes
      : [];
  const references = Array.isArray(document?.referenceList)
    ? document.referenceList
    : Array.isArray(document?.references)
      ? document.references
      : [];
  const positionedHits = hits.filter(
    (hit) => Array.isArray(hit?.boxes) && hit.boxes.length > 0,
  ).length;
  const grobidHits = hits.filter((hit) => hit?.source === 'grobid').length;

  return {
    ready: Boolean(
      document
      && Array.isArray(document.citationHits)
      && (
        document.citationStatus === 'ready'
        || document.citationsExtractedAt
        || hits.length > 0
      )
    ),
    hits: hits.length,
    positionedHits,
    grobidHits,
    pageSizes: pageSizes.length,
    references: references.length,
  };
}

function isCoordinateCitationDocument(document) {
  const summary = citationDocumentSummary(document);
  return Boolean(
    summary.ready
    && summary.positionedHits > 0
    && summary.pageSizes > 0
  );
}

function compareCitationDocuments(left, right) {
  const a = citationDocumentSummary(left);
  const b = citationDocumentSummary(right);
  const fields = [
    'ready',
    'positionedHits',
    'grobidHits',
    'pageSizes',
    'references',
    'hits',
  ];
  for (const field of fields) {
    const difference = Number(a[field]) - Number(b[field]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function preferCitationDocument(documents) {
  return documents
    .filter(Boolean)
    .reduce(
      (best, candidate) =>
        !best || compareCitationDocuments(candidate, best) > 0
          ? candidate
          : best,
      null,
    );
}

module.exports = {
  citationDocumentSummary,
  compareCitationDocuments,
  isCoordinateCitationDocument,
  preferCitationDocument,
};
