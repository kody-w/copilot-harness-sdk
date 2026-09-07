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
 * (startConversationStreaming, executeStreaming) and the token refresh trick
 * (assigning client.token before each turn) are the ones proven in server.js.
 *
 * "agentic-directline" does not use the client library at all: it fetches a
 * Direct Line token from the no-auth agentic runtime endpoint and drives the
 * standard Direct Line v3 REST API (final-only responses were observed).
 */
import { TextAccumulator, normalizeStudioActivity } from '../events.js';
import { build3pUrl, buildAgenticDirectLineTokenUrl, guard3pUrl } from '../url.js';

/** @typedef {import('../../index.js').HarnessEvent} HarnessEvent */
/** @typedef {import('../../index.js').CopilotStudioConfig} CopilotStudioConfig */
/** @typedef {import('../../index.js').HarnessMode} HarnessMode */

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
    if (!config.environmentId || !config.schemaName) {
      throw new Error('agentic-directline requires environmentId and schemaName.');
    }
    return { settings: undefined, tokenUrl: config.directLineTokenUrl || buildAgenticDirectLineTokenUrl({ environmentId: config.environmentId, schemaName: config.schemaName, cloud: /** @type {any} */ (cloud) }) };
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
 * @param {HarnessMode} mode
 * @param {CopilotStudioConfig} config
 * @param {{ clientFactory?: (settings: any, token: string) => any, fetchImpl?: typeof fetch }} [deps]
 */
export async function createCopilotStudioAdapter(mode, config, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const resolved = resolveStudioConnection(mode, config);

  /** @type {Set<(event: HarnessEvent) => void>} */
  const listeners = new Set();
  const emit = (/** @type {HarnessEvent} */ event) => listeners.forEach((l) => l(event));

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
   * Pump one turn of client-library activities into normalized events.
   * @param {AsyncGenerator<any>} activities
   * @param {number} turn
   * @param {() => string | undefined} getConversationId
   */
  async function* pump(activities, turn, getConversationId) {
    const acc = new TextAccumulator();
    let count = 0;
    try {
      for await (const activity of activities) {
        count += 1;
        for (const ev of normalizeStudioActivity(activity, acc)) {
          const withTurn = { ...ev, turn };
          emit(withTurn);
          yield withTurn;
        }
      }
      const idle = { type: /** @type {const} */ ('idle'), text: acc.snapshot, source: /** @type {const} */ ('copilot-studio'), raw: { count, conversationId: getConversationId() }, turn };
      emit(idle);
      yield idle;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const ev = { type: /** @type {const} */ ('error'), error, code: /** @type {any} */ (err)?.code, statusCode: /** @type {any} */ (err)?.httpStatus, source: /** @type {const} */ ('copilot-studio'), raw: err, turn };
      emit(ev);
      yield ev;
    }
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

    if (!conversationId) {
      // Start the conversation now so the session has an id; greeting
      // activities are kept and replayed as the first turn's events.
      const turn = ++turnCounter;
      for await (const ev of pump(client.startConversationStreaming(true), turn, () => client.conversationId)) {
        greeting.push(ev);
      }
      conversationId = client.conversationId;
      if (!conversationId) throw new Error('Copilot Studio did not return a conversation id.');
    }

    /**
     * @param {string} prompt
     * @returns {AsyncIterableIterator<HarnessEvent>}
     */
    function stream(prompt) {
      const turn = ++turnCounter;
      return (async function* () {
        client.token = await getAccessToken();
        const activity = { type: 'message', text: prompt, conversation: { id: conversationId } };
        yield* pump(client.executeStreaming(activity, /** @type {string} */ (conversationId)), turn, () => client.conversationId || conversationId);
      })();
    }

    return {
      id: /** @type {string} */ (conversationId),
      conversationId: /** @type {string} */ (conversationId),
      mode,
      greeting,
      stream,
      /** @param {string} prompt */
      async send(prompt) {
        /** @type {HarnessEvent[]} */
        const events = [];
        let text = '';
        /** @type {Error | undefined} */
        let failure;
        for await (const ev of stream(prompt)) {
          events.push(ev);
          if (ev.type === 'text.final') text = ev.text;
          if (ev.type === 'idle' && !text) text = ev.text;
          if (ev.type === 'error') failure = ev.error;
        }
        if (failure && !text) throw failure;
        return { text, events };
      },
      async abort() {},
      async close() {},
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
 * @param {CopilotStudioConfig} config
 * @param {string} tokenUrl
 * @param {typeof fetch} fetchImpl
 * @param {Set<(event: HarnessEvent) => void>} listeners
 * @param {(event: HarnessEvent) => void} emit
 */
async function createAgenticDirectLineAdapter(config, tokenUrl, fetchImpl, listeners, emit) {
  const directLineBase = config.directLineBase || 'https://directline.botframework.com/v3/directline';

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
    let turnCounter = 0;

    /** @param {string} prompt */
    function stream(prompt) {
      const turn = ++turnCounter;
      return (async function* () {
        const acc = new TextAccumulator();
        try {
          const post = await fetchImpl(`${directLineBase}/conversations/${conversationId}/activities`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'message', from: { id: config.userId || 'copilot-harness-sdk' }, text: prompt })
          });
          if (!post.ok) throw Object.assign(new Error(`Direct Line post returned HTTP ${post.status}`), { httpStatus: post.status });
          const deadline = Date.now() + (config.turnTimeoutMs || 60_000);
          let done = false;
          while (!done && Date.now() < deadline) {
            const q = watermark ? `?watermark=${encodeURIComponent(watermark)}` : '';
            const res = await fetchImpl(`${directLineBase}/conversations/${conversationId}/activities${q}`, { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) throw Object.assign(new Error(`Direct Line poll returned HTTP ${res.status}`), { httpStatus: res.status });
            const body = await res.json();
            watermark = body.watermark || watermark;
            for (const activity of body.activities || []) {
              if (activity.from?.id === (config.userId || 'copilot-harness-sdk')) continue;
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
          const idle = { type: /** @type {const} */ ('idle'), text: acc.snapshot, source: /** @type {const} */ ('copilot-studio'), raw: { conversationId, watermark }, turn };
          emit(idle);
          yield idle;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const ev = { type: /** @type {const} */ ('error'), error, statusCode: /** @type {any} */ (err)?.httpStatus, source: /** @type {const} */ ('copilot-studio'), raw: err, turn };
          emit(ev);
          yield ev;
        }
      })();
    }

    return {
      id: /** @type {string} */ (conversationId),
      conversationId: /** @type {string} */ (conversationId),
      mode: /** @type {const} */ ('agentic-directline'),
      greeting: [],
      stream,
      /** @param {string} prompt */
      async send(prompt) {
        /** @type {HarnessEvent[]} */
        const events = [];
        let text = '';
        /** @type {Error | undefined} */
        let failure;
        for await (const ev of stream(prompt)) {
          events.push(ev);
          if (ev.type === 'text.final') text = ev.text;
          if (ev.type === 'error') failure = ev.error;
        }
        if (failure && !text) throw failure;
        return { text, events };
      },
      async abort() {},
      async close() {},
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
