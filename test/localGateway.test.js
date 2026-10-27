const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('HTTP gateway survives upgraded socket resets and upstream downtime', { timeout: 15000 }, async (t) => {
  const upstream = http.createServer((_request, response) => response.end('healthy'));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  t.after(() => upstream.close());
  upstream.on('upgrade', (_request, socket) => {
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    setTimeout(() => socket.resetAndDestroy(), 30);
  });
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const gatewayPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const gateway = spawn(process.execPath, [path.resolve(__dirname, '../scripts/local-gateway.js')], {
    env: { ...process.env, GOP_GATEWAY_PROTOCOL: 'http', GOP_GATEWAY_PORT: String(gatewayPort), GOP_GATEWAY_UPSTREAM_PORT: String(upstreamPort) },
    stdio: ['ignore','pipe','pipe'], windowsHide: true,
  });
  let errors = '';
  gateway.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(() => gateway.kill());
  await new Promise((resolve, reject) => {
    gateway.stdout.on('data', (chunk) => { if (chunk.toString().includes('Garden gateway listening')) resolve(); });
    gateway.on('exit', (code) => reject(new Error(`Gateway exited ${code}: ${errors}`)));
  });
  const address = `http://127.0.0.1:${gatewayPort}/garden-server/health`;
  assert.equal(await (await fetch(address)).text(), 'healthy');
  const downstream = net.connect(gatewayPort, '127.0.0.1');
  downstream.on('error', () => {});
  downstream.resume();
  t.after(() => downstream.destroy());
  await once(downstream, 'connect');
  downstream.write('GET /garden-server/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
  await new Promise((resolve) => downstream.once('close', resolve));
  assert.equal(gateway.exitCode, null, errors);
  assert.equal((await fetch(address)).status, 200);
  await new Promise((resolve) => upstream.close(resolve));
  assert.equal((await fetch(address)).status, 502);
  upstream.listen(upstreamPort, '127.0.0.1');
  await once(upstream, 'listening');
  assert.equal(await (await fetch(address)).text(), 'healthy');
  assert.equal(errors, '');
});
