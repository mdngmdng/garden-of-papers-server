const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const http = require('http');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const { connect } = require('./services/mongo');
const { createWebSocketServer } = require('./services/websocket');
const { spawnUdpRelay } = require('./services/udpRelay');
const { studyAuditMiddleware, createAuditedProviderFetch } = require('./services/studyProviderAudit');

global.fetch = createAuditedProviderFetch(global.fetch);

// Routes
const projectsRouter = require('./routes/projects');
const dataRouter = require('./routes/data');
const pdfRouter = require('./routes/pdf');
const papersRouter = require('./routes/papers');
const analyzeRouter = require('./routes/analyze');
const extensionBridgeRouter = require('./routes/extensionBridge');
const workspaceSnapshotsRouter = require('./routes/workspaceSnapshots');
const llmWikiRouter = require('./routes/llmWiki');
const studyRecordingsRouter = require('./routes/studyRecordings');
const researchDocumentJobsRouter = require('./routes/researchDocumentJobs');

const app = express();

// Middleware
app.use(cors({
  origin: true, // allow all origins (Chrome extension + Unity)
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Range',
    'ngrok-skip-browser-warning',
    'x-gop-study-context',
  ],
  exposedHeaders: [
    'Accept-Ranges',
    'Content-Range',
    'Content-Length',
    'ETag',
    'Last-Modified',
    'Retry-After',
    'x-gop-idempotent-replay',
  ],
  credentials: true,
}));
// Workspace payloads contain highly compressible citation and note JSON.
// Compressing them prevents multi-megabyte boards from spending most of their
// load deadline crossing the public tunnel to the browser.
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(studyAuditMiddleware);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 기존 MARO 서버 엔드포인트 (Unity 클라이언트 호환)
app.use('/', projectsRouter);
app.use('/', dataRouter);
app.use('/', pdfRouter);

// 새로운 논문 관리 API
app.use('/papers', papersRouter);

// LLM 분석 API
app.use('/analyze', analyzeRouter);

// Chrome 확장 프로그램 브릿지
app.use('/extension', extensionBridgeRouter);

// Web client durable workspace snapshots (single-document MongoDB CAS)
app.use('/api', workspaceSnapshotsRouter);

// Automatic canvas -> Markdown wiki sync and workspace-grounded chat.
app.use('/api/llm-wiki', llmWikiRouter);
app.use('/api/study-recordings', studyRecordingsRouter);
app.use('/api/research-document-jobs', researchDocumentJobsRouter);

const server = http.createServer(app);

// Start
connect()
  .then(async () => {
    await require('./services/researchDocumentJobs').researchDocumentJobs().start();
    server.listen(config.port, () => {
      console.log(`HTTP + WebSocket server running on port ${config.port}`);
    });
    createWebSocketServer(server);
    spawnUdpRelay();
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });

module.exports = app;
