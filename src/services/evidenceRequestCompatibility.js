/** Older clients omit request arrays; explicit [] from a current client clears them (including Undo). */
function preserveEvidenceRequests(previous, incoming) {
  if (!previous || !incoming) return incoming;
  if (incoming.type === 'GX.MAROLink' && !Object.hasOwn(incoming, 'evidenceRequests') && previous.evidenceRequests) {
    incoming.evidenceRequests = structuredClone(previous.evidenceRequests);
  }
  if (incoming.type === 'GX.MARONote' && incoming.claimEvidence && previous.claimEvidence?.requests && !Object.hasOwn(incoming.claimEvidence, 'requests')) {
    incoming.claimEvidence.requests = structuredClone(previous.claimEvidence.requests);
  }
  return incoming;
}
module.exports = { preserveEvidenceRequests };
