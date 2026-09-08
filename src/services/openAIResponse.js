// Only a completed, final assistant message may become a user-visible answer.
function responseError(payload, code) {
  return Object.assign(new Error('OpenAI did not return a completed final answer'), {
    code, responseId: payload?.id, responseStatus: payload?.status,
    incompleteReason: payload?.incomplete_details?.reason,
  });
}

function outputText(payload) {
  if (payload?.status !== 'completed') throw responseError(payload, 'openai_incomplete_response');
  const messages = (payload.output || []).filter((item) => item?.type === 'message'
    && item.role === 'assistant'
    && (!item.phase || item.phase === 'final_answer')
    && (!item.channel || item.channel === 'final'));
  const message = messages.at(-1);
  if (!message || message.status !== 'completed') throw responseError(payload, 'openai_nonfinal_response');
  if (message.content?.some((part) => part.type === 'refusal')) throw responseError(payload, 'openai_refusal');
  const text = (message.content || []).filter((part) => part.type === 'output_text')
    .map((part) => typeof part.text === 'string' ? part.text : '').join('\n\n').trim();
  if (!text) throw responseError(payload, 'openai_empty_response');
  return text;
}

module.exports = { outputText };
