const { analyzeRelations, generateClusterLabels, findRelevantSentences, summarizePaper, storytelling, generatePlacementReasons } = require('../services/gemini');
const { extractSentences } = require('../services/grobid');
const s3Service = require('../services/s3');
const { getClient } = require('../services/mongo');

// --- Layout 유틸리티 ---

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
 * 문장 기반 클러스터링 (union-find)
 * 같은 문장에서 함께 인용된 마커 = 같은 클러스터
 * 단독 마커는 하나의 기타 클러스터로 병합
 */
function buildSentenceClusters(paragraphs, validMarkers) {
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

  // 같은 문장에서 함께 인용된 마커끼리 union
  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[.!?])\s+/);
    console.log(`[Cluster] ${sentences.length} sentences in paragraph`);
    for (const sent of sentences) {
      const sentMarkers = [...new Set(extractMarkers(sent, validMarkers))];
      console.log(`[Cluster] Sentence markers: ${JSON.stringify(sentMarkers)}`);
      for (let i = 1; i < sentMarkers.length; i++) {
        union(sentMarkers[0], sentMarkers[i]);
      }
    }
  }

  // 연결 요소 → 클러스터 ID
  const rootToMembers = {};
  for (const m of allMarkers) {
    const root = find(m);
    if (!rootToMembers[root]) rootToMembers[root] = [];
    rootToMembers[root].push(m);
  }

  let nextId = 0;
  const rootToCluster = {};
  let singletonClusterId = null;
  const clusterAssignment = {};

  for (const [root, members] of Object.entries(rootToMembers)) {
    if (members.length === 1) {
      // 단독 마커 → 하나의 기타 클러스터로 병합
      if (singletonClusterId === null) {
        singletonClusterId = nextId++;
      }
      rootToCluster[root] = singletonClusterId;
    } else {
      rootToCluster[root] = nextId++;
    }
  }

  for (const m of allMarkers) {
    const root = find(m);
    clusterAssignment[m] = rootToCluster[root];
  }

  console.log(`[Cluster] Final assignment:`, JSON.stringify(clusterAssignment));
  return clusterAssignment;
}

/**
 * 마커의 본문 내 첫 등장 위치 맵 생성
 * [1], [1,3], [2, 1, 5] 등 묶음 인용도 매칭
 */
function computeFirstMentionPos(markers, fullText) {
  const firstPos = {};
  for (const m of markers) {
    const num = m.replace(/[[\]]/g, '');
    const regex = new RegExp(
      `\\[(?:\\d+[,\\s]+)*${num}(?:[,\\s]+\\d+)*\\]`
    );
    const match = regex.exec(fullText);
    firstPos[m] = match ? match.index : Infinity;
  }
  return firstPos;
}

/**
 * Y축: 클러스터별 동일 Y, 클러스터 간 큰 간격
 * 클러스터 순서 = 본문 내 첫 언급 순서
 */
function computeClusterY(markers, clusterAssignment, firstPos) {
  const n = markers.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];

  // 클러스터별 그룹화
  const clusterGroups = {};
  for (const m of markers) {
    const cId = clusterAssignment[m] ?? 0;
    if (!clusterGroups[cId]) clusterGroups[cId] = [];
    clusterGroups[cId].push(m);
  }

  // 클러스터를 첫 멤버의 언급 순서로 정렬
  const sortedClusterIds = Object.keys(clusterGroups).sort((a, b) => {
    const minA = Math.min(...clusterGroups[a].map((m) => firstPos[m] ?? Infinity));
    const minB = Math.min(...clusterGroups[b].map((m) => firstPos[m] ?? Infinity));
    return minA - minB;
  });

  // 클러스터별 동일 Y, 클러스터 간 균등 배분
  const yMap = {};
  const numClusters = sortedClusterIds.length;

  sortedClusterIds.forEach((cId, ci) => {
    const y = numClusters > 1 ? ci / (numClusters - 1) : 0.5;
    for (const m of clusterGroups[cId]) {
      yMap[m] = y;
    }
  });

  return markers.map((m) => yMap[m]);
}

/**
 * X축: 클러스터 내 연도순 배치, 모든 클러스터의 중점 X = 0.5
 * 클러스터 폭은 멤버 수에 비례
 */
function computeYearX(papers, clusterAssignment) {
  const xResult = new Array(papers.length).fill(0.5);
  if (papers.length === 0) return xResult;

  // 클러스터별 그룹화
  const clusterGroups = {};
  papers.forEach((p, i) => {
    const cId = clusterAssignment[p.marker] ?? 0;
    if (!clusterGroups[cId]) clusterGroups[cId] = [];
    clusterGroups[cId].push(i);
  });

  // 각 클러스터: 중점 0.5 기준으로 연도순 펼침
  // 폭은 (멤버수 / 전체수)로 비례
  const totalPapers = papers.length;

  for (const cId of Object.keys(clusterGroups)) {
    const members = clusterGroups[cId];

    if (members.length === 1) {
      xResult[members[0]] = 0.5;
      continue;
    }

    // 클러스터 폭: 멤버 수에 비례, 최대 1.0
    const clusterWidth = Math.min(
      members.length / totalPapers, 1.0);

    // 연도순 정렬
    const sorted = [...members].sort((a, b) => {
      const ya = papers[a].year ? parseInt(papers[a].year) : Infinity;
      const yb = papers[b].year ? parseInt(papers[b].year) : Infinity;
      return ya - yb;
    });

    // 중점 0.5 기준으로 좌우 대칭 배치
    sorted.forEach((paperIdx, rank) => {
      const localX = rank / (sorted.length - 1); // 0~1
      xResult[paperIdx] = 0.5 + (localX - 0.5) * clusterWidth;
    });
  }

  return xResult;
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
// Related Work 텍스트의 문장 co-citation 기반 클러스터링 + 2D 배치
exports.layout = async (req, res) => {
  const { projectName, paragraph, papers: inputPapers } = req.body;

  if (!projectName || !paragraph || !inputPapers || !Array.isArray(inputPapers) || inputPapers.length < 2) {
    return res.status(400).json({
      error: 'projectName, paragraph, and papers[] (min 2, with marker/fileId) required',
    });
  }

  try {
    const db = getClient().db(projectName);
    const { ObjectId } = require('mongodb');

    const paragraphs = splitIntoParagraphs(paragraph);
    const fullText = paragraphs.join('\n\n');

    // 마커 정규화: "[42," → "[42]", "54]" → "[54]" 등
    function normalizeMarker(m) {
      const num = m.replace(/[^0-9]/g, '');
      return `[${num}]`;
    }
    for (const p of inputPapers) {
      p.marker = normalizeMarker(p.marker);
    }

    const validMarkers = new Set(inputPapers.map((p) => p.marker));

    console.log(`[Layout] Processing ${inputPapers.length} papers, markers: ${[...validMarkers].join(', ')}...`);

    // 1. MongoDB에서 논문 정보 조회 (연도/제목)
    const paperDocs = [];
    for (const p of inputPapers) {
      let query;
      try {
        query = { _id: new ObjectId(p.fileId) };
      } catch {
        query = { _id: p.fileId };
      }
      const doc = await db.collection('SaveFile').findOne(query);
      paperDocs.push({
        fileId: p.fileId,
        marker: p.marker,
        title: doc?.paperName || 'Untitled',
        year: p.year || doc?.year || null,
      });
    }

    // 2. 문장 기반 클러스터링
    console.log(`[Layout] Building sentence clusters...`);
    const clusterAssignment = buildSentenceClusters(paragraphs, validMarkers);
    const numClusters = new Set(Object.values(clusterAssignment)).size;
    console.log(`[Layout] ${numClusters} clusters found`);

    // 3. 좌표 계산: X=연도순 균등, Y=클러스터별 동일값+큰 간격
    const markerList = paperDocs.map((p) => p.marker);
    const firstPos = computeFirstMentionPos(markerList, fullText);
    const xCoords = computeYearX(paperDocs, clusterAssignment);
    const yCoords = computeClusterY(markerList, clusterAssignment, firstPos);

    // 4. 클러스터 라벨 생성 (Gemini)
    const clusterTitles = {};
    const clusterMarkerMap = {};
    for (const p of paperDocs) {
      const cId = clusterAssignment[p.marker] ?? 0;
      if (!clusterTitles[cId]) clusterTitles[cId] = [];
      if (!clusterMarkerMap[cId]) clusterMarkerMap[cId] = [];
      clusterTitles[cId].push(p.title);
      clusterMarkerMap[cId].push(p.marker);
    }

    console.log(`[Layout] Generating cluster labels...`);
    const clusterLabels = await generateClusterLabels(
      clusterTitles, fullText, clusterMarkerMap);

    // 5. 배치 이유 생성 (Gemini)
    const positions = paperDocs.map((p, i) => ({
      fileId: p.fileId,
      marker: p.marker,
      title: p.title,
      year: p.year || null,
      x: xCoords[i],
      y: yCoords[i],
      cluster: clusterAssignment[p.marker] ?? 0,
    }));

    console.log(`[Layout] Generating placement reasons...`);
    const positionsWithClusterLabel = positions.map((p) => ({
      ...p,
      clusterLabel: clusterLabels[p.cluster] || `Cluster ${p.cluster}`,
    }));
    let placementReasons = {};
    try {
      placementReasons = await generatePlacementReasons(
        fullText, positionsWithClusterLabel, []);
    } catch (err) {
      console.warn(`[Layout] Placement reasons failed: ${err.message}`);
    }
    for (const pos of positions) {
      pos.reason = placementReasons[pos.marker] || '';
    }

    // 6. 응답 조립
    const clusters = Object.keys(clusterTitles).map((cId) => ({
      id: parseInt(cId),
      label: clusterLabels[cId] || `Cluster ${cId}`,
      count: clusterTitles[cId].length,
    }));

    console.log(`[Layout] Done. ${positions.length} positions, ${clusters.length} clusters.`);
    res.json({ positions, clusters, relations: [] });
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
        const [{ indices }, sumResult] = await Promise.all([
          findRelevantSentences(paragraph, marker, paperTitle, sentences),
          summarizePaper(paragraph, marker, paperTitle, sentences),
        ]);

        // 4. 인덱스 → 원본 문장 추출
        const quotes = indices.map((i) => sentences[i]);
        const summary = `[배경] ${sumResult.background}\n\n[기여] ${sumResult.contribution}\n\n[한계] ${sumResult.limitation}`;
        console.log(`[Highlights] ${marker}: Found ${quotes.length} relevant quotes, bg: ${sumResult.background.slice(0, 40)}...`);

        highlights.push({
          fileId,
          marker,
          title: paperTitle,
          quotes,
          summary,
          background: sumResult.background,
          contribution: sumResult.contribution,
          limitation: sumResult.limitation,
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

// POST /analyze/summarize
// 키워드 검색으로 수집한 논문의 독립 요약 (citation context 불필요)
exports.summarize = async (req, res) => {
  const { projectName, fileId, paperTitle } = req.body;

  if (!projectName || !fileId) {
    return res.status(400).json({
      error: 'projectName and fileId required',
    });
  }

  try {
    console.log(`[Summarize] Processing ${fileId}...`);

    // 1. S3에서 TEI XML 가져와서 문장 추출
    let sentences = [];
    const teiKey = `tei/${projectName}/${fileId}.xml`;
    try {
      const teiXml = await s3Service.downloadTeiXml(teiKey);
      sentences = extractSentences(teiXml);
      console.log(`[Summarize] ${sentences.length} sentences from cached TEI`);
    } catch {
      console.log(`[Summarize] No cached TEI, extracting from PDF...`);
      const { processFulltext } = require('../services/grobid');
      const s3Key = `papers/${projectName}/${fileId}.pdf`;
      const s3Res = await s3Service.downloadPdf(s3Key);
      const chunks = [];
      for await (const chunk of s3Res.Body) chunks.push(chunk);
      const pdfBuffer = Buffer.concat(chunks);

      const teiXml = await processFulltext(pdfBuffer);
      sentences = extractSentences(teiXml);
      console.log(`[Summarize] GROBID extracted ${sentences.length} sentences`);

      await s3Service.uploadTeiXml(teiKey, teiXml);
    }

    if (sentences.length === 0) {
      return res.json({ summary: '' });
    }

    // 2. 요약 생성 (citation context 없이)
    const title = paperTitle || 'Untitled';
    const sumResult = await summarizePaper(
      '', '', title, sentences);
    const summary = `[배경] ${sumResult.background}\n\n[기여] ${sumResult.contribution}\n\n[한계] ${sumResult.limitation}`;
    console.log(`[Summarize] Done: bg=${sumResult.background.slice(0, 40)}...`);

    res.json({
      summary,
      background: sumResult.background,
      contribution: sumResult.contribution,
      limitation: sumResult.limitation,
    });
  } catch (err) {
    console.error('[Summarize] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /analyze/storytelling
// 여러 논문 선택 → 연구 변천사 스토리텔링 생성
exports.storytelling = async (req, res) => {
  const { papers, links, myResearch } = req.body;

  if (!papers || !Array.isArray(papers) || papers.length < 1) {
    return res.status(400).json({
      error: 'papers[] (min 1, with title/year/summary) required',
    });
  }

  try {
    console.log(`[Storytelling] Processing ${papers.length} papers, ${(links || []).length} links...`);
    const result = await storytelling(papers, links || [], myResearch || '');
    console.log(`[Storytelling] Done: ${result.story.slice(0, 80)}...`);
    res.json(result);
  } catch (err) {
    console.error('[Storytelling] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

