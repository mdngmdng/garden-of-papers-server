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

function fixture() {
  const collection = new MemoryCollection();
  const markdownStore = new MemoryMarkdownStore();
  let sourceLoads = 0;
  let modelInput = '';
  let timestamp = Date.parse('2026-08-17T00:00:00.000Z');
  const bridgeRequests = [];
  const service = createLLMWikiService({
    getCollection: () => collection,
    markdownStore,
    sourceTextLoader: async () => {
      sourceLoads += 1;
      return 'ILoveSketch full PDF text from the cached TEI document.';
    },
    openAIRequest: async ({ input }) => {
      modelInput = input;
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
  const { markdownStore, service, sourceLoads } = fixture();
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

test('does not let an older workspace revision overwrite a newer Wiki snapshot', async () => {
  const { collection, service } = fixture();
  await service.sync('garden', workspace({ revision: 2, x: 500 }));
  const result = await service.sync('garden', workspace({ revision: 1, x: 100 }));

  assert.equal(result.revision, 2);
  assert.equal(collection.document.papers[0].position.x, 500);
});

test('grounds chat in the complete catalog and the selected paper Markdown', async () => {
  const { collection, modelInput, service } = fixture();
  await service.sync('garden', workspace());
  const response = await service.chat('garden', 'ILoveSketch 저자가 누구야?');

  assert.match(response.answer, /Seok-Hyung Bae/);
  assert.match(modelInput(), /Complete paper catalog/);
  assert.match(modelInput(), /Karan Singh/);
  assert.equal(response.sources[0].title, 'ILoveSketch');
  assert.equal(response.messages.length, 2);
  assert.equal(collection.document.chatMessages.length, 2);
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
  assert.ok(collection.document.markdownDocuments.every((item) => item.markdown));
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
