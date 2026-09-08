const PAPER = 'GX.MAROScientificPaper';
const RESTORED_FIELDS = [
  'persistenceKey', 'createdAt', 'title', 'authors', 'year', 'venue', 'doi',
  'resultId', 'abstract', 'resourceLink', 'pdfSourceUrl', 'fileId', 'pdfUrl',
  'bibtex', 'bibtexSource', 'bibtexStatus', 'x', 'y', 'zIndex', 'width', 'height',
  'references', 'citationHits', 'referenceTitleList', 'pageCount', 'pageSizeList',
  'citationExtractionStatus', 'pdfDownloadStatus',
];

/** Restore only a paper's identity/PDF and position, retaining current research. */
function planPaperRecovery({ current, source, paperId, expectedRevision, timestamp }) {
  if (current.revision !== expectedRevision) throw new Error('Workspace changed; create a new recovery plan');
  if (current.id !== source.id || current.projectName !== source.projectName) throw new Error('Recovery board mismatch');
  const originals = source.objects.filter(o => o.id === paperId && o.type === PAPER);
  const affected = current.objects.filter(o => o.id === paperId && o.type === PAPER);
  if (originals.length !== 1 || affected.length !== 1 || !originals[0].persistenceKey || !originals[0].fileId) {
    throw new Error('Recovery requires one unambiguous original and current paper');
  }
  const original = originals[0];
  if (current.objects.some(o => o.id !== paperId && o.persistenceKey === original.persistenceKey)) {
    throw new Error('Another object already owns the original paper identity');
  }
  const restored = structuredClone(affected[0]);
  for (const key of RESTORED_FIELDS) {
    if (Object.hasOwn(original, key)) restored[key] = structuredClone(original[key]);
    else delete restored[key];
  }
  // Cached previews of the wrong PDF must be rebuilt from the restored file.
  delete restored.pdfPagePreview;
  delete restored.pdfDownloadError;
  restored.pdfDownloadedBytes = 0;
  restored.pdfTotalBytes = 0;
  restored.pageIndex = Math.min(restored.pageIndex || 0, Math.max(0, restored.pageCount - 1));
  restored.updatedAt = timestamp;
  const state = { ...structuredClone(current), revision: expectedRevision + 1, updatedAt: timestamp,
    objects: current.objects.map(o => structuredClone(o.id === paperId ? restored : o)),
  };
  return { state, paper: restored, changedFields: [...new Set([...Object.keys(affected[0]), ...Object.keys(restored)])]
    .filter(key => JSON.stringify(affected[0][key]) !== JSON.stringify(restored[key])) };
}

module.exports = { planPaperRecovery };
