// @ts-check
/**
 * Pure mapping from @github/copilot-sdk session events to normalized
 * HarnessEvents. Kept free of I/O so it can be unit-tested with recorded
 * events and reused by anything that already holds an SDK session.
 *
 * Field names verified against @github/copilot-sdk 1.0.13
 * dist/generated/session-events.d.ts (see the adapter header). The
 * end-of-turn rule mirrors the SDK's own sendAndWait (dist/session.js):
 * `session.idle` ends the turn unless `data.mode === "autopilot"`.
 */

/** @typedef {import('../../index.js').HarnessEvent} HarnessEvent */

/**
 * @param {{ turn?: number }} [opts]
 */
export function createSdkEventMapper(opts = {}) {
  const turn = opts.turn;
  let snapshot = '';
  let finalText = '';
  let sawFinal = false;

  return {
    get snapshot() {
      return snapshot;
    },
    get finalText() {
      return sawFinal ? finalText : snapshot;
    },
    /**
     * @param {{ type: string, data?: any }} event
     * @returns {{ event: HarnessEvent, done: boolean }}
     */
    map(event) {
      const data = event?.data || {};
      const base = { source: /** @type {const} */ ('copilot-sdk'), raw: event, turn };
      switch (event?.type) {
        case 'assistant.message_delta':
          snapshot += data.deltaContent || '';
          return { event: { type: 'text.delta', delta: data.deltaContent || '', snapshot, replaced: false, messageId: data.messageId, ...base }, done: false };
        case 'assistant.message':
          finalText = data.content ?? snapshot;
          sawFinal = true;
          snapshot = '';
          return { event: { type: 'text.final', text: finalText, messageId: data.messageId, model: data.model, citations: data.citations, ...base }, done: false };
        case 'assistant.reasoning_delta':
          return { event: { type: 'reasoning.delta', delta: data.deltaContent || '', ...base }, done: false };
        case 'assistant.intent':
          return { event: { type: 'status', text: data.intent || '', ...base }, done: false };
        case 'tool.execution_start':
          return { event: { type: 'tool.start', id: data.toolCallId, name: data.toolName, args: data.arguments, mcpServer: data.mcpServerName, ...base }, done: false };
        case 'tool.execution_complete':
          return { event: { type: 'tool.end', id: data.toolCallId, success: Boolean(data.success), result: data.result, error: data.error, ...base }, done: false };
        case 'assistant.usage':
          return { event: { type: 'usage', model: data.model, inputTokens: data.inputTokens, outputTokens: data.outputTokens, cost: data.cost, byok: Boolean(data.isByok), ...base }, done: false };
        case 'session.usage_info':
          return { event: { type: 'context', currentTokens: data.currentTokens, tokenLimit: data.tokenLimit, ...base }, done: false };
        case 'session.error':
          return { event: { type: 'error', error: new Error(data.message || 'session.error'), code: data.errorCode || data.errorType, statusCode: data.statusCode, ...base }, done: false };
        case 'session.idle': {
          const terminal = data.mode !== 'autopilot';
          return { event: { type: terminal ? 'idle' : 'status', text: terminal ? (sawFinal ? finalText : snapshot) : 'autopilot: idle between steps', aborted: Boolean(data.aborted), ...base }, done: terminal };
        }
        default:
          return { event: { type: 'raw', ...base }, done: false };
      }
    }
  };
}
