function normalizeDoi(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/[?#].*$/, '')
    .replace(/[.,;)\]}]+$/, '');
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedReferenceId(value) {
  return String(value || '').replace(/^#/, '').trim().toLowerCase();
}

function referenceIdsMatch(left, right) {
  const normalizedLeft = normalizedReferenceId(left);
  const normalizedRight = normalizedReferenceId(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const leftGrobid = normalizedLeft.match(/^b(\d+)$/);
  const rightGrobid = normalizedRight.match(/^b(\d+)$/);
  if (leftGrobid && String(Number(leftGrobid[1]) + 1) === normalizedRight) {
    return true;
  }
  if (rightGrobid && String(Number(rightGrobid[1]) + 1) === normalizedLeft) {
    return true;
  }
  return false;
}

function identifierValues(value) {
  if (Array.isArray(value)) return value.flatMap(identifierValues);
  if (value === null || value === undefined) return [];
  const normalized = String(value).trim().toLowerCase();
  return normalized ? [normalized] : [];
}

function documentIdentifiers(doc) {
  return new Set([
    ...identifierValues(doc.resultId),
    ...identifierValues(doc.googleScholarId),
    ...identifierValues(doc.scholarId),
    ...identifierValues(doc.citesId),
  ]);
}

function referenceIdentifiers(reference) {
  return new Set([
    ...identifierValues(reference.resultId),
    ...identifierValues(reference.googleScholarId),
    ...identifierValues(reference.scholarId),
    ...identifierValues(reference.citesId),
  ]);
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

function referenceList(doc) {
  if (Array.isArray(doc.referenceList)) return doc.referenceList;
  if (Array.isArray(doc.references)) return doc.references;
  return [];
}

function matchingReferenceScore(reference, targetDoc, fallbackTitle) {
  const targetDoi =
    normalizeDoi(targetDoc.doi)
    || normalizeDoi(targetDoc.resourceLink)
    || normalizeDoi(targetDoc.url);
  const referenceDoi =
    normalizeDoi(reference.doi)
    || normalizeDoi(reference.url);
  if (targetDoi && referenceDoi && targetDoi === referenceDoi) return 4;

  const targetIds = documentIdentifiers(targetDoc);
  const referenceIds = referenceIdentifiers(reference);
  for (const id of referenceIds) {
    if (targetIds.has(id)) return 3;
  }

  const targetTitle = normalizeTitle(targetDoc.paperName || fallbackTitle);
  const referenceTitle = normalizeTitle(reference.title);
  if (!targetTitle || !referenceTitle) return 0;
  if (targetTitle === referenceTitle) return 2;

  const similarity = tokenSimilarity(targetTitle, referenceTitle);
  return similarity >= 0.82 ? similarity : 0;
}

function findMatchingReference(sourceDoc, targetDoc, fallbackTitle = '') {
  let best = null;
  for (const reference of referenceList(sourceDoc)) {
    const score = matchingReferenceScore(reference, targetDoc, fallbackTitle);
    if (!score || (best && best.score >= score)) continue;
    const refId = String(
      reference.refId || reference.id || reference.xmlId || '',
    ).replace(/^#/, '');
    if (!refId) continue;
    best = { reference, refId, score };
  }
  return best;
}

function findCitationHits(sourceDoc, referenceId) {
  const hits = Array.isArray(sourceDoc.citationHits)
    ? sourceDoc.citationHits
    : [];
  return hits.filter((hit) =>
    (Array.isArray(hit.refIds) ? hit.refIds : []).some((candidate) =>
      referenceIdsMatch(candidate, referenceId),
    ),
  );
}

function citationHitPageIndex(hit) {
  if (Number.isFinite(hit?.pageIndex)) return Number(hit.pageIndex);
  const page = Number(hit?.boxes?.[0]?.page);
  return Number.isFinite(page) ? Math.max(0, page - 1) : null;
}

function findCitationHit(
  sourceDoc,
  referenceId,
  { citationHitId = '', pageIndex } = {},
) {
  const hits = findCitationHits(sourceDoc, referenceId);
  if (citationHitId) {
    const exact = hits.find((hit) => hit.id === citationHitId);
    if (exact) return exact;
  }
  if (Number.isFinite(pageIndex)) {
    const onPage = hits.find(
      (hit) => citationHitPageIndex(hit) === Number(pageIndex),
    );
    if (onPage) return onPage;
  }
  return hits[0] || null;
}

module.exports = {
  findCitationHit,
  findCitationHits,
  findMatchingReference,
  normalizeDoi,
  normalizeTitle,
  referenceIdsMatch,
};
