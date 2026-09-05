const crypto = require('node:crypto');
const semanticScholar = require('./semanticScholar');

const MAX_GRAPH_PAPERS = 20;
const CANONICALIZE_CONCURRENCY = 2;

function clean(value, maximum = 4_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizedTitle(value) {
  return clean(value, 1_000).normalize('NFKD').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizedDoi(value) {
  return clean(value, 300).toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '').replace(/[?#].*$/, '').replace(/\/$/, '');
}

function authorSurnames(authors) {
  return new Set((authors || []).flatMap((author) => {
    const tokens = clean(author, 200).toLowerCase().match(/[\p{L}\p{N}]+/gu);
    return tokens?.length ? [tokens.at(-1)] : [];
  }));
}

function canonicalMatchesPaper(canonical, paper) {
  if (!canonical) return false;
  const expectedDoi = normalizedDoi(paper.doi);
  const actualDoi = normalizedDoi(canonical.doi);
  if (expectedDoi && actualDoi) return expectedDoi === actualDoi;
  const expectedTitle = normalizedTitle(paper.title);
  const actualTitle = normalizedTitle(canonical.title);
  if (!expectedTitle || expectedTitle !== actualTitle) return false;
  if (paper.year && canonical.year && Math.abs(paper.year - canonical.year) > 1) return false;
  const expectedAuthors = authorSurnames(paper.authors);
  const actualAuthors = authorSurnames(canonical.authors);
  if (
    expectedAuthors.size &&
    actualAuthors.size &&
    ![...expectedAuthors].some((surname) => actualAuthors.has(surname))
  ) return false;
  return true;
}

function validateResearchBundle(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) {
    throw new Error('A version 1 research bundle is required.');
  }
  if (!clean(value.id, 200) || !clean(value.originalPrompt, 4_000)) {
    throw new Error('The research bundle is incomplete. Run the research step again.');
  }
  if (!Array.isArray(value.papers) || value.papers.length < 1) {
    throw new Error('The research bundle contains no papers to graph.');
  }
}

function normalizeGraphPapers(bundle, requestedPaperIds) {
  const allowed = new Set(
    (Array.isArray(requestedPaperIds) ? requestedPaperIds : [])
      .map((id) => clean(id, 240)).filter(Boolean),
  );
  const seen = new Set();
  return bundle.papers.flatMap((paper) => {
    if (!paper || typeof paper !== 'object' || paper.verified !== true) return [];
    const paperId = clean(paper.paperId, 240);
    const title = clean(paper.title, 1_000);
    if (!paperId || !title || (allowed.size && !allowed.has(paperId))) return [];
    const identities = [paperId, normalizedTitle(title)].filter(Boolean);
    if (!identities.length || identities.some((identity) => seen.has(identity))) return [];
    identities.forEach((identity) => seen.add(identity));
    return [{
      researchPaperId: clean(paper.researchPaperId, 240) || paperId,
      paperId,
      title,
      authors: Array.isArray(paper.authors)
        ? paper.authors.map((author) => clean(author, 200)).filter(Boolean).slice(0, 30)
        : [],
      year: Number.isInteger(paper.year) ? paper.year : null,
      doi: normalizedDoi(paper.doi),
      url: clean(paper.url, 2_000),
      inclusionReason: clean(paper.inclusionReason, 1_500),
      supportedClaims: Array.isArray(paper.supportedClaims)
        ? paper.supportedClaims.map((claim) => clean(claim, 1_000)).filter(Boolean).slice(0, 8)
        : [],
    }];
  }).slice(0, MAX_GRAPH_PAPERS);
}

async function canonicalizePaper(paper, service, signal) {
  const canonical = paper.doi
    ? await service.lookupByDoi(paper.doi, { signal })
    : await service.searchByTitle(paper.title, { signal });
  if (canonicalMatchesPaper(canonical, paper)) return canonical;
  if (paper.doi) {
    const byTitle = await service.searchByTitle(paper.title, { signal });
    return canonicalMatchesPaper(byTitle, { ...paper, doi: '' }) ? byTitle : null;
  }
  return null;
}

async function mapConcurrent(items, concurrency, mapper, onItem) {
  const output = new Array(items.length);
  let next = 0;
  let finished = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index], index);
      finished++;
      onItem?.(finished, items.length, items[index], output[index]);
    }
  }));
  return output;
}

function referenceMatchesTarget(reference, target) {
  if (!reference || !target) return false;
  if (reference.paperId && target.semanticScholarId === reference.paperId) return true;
  const referenceDoi = normalizedDoi(reference.doi || reference.externalIds?.DOI);
  if (referenceDoi && target.doi && referenceDoi === target.doi) return true;
  return Boolean(
    normalizedTitle(reference.title) &&
    normalizedTitle(reference.title) === normalizedTitle(target.title),
  );
}

async function executeResearchGraph(input, onProgress = () => {}, options = {}) {
  validateResearchBundle(input?.researchBundle);
  const bundle = input.researchBundle;
  const papers = normalizeGraphPapers(bundle, input.paperIds);
  if (!papers.length) throw new Error('No verified research papers are available to graph.');
  const signal = options.signal;
  const service = options.semanticScholarService || semanticScholar;
  const warnings = [];
  const onActivity = typeof options.onActivity === 'function'
    ? options.onActivity
    : () => {};
  onActivity({
    phase: 'graph', kind: 'stage', status: 'active',
    title: `고정된 조사 결과 ${papers.length}편으로 인용 그래프 검증을 시작했습니다`,
    counters: { graphPapersTotal: papers.length },
  });
  onProgress({
    stage: 'canonicalizing', percent: 8,
    message: 'Resolving canonical scholarly records for the frozen research bundle…',
  });
  const canonical = await mapConcurrent(
    papers,
    CANONICALIZE_CONCURRENCY,
    async (paper) => {
      try {
        return await canonicalizePaper(paper, service, signal);
      } catch (error) {
        warnings.push(`Could not resolve "${paper.title}": ${error.message}`);
        return null;
      }
    },
    (finished, total, paper, resolved) => {
      onProgress({
        stage: 'canonicalizing',
        percent: 8 + Math.round((finished / total) * 32),
        message: `Resolved ${finished}/${total} scholarly records…`,
      });
      onActivity({
        phase: 'graph', kind: 'canonical_record',
        status: resolved ? 'completed' : 'error',
        title: resolved
          ? 'Semantic Scholar에서 정확한 논문 식별자를 확인했습니다'
          : '정확히 일치하는 논문 식별자를 찾지 못했습니다',
        detail: clean(paper?.title, 1_000),
        counters: {
          graphPapersChecked: finished,
          graphPapersTotal: total,
          graphPapersResolved: resolved ? 1 : 0,
        },
      });
    },
  );
  const nodes = papers.map((paper, index) => ({
    ...paper,
    semanticScholarId: clean(canonical[index]?.paperId, 240),
    doi: normalizedDoi(canonical[index]?.doi || paper.doi),
    canonicalStatus: canonical[index] ? 'verified' : 'unresolved',
  }));
  nodes.forEach((node) => {
    if (node.canonicalStatus === 'unresolved') {
      warnings.push(`No exact Semantic Scholar identity was found for "${node.title}"; no citation edges were inferred for it.`);
    }
  });
  const canonicalTargets = nodes.filter((node) => node.semanticScholarId);
  const referencesByIndex = new Array(nodes.length).fill(null).map(() => []);
  onProgress({
    stage: 'verifying_citations', percent: 44,
    message: 'Checking each paper’s actual reference list…',
  });
  // Reference calls are intentionally sequential to stay below the public API's
  // burst limits. A configured S2 key is sent by semanticScholar.js.
  for (let index = 0; index < nodes.length; index++) {
    if (signal?.aborted) throw signal.reason || new Error('Graph generation was cancelled.');
    const node = nodes[index];
    if (node.semanticScholarId) {
      try {
        referencesByIndex[index] = await service.fetchReferences(
          node.semanticScholarId,
          { limit: 1_000, signal },
        );
      } catch (error) {
        warnings.push(`Could not inspect references for "${node.title}": ${error.message}`);
      }
    }
    onActivity({
      phase: 'graph', kind: 'reference_list',
      status: node.semanticScholarId ? 'completed' : 'error',
      title: node.semanticScholarId
        ? `참고문헌 ${referencesByIndex[index].length}개를 대조했습니다`
        : '논문 식별자가 없어 참고문헌 대조를 건너뛰었습니다',
      detail: node.title,
      counters: {
        referenceListsChecked: index + 1,
        graphPapersTotal: nodes.length,
        referencesInspected: referencesByIndex[index].length,
      },
    });
    onProgress({
      stage: 'verifying_citations',
      percent: 44 + Math.round(((index + 1) / nodes.length) * 48),
      message: `Checked ${index + 1}/${nodes.length} reference lists…`,
    });
  }
  const edges = [];
  const seenEdges = new Set();
  for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex++) {
    const source = nodes[sourceIndex];
    for (const reference of referencesByIndex[sourceIndex]) {
      const target = canonicalTargets.find((candidate) =>
        candidate.paperId !== source.paperId && referenceMatchesTarget(reference, candidate),
      );
      if (!target) continue;
      const key = `${source.paperId}\u001e${target.paperId}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({
        id: crypto.randomUUID(),
        sourcePaperId: source.paperId,
        targetPaperId: target.paperId,
        relationship: 'cite',
        verificationProvider: 'semantic-scholar-reference-list',
        verifiedAt: new Date().toISOString(),
        citationContextStatus: 'pending_pdf',
      });
    }
  }
  if (!edges.length) {
    warnings.push('No direct citation relationships among the researched papers were verified. The papers remain as disconnected graph nodes.');
  }
  onActivity({
    phase: 'graph', kind: 'citation_edges', status: 'completed',
    title: `실제 참고문헌에서 인용관계 ${edges.length}개를 확인했습니다`,
    counters: { citationEdgesVerified: edges.length },
  });
  return {
    version: 1,
    id: crypto.randomUUID(),
    researchBundleId: clean(bundle.id, 200),
    originalPrompt: clean(bundle.originalPrompt, 4_000),
    nodes,
    edges,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  canonicalMatchesPaper,
  executeResearchGraph,
  normalizeGraphPapers,
  referenceMatchesTarget,
  validateResearchBundle,
};
