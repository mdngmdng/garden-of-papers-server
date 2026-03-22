const { v4: uuidv4 } = require('uuid');

// WebSocket 클라이언트 관리
const clients = new Map();

// 업로드 키 동시성 제어
const projectUploadKeys = new Map();   // projectName → uploadKey
const clientUploadKeys = new Map();    // wsId → uploadKey
const clientProjects = new Map();      // wsId → projectName

function registerClient(wsId) {
  clientUploadKeys.set(wsId, '');
}

function removeClient(wsId) {
  const projectName = clientProjects.get(wsId);

  clientUploadKeys.delete(wsId);
  clientProjects.delete(wsId);

  // 같은 프로젝트에 연결된 다른 클라이언트가 없으면 프로젝트 키 삭제
  if (projectName) {
    let projectStillInUse = false;
    clientProjects.forEach((value) => {
      if (value === projectName) projectStillInUse = true;
    });
    if (!projectStillInUse) {
      projectUploadKeys.delete(projectName);
    }
  }
}

function onLoadData(wsId, projectName) {
  if (!projectUploadKeys.has(projectName)) {
    const key = 'start';
    projectUploadKeys.set(projectName, key);
    clientUploadKeys.set(wsId, key);
  } else {
    clientUploadKeys.set(wsId, projectUploadKeys.get(projectName));
  }
  clientProjects.set(wsId, projectName);
}

function checkKey(wsId, projectName) {
  return clientUploadKeys.get(wsId) === projectUploadKeys.get(projectName);
}

function rotateKey(wsId, projectName) {
  const newKey = uuidv4();
  clientUploadKeys.set(wsId, newKey);
  projectUploadKeys.set(projectName, newKey);
}

// 프로젝트에 연결된 모든 클라이언트에게 메시지 전송
function broadcastToProject(projectName, message) {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);

  clientProjects.forEach((proj, wsId) => {
    if (proj === projectName) {
      const ws = clients.get(wsId);
      if (ws && ws.readyState === 1) { // WebSocket.OPEN === 1
        ws.send(payload);
      }
    }
  });
}

function debugLog() {
  clientProjects.forEach((v, k) => console.log(`client ${k} mongoDB: ${v}`));
  projectUploadKeys.forEach((v, k) => console.log(`MongoDB ${k} key: ${v}`));
  clientUploadKeys.forEach((v, k) => console.log(`Client ${k}: ${v}`));
}

module.exports = {
  clients,
  registerClient,
  removeClient,
  onLoadData,
  checkKey,
  rotateKey,
  broadcastToProject,
  debugLog,
};
