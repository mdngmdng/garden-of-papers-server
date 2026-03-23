const { analyzeRelations, analyzeRelationsForLayout, getEmbeddings, generateClusterLabels, findRelevantSentences } = require('../services/gemini');
const { extractSentences } = require('../services/grobid');
const s3Service = require('../services/s3');
const { getClient } = require('../services/mongo');
const { UMAP } = require('umap-js');

// 관계 유형별 boost 강도
const BOOST_BY_TYPE = {
  similar: 0.4,
  extension: 0.35,
  builds_upon: 0.35,
  application: 0.3,
  comparison: 0.2,
  addresses_limitation: 0.2,
  contrast: 0.1,
};

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
// 문단에 언급된 논문들의 2D 배치 + 관계 분석
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

    console.log(`[Layout] Processing ${inputPapers.length} papers from paragraph...`);

    // 1. 각 fileId로 MongoDB에서 논문 정보 조회
    const paperDocs = [];
    const markerMap = {}; // fileId → marker
    for (const p of inputPapers) {
      markerMap[p.fileId] = p.marker;
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
        referenceList: doc?.referenceList || [],
      });
    }

    // 2. 각 논문의 임베딩 텍스트 생성 (제목 + 레퍼런스 제목들)
    const texts = paperDocs.map((p) => {
      const refTitles = p.referenceList
        .map((r) => r.title)
        .filter(Boolean)
        .join('. ');
      return `${p.title}. References: ${refTitles}`.slice(0, 8000);
    });

    // 3. Gemini 임베딩
    console.log(`[Layout] Getting embeddings for ${texts.length} papers...`);
    const embeddings = await getEmbeddings(texts);

    // 4. LLM 관계 분석 (문단 + marker)
    console.log(`[Layout] Analyzing relations with LLM...`);
    const references = paperDocs.map((p) => ({
      refId: p.marker,
      title: p.title,
    }));
    let llmRelations = [];
    try {
      const result = await analyzeRelationsForLayout(paragraph, references);
      llmRelations = result.relations || [];
    } catch (err) {
      console.warn(`[Layout] LLM relation analysis failed: ${err.message}`);
    }

    // 5. 관계 기반 임베딩 boost
    const dim = embeddings[0].length;
    const markerToIdx = {};
    paperDocs.forEach((p, i) => {
      markerToIdx[p.marker] = i;
    });

    for (const rel of llmRelations) {
      const fromIdx = markerToIdx[rel.from];
      const toIdx = markerToIdx[rel.to];
      if (fromIdx === undefined || toIdx === undefined) continue;

      const strength = BOOST_BY_TYPE[rel.type] || 0.2;
      for (let d = 0; d < dim; d++) {
        const mid = (embeddings[fromIdx][d] + embeddings[toIdx][d]) / 2;
        embeddings[fromIdx][d] = embeddings[fromIdx][d] * (1 - strength) + mid * strength;
        embeddings[toIdx][d] = embeddings[toIdx][d] * (1 - strength) + mid * strength;
      }
    }
    console.log(`[Layout] Applied ${llmRelations.length} relation boosts`);

    // 6. UMAP → 2D
    console.log(`[Layout] Running UMAP...`);
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: Math.min(15, Math.max(2, paperDocs.length - 1)),
      minDist: 0.1,
    });
    const coords2d = umap.fit(embeddings);

    // 정규화 0~1
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of coords2d) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    // 7. K-Means 클러스터링
    const k = Math.min(Math.max(2, Math.round(Math.sqrt(paperDocs.length / 2))), 8);
    console.log(`[Layout] Clustering into ${k} groups...`);
    const assignments = kMeans(embeddings, k);

    // 클러스터별 논문 제목 수집
    const clusterTitles = {};
    for (let i = 0; i < paperDocs.length; i++) {
      const c = assignments[i];
      if (!clusterTitles[c]) clusterTitles[c] = [];
      clusterTitles[c].push(paperDocs[i].title);
    }

    // 8. Gemini로 클러스터 라벨 생성
    console.log(`[Layout] Generating cluster labels...`);
    const clusterLabels = await generateClusterLabels(clusterTitles);

    // 9. 응답 조립
    const positions = paperDocs.map((p, i) => ({
      fileId: p.fileId,
      marker: p.marker,
      title: p.title,
      x: (coords2d[i][0] - minX) / rangeX,
      y: (coords2d[i][1] - minY) / rangeY,
      cluster: assignments[i],
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

    // relations: marker → fileId 변환
    const markerToFileId = {};
    for (const p of inputPapers) {
      markerToFileId[p.marker] = p.fileId;
    }
    const relations = llmRelations
      .filter((r) => markerToFileId[r.from] && markerToFileId[r.to])
      .map((r) => ({
        from: markerToFileId[r.from],
        to: markerToFileId[r.to],
        label: r.label,
        type: r.type,
      }));

    console.log(`[Layout] Done. ${positions.length} positions, ${clusters.length} clusters, ${relations.length} relations.`);
    res.json({ positions, clusters, relations });
  } catch (err) {
    console.error('[Layout] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// --- K-Means 구현 (순수 JS, 외부 의존성 없음) ---
function kMeans(vectors, k, maxIter = 50) {
  const n = vectors.length;
  const dim = vectors[0].length;

  // 초기 중심: 랜덤 선택
  const centroids = [];
  const used = new Set();
  for (let i = 0; i < k; i++) {
    let idx;
    do {
      idx = Math.floor(Math.random() * n);
    } while (used.has(idx));
    used.add(idx);
    centroids.push([...vectors[idx]]);
  }

  const assignments = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // 할당
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          const diff = vectors[i][d] - centroids[c][d];
          dist += diff * diff;
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        changed = true;
      }
    }

    if (!changed) break;

    // 중심 갱신
    for (let c = 0; c < k; c++) {
      const members = [];
      for (let i = 0; i < n; i++) {
        if (assignments[i] === c) members.push(i);
      }
      if (members.length === 0) continue;
      for (let d = 0; d < dim; d++) {
        let sum = 0;
        for (const idx of members) sum += vectors[idx][d];
        centroids[c][d] = sum / members.length;
      }
    }
  }

  return assignments;
}

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

        // 3. Gemini로 관련 문장 인덱스 찾기
        console.log(`[Highlights] ${marker}: Finding relevant sentences (${sentences.length} total)...`);
        const { indices } = await findRelevantSentences(paragraph, marker, paperTitle, sentences);

        // 4. 인덱스 → 원본 문장 추출
        const quotes = indices.map((i) => sentences[i]);
        console.log(`[Highlights] ${marker}: Found ${quotes.length} relevant quotes`);

        highlights.push({
          fileId,
          marker,
          title: paperTitle,
          quotes,
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

