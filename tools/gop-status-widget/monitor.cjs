'use strict';
const DEFAULT_ENDPOINT = 'https://garden-of-papers.ngrok.app/garden-server/health';
const INTERVAL_MS = 60_000;
const TIMEOUT_MS = 6_000;

function normalizeEndpoint(value) {
  const url = new URL(String(value).trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTPS health URL without credentials or query parameters.');
  return url.href;
}

async function probe(url, { fetcher = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const start = Date.now();
  try {
    const response = await fetcher(url, {
      headers: { accept: 'application/json', 'ngrok-skip-browser-warning': 'true' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}`, ms: Date.now() - start };
    const payload = await response.json();
    // An ngrok/browser warning or unrelated HTTP 200 page is not a healthy GOP API.
    if (payload?.status !== 'ok' || payload?.capabilities?.workspaceSync?.protocolVersion !== 2)
      return { ok: false, detail: 'Unexpected health response', ms: Date.now() - start };
    return { ok: true, detail: 'Responding', ms: Date.now() - start };
  } catch (error) {
    return { ok: false, detail: ['TimeoutError', 'AbortError'].includes(error.name) ? 'Request timed out' : 'Connection failed', ms: Date.now() - start };
  }
}

function summarize(remote, local, failures) {
  if (remote.ok) return { level: local && !local.ok ? 'warning' : 'online',
    title: local && !local.ok ? 'Public server online' : 'All systems reachable',
    detail: local && !local.ok ? 'The server on this computer is not responding.' : 'Garden of Papers is ready to use.' };
  if (failures < 2) return { level: 'warning', title: 'Connection interrupted', detail: 'One check failed. The next check will confirm.' };
  if (local?.ok) return { level: 'offline', title: 'Public connection down', detail: 'Local server is up. Check ngrok or this computer’s internet connection.' };
  return { level: 'offline', title: 'Server unreachable', detail: 'The server, tunnel, or network may be unavailable.' };
}
module.exports = { DEFAULT_ENDPOINT, INTERVAL_MS, TIMEOUT_MS, normalizeEndpoint, probe, summarize };
