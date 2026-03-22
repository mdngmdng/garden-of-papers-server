const { spawn } = require('child_process');
const path = require('path');

function spawnUdpRelay() {
  const scriptPath = path.join(__dirname, '../../udp-relay/server.py');
  const cmd = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawn(cmd, [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    console.log(`[UDP] ${data.toString().trim()}`);
  });

  child.stderr.on('data', (data) => {
    console.error(`[UDP] ${data.toString().trim()}`);
  });

  child.on('error', (err) => {
    console.error(`[UDP] Failed to start: ${err.message}`);
  });

  child.on('close', (code) => {
    console.log(`[UDP] Process exited with code ${code}`);
  });

  // Node.js 종료 시 Python도 종료
  process.on('exit', () => child.kill());
  process.on('SIGINT', () => { child.kill(); process.exit(); });
  process.on('SIGTERM', () => { child.kill(); process.exit(); });

  console.log('[UDP] Relay server spawned');
}

module.exports = { spawnUdpRelay };
