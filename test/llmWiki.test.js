const assert = require('node:assert/strict');
const test = require('node:test');
const { createLLMWikiService } = require('../src/services/llmWiki');

class MemoryCollection {
  constructor() {
    this.document = null;
  }

  async createIndex() {
    return 'llm_wiki_updated';
  }

  async findOne(query) {
    if (!this.document || this.document._id !== query._id) return null;
    return structuredClone(this.document);
  }

  async updateOne(query, update) {
    this.document = {
      ...(this.document || { _id: query._id }),
      ...structuredClone(update.$set),
    };
    for (const [field, operation] of Object.entries(update.$push || {})) {
      const current = Array.isArray(this.document[field]) ? this.document[field] : [];
      const values = Array.isArray(operation?.$each)
        ? structuredClone(operation.$each)
        : [structuredClone(operation)];
      const combined = [...current, ...values];
      this.document[field] = Number.isInteger(operation?.$slice)
        ? combined.slice(operation.$slice)
        : combined;
    }
    return { matchedCount: this.document ? 1 : 0, upsertedCount: 1 };
  }
}

class MemoryMarkdownStore {
  constructor() {
    this.root = '/tmp/test-llm-wiki';
    this.files = new Map();
    this.removed = [];
  }

  async write(filePath, markdown) {
    this.files.set(filePath, markdown);
  }

  async remove(filePath) {
    this.removed.push(filePath);
    this.files.delete(filePath);
  }

  async read(filePath) {
    if (!this.files.has(filePath)) {
      const error = new Error('Markdown not found');
      error.code = 'ENOENT';
      throw error;
    }
    return this.files.get(filePath);
  }
}

function workspace({ revision = 1, includePaper = true, includeNote = true, x = 100 } = {}) {
  const objects = [];
  if (includePaper) {
    objects.push({
      id: 'paper-ilovesketch',
      type: 'GX.MAROScientificPaper',
      title: 'ILoveSketch',
      authors: ['Seok-Hyung Bae', 'Ravin Balakrishnan', 'Karan Singh'],
      year: '2008',
      venue: 'UIST',
      doi: '10.1145/example',
      abstract: 'A 3D curve sketching system.',
      fileId: 'pdf-1',
      pdfUrl: '/download_pdf/garden/pdf-1',
      pdfSourceUrl: 'https://example.org/ilovesketch.pdf',
      pageIndex: 2,
      pageCount: 10,
      x,
      y: 200,
      width: 342,
      height: 444,
      zIndex: 3,
      highlights: [{
        id: 'highlight-1',
        pageIndex: 3,
        text: 'A suggestive interface for 3D curve sketching.',
        color: '#ffd42d',
        rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
      }],
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    });
  }
  if (includeNote) {
    objects.push({
      id: 'note-1',
      type: 'GX.MARONote',
      parentPaperId: 'paper-ilovesketch',
      parentPageIndex: 4,
      pageRect: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 },
      text: 'Compare the gesture vocabulary with EverybodyLovesSketch.',
      color: '#ffd42d',
      x: 150,
      y: 260,
      width: 120,
      height: 120,
      zIndex: 4,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    });
  }
  return {
    schemaVersion: 3,
    id: 'garden',
    ownerName: 'tester',
    projectName: 'garden',
    revision,
    camera: { x: 0, y: 0, scale: 1 },
    objects,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}

function fixture(options = {}) {
  const collection = new MemoryCollection();
  const markdownStore = new MemoryMarkdownStore();
  let sourceLoads = 0;
  let modelInput = '';
  let timestamp = Date.parse('2026-08-17T00:00:00.000Z');
  const bridgeRequests = [];
  const service = createLLMWikiService({
    getCollection: () => collection,
    markdownStore,
    sourceTextLoader: options.sourceTextLoader || (async () => {
      sourceLoads += 1;
      return 'ILoveSketch full PDF text from the cached TEI document.';
    }),
    openAIRequest: async (request) => {
      modelInput = request.input;
      if (options.openAIRequest) return options.openAIRequest(request);
      return 'ILoveSketch의 저자는 Seok-Hyung Bae, Ravin Balakrishnan, Karan Singh입니다.';
    },
    pdfBridgeRegistrar: async (request) => {
      bridgeRequests.push(request);
      return { status: 'ok' };
    },
    now: () => new Date(timestamp += 1_000),
  });
  return {
    collection,
    markdownStore,
    service,
    sourceLoads: () => sourceLoads,
    modelInput: () => modelInput,
    bridgeRequests,
  };
}

test('syncs PDF, metadata, notes, highlights, positions, and a Markdown audit log', async () => {
  const { collection, markdownStore, service, sourceLoads } = fixture();
  const result = await service.sync('garden', workspace());

  assert.deepEqual(result.counts, {
    papers: 1,
    notes: 1,
    attachedNotes: 1,
    canvasNotes: 0,
    highlights: 1,
    positions: 1,
    relationships: 0,
    searchNodes: 0,
    searchResults: 0,
  });
  assert.equal(sourceLoads(), 1);
  assert.equal(collection.document.papers[0].sourceText, undefined);
  assert.ok(collection.document.papers[0].sourceTextGzip);
  assert.equal(result.papers[0].sourceTextCharacters > 0, true);
  assert.equal(result.diff.papers.added[0], 'paper-ilovesketch');
  const paperFile = [...markdownStore.files.entries()]
    .find(([filePath]) => filePath.includes('ilovesketch'));
  assert.ok(paperFile);
  assert.match(paperFile[1], /Seok-Hyung Bae/);
  assert.match(paperFile[1], /Compare the gesture vocabulary/);
  assert.match(paperFile[1], /A suggestive interface/);
  assert.match(paperFile[1], /"x": 100/);
  assert.match(result.latestLogMarkdown, /PDF text characters transferred/);
  assert.match(result.latestLogMarkdown, /Attached notes transferred: 1/);
});

test('reuses extracted PDF text for position-only updates and records note deletion', async () => {
  const { service, sourceLoads } = fixture();
  await service.sync('garden', workspace());
  const result = await service.sync(
    'garden',
    workspace({ revision: 2, includeNote: false, x: 500 }),
  );

  assert.equal(sourceLoads(), 1);
  assert.deepEqual(result.diff.movedPapers, ['paper-ilovesketch']);
  assert.equal(result.diff.notes.deleted.length, 1);
  assert.equal(result.counts.notes, 0);
});

test('removes generated paper files when a paper is deleted from the canvas', async () => {
  const { markdownStore, service } = fixture();
  await service.sync('garden', workspace());
  const paperPath = [...markdownStore.files.keys()]
    .find((filePath) => filePath.includes('ilovesketch'));
  const result = await service.sync(
    'garden',
    workspace({ revision: 2, includePaper: false, includeNote: false }),
  );

  assert.deepEqual(result.diff.papers.deleted, ['paper-ilovesketch']);
  assert.ok(markdownStore.removed.includes(paperPath));
  assert.equal(markdownStore.files.has(paperPath), false);
});

test('accepts a canonical saved workspace after an optimistic revision ran ahead', async () => {
  const { collection, service } = fixture();
  await service.sync('garden', workspace({ revision: 2, x: 500 }));
  const result = await service.sync('garden', workspace({ revision: 1, x: 100 }));

  assert.equal(result.revision, 1);
  assert.equal(collection.document.papers[0].position.x, 100);
});

test('grounds a named-paper question in its focused Markdown body and metadata', async () => {
  const { collection, modelInput, service } = fixture();
  await service.sync('garden', workspace());
  const response = await service.chat('garden', 'ILoveSketch 저자가 누구야?');

  assert.match(response.answer, /Seok-Hyung Bae/);
  assert.match(modelInput(), /Focused paper reading mode/);
  assert.match(modelInput(), /Focused Markdown reading: ILoveSketch/);
  assert.match(modelInput(), /Karan Singh/);
  assert.equal(response.sources[0].title, 'ILoveSketch');
  assert.equal(response.messages.length, 2);
  assert.equal(collection.document.chatMessages.length, 2);
});

test('stores the exact PDF ranges read for a normal answer', async () => {
  const { service } = fixture({
    sourceTextLoader: async () => [
      '[Page 1]',
      'ILoveSketch introduces a three-dimensional curve sketching system.',
      '[Page 2]',
      'The evaluation discusses professional designers and iteration.',
    ].join('\n'),
    openAIRequest: async () =>
      'ILoveSketch는 3차원 곡선 스케치 시스템을 제안합니다.',
  });
  await service.sync('garden', workspace());

  const response = await service.chat('garden', '3D 곡선 스케치 시스템을 설명해줘');
  const report = response.messages.at(-1).readingReport;

  assert.equal(report.mode, 'retrieved-passages');
  assert.equal(report.offerFullTextReview, true);
  assert.equal(report.papers[0].title, 'ILoveSketch');
  assert.ok(report.papers[0].passages.length > 0);
  assert.ok(report.papers[0].passages[0].end > report.papers[0].passages[0].start);
  assert.match(report.papers[0].passages[0].excerpt, /3D curve sketching|three-dimensional/i);
});

test('automatically reads a named paper deeply from relevant, adjacent, and important Markdown chunks', async () => {
  const body = [
    '[Page 1]\n[Section: Introduction]\nThe paper motivates professional three-dimensional sketching.',
    'Background context about existing sketching tools. '.repeat(90),
    '[Page 3]\n[Section: System Design]\nILoveSketch introduces a natural curve sketching workflow for designers.',
    'Interaction details and implementation context. '.repeat(90),
    '[Page 7]\n[Section: Evaluation]\nProfessional designers evaluated the workflow in realistic tasks.',
    'Evaluation observations and evidence. '.repeat(90),
    '[Page 10]\n[Section: Conclusion]\nThe system supports iterative 3D curve creation but has limitations.',
  ].join('\n\n');
  const { modelInput, service } = fixture({
    sourceTextLoader: async () => body,
    openAIRequest: async () => 'ILoveSketch의 설계와 평가를 함께 종합했습니다.',
  });
  await service.sync('garden', workspace());

  const response = await service.chat('garden', 'ILoveSketch의 설계 기여와 평가 근거를 설명해줘');
  const report = response.messages.at(-1).readingReport;

  assert.equal(report.mode, 'focused-chunks');
  assert.match(modelInput(), /# Focused paper reading mode/);
  assert.match(modelInput(), /Why this chunk was read/);
  assert.match(modelInput(), /Evaluation/);
  assert.match(report.scope, /질문에 논문명이 명시됨/);
  assert.match(report.selectionRule, /앞뒤 1개 문맥/);
  assert.ok(report.papers[0].chunkCount > 1);
  assert.ok(report.papers[0].readCharacters >= report.papers[0].sourceTextCharacters * 0.6);
});

test('recovers a stored PDF body from its Markdown file when Mongo source text is empty', async () => {
  const { collection, modelInput, service } = fixture({
    sourceTextLoader: async () =>
      '[Page 1]\n[Section: Introduction]\nRECOVERED-MARKDOWN-BODY describes natural 3D sketching.',
    openAIRequest: async () => '저장된 Markdown 본문을 읽었습니다.',
  });
  await service.sync('garden', workspace());
  collection.document.papers[0].sourceTextGzip = null;
  collection.document.papers[0].sourceTextCharacters = 0;

  const response = await service.chat('garden', 'ILoveSketch 본문에서 무엇을 제안해?');

  assert.match(modelInput(), /RECOVERED-MARKDOWN-BODY/);
  assert.equal(response.messages.at(-1).readingReport.mode, 'focused-chunks');
  assert.ok(response.messages.at(-1).readingReport.papers[0].sourceTextCharacters > 0);
});

test('reads a complete PDF directly when it fits the input token budget', async () => {
  const completeBody = [
    '[Page 1] Beginning of the argument.',
    'Middle method and evaluation evidence.',
    '[Page 8] End of the paper and limitations.',
  ].join('\n\n');
  const { modelInput, service } = fixture({
    sourceTextLoader: async () => completeBody,
    openAIRequest: async () =>
      'ILoveSketch 본문 전체의 논증과 한계를 종합했습니다.',
  });
  await service.sync('garden', workspace());

  const response = await service.chat(
    'garden',
    '이 PDF 본문 전체를 처음부터 끝까지 읽어보고 알려줘',
    ['paper-ilovesketch'],
  );
  const report = response.messages.at(-1).readingReport;

  assert.equal(report.mode, 'full-text');
  assert.equal(report.offerFullTextReview, false);
  assert.equal(report.papers[0].coverage, 'full-text');
  assert.match(modelInput(), /Beginning of the argument/);
  assert.match(modelInput(), /End of the paper and limitations/);
});

test('reads an oversized PDF in ordered passes and synthesizes every pass', async () => {
  const longBody = [
    '[Page 1] BEGINNING-CONTEXT',
    'method evidence and discussion. '.repeat(7_200),
    '[Page 40] ENDING-LIMITATIONS',
  ].join('\n');
  const requests = [];
  const { service } = fixture({
    sourceTextLoader: async () => longBody,
    openAIRequest: async (request) => {
      requests.push(request);
      if (request.instructions.includes('complete-paper reading pipeline')) {
        return `Pass summary ${requests.length}: ${request.input.includes('BEGINNING-CONTEXT') ? 'beginning' : ''} ${request.input.includes('ENDING-LIMITATIONS') ? 'ending' : ''}`;
      }
      return 'ILoveSketch의 긴 본문 전체 흐름을 청크별로 읽고 종합했습니다.';
    },
  });
  await service.sync('garden', workspace());

  const response = await service.chat(
    'garden',
    '이 PDF 원문 전체를 읽고 흐름과 한계를 알려줘',
    ['paper-ilovesketch'],
  );
  const report = response.messages.at(-1).readingReport;
  const passRequests = requests.filter((request) =>
    request.instructions.includes('complete-paper reading pipeline'));
  const finalRequest = requests.at(-1);

  assert.equal(report.mode, 'chunked-full-text');
  assert.equal(report.papers[0].coverage, 'full-text');
  assert.ok(report.papers[0].chunkCount >= 2);
  assert.ok(passRequests.some((request) => request.input.includes('BEGINNING-CONTEXT')));
  assert.ok(passRequests.some((request) => request.input.includes('ENDING-LIMITATIONS')));
  assert.match(finalRequest.input, /Pass summary/);
});

test('retrieves a named paper contribution from 50 PDFs without sending every full text', async () => {
  const contribution = [
    'In summary, our work has the following primary contributions.',
    'We present an immersive literature foraging system and an observational study.',
  ].join(' ');
  const { modelInput, service } = fixture({
    sourceTextLoader: async (_workspaceId, paper) => paper.title.startsWith('LITFORAGER:')
      ? `${'unrelated introduction material. '.repeat(1_500)} ${contribution}`
      : 'unrelated background material. '.repeat(1_000),
    openAIRequest: async () =>
      'LITFORAGER의 핵심 기여는 immersive literature foraging system입니다.',
  });
  const state = workspace({ includePaper: false, includeNote: false });
  state.objects = Array.from({ length: 50 }, (_, index) => ({
    id: `paper-${index}`,
    type: 'GX.MAROScientificPaper',
    title: index === 37
      ? 'LITFORAGER: Exploring Multimodal Literature Foraging Strategies in Immersive Sensemaking'
      : `Background Research Paper ${String(index).padStart(2, '0')}`,
    authors: [`Author ${index}`],
    year: '2025',
    venue: 'CHI',
    abstract: index === 37 ? 'A system for immersive literature foraging.' : 'Background research.',
    fileId: `pdf-${index}`,
    pageIndex: 0,
    pageCount: 10,
    x: index * 10,
    y: 0,
    width: 342,
    height: 444,
    zIndex: index,
    highlights: [],
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  }));

  await service.sync('garden', state);
  const response = await service.chat('garden', 'litforager가 주장하는 핵심 기여가 뭐야?');

  assert.match(modelInput(), /following primary contributions/);
  assert.equal(response.sources[0].title.startsWith('LITFORAGER:'), true);
  assert.equal(response.sources.length, 1);
  assert.ok(modelInput().length < 100_000);
});

test('searches full text across a large board and preserves paper diversity for broad questions', async () => {
  const relevant = new Set([4, 18, 27]);
  const { modelInput, service } = fixture({
    sourceTextLoader: async (_workspaceId, paper) => {
      const index = Number(paper.id.split('-').at(-1));
      return relevant.has(index)
        ? 'This work directly supports scholarly literature search, contextual retrieval, and research sensemaking.'
        : 'This work studies an unrelated interaction technique and device evaluation.';
    },
    openAIRequest: async () =>
      'Relevant Study 04, Relevant Study 18, Relevant Study 27의 세 편이 직접 다룹니다.',
  });
  const state = workspace({ includePaper: false, includeNote: false });
  state.objects = Array.from({ length: 30 }, (_, index) => ({
    id: `paper-${index}`,
    type: 'GX.MAROScientificPaper',
    title: relevant.has(index)
      ? `Relevant Study ${String(index).padStart(2, '0')}`
      : `Background Study ${String(index).padStart(2, '0')}`,
    authors: [`Author ${index}`],
    year: '2026',
    venue: 'CHI',
    abstract: 'An empirical investigation.',
    fileId: `pdf-${index}`,
    pageIndex: 0,
    pageCount: 8,
    x: index * 10,
    y: 0,
    width: 342,
    height: 444,
    zIndex: index,
    highlights: [],
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  }));

  await service.sync('garden', state);
  const response = await service.chat(
    'garden',
    '논문 검색이나 학술문헌 컨텍스트를 직접 다루는 논문은 몇 편이야?',
  );

  for (const index of relevant) {
    assert.match(modelInput(), new RegExp(`Relevant Study ${String(index).padStart(2, '0')}`));
  }
  assert.deepEqual(response.sources.map((source) => source.title), [
    'Relevant Study 04',
    'Relevant Study 18',
    'Relevant Study 27',
  ]);
  assert.ok(modelInput().length < 110_000);
});

test('coalesces queued large-board syncs to the newest saved revision', async () => {
  const collection = new MemoryCollection();
  let releaseFirstLoad;
  let sourceLoads = 0;
  const firstLoad = new Promise((resolve) => {
    releaseFirstLoad = resolve;
  });
  const service = createLLMWikiService({
    getCollection: () => collection,
    markdownStore: new MemoryMarkdownStore(),
    sourceTextLoader: async () => {
      sourceLoads += 1;
      if (sourceLoads === 1) await firstLoad;
      return 'Cached full PDF text.';
    },
    openAIRequest: async () => 'unused',
  });

  const first = service.sync('garden', workspace({ revision: 1, x: 100 }));
  while (sourceLoads === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = service.sync('garden', workspace({ revision: 2, x: 200 }));
  const third = service.sync('garden', workspace({ revision: 3, x: 300 }));
  releaseFirstLoad();

  const [firstResult, secondResult, thirdResult] = await Promise.all([
    first,
    second,
    third,
  ]);
  assert.equal(firstResult.revision, 1);
  assert.equal(secondResult.revision, 3);
  assert.equal(thirdResult.revision, 3);
  assert.equal(collection.document.revision, 3);
  assert.equal(collection.document.papers[0].position.x, 300);
});

test('accepts a background sync before a large PDF load completes', async () => {
  let releaseLoad;
  const loadPending = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const { service } = fixture({
    sourceTextLoader: async () => {
      await loadPending;
      return 'Full PDF text.';
    },
  });

  const receipt = service.requestSync('garden', workspace({ revision: 7 }));

  assert.deepEqual(receipt, {
    workspaceId: 'garden',
    requestedRevision: 7,
    accepted: true,
  });
  releaseLoad();
});

test('uses the currently selected paper when the question omits its title', async () => {
  const { modelInput, service } = fixture({
    sourceTextLoader: async () =>
      'The selected paper makes a primary contribution to interactive 3D sketching.',
    openAIRequest: async () =>
      'ILoveSketch의 핵심 기여는 대화형 3D 스케치 방식입니다.',
  });
  await service.sync('garden', workspace());

  const response = await service.chat(
    'garden',
    '이 논문의 핵심 기여가 뭐야?',
    ['paper-ilovesketch'],
  );

  assert.match(modelInput(), /# Focused paper reading mode/);
  assert.match(modelInput(), /Selection reason: 캔버스에서 선택된 논문/);
  assert.equal(response.messages.at(-1).readingReport.mode, 'focused-chunks');
  assert.deepEqual(response.sources.map((source) => source.id), [
    'paper-ilovesketch',
  ]);
});

test('does not publish an in-list search-result PDF preview to the Wiki', async () => {
  const { service, sourceLoads } = fixture();
  const state = workspace({ includeNote: false });
  state.objects[0].searchResultPreview = true;

  const result = await service.sync('garden', state);

  assert.equal(result.counts.papers, 0);
  assert.equal(sourceLoads(), 0);
  assert.deepEqual(result.papers, []);
});

test('returns board-shared chat history and grounds follow-up questions in it', async () => {
  const { modelInput, service } = fixture();
  await service.sync('garden', workspace());
  await service.chat('garden', 'ILoveSketch 저자가 누구야?');
  const status = await service.status('garden');

  assert.equal(status.messages.length, 2);
  assert.equal(status.messages[0].role, 'user');
  assert.match(status.messages[1].text, /Seok-Hyung Bae/);

  await service.chat('garden', '그중 첫 번째 저자는?');
  assert.match(modelInput(), /Shared recent conversation/);
  assert.match(modelInput(), /ILoveSketch 저자가 누구야/);
});

test('accepts chat immediately and stores the answer behind the persisted question', async () => {
  let releaseAnswer;
  const answerPending = new Promise((resolve) => {
    releaseAnswer = resolve;
  });
  const { collection, service } = fixture({
    openAIRequest: async () => answerPending,
  });
  await service.sync('garden', workspace());

  const receipt = await service.enqueueChat(
    'garden',
    'ILoveSketch 저자가 누구야?',
    'request-1',
  );

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.messages.at(-1).id, 'request-1');
  assert.equal(collection.document.chatMessages.length, 1);
  assert.equal(collection.document.chatMessages[0].role, 'user');

  releaseAnswer('저자는 세 명입니다.');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (collection.document.chatMessages.length === 2) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(collection.document.chatMessages.length, 2);
  assert.equal(collection.document.chatMessages[0].id, 'request-1');
  assert.equal(collection.document.chatMessages[1].role, 'assistant');
  assert.equal(collection.document.chatMessages[1].replyTo, 'request-1');
});

test('deduplicates a retried queued question by its request id', async () => {
  let releaseAnswer;
  const answerPending = new Promise((resolve) => {
    releaseAnswer = resolve;
  });
  const { collection, service } = fixture({
    openAIRequest: async () => answerPending,
  });
  await service.sync('garden', workspace());

  await service.enqueueChat('garden', '같은 질문', 'request-1');
  await service.enqueueChat('garden', '같은 질문', 'request-1');

  assert.equal(collection.document.chatMessages.length, 1);
  releaseAnswer('답변');
});

test('clears the complete shared chat history for the board', async () => {
  const { collection, service } = fixture();
  await service.sync('garden', workspace());
  await service.chat('garden', 'ILoveSketch 저자가 누구야?');

  const result = await service.clearChat('garden');

  assert.deepEqual(result.messages, []);
  assert.deepEqual(collection.document.chatMessages, []);
  assert.deepEqual((await service.status('garden')).messages, []);
});

test('organizes attached and independent canvas post-its with their locations', async () => {
  const { markdownStore, service } = fixture();
  const state = workspace();
  state.objects.push({
    id: 'canvas-note-1',
    type: 'GX.MARONote',
    text: 'Independent canvas thought.',
    color: '#fff09b',
    x: 880,
    y: 640,
    width: 120,
    height: 120,
    zIndex: 8,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  });

  const result = await service.sync('garden', state);
  const postIts = [...markdownStore.files.entries()]
    .find(([filePath]) => filePath.endsWith('/post-its.md'));

  assert.equal(result.counts.notes, 2);
  assert.equal(result.counts.attachedNotes, 1);
  assert.equal(result.counts.canvasNotes, 1);
  assert.ok(postIts);
  assert.match(postIts[1], /attached to paper/);
  assert.match(postIts[1], /PDF page: 5/);
  assert.match(postIts[1], /Independent canvas thought/);
  assert.match(postIts[1], /"x":880/);
  assert.match(result.latestLogMarkdown, /Data transferred by post-it/);
});

test('persists citation arrows, search nodes, and generated Markdown in MongoDB', async () => {
  const { collection, markdownStore, modelInput, service } = fixture();
  const state = workspace();
  state.objects.push(
    {
      id: 'paper-related',
      type: 'GX.MAROScientificPaper',
      title: 'EverybodyLovesSketch',
      authors: ['Seok-Hyung Bae'],
      year: '2009',
      venue: 'UIST',
      abstract: 'A broader-audience 3D sketching system.',
      fileId: '',
      pageIndex: 0,
      pageCount: 8,
      x: 520,
      y: 200,
      width: 342,
      height: 444,
      zIndex: 4,
      highlights: [],
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    },
    {
      id: 'citation-link-1',
      type: 'GX.MAROLink',
      startPaperId: 'paper-ilovesketch',
      endPaperId: 'paper-related',
      label: 'extends interaction technique',
      relationshipInfo: 'The later paper adapts the sketching interaction.',
      citationContextParagraph: 'EverybodyLovesSketch extends ILoveSketch.',
      referenceText: 'EverybodyLovesSketch: 3D sketching for a broader audience.',
      citationHitId: 'b12',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      zIndex: 2,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    },
    {
      id: 'search-node-1',
      type: 'GX.MAROBlankPaper',
      paperKind: 'search',
      query: '3D sketching interfaces',
      searchType: 'normal',
      resultCount: 1,
      aiSearchEnabled: true,
      x: 900,
      y: 100,
      width: 342,
      height: 444,
      zIndex: 8,
      searchSnapshot: {
        version: 1,
        query: '3D sketching interfaces',
        contextKey: '',
        results: [{
          paperId: 'search-result-1',
          title: 'Sketching With Hands',
          authors: ['A. Researcher'],
          year: 2024,
          venue: 'CHI',
          citationCount: 7,
          url: 'https://example.org/result',
          abstract: 'A hand-based sketching interface.',
          relevanceExplanation: 'Directly studies spatial sketching.',
        }],
        total: 1,
        nextOffset: 1,
        hasMore: false,
        retrievalQuery: 'spatial 3D sketching interaction',
        rankingProvider: 'OpenAI',
        notice: '',
        savedAt: '2026-08-17T00:00:00.000Z',
        layer: {
          version: 1,
          id: 'layer-1',
          name: '검색 · 3D sketching interfaces',
          visible: true,
          nodes: [{
            paperId: 'search-result-1',
            x: 70,
            y: 0,
            width: 214,
            height: 252,
            reviewState: 'understood',
          }],
        },
      },
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    },
  );

  const result = await service.sync('garden', state);
  await service.chat('garden', '인용 관계와 검색 결과를 알려줘');
  const relationships = markdownStore.files.get(result.relationshipsPath);
  const searchResults = markdownStore.files.get(result.searchResultsPath);

  assert.equal(result.counts.relationships, 1);
  assert.equal(result.counts.searchNodes, 1);
  assert.equal(result.counts.searchResults, 1);
  assert.match(relationships, /ILoveSketch → EverybodyLovesSketch/);
  assert.match(relationships, /extends interaction technique/);
  assert.match(searchResults, /3D sketching interfaces/);
  assert.match(searchResults, /Sketching With Hands/);
  assert.match(searchResults, /"x":1312/);
  assert.match(modelInput(), /Citation and canvas relationships/);
  assert.match(modelInput(), /Search nodes and saved results/);
  assert.ok(collection.document.markdownDocuments.length >= 6);
  assert.ok(collection.document.markdownDocuments.every(
    (item) => Number.isInteger(item.characters) && item.characters > 0,
  ));
  assert.ok(collection.document.markdownDocuments.every(
    (item) => item.markdown === undefined,
  ));
  assert.match(result.latestLogMarkdown, /Relationships added \/ updated \/ deleted/);
  assert.match(result.latestLogMarkdown, /Search nodes transferred/);
});

test('queues a missing stored PDF for Bridge collection and exposes its ingestion status', async () => {
  const collection = new MemoryCollection();
  const bridgeRequests = [];
  const service = createLLMWikiService({
    getCollection: () => collection,
    markdownStore: new MemoryMarkdownStore(),
    sourceTextLoader: async () => {
      const error = new Error('The specified key does not exist.');
      error.name = 'NoSuchKey';
      throw error;
    },
    pdfBridgeRegistrar: async (request) => {
      bridgeRequests.push(request);
      return { status: 'ok' };
    },
    openAIRequest: async () => 'unused',
  });

  const result = await service.sync('garden', workspace());

  assert.equal(bridgeRequests.length, 1);
  assert.equal(bridgeRequests[0].fileId, 'pdf-1');
  assert.equal(result.papers[0].sourceStatus, 'waiting-for-pdf-bridge');
  assert.equal(result.papers[0].sourceTextCharacters, 0);
});
