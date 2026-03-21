const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const syncKeys = require('./syncKeys');

function createWebSocketServer(wsPort) {
  const wss = new WebSocket.Server({ port: wsPort });

  wss.on('connection', (ws) => {
    const id = uuidv4();
    syncKeys.clients.set(id, ws);
    syncKeys.registerClient(id);
    ws.id = id;

    console.log('A client has connected with id:', id);

    ws.on('message', (message) => {
      const jsonMessage = JSON.stringify({ message });

      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(jsonMessage);
        }
      });
    });

    ws.on('close', () => {
      syncKeys.clients.delete(id);
      syncKeys.removeClient(id);
      console.log('Client disconnected:', id);
      syncKeys.debugLog();
    });

    ws.send(id);
  });

  console.log(`WebSocket server running on port ${wsPort}`);
  return wss;
}

module.exports = { createWebSocketServer };
