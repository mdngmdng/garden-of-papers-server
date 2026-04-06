const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const syncKeys = require('./syncKeys');

function createWebSocketServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (ws) => {
    const id = uuidv4();
    syncKeys.clients.set(id, ws);
    syncKeys.registerClient(id);
    ws.id = id;

    console.log('A client has connected with id:', id);

    ws.on('message', (message) => {
      // 클라이언트→서버 메시지 수신 (릴레이 없음, 필요 시 처리)
      console.log(`[WS] Message from ${id}:`, message.toString().substring(0, 100));
    });

    ws.on('close', () => {
      syncKeys.clients.delete(id);
      syncKeys.removeClient(id);
      console.log('Client disconnected:', id);
      syncKeys.debugLog();
    });

    ws.send(id);
  });

  console.log('WebSocket server attached to HTTP server');
  return wss;
}

module.exports = { createWebSocketServer };
