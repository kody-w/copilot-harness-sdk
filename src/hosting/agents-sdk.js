// @ts-check
/**
 * Serve any HarnessClient as a Microsoft 365 Agents SDK agent, so the same
 * agent answers in Teams, Microsoft 365 Copilot and every other channel the
 * Agents SDK reaches.
 *
 *   const { agent } = await createAgentsSdkAgent({ client });
 *   startServer(agent);                       // @microsoft/agents-hosting-express
 *
 * One channel conversation maps to one harness session. Each incoming message
 * becomes one turn: `status` and `tool.start` become informative updates,
 * `text.delta` becomes streamed text, and the turn ends the stream. The
 * Agents SDK decides per channel whether that is sent as a live stream
 * (Teams, Web Chat, Direct Line) or as one final message.
 *
 * `@microsoft/agents-hosting` is an optional peer dependency: it is imported
 * only when this function is called.
 *
 * Verified against @microsoft/agents-hosting 1.8.1
 * (dist/src/app/streaming/streamingResponse.js, dist/src/app/agentApplication.d.ts).
 */
import { createHash } from 'node:crypto';

/** @typedef {import('../../index.js').HarnessEvent} HarnessEvent */
/** @typedef {import('../../index.js').AgentsSdkAgentOptions} AgentsSdkAgentOptions */

export const AGENTS_SDK_PACKAGE = '@microsoft/agents-hosting';

const DEFAULT_ERROR_TEXT = 'Sorry, something went wrong on my side. Please try again.';
const DEFAULT_EMPTY_TEXT = 'I do not have an answer for that. Try asking in a different way.';
const DEFAULT_IDLE_SESSION_MS = 30 * 60_000;

/**
 * A harness session id for a channel conversation: stable across restarts,
 * and free of the characters channel conversation ids carry (`:`, `;`, `@`).
 * @param {string} conversationKey
 */
export function sessionIdForConversation(conversationKey) {
  return `m365-${createHash('sha256').update(String(conversationKey)).digest('hex').slice(0, 32)}`;
}

/** @param {any} deps */
async function loadHosting(deps) {
  if (deps.hosting) return deps.hosting;
  try {
    const mod = await (deps.importHosting ? deps.importHosting() : import(AGENTS_SDK_PACKAGE));
    return mod.AgentApplication ? mod : mod.default;
  } catch (e) {
    throw new Error(
      `createAgentsSdkAgent needs the Microsoft 365 Agents SDK. Install it next to this package: npm install ${AGENTS_SDK_PACKAGE} @microsoft/agents-hosting-express`,
      { cause: e }
    );
  }
}

/**
 * @param {AgentsSdkAgentOptions} options
 * @param {{ hosting?: any, importHosting?: () => Promise<any>, now?: () => number }} [deps] test seams
 */
export async function createAgentsSdkAgent(options, deps = {}) {
  const client = options?.client;
  if (!client || typeof client.createSession !== 'function') {
    throw new Error('createAgentsSdkAgent requires options.client (a HarnessClient).');
  }
  const hosting = await loadHosting(deps);
  const { AgentApplication, MemoryStorage, MessageFactory } = hosting;
  const now = deps.now || Date.now;

  const errorText = options.errorText ?? DEFAULT_ERROR_TEXT;
  const emptyText = options.emptyText ?? DEFAULT_EMPTY_TEXT;
  const idleSessionMs = options.idleSessionMs ?? DEFAULT_IDLE_SESSION_MS;
  const conversationKey = options.conversationKey || ((/** @type {any} */ activity) => activity?.conversation?.id);
  const describeTool = options.describeTool || ((/** @type {any} */ ev) => (ev.name ? `Using ${ev.name}…` : ''));
  const reportError = async (/** @type {Error} */ error, /** @type {any} */ context) => {
    try {
      await options.onError?.(error, context);
    } catch {
      // A throwing error handler must not break the turn.
    }
  };

  /** @type {Map<string, { session: Promise<import('../../index.js').HarnessSession>, lastUsed: number, busy: number }>} */
  const sessions = new Map();
  let closed = false;

  /** @param {any} activity */
  function entryFor(activity) {
    const key = conversationKey(activity);
    if (!key) throw new Error('The incoming activity has no conversation id.');
    let entry = sessions.get(key);
    if (!entry) {
      const sessionId = sessionIdForConversation(key);
      const open = options.resumeSessions
        ? client.createSession({ resume: sessionId }).catch(() => client.createSession({ sessionId }))
        : client.createSession({ sessionId });
      entry = { session: open, lastUsed: now(), busy: 0 };
      sessions.set(key, entry);
      // A session that failed to open must not poison the conversation.
      open.catch(() => { if (sessions.get(key) === entry) sessions.delete(key); });
    }
    entry.lastUsed = now();
    return entry;
  }

  /** Close sessions nobody has used for `idleSessionMs`. Returns how many were closed. */
  async function sweep() {
    const cutoff = now() - idleSessionMs;
    let closedCount = 0;
    for (const [key, entry] of [...sessions]) {
      if (entry.busy > 0 || entry.lastUsed > cutoff) continue;
      sessions.delete(key);
      closedCount += 1;
      await entry.session.then((s) => s.close()).catch(() => {});
    }
    return closedCount;
  }

  /** @param {any} context */
  async function onMessage(context) {
    const prompt = String(context.activity?.text ?? '').trim();
    if (!prompt || closed) return;
    const stream = context.streamingResponse;
    if (options.aiLabel !== false) stream.setGeneratedByAILabel(true);

    let streamed = '';
    let messageStreamed = false;
    let replaced = false;
    let idleText = '';
    /** @type {string[]} */
    const finals = [];
    /** @type {Error | null} */
    let failure = null;
    const chunk = (/** @type {string} */ text) => {
      if (!text) return;
      // A new assistant message in the same turn starts on its own paragraph.
      const lead = streamed && !messageStreamed ? '\n\n' : '';
      stream.queueTextChunk(lead + text);
      streamed += lead + text;
      messageStreamed = true;
    };

    /** @type {ReturnType<typeof entryFor> | undefined} */
    let entry;
    try {
      entry = entryFor(context.activity);
      entry.busy += 1;
      const session = await entry.session;
      for await (const ev of session.stream(prompt, options.turnTimeoutMs ? { timeoutMs: options.turnTimeoutMs } : undefined)) {
        switch (ev.type) {
          case 'status':
            if (ev.text) stream.queueInformativeUpdate(ev.text);
            break;
          case 'tool.start': {
            const text = describeTool(ev);
            if (text) stream.queueInformativeUpdate(text);
            break;
          }
          case 'text.delta':
            if (ev.replaced) replaced = true;
            else chunk(ev.delta);
            break;
          case 'text.final':
            if (ev.text) finals.push(ev.text);
            // Final-only modes send no deltas: the final text is the message.
            if (!messageStreamed) chunk(ev.text);
            messageStreamed = false;
            break;
          case 'permission.request': {
            // Nobody is at a keyboard to approve: deny unless the host decides otherwise.
            let decision = 'deny';
            try {
              decision = (await options.onPermissionRequest?.(ev, context)) === 'approve' ? 'approve' : 'deny';
            } catch {
              decision = 'deny';
            }
            ev.respond(/** @type {'approve' | 'deny'} */ (decision));
            break;
          }
          case 'idle':
            idleText = ev.text || '';
            break;
          case 'error':
            failure = ev.error instanceof Error ? ev.error : new Error(String(ev.error));
            break;
          default:
            break;
        }
      }
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    } finally {
      if (entry) {
        entry.busy -= 1;
        entry.lastUsed = now();
      }
    }

    const authoritative = finals.length ? finals.join('\n\n') : idleText;
    if (!streamed) {
      // Nothing reached the user yet: an answer that arrived only at the end, a failure, or silence.
      stream.queueTextChunk(authoritative || (failure ? errorText : emptyText));
    } else if (replaced && authoritative) {
      // A cumulative snapshot replaced text that was already streamed: the final message carries the true text.
      stream.setFinalMessage(MessageFactory.text(authoritative));
    }
    await stream.endStream();
    if (failure) await reportError(failure, context);
  }

  const agent = new AgentApplication({
    storage: options.storage || new MemoryStorage(),
    ...(options.application || {})
  });
  if (options.greeting) {
    agent.onConversationUpdate('membersAdded', async (/** @type {any} */ context) => {
      await context.sendActivity(options.greeting);
    });
  }
  agent.onActivity('message', onMessage);

  /** @type {ReturnType<typeof setInterval> | undefined} */
  let sweeper;
  if (idleSessionMs > 0 && options.sweepIntervalMs !== 0) {
    sweeper = setInterval(() => { sweep().catch(() => {}); }, options.sweepIntervalMs ?? 60_000);
    sweeper.unref?.();
  }

  return {
    agent,
    /** Open harness sessions, one per channel conversation. */
    get sessionCount() {
      return sessions.size;
    },
    sweep,
    /** Close every harness session and stop the idle sweep. Does not close the client. */
    async close() {
      closed = true;
      if (sweeper) clearInterval(sweeper);
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((entry) => entry.session.then((s) => s.close()).catch(() => {})));
    }
  };
}
