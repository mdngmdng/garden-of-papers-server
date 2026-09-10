// Stream public provider events without holding the response until EOF. Writes
// are batched and serialized; terminal events are delivered only after the
// journal has caught up, so callers cannot report an unrecorded success.
function parseSseBlock(block) {
  let eventName = '';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length || data.join('\n').trim() === '[DONE]') return null;
  const parsed = JSON.parse(data.join('\n'));
  if (!parsed.type && eventName) parsed.type = eventName;
  return parsed;
}

function publicStreamEvent(event) {
  if (event.type?.startsWith('response.reasoning_text.')
      || event.item?.type === 'reasoning' || event.part?.type === 'reasoning_text') return null;
  if (!event.response) return event;
  return { ...event, response: { ...event.response,
    output: event.response.output?.filter(item => item.type !== 'reasoning') } };
}

const terminalTypes = new Set(['response.completed', 'response.failed', 'response.incomplete']);

function auditResponseStream(response, record) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const started = performance.now();
  let buffer = '', pending = [], pendingBytes = 0, queuedBytes = 0;
  let writes = Promise.resolve(), writing = false, writeError, timer, closed = false, terminal = '';
  let eventCount = 0, lastEventType = '', lastEventAt = null;
  const diagnostics = () => ({ eventCount, lastEventType, lastEventAt, terminalEvent: terminal,
    elapsedMs: Math.round(performance.now() - started) });
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (!writing && pending.length) {
      writing = true;
      // Coalesce events arriving during a slow journal write into the next batch.
      // Enqueuing one new write every 100 ms otherwise creates minutes of backlog.
      writes = (async () => {
        try {
          while (pending.length && !writeError) {
            const events = pending;
            queuedBytes = pendingBytes; pending = []; pendingBytes = 0;
            await record('provider.stream', { events });
            queuedBytes = 0;
          }
        } catch (error) { writeError = error; }
        finally { writing = false; queuedBytes = 0; }
      })();
    }
    return writes;
  };
  const capture = block => {
    const event = parseSseBlock(block);
    if (!event) return;
    eventCount++; lastEventType = event.type;
    lastEventAt = new Date().toISOString();
    if (terminalTypes.has(event.type)) terminal = event.type;
    const body = publicStreamEvent(event);
    if (!body) return;
    const entry = { receivedAt: lastEventAt, elapsedMs: Math.round(performance.now() - started), body };
    pending.push(entry); pendingBytes += JSON.stringify(entry).length;
    if (pendingBytes >= 32 * 1024) void flush();
    else if (!timer) { timer = setTimeout(flush, 100); timer.unref?.(); }
  };
  const finish = async (error, cancelled = false) => {
    if (closed) return;
    closed = true;
    await flush();
    if (writeError) throw writeError;
    if (error) await record('provider.failed', { error: String(error), phase: 'response_stream', ...diagnostics() });
    await record('session.ended', { source: 'provider', cancelled, ...diagnostics() });
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (writeError) throw writeError;
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        for (const block of blocks) capture(block);
        if (done && buffer.trim()) { capture(buffer); buffer = ''; }
        if (terminal || queuedBytes + pendingBytes > 2 * 1024 * 1024) {
          await flush();
          if (writeError) throw writeError;
        }
        if (done) {
          await finish(); controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        let failure = error;
        try { await finish(error); } catch (journalError) { failure = journalError; }
        controller.error(failure);
        void reader.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      // Observe cancellation immediately: it can reject while the journal is
      // still being saved. An unobserved AbortError would terminate Node.
      const [cancelled, finished] = await Promise.allSettled([
        reader.cancel(reason),
        finish(null, !terminal),
      ]);
      if (finished.status === 'rejected') throw finished.reason;
      if (cancelled.status === 'rejected') throw cancelled.reason;
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

module.exports = { auditResponseStream, parseSseBlock };
