'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const listenHost = process.env.GOP_GATEWAY_HOST || '127.0.0.1';
const listenPort = Number(process.env.GOP_GATEWAY_PORT || 8081);
const publicPrefix = normalizePrefix(
  process.env.GOP_GATEWAY_PREFIX || '/garden-server',
);
const upstreamHost = process.env.GOP_GATEWAY_UPSTREAM_HOST || '127.0.0.1';
const upstreamPort = Number(process.env.GOP_GATEWAY_UPSTREAM_PORT || 5002);
const bundledTlsPemPath = path.resolve(
  __dirname,
  '../../gop-web/node_modules/.vite/iwsdk-https/_cert.pem',
);
const hasBundledTlsPem = fs.existsSync(bundledTlsPemPath);
const tlsKeyPath = process.env.GOP_GATEWAY_TLS_KEY
  || (hasBundledTlsPem
    ? bundledTlsPemPath
    : path.resolve(__dirname, 'local-gateway-key.pem'));
const tlsCertPath = process.env.GOP_GATEWAY_TLS_CERT
  || (hasBundledTlsPem
    ? bundledTlsPemPath
    : path.resolve(__dirname, 'local-gateway-cert.pem'));

function normalizePrefix(value) {
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/u, '') || '/';
}

function rewritePath(requestUrl = '/') {
  const url = new URL(requestUrl, 'https://localhost');
  if (publicPrefix === '/') return `${url.pathname}${url.search}`;
  if (url.pathname === publicPrefix) return `/${url.search}`;
  if (!url.pathname.startsWith(`${publicPrefix}/`)) return null;
  return `${url.pathname.slice(publicPrefix.length)}${url.search}`;
}

function upstreamHeaders(headers) {
  return {
    ...headers,
    host: `${upstreamHost}:${upstreamPort}`,
    'x-forwarded-host': headers.host || '',
    'x-forwarded-prefix': publicPrefix,
    'x-forwarded-proto': 'https',
  };
}

function writeGatewayError(response, statusCode, message) {
  const body = JSON.stringify({ error: message });
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

const tlsKey = fs.readFileSync(tlsKeyPath);
const tlsCert = fs.readFileSync(tlsCertPath);
const server = https.createServer(
  { key: tlsKey, cert: tlsCert },
  (request, response) => {
    const targetPath = rewritePath(request.url);
    if (targetPath === null) {
      writeGatewayError(response, 404, `Expected a ${publicPrefix} path.`);
      return;
    }

    const proxyRequest = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: request.method,
        path: targetPath,
        headers: upstreamHeaders(request.headers),
      },
      (proxyResponse) => {
        response.writeHead(
          proxyResponse.statusCode || 502,
          proxyResponse.statusMessage,
          proxyResponse.headers,
        );
        proxyResponse.pipe(response);
      },
    );

    proxyRequest.on('error', (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      writeGatewayError(response, 502, 'Garden server upstream is unavailable.');
    });
    request.on('aborted', () => proxyRequest.destroy());
    request.pipe(proxyRequest);
  },
);

server.on('upgrade', (request, socket, head) => {
  const targetPath = rewritePath(request.url);
  if (targetPath === null) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }

  const proxyRequest = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: targetPath,
    headers: upstreamHeaders(request.headers),
  });

  proxyRequest.on('upgrade', (proxyResponse, proxySocket, proxyHead) => {
    const statusLine = [
      `HTTP/${proxyResponse.httpVersion}`,
      proxyResponse.statusCode,
      proxyResponse.statusMessage,
    ].join(' ');
    const responseHeaders = Object.entries(proxyResponse.headers)
      .flatMap(([name, value]) => {
        if (Array.isArray(value)) return value.map((item) => `${name}: ${item}`);
        return value === undefined ? [] : [`${name}: ${value}`];
      });
    socket.write(`${statusLine}\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    socket.pipe(proxySocket).pipe(socket);
  });
  proxyRequest.on('response', (proxyResponse) => {
    socket.end(
      `HTTP/1.1 ${proxyResponse.statusCode || 502} Bad Gateway\r\nConnection: close\r\n\r\n`,
    );
    proxyResponse.resume();
  });
  proxyRequest.on('error', () => {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  proxyRequest.end();
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(listenPort, listenHost, () => {
  console.log(
    `Garden gateway listening on https://${listenHost}:${listenPort}${publicPrefix} -> http://${upstreamHost}:${upstreamPort}`,
  );
});
