// Overall work and a silent connection have different limits. Incoming model
// events renew only the idle deadline; the overall deadline is never extended.
function researchDeadline({ signal: parentSignal, timeoutMs, idleTimeoutMs }) {
  const controller = new AbortController();
  const abort = (code, duration) => {
    const error = new Error(code === 'research_idle_timeout'
      ? `GPT 조사에서 ${Math.round(duration / 1000)}초 동안 새 응답 이벤트를 받지 못했습니다.`
      : `GPT 조사가 최대 허용 시간 ${Math.round(duration / 1000)}초를 초과했습니다.`);
    error.name = 'TimeoutError';
    error.details = { code, timeoutMs: duration };
    controller.abort(error);
  };
  const total = setTimeout(() => abort('research_total_timeout', timeoutMs), timeoutMs);
  total.unref?.();
  let idle;
  const touch = () => {
    clearTimeout(idle);
    if (controller.signal.aborted || parentSignal?.aborted) return;
    idle = setTimeout(() => abort('research_idle_timeout', idleTimeoutMs), idleTimeoutMs);
    idle.unref?.();
  };
  const dispose = () => { clearTimeout(total); clearTimeout(idle); };
  touch();
  return { signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal,
    touch, dispose };
}

module.exports = { researchDeadline };
