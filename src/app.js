const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const http = require('http');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { connect } = require('./services/mongo');
const { createWebSocketServer } = require('./services/websocket');
const { spawnUdpRelay } = require('./services/udpRelay');

// Routes
const projectsRouter = require('./routes/projects');
const dataRouter = require('./routes/data');
const pdfRouter = require('./routes/pdf');
const papersRouter = require('./routes/papers');
const analyzeRouter = require('./routes/analyze');

const app = express();

// Middleware
app.use(cors({
  origin: config.origin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

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

const server = http.createServer(app);

// Start
connect()
  .then(() => {
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
