const { analyzeRelations, analyzeRelationsForLayout, generateClusterLabels, findRelevantSentences, summarizePaper } = require('../services/gemini');
const { extractSentences } = require('../services/grobid');
const s3Service = require('../services/s3');
const { getClient } = require('../services/mongo');

// --- Co-citation 그래프 유틸리티 ---

/**
 * 텍스트에서 인용 마커 추출 (예: [1], [2,3], [4, 5] 등)
 * validMarkers가 주어지면 해당 마커만 반환
 */
function extractMarkers(text, validMarkers) {
  const markers = [];
  const regex = /\[(\d+(?:\s*[,\s]\s*\d+)*)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const nums = match[1].split(/[,\s]+/).filter(Boolean);
    for (const n of nums) {
      const marker = `[${n.trim()}]`;
      if (!validMarkers || validMarkers.has(marker)) {
        markers.push(marker);
      }
    }
  }
  return markers;
}

/**
 * 텍스트를 문단 단위로 분할
 */
function splitIntoParagraphs(text) {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Related Work 텍스트 구조로부터 co-citation 그래프 생성
 *
 * 가중치 규칙:
 *   같은 문장 내 co-citation → weight 1.0
 *   같은 문단 내 co-citation → weight 0.5 (문장 엣지가 없는 경우에만)
 *
 * 클러스터:
 *   여러 문단 → 각 문단이 하나의 클러스터
 *   단일 문단 → 문장 co-citation 연결 요소(union-find)로 하위 클러스터 생성
 */
function buildCoCitationGraph(paragraphs, validMarkers) {
  const edgeMap = {}; // "a|b" → { from, to, weight }

  function edgeKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function addEdge(a, b, weight) {
    if (a === b) return;
    const key = edgeKey(a, b);
    if (!edgeMap[key]) {
      edgeMap[key] = { from: a < b ? a : b, to: a < b ? b : a, weight: 0 };
    }
    edgeMap[key].weight = Math.max(edgeMap[key].weight, weight);
  }

  // 문단별 소속 마커 기록
  const paraClusters = []; // [ Set<marker>, ... ]

  for (const para of paragraphs) {
    const paraMarkers = new Set(extractMarkers(para, validMarkers));
    paraClusters.push(paraMarkers);

    // 문장 단위 co-citation (weight 1.0)
    const sentences = para.split(/(?<=[.!?])\s+/);
    for (const sent of sentences) {
      const sentMarkers = [...new Set(extractMarkers(sent, validMarkers))];
      for (let i = 0; i < sentMarkers.length; i++) {
        for (let j = i + 1; j < sentMarkers.length; j++) {
          addEdge(sentMarkers[i], sentMarkers[j], 1.0);
        }
      }
    }

    // 문단 단위 co-citation (weight 0.5)
    const uniqueInPara = [...paraMarkers];
    for (let i = 0; i < uniqueInPara.length; i++) {
      for (let j = i + 1; j < uniqueInPara.length; j++) {
        addEdge(uniqueInPara[i], uniqueInPara[j], 0.5);
      }
    }
  }

  const edges = Object.values(edgeMap);

  // --- 클러스터 결정 ---
  let clusterAssignment; // marker → clusterId

  if (paragraphs.length > 1) {
    // 여러 문단: 각 문단이 클러스터. 여러 문단에 등장하면 첫 등장 문단에 배정
    clusterAssignment = {};
    for (let pIdx = 0; pIdx < paraClusters.length; pIdx++) {
      for (const marker of paraClusters[pIdx]) {
        if (!(marker in clusterAssignment)) {
          clusterAssignment[marker] = pIdx;
        }
      }
    }
    // 어떤 문단에도 없는 마커 → 별도 클러스터
    for (const m of validMarkers) {
      if (!(m in clusterAssignment)) {
        clusterAssignment[m] = paraClusters.length;
      }
    }
  } else {
    // 단일 문단: union-find로 문장 co-citation 연결 요소 기반 하위 클러스터 생성
    const allMarkers = [...validMarkers];
    const parent = {};
    for (const m of allMarkers) parent[m] = m;

    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }
    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    // 같은 문장에서 함께 인용된 마커끼리 union (가장 강한 관계만)
    const sentences = paragraphs[0].split(/(?<=[.!?])\s+/);
    for (const sent of sentences) {
      const sentMarkers = [...new Set(extractMarkers(sent, validMarkers))];
      for (let i = 1; i < sentMarkers.length; i++) {
        union(sentMarkers[0], sentMarkers[i]);
      }
    }

    // 연결 요소 → 클러스터 ID
    const rootToCluster = {};
    let nextId = 0;
    clusterAssignment = {};
    for (const m of allMarkers) {
      const root = find(m);
      if (!(root in rootToCluster)) {
        rootToCluster[root] = nextId++;
      }
      clusterAssignment[m] = rootToCluster[root];
    }
  }

  return { edges, clusterAssignment };
}

/**
 * Y축 1D force-directed layout
 * 클러스터별 Y 밴드 중심에 중력 + co-citation 엣지 인력 + 노드 간 척력
 *
 * @param {string[]} markers - 마커 목록
 * @param {Object[]} edges - co-citation 엣지 ({ from, to, weight })
 * @param {Object} clusterAssignment - marker → clusterId
 * @param {number} numClusters - 총 클러스터 수
 * @returns {number[]} - 각 마커의 y좌표 (0~1 정규화)
 */
function computeClusterY(markers, edges, clusterAssignment, numClusters, iterations = 200) {
  const n = markers.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];

  const markerIdx = {};
  markers.forEach((m, i) => { markerIdx[m] = i; });

  // 클러스터별 Y 밴드 중심 (균등 분배)
  const clusterCenter = {};
  for (let c = 0; c < numClusters; c++) {
    clusterCenter[c] = (c + 0.5) / numClusters;
  }

  const k = 1.0 / n; // 이상적 노드 간 거리

  // 초기 Y: 클러스터 중심 + 약간의 오프셋
  const y = markers.map((m, i) => {
    const cId = clusterAssignment[m] ?? 0;
    const center = clusterCenter[cId] ?? 0.5;
    const membersInCluster = markers.filter((mm) => (clusterAssignment[mm] ?? 0) === cId).length;
    const idxInCluster = markers.slice(0, i + 1).filter((mm) => (clusterAssignment[mm] ?? 0) === cId).length - 1;
    const spread = membersInCluster > 1 ? (0.5 / numClusters) : 0;
    return center + (idxInCluster / Math.max(membersInCluster - 1, 1) - 0.5) * spread;
  });

  let temp = 0.05;

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Array(n).fill(0);

    // 척력 (모든 노드 쌍, Y축만)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dy = y[i] - y[j];
        const dist = Math.abs(dy) || 0.001;
        const force = (k * k) / dist;
        const fy = Math.sign(dy) * force;
        disp[i] += fy;
        disp[j] -= fy;
      }
    }

    // 인력: co-citation 엣지 (Y축만)
    for (const edge of edges) {
      const i = markerIdx[edge.from];
      const j = markerIdx[edge.to];
      if (i === undefined || j === undefined) continue;
      const dy = y[i] - y[j];
      const dist = Math.abs(dy) || 0.001;
      const force = (dist * dist / k) * edge.weight;
      const fy = Math.sign(dy) * force;
      disp[i] -= fy;
      disp[j] += fy;
    }

    // 클러스터 중심 중력 (같은 클러스터끼리 모이게)
    for (let i = 0; i < n; i++) {
      const cId = clusterAssignment[markers[i]] ?? 0;
      const center = clusterCenter[cId] ?? 0.5;
      const dy = y[i] - center;
      disp[i] -= dy * 0.3; // 중력 강도
    }

    // 변위 적용
    for (let i = 0; i < n; i++) {
      const absd = Math.abs(disp[i]) || 0.001;
      y[i] += disp[i] * Math.min(absd, temp) / absd;
    }

    temp *= 0.97;
  }

  // 0~1 정규화
  let minY = Infinity, maxY = -Infinity;
  for (const v of y) {
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }
  const range = maxY - minY || 1;
  return y.map((v) => (v - minY) / range);
}

/**
 * 연도 → X좌표 정규화 (0~1)
 * 연도가 없는 논문은 주변 논문 기준으로 보간
 */
function computeYearX(papers) {
  const years = papers.map((p) => p.year ? parseInt(p.year) : null);
  const validYears = years.filter((y) => y !== null && !isNaN(y));

  if (validYears.length === 0) {
    // 연도 정보가 전혀 없으면 균등 배치
    return papers.map((_, i) => i / Math.max(papers.length - 1, 1));
  }

  const minYear = Math.min(...validYears);
  const maxYear = Math.max(...validYears);
  const yearRange = maxYear - minYear || 1;

  return years.map((y) => {
    if (y !== null && !isNaN(y)) {
      return (y - minYear) / yearRange;
    }
    // 연도 없는 논문 → 중앙 배치
    return 0.5;
  });
}

// POST /analyze/relations
exports.relations = async (req, res) => {
  const { projectName, paragraph, refs } = req.body;

  if (!projectName || !paragraph || !refs || !Array.isArray(refs)) {
    return res.status(400).json({
      error: 'projectName, paragraph, and refs[] (with fileId/refId) required',
    });
  }

  try {
    console.log(`[Analyze] Looking up ${refs.length} references from MongoDB...`);
    const db = getClient().db(projectName);
    const { ObjectId } = require('mongodb');

    // fileId로 MongoDB에서 논문 정보 조회
    const references = [];
    for (const ref of refs) {
      let query;
      try {
        query = { _id: new ObjectId(ref.fileId) };
      } catch {
        query = { _id: ref.fileId };
      }

      const doc = await db.collection('SaveFile').findOne(query);
      if (!doc) {
        console.warn(`[Analyze] Paper not found: ${ref.fileId}`);
        references.push({
          refId: ref.refId,
          fileId: ref.fileId,
          title: 'Unknown',
          authors: [],
        });
        continue;
      }

      // referenceList에서 refId로 매칭
      if (ref.refId && doc.referenceList) {
        const refInfo = doc.referenceList.find((r) => r.refId === ref.refId);
        if (refInfo) {
          references.push({
            refId: ref.refId,
            fileId: ref.fileId,
            title: refInfo.title || doc.paperName || '',
            authors: refInfo.authors || [],
            year: refInfo.year || '',
            doi: refInfo.doi || '',
          });
          continue;
        }
      }

      // refId 매칭 실패 시 논문 자체 정보 사용
      references.push({
        refId: ref.refId,
        fileId: ref.fileId,
        title: doc.paperName || '',
        authors: [],
        year: '',
      });
    }

    console.log(
      `[Analyze] Resolved ${references.length} references, sending to Gemini...`,
    );
    const result = await analyzeRelations(paragraph, references);
    console.log(`[Analyze] Found ${result.relations?.length || 0} relations`);
    res.json(result);
  } catch (err) {
    console.error('[Analyze] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /analyze/layout
// Related Work 텍스트의 co-citation 구조 기반 2D 배치 + 관계 분석
exports.layout = async (req, res) => {
  const { projectName, paragraph, paragraphs: inputParagraphs, papers: inputPapers } = req.body;

  if (!projectName || (!paragraph && !inputParagraphs) || !inputPapers || !Array.isArray(inputPapers) || inputPapers.length < 2) {
    return res.status(400).json({
      error: 'projectName, paragraph (or paragraphs[]), and papers[] (min 2, with marker/fileId) required',
    });
  }

  try {
    const db = getClient().db(projectName);
    const { ObjectId } = require('mongodb');

    // paragraphs 배열 또는 단일 paragraph를 문단 단위로 분할
    const paragraphs = inputParagraphs || splitIntoParagraphs(paragraph);
    const fullText = paragraphs.join('\n\n');
    const validMarkers = new Set(inputPapers.map((p) => p.marker));

    console.log(`[Layout] Processing ${inputPapers.length} papers across ${paragraphs.length} paragraph(s)...`);

    // 1. MongoDB에서 논문 정보 조회 (연도 포함)
    const paperDocs = [];
    for (const p of inputPapers) {
      let query;
      try {
        query = { _id: new ObjectId(p.fileId) };
      } catch {
        query = { _id: p.fileId };
      }
      const doc = await db.collection('SaveFile').findOne(query);

      // 연도: 클라이언트 전달값 > MongoDB 문서의 year 필드 > null
      let year = p.year || doc?.year || null;

      paperDocs.push({
        fileId: p.fileId,
        marker: p.marker,
        title: doc?.paperName || 'Untitled',
        year: year,
      });
    }

    // 2. Co-citation 그래프 생성 (저자의 문단/문장 구조 그대로 활용)
    console.log(`[Layout] Building co-citation graph from text structure...`);
    const { edges, clusterAssignment } = buildCoCitationGraph(paragraphs, validMarkers);
    console.log(`[Layout] Graph: ${edges.length} co-citation edges`);

    // 3. LLM 관계 분석 (엣지 라벨링용)
    console.log(`[Layout] Analyzing relations with LLM...`);
    const references = paperDocs.map((p) => ({
      refId: p.marker,
      title: p.title,
    }));
    let llmRelations = [];
    try {
      const result = await analyzeRelationsForLayout(fullText, references);
      llmRelations = result.relations || [];
    } catch (err) {
      console.warn(`[Layout] LLM relation analysis failed: ${err.message}`);
    }

    // 4. LLM 관계를 co-citation 엣지에 병합 (라벨/타입 보강)
    const llmEdgeMap = {};
    for (const rel of llmRelations) {
      const a = rel.from < rel.to ? rel.from : rel.to;
      const b = rel.from < rel.to ? rel.to : rel.from;
      llmEdgeMap[`${a}|${b}`] = rel;
    }
    for (const edge of edges) {
      const key = `${edge.from}|${edge.to}`;
      if (llmEdgeMap[key]) {
        edge.label = llmEdgeMap[key].label;
        edge.type = llmEdgeMap[key].type;
      }
    }
    // LLM이 발견했지만 co-citation에 없는 관계도 약한 엣지로 추가
    for (const rel of llmRelations) {
      const a = rel.from < rel.to ? rel.from : rel.to;
      const b = rel.from < rel.to ? rel.to : rel.from;
      const key = `${a}|${b}`;
      const exists = edges.some((e) => `${e.from}|${e.to}` === key);
      if (!exists && validMarkers.has(rel.from) && validMarkers.has(rel.to)) {
        edges.push({ from: a, to: b, weight: 0.3, label: rel.label, type: rel.type });
      }
    }

    // 5. X축 = 연도순, Y축 = 클러스터 기반 force-directed
    console.log(`[Layout] Computing layout (x=year, y=cluster)...`);
    const markerList = paperDocs.map((p) => p.marker);
    const xCoords = computeYearX(paperDocs);

    const numClusters = Math.max(...Object.values(clusterAssignment), 0) + 1;
    const yCoords = computeClusterY(markerList, edges, clusterAssignment, numClusters);

    // 6. 클러스터별 논문 제목 + 마커 수집 → Gemini 라벨 생성
    const clusterTitles = {};
    const clusterMarkers = {};
    for (const p of paperDocs) {
      const cId = clusterAssignment[p.marker] ?? 0;
      if (!clusterTitles[cId]) clusterTitles[cId] = [];
      if (!clusterMarkers[cId]) clusterMarkers[cId] = [];
      clusterTitles[cId].push(p.title);
      clusterMarkers[cId].push(p.marker);
    }

    console.log(`[Layout] Generating labels for ${Object.keys(clusterTitles).length} clusters...`);
    const clusterLabels = await generateClusterLabels(clusterTitles, fullText, clusterMarkers);

    // 7. 응답 조립 (기존 응답 형식 유지)
    const positions = paperDocs.map((p, i) => ({
      fileId: p.fileId,
      marker: p.marker,
      title: p.title,
      year: p.year || null,
      x: xCoords[i],
      y: yCoords[i],
      cluster: clusterAssignment[p.marker] ?? 0,
    }));

    const clusters = Object.keys(clusterTitles).map((cId) => {
      const members = positions.filter((p) => p.cluster === parseInt(cId));
      const centerX = members.reduce((s, p) => s + p.x, 0) / members.length;
      const centerY = members.reduce((s, p) => s + p.y, 0) / members.length;
      return {
        id: parseInt(cId),
        label: clusterLabels[cId] || `Cluster ${cId}`,
        centerX,
        centerY,
        count: members.length,
      };
    });

    const markerToFileId = {};
    for (const p of inputPapers) {
      markerToFileId[p.marker] = p.fileId;
    }
    const relations = edges
      .filter((e) => e.label && markerToFileId[e.from] && markerToFileId[e.to])
      .map((e) => ({
        from: markerToFileId[e.from],
        to: markerToFileId[e.to],
        label: e.label,
        type: e.type || 'similar',
      }));

    console.log(`[Layout] Done. ${positions.length} positions, ${clusters.length} clusters, ${relations.length} relations, ${edges.length} edges.`);
    res.json({ positions, clusters, relations });
  } catch (err) {
    console.error('[Layout] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /analyze/highlights
// 관련 연구 문단에서 언급된 논문들의 본문에서 관련 문장 찾기
exports.highlights = async (req, res) => {
  const { projectName, paragraph, papers: inputPapers } = req.body;

  if (!projectName || !paragraph || !inputPapers || !Array.isArray(inputPapers)) {
    return res.status(400).json({
      error: 'projectName, paragraph, and papers[] (with marker/fileId) required',
    });
  }

  try {
    const db = getClient().db(projectName);
    const { ObjectId } = require('mongodb');

    console.log(`[Highlights] Processing ${inputPapers.length} papers...`);

    const highlights = [];

    for (const paper of inputPapers) {
      const { fileId, marker } = paper;
      console.log(`[Highlights] --- Processing ${marker} (${fileId}) ---`);

      try {
        // 1. MongoDB에서 논문 정보 + 저장된 TEI 문장 확인
        let query;
        try {
          query = { _id: new ObjectId(fileId) };
        } catch {
          query = { _id: fileId };
        }
        const doc = await db.collection('SaveFile').findOne(query);
        if (!doc) {
          console.warn(`[Highlights] ${marker}: Document not found in MongoDB, skipping`);
          highlights.push({ fileId, marker, title: 'Unknown', quotes: [] });
          continue;
        }
        const paperTitle = doc?.paperName || 'Untitled';
        console.log(`[Highlights] ${marker}: title="${paperTitle}"`);

        // 2. S3에서 TEI XML 가져와서 문장 추출
        let sentences = [];
        const teiKey = `tei/${projectName}/${fileId}.xml`;
        try {
          const teiXml = await s3Service.downloadTeiXml(teiKey);
          sentences = extractSentences(teiXml);
          console.log(`[Highlights] ${marker}: ${sentences.length} sentences from cached TEI XML`);
        } catch (teiErr) {
          // TEI XML이 없으면 PDF에서 GROBID 추출
          console.log(`[Highlights] ${marker}: No cached TEI XML, extracting from PDF...`);
          const { processFulltext } = require('../services/grobid');
          const s3Key = `papers/${projectName}/${fileId}.pdf`;
          const s3Res = await s3Service.downloadPdf(s3Key);
          const chunks = [];
          for await (const chunk of s3Res.Body) chunks.push(chunk);
          const pdfBuffer = Buffer.concat(chunks);

          const teiXml = await processFulltext(pdfBuffer);
          sentences = extractSentences(teiXml);
          console.log(`[Highlights] ${marker}: GROBID extracted ${sentences.length} sentences`);

          // TEI XML을 S3에 저장 (다음에 재사용)
          await s3Service.uploadTeiXml(teiKey, teiXml);
        }

        if (sentences.length === 0) {
          console.warn(`[Highlights] ${marker}: No sentences found, skipping`);
          highlights.push({ fileId, marker, title: paperTitle, quotes: [] });
          continue;
        }

        // 3. Gemini로 관련 문장 인덱스 찾기 + 요약 병렬 호출
        console.log(`[Highlights] ${marker}: Finding relevant sentences (${sentences.length} total)...`);
        const [{ indices }, { summary }] = await Promise.all([
          findRelevantSentences(paragraph, marker, paperTitle, sentences),
          summarizePaper(paragraph, marker, paperTitle, sentences),
        ]);

        // 4. 인덱스 → 원본 문장 추출
        const quotes = indices.map((i) => sentences[i]);
        console.log(`[Highlights] ${marker}: Found ${quotes.length} relevant quotes, summary: ${summary.slice(0, 60)}...`);

        highlights.push({
          fileId,
          marker,
          title: paperTitle,
          quotes,
          summary,
        });
      } catch (paperErr) {
        console.error(`[Highlights] ${marker} (${fileId}): ERROR - ${paperErr.message}`);
        highlights.push({ fileId, marker, title: 'Error', quotes: [] });
      }
    }

    console.log(`[Highlights] Done. ${highlights.length} papers processed.`);
    res.json({ highlights });
  } catch (err) {
    console.error('[Highlights] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

