// @ts-check
/**
 * Modes "copilot-studio-3p", "copilot-studio-standard", "copilot-studio-s2s"
 * and "agentic-directline": a published Copilot Studio agent reached from
 * code.
 *
 * The first three share @microsoft/agents-copilotstudio-client and differ only
 * in the URL they target and the token they carry:
 *
 *   copilot-studio-3p        directConnectUrl = build3pUrl(...)  + delegated user token
 *   copilot-studio-standard  environmentId + schemaName          + delegated user token
 *   copilot-studio-s2s       directConnectUrl = build3pUrl(...)  + app-only token (private preview)
 *
 * The client library appends /conversations[/{id}] itself; the turn shapes
 * (startConversationStreaming, executeStreaming) and the token refresh
 * (assigning client.token before each turn) are the ones proven in the
 * playground's server.js.
 *
 * "agentic-directline" does not use the client library at all: it fetches a
 * Direct Line token from the no-auth agentic runtime endpoint and drives the
 * standard Direct Line v3 REST API (final-only responses were observed).
 *
 * Turn contract: every turn ends with `idle`, also after an in-stream `error`
 * (TURN_TIMEOUT, ABORTED, token failure, HTTP failure).
 */
import { TextAccumulator, normalizeStudioActivity, safeEmit } from '../events.js';
import { build3pUrl, buildAgenticDirectLineTokenUrl, guard3pUrl } from '../url.js';

/** @typedef {import('../../index.js').HarnessEvent} HarnessEvent */
/** @typedef {import('../../index.js').CopilotStudioConfig} CopilotStudioConfig */
/** @typedef {import('../../index.js').HarnessMode} HarnessMode */

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * Resolve the connection shape for a Copilot Studio mode.
 * @param {HarnessMode} mode
 * @param {CopilotStudioConfig} config
 */
export function resolveStudioConnection(mode, config) {
  const cloud = config.cloud || 'Prod';
  if (!config.getAccessToken && mode !== 'agentic-directline') {
    throw new Error(`${mode} requires getAccessToken (a function returning a bearer token).`);
  }
  if (mode === 'copilot-studio-standard') {
    if (!config.environmentId || !config.schemaName) {
      throw new Error('copilot-studio-standard requires environmentId and schemaName.');
    }
    return {
      settings: {
        environmentId: config.environmentId,
        schemaName: config.schemaName,
        cloud,
        copilotAgentType: config.agentType || 'Published',
        enableDiagnostics: Boolean(config.diagnostics)
      },
      conversationsUrl: undefined
    };
  }
  if (mode === 'agentic-directline') {
    if (config.directLineTokenUrl) return { settings: undefined, tokenUrl: config.directLineTokenUrl };
    if (!config.environmentId || !config.schemaName) {
      throw new Error('agentic-directline requires environmentId and schemaName, or directLineTokenUrl.');
    }
    return { settings: undefined, tokenUrl: buildAgenticDirectLineTokenUrl({ environmentId: config.environmentId, schemaName: config.schemaName, cloud: /** @type {any} */ (cloud) }) };
  }
  // 3p (delegated) and s2s (app-only) both use the guarded /3p URL.
  const directConnectUrl =
    config.directConnectUrl ||
    build3pUrl({ environmentId: String(config.environmentId), schemaName: String(config.schemaName), cloud: /** @type {any} */ (cloud) });
  const conversationsUrl = guard3pUrl(directConnectUrl);
  return {
    settings: {
      directConnectUrl,
      cloud,
      copilotAgentType: config.agentType || 'Published',
      enableDiagnostics: Boolean(config.diagnostics)
    },
    conversationsUrl
  };
}

/**
 * One-shot preflight against the /3p conversations endpoint so 401/403/404
 * surface immediately instead of hanging in the streaming client's reconnect
 * loop (Agents-for-js#1198). A 200 starts a throwaway conversation.
 * @param {URL} conversationsUrl
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 */
export async function preflight3p(conversationsUrl, token, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(conversationsUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ emitStartConversationEvent: true }),
      signal: controller.signal
    });
  } catch (err) {
    if (/** @type {any} */ (err)?.name === 'AbortError') throw Object.assign(new Error('/3p preflight timed out after 25 seconds.'), { code: 'PREFLIGHT_TIMEOUT' });
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().split('\n')[0].slice(0, 240);
    const error = new Error(`/3p runtime returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    /** @type {any} */ (error).httpStatus = response.status;
    /** @type {any} */ (error).hint = explainStatus(response.status, detail);
    throw error;
  }
  await response.body?.cancel().catch(() => {});
  return { ok: true, status: response.status, endpoint: conversationsUrl.href, elapsedMs: Date.now() - started };
}

/**
 * The failure table from the reference (§7.3).
 * @param {number} status
 * @param {string} detail
 */
export function explainStatus(status, detail = '') {
  if (/S2SDirectEngineRequiresNoAuthentication/i.test(detail)) {
    return 'The target agent is authenticated; app-only S2S works only with No Authentication agents.';
  }
  switch (status) {
    case 401:
      return 'Token audience, app credential, or private-preview enablement problem. /3p rejects app-only tokens on the authenticated route.';
    case 403:
      return 'Missing CopilotStudio.Copilots.Invoke permission/consent, agent not shared with this identity, policy, or S2S ACL.';
    case 404:
      return 'Wrong environment/schema name, agent not published, or /3p not enabled for this harness/runtime.';
    default:
      return '';
  }
}

/**
 * Wrap an async generator with a per-turn timeout and an abort hook. On
 * timeout/abort the inner generator is closed and an error with `code` is thrown.
 * @template T
 * @param {AsyncGenerator<T>} inner
 * @param {number} timeoutMs
 * @param {{ aborted: boolean }} abortFlag
 * @returns {AsyncGenerator<T>}
 */
async function* withTurnGuard(inner, timeoutMs, abortFlag) {
  try {
    while (true) {
      if (abortFlag.aborted) throw Object.assign(new Error('Turn aborted'), { code: 'ABORTED' });
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Turn timed out after ${timeoutMs} ms`), { code: 'TURN_TIMEOUT' })), timeoutMs);
        timer.unref?.();
      });
      let result;
      try {
        result = await Promise.race([inner.next(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Do not await: an async generator suspended in a pending next() only
    // honours return() after that next() settles, which on a stalled SSE
    // stream is never. Fire-and-forget releases the wrapper immediately.
    try {
      const r = inner.return?.(undefined);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      // ignore
    }
  }
}

/**
 * @param {HarnessMode} mode
 * @param {CopilotStudioConfig} config
 * @param {{ clientFactory?: (settings: any, token: string) => any, fetchImpl?: typeof fetch }} [deps]
 */
export async function createCopilotStudioAdapter(mode, config, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const resolved = resolveStudioConnection(mode, config);

  /** @type {Set<(event: HarnessEvent) => void>} */
  const listeners = new Set();
  const onListenerError = config.onListenerError || (() => {});
  const emit = (/** @type {HarnessEvent} */ event) => safeEmit(listeners, event, onListenerError);

  if (mode === 'agentic-directline') {
    return createAgenticDirectLineAdapter(config, /** @type {string} */ (resolved.tokenUrl), fetchImpl, listeners, emit);
  }

  let clientFactory = deps.clientFactory;
  if (!clientFactory) {
    const lib = await import('@microsoft/agents-copilotstudio-client');
    clientFactory = (settings, token) => new lib.CopilotStudioClient(new lib.ConnectionSettings(settings), token);
  }
  const getAccessToken = /** @type {() => Promise<string>} */ (config.getAccessToken);

  /**
   * Pump one turn of client-library activities into normalized events. Any
   * failure becomes an `error` event; `idle` is always yielded last.
   * @param {() => AsyncGenerator<any>} startActivities
   * @param {number} turn
   * @param {() => string | undefined} getConversationId
   * @param {number} timeoutMs
   * @param {{ aborted: boolean }} abortFlag
   */
  async function* pump(startActivities, turn, getConversationId, timeoutMs, abortFlag) {
    const acc = new TextAccumulator();
    let count = 0;
    try {
      for await (const activity of withTurnGuard(startActivities(), timeoutMs, abortFlag)) {
        count += 1;
        for (const ev of normalizeStudioActivity(activity, acc)) {
          const withTurn = { ...ev, turn };
          emit(withTurn);
          yield withTurn;
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const ev = { type: /** @type {const} */ ('error'), error, code: /** @type {any} */ (err)?.code, statusCode: /** @type {any} */ (err)?.httpStatus, hint: /** @type {any} */ (err)?.hint, source: /** @type {const} */ ('copilot-studio'), raw: err, turn };
      emit(ev);
      yield ev;
    }
    const idle = { type: /** @type {const} */ ('idle'), text: acc.snapshot, source: /** @type {const} */ ('copilot-studio'), raw: { count, conversationId: getConversationId() }, turn };
    emit(idle);
    yield idle;
  }

  /** @param {import('../../index.js').CreateSessionOptions} [opts] */
  async function createSession(opts = {}) {
    const token = await getAccessToken();
    if (resolved.conversationsUrl && config.preflight !== false && !opts.resume) {
      await preflight3p(resolved.conversationsUrl, token, fetchImpl);
    }
    const client = clientFactory(resolved.settings, token);
    let conversationId = opts.resume || undefined;
    if (conversationId) client.conversationId = conversationId;
    let turnCounter = 0;
    /** @type {HarnessEvent[]} */
    const greeting = [];
    /** @type {{ aborted: boolean }} */
    let currentAbort = { aborted: false };
    const turnTimeout = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

    if (!conversationId) {
      // Start the conversation now so the session has an id; greeting
      // activities are kept and exposed as session.greeting. A failure here
      // is the library's real error (401/403/404), rethrown with its status.
      const turn = ++turnCounter;
      currentAbort = { aborted: false };
      for await (const ev of pump(() => client.startConversationStreaming(true), turn, () => client.conversationId, turnTimeout, currentAbort)) {
        greeting.push(ev);
      }
      const failed = greeting.find((e) => e.type === 'error');
      if (failed && failed.type === 'error') {
        const error = failed.error;
        if (/** @type {any} */ (error).httpStatus && !/** @type {any} */ (error).hint) /** @type {any} */ (error).hint = explainStatus(/** @type {any} */ (error).httpStatus);
        throw error;
      }
      conversationId = client.conversationId;
      if (!conversationId) throw new Error('Copilot Studio did not return a conversation id.');
    }

    /**
     * @param {string} prompt
     * @param {{ timeoutMs?: number }} [sendOpts]
     * @returns {AsyncIterableIterator<HarnessEvent>}
     */
    function stream(prompt, sendOpts = {}) {
      const turn = ++turnCounter;
      const abortFlag = { aborted: false };
      currentAbort = abortFlag;
      const timeoutMs = sendOpts.timeoutMs ?? turnTimeout;
      return (async function* () {
        yield* pump(
          () => {
            const activity = { type: 'message', text: prompt, conversation: { id: conversationId } };
            return (async function* () {
              // Token acquisition is inside the guarded generator so a refresh
              // failure surfaces as an in-stream error, not a thrown next().
              client.token = await getAccessToken();
              yield* client.executeStreaming(activity, /** @type {string} */ (conversationId));
            })();
          },
          turn,
          () => client.conversationId || conversationId,
          timeoutMs,
          abortFlag
        );
      })();
    }

    return {
      id: /** @type {string} */ (conversationId),
      conversationId: /** @type {string} */ (conversationId),
      mode,
      greeting,
      stream,
      /** @param {string} prompt @param {{ timeoutMs?: number }} [sendOpts] */
      async send(prompt, sendOpts) {
        /** @type {HarnessEvent[]} */
        const events = [];
        let text = '';
        /** @type {Error | undefined} */
        let failure;
        for await (const ev of stream(prompt, sendOpts)) {
          events.push(ev);
          if (ev.type === 'text.final' && ev.text) text = ev.text;
          if (ev.type === 'idle' && !text) text = ev.text;
          if (ev.type === 'error') failure = ev.error;
        }
        if (failure && !text) throw failure;
        return { text, events };
      },
      async abort() {
        currentAbort.aborted = true;
      },
      async close() {
        currentAbort.aborted = true;
      },
      native: client
    };
  }

  return {
    mode,
    createSession,
    /** @param {(event: HarnessEvent) => void} listener */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async preflight() {
      const token = await getAccessToken();
      if (resolved.conversationsUrl) {
        const result = await preflight3p(resolved.conversationsUrl, token, fetchImpl);
        return { ...result, mode };
      }
      // Standard mode: the library computes the URL; starting a conversation is the check.
      const started = Date.now();
      const client = clientFactory(resolved.settings, token);
      for await (const _ of client.startConversationStreaming(false)) {
        // drain
      }
      return { ok: true, mode, elapsedMs: Date.now() - started, endpoint: undefined, details: { conversationId: client.conversationId } };
    },
    async listSessions() {
      return [];
    },
    async deleteSession() {},
    async close() {},
    native: undefined,
    resolved
  };
}

/**
 * No-auth agentic Direct Line diagnostic: token from the agentic runtime,
 * then Direct Line v3 REST (start conversation, post activity, poll).
 *
 * The watermark is primed when the session opens (an initial GET drains
 * existing activities), so a resumed conversation's history is never replayed
 * as this turn's answer; only activities after the posted prompt count.
 * @param {CopilotStudioConfig} config
 * @param {string} tokenUrl
 * @param {typeof fetch} fetchImpl
 * @param {Set<(event: HarnessEvent) => void>} listeners
 * @param {(event: HarnessEvent) => void} emit
 */
async function createAgenticDirectLineAdapter(config, tokenUrl, fetchImpl, listeners, emit) {
  const directLineBase = config.directLineBase || 'https://directline.botframework.com/v3/directline';
  const userId = config.userId || 'copilot-harness-sdk';

  async function fetchToken() {
    const res = await fetchImpl(tokenUrl, { method: 'GET' });
    if (!res.ok) {
      const error = new Error(`Agentic Direct Line token endpoint returned HTTP ${res.status}`);
      /** @type {any} */ (error).httpStatus = res.status;
      throw error;
    }
    const body = await res.json();
    if (!body?.token) throw new Error('Token endpoint response did not contain a "token" field.');
    return { token: /** @type {string} */ (body.token), conversationId: body.conversationId };
  }

  /**
   * @param {string} token
   * @param {string} conversationId
   * @param {string} watermark
   */
  async function poll(token, conversationId, watermark) {
    const q = watermark ? `?watermark=${encodeURIComponent(watermark)}` : '';
    const res = await fetchImpl(`${directLineBase}/conversations/${conversationId}/activities${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw Object.assign(new Error(`Direct Line poll returned HTTP ${res.status}`), { httpStatus: res.status });
    const body = await res.json();
    return { watermark: body.watermark || watermark, activities: /** @type {any[]} */ (body.activities || []) };
  }

  /** @param {import('../../index.js').CreateSessionOptions} [opts] */
  async function createSession(opts = {}) {
    const { token } = await fetchToken();
    let conversationId = opts.resume;
    let watermark = '';
    if (!conversationId) {
      const res = await fetchImpl(`${directLineBase}/conversations`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw Object.assign(new Error(`Direct Line start returned HTTP ${res.status}`), { httpStatus: res.status });
      const body = await res.json();
      conversationId = body.conversationId;
    }
    // Prime the watermark: drain what already exists. For a new conversation
    // that is the greeting (kept); for a resumed one it is history (discarded).
    /** @type {HarnessEvent[]} */
    const greeting = [];
    const primed = await poll(token, /** @type {string} */ (conversationId), '');
    watermark = primed.watermark;
    if (!opts.resume) {
      const acc = new TextAccumulator();
      for (const activity of primed.activities) {
        if (activity.from?.id === userId) continue;
        for (const ev of normalizeStudioActivity(activity, acc)) greeting.push({ ...ev, turn: 0 });
      }
    }
    let turnCounter = 0;
    let aborted = false;

    /**
     * @param {string} prompt
     * @param {{ timeoutMs?: number }} [sendOpts]
     */
    function stream(prompt, sendOpts = {}) {
      const turn = ++turnCounter;
      const timeoutMs = sendOpts.timeoutMs ?? config.turnTimeoutMs ?? 60_000;
      aborted = false;
      return (async function* () {
        const acc = new TextAccumulator();
        let done = false;
        try {
          const post = await fetchImpl(`${directLineBase}/conversations/${conversationId}/activities`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'message', from: { id: userId }, text: prompt })
          });
          if (!post.ok) throw Object.assign(new Error(`Direct Line post returned HTTP ${post.status}`), { httpStatus: post.status });
          const deadline = Date.now() + timeoutMs;
          while (!done && Date.now() < deadline) {
            if (aborted) throw Object.assign(new Error('Turn aborted'), { code: 'ABORTED' });
            const page = await poll(token, /** @type {string} */ (conversationId), watermark);
            watermark = page.watermark;
            for (const activity of page.activities) {
              if (activity.from?.id === userId) continue;
              for (const ev of normalizeStudioActivity(activity, acc)) {
                const withTurn = { ...ev, turn };
                emit(withTurn);
                yield withTurn;
                if (ev.type === 'text.final') done = true;
              }
              if (activity.type === 'event' && /turn\.complete/i.test(activity.name || '')) done = true;
            }
            if (!done) await new Promise((r) => setTimeout(r, 750));
          }
          if (!done) throw Object.assign(new Error(`Turn timed out after ${timeoutMs} ms`), { code: 'TURN_TIMEOUT' });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const ev = { type: /** @type {const} */ ('error'), error, code: /** @type {any} */ (err)?.code, statusCode: /** @type {any} */ (err)?.httpStatus, source: /** @type {const} */ ('copilot-studio'), raw: err, turn };
          emit(ev);
          yield ev;
        }
        const idle = { type: /** @type {const} */ ('idle'), text: acc.snapshot, source: /** @type {const} */ ('copilot-studio'), raw: { conversationId, watermark }, turn };
        emit(idle);
        yield idle;
      })();
    }

    return {
      id: /** @type {string} */ (conversationId),
      conversationId: /** @type {string} */ (conversationId),
      mode: /** @type {const} */ ('agentic-directline'),
      greeting,
      stream,
      /** @param {string} prompt @param {{ timeoutMs?: number }} [sendOpts] */
      async send(prompt, sendOpts) {
        /** @type {HarnessEvent[]} */
        const events = [];
        let text = '';
        /** @type {Error | undefined} */
        let failure;
        for await (const ev of stream(prompt, sendOpts)) {
          events.push(ev);
          if (ev.type === 'text.final' && ev.text) text = ev.text;
          if (ev.type === 'error') failure = ev.error;
        }
        if (failure && !text) throw failure;
        return { text, events };
      },
      async abort() {
        aborted = true;
      },
      async close() {
        aborted = true;
      },
      native: { token, conversationId }
    };
  }

  return {
    mode: /** @type {const} */ ('agentic-directline'),
    createSession,
    /** @param {(event: HarnessEvent) => void} listener */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async preflight() {
      const started = Date.now();
      const { conversationId } = await fetchToken();
      return { ok: true, mode: 'agentic-directline', elapsedMs: Date.now() - started, endpoint: tokenUrl, details: { conversationId } };
    },
    async listSessions() {
      return [];
    },
    async deleteSession() {},
    async close() {},
    native: undefined,
    resolved: { tokenUrl }
  };
}
