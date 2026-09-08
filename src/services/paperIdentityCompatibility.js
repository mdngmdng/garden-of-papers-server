function title(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// A DOI or URL match does not override explicit, contradictory titles.
// Mixed-title library entries may already have been polluted by a bad reuse.
function compatiblePdfIdentity(identity, storedKeys = []) {
  const requestedTitle = title(identity.title || identity.paperName);
  const storedTitles = storedKeys.filter((key) => key.startsWith('title:'))
    .map((key) => title(key.slice(6).split('|year:')[0]));
  return !requestedTitle || storedTitles.every((value) => value === requestedTitle);
}

module.exports = { compatiblePdfIdentity };
