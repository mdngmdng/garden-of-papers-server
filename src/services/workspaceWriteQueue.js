// Admit writes in arrival order, before JSON body parsing. Otherwise a small
// PATCH can overtake a slow full-board PUT repeatedly, making the slower tab's
// conflict-recovery upload obsolete before it even reaches the CAS check.
// Revision validation still happens in the snapshot service; this never merges
// or accepts stale content by itself. Unrelated boards and reads remain free.
function createWorkspaceWriteQueue({ timeoutMs = 60_000 } = {}) {
  const tails = new Map();
  return (req, res, next) => {
    const match = /^\/api\/workspaces\/([^/]+)\/?$/u.exec(req.path);
    if (!match || !['PUT', 'PATCH'].includes(req.method)) return next();
    const key = match[1];
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const completed = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => completed);
    tails.set(key, tail);
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      res.removeListener('finish', finish);
      res.removeListener('close', finish);
      release();
    };
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(408).json({ error: 'Workspace save request timed out', code: 'request_timeout' });
      else res.destroy();
      finish();
    }, timeoutMs);
    timer.unref?.();
    res.once('finish', finish);
    res.once('close', finish);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    void previous.then(() => { if (!closed) next(); });
  };
}

module.exports = { createWorkspaceWriteQueue };
