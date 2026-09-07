// @ts-check
/**
 * Mode "copilot-sdk": the GitHub Copilot CLI harness running in (or next to)
 * this process, driven through @github/copilot-sdk.
 *
 * Field names are taken from @github/copilot-sdk 1.0.13
 * dist/generated/session-events.d.ts (see copilot-sdk-map.js).
 *
 * Turn contract (verified against dist/session.js and dist/client.js):
 *   - turns on one session are serialized; a new stream() waits for the
 *     previous turn to end, so a stale session.idle can never end the wrong turn;
 *   - session.idle ends the turn unless data.mode === "autopilot";
 *   - breaking out of a stream aborts the SDK turn, unsubscribes and clears the timer;
 *   - session.close()/abort() and client.close() end every open stream with an
 *     error (SESSION_CLOSED / ABORTED) followed by idle, so consumers never hang;
 *   - `idle` is always the last event of a turn, including after an error.
 */
import { createEventQueue, safeEmit } from '../events.js';
import { createSdkEventMapper } from './copilot-sdk-map.js';

/** @typedef {import('../../index.js').HarnessEvent} HarnessEvent */
/** @typedef {import('../../index.js').CopilotSdkConfig} CopilotSdkConfig */

const APPROVE_ALL_KINDS = ['approve-all', 'approveAll', 'allow-all'];
const PERMISSION_EMIT_TIMEOUT_MS = 60_000;

/**
 * Translate the SDK's permission option into a handler the SDK accepts.
 * `sink` is the session-level hook that routes emitted requests into the
 * active turn's stream as well as to client-level listeners.
 * @param {CopilotSdkConfig['permissions']} permissions
 * @param {any} sdk
 * @param {{ deliver: (event: HarnessEvent) => void }} sink
 */
function buildPermissionHandler(permissions, sdk, sink) {
  if (typeof permissions === 'function') return permissions;
  if (permissions && APPROVE_ALL_KINDS.includes(String(permissions))) return sdk.approveAll;
  if (permissions === 'emit') {
    return (/** @type {any} */ request, /** @type {any} */ invocation) =>
      new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
          }
        }, PERMISSION_EMIT_TIMEOUT_MS);
        timer.unref?.();
        sink.deliver({
          type: 'permission.request',
          source: 'copilot-sdk',
          request,
          sessionId: invocation?.sessionId,
          respond(decision) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // "approve-once" is what the SDK's own approveAll helper returns.
            resolve(decision === 'approve' ? { kind: 'approve-once' } : { kind: 'denied-interactively-by-user' });
          },
          raw: request
        });
      });
  }
  // "deny" or undefined: leave the SDK default (deny) in place.
  return undefined;
}

/**
 * @param {CopilotSdkConfig} config
 * @param {{ sdk?: any }} [deps] test seam: an object shaped like the @github/copilot-sdk module
 */
export async function createCopilotSdkAdapter(config = {}, deps = {}) {
  const sdk = deps.sdk || (await import('@github/copilot-sdk'));
  const { CopilotClient, RuntimeConnection } = sdk;

  /** @type {any} */
  const clientOptions = { ...(config.client || {}) };
  const runtime = config.runtime || {};
  if (runtime.uri) {
    clientOptions.connection = RuntimeConnection.forUri(runtime.uri, { connectionToken: runtime.connectionToken });
  } else if (runtime.cliPath || runtime.args || runtime.env) {
    clientOptions.connection = RuntimeConnection.forStdio({ path: runtime.cliPath, args: runtime.args, env: runtime.env });
  }
  if (runtime.mode) clientOptions.mode = runtime.mode;
  if (runtime.baseDirectory) clientOptions.baseDirectory = runtime.baseDirectory;
  const externalRuntime = clientOptions.connection?.kind === 'uri' || clientOptions.connection?.kind === 'parent-process';
  if (clientOptions.mode === 'empty' && !clientOptions.baseDirectory && !clientOptions.sessionFs && !externalRuntime) {
    // Verified against @github/copilot-sdk 1.0.13 (dist/client.js): empty mode
    // requires baseDirectory or sessionFs unless the runtime is external
    // (uri / parent-process). Default to a per-user temp directory.
    const os = await import('node:os');
    const path = await import('node:path');
    clientOptions.baseDirectory = path.join(os.tmpdir(), 'copilot-harness-sdk', 'empty-mode');
  }
  if (config.githubToken) {
    clientOptions.gitHubToken = config.githubToken;
    clientOptions.useLoggedInUser = false;
  }

  const client = new CopilotClient(clientOptions);
  await client.start();

  /** @type {Set<(event: HarnessEvent) => void>} */
  const listeners = new Set();
  const onListenerError = config.onListenerError || (() => {});
  const emit = (/** @type {HarnessEvent} */ event) => safeEmit(listeners, event, onListenerError);
  /** @type {Set<{ close: (reason: 'SESSION_CLOSED' | 'ABORTED') => Promise<void> }>} */
  const openSessions = new Set();

  /** @param {import('../../index.js').CreateSessionOptions} [opts] */
  async function createSession(opts = {}) {
    /** @type {any} */
    const sessionConfig = {
      streaming: true,
      ...(config.session || {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {})
    };
    if (config.model && !sessionConfig.model) sessionConfig.model = config.model;
    if (config.instructions && !sessionConfig.systemMessage) {
      sessionConfig.systemMessage = { mode: 'append', content: config.instructions };
    }
    if (config.tools?.length) sessionConfig.tools = [...(sessionConfig.tools || []), ...config.tools];
    if (config.mcpServers) sessionConfig.mcpServers = { ...(sessionConfig.mcpServers || {}), ...config.mcpServers };
    if (config.skillDirectories) sessionConfig.skillDirectories = config.skillDirectories;
    if (config.customAgents) sessionConfig.customAgents = config.customAgents;
    if (config.byok) {
      sessionConfig.provider = config.byok;
      if (!sessionConfig.model) throw new Error('BYOK requires model to be set at the session level.');
    }
    if (config.hooks) sessionConfig.hooks = config.hooks;
    if (clientOptions.mode === 'empty' && sessionConfig.availableTools === undefined) {
      // Verified against @github/copilot-sdk 1.0.13: "Empty mode requires every
      // session to explicitly opt into the tools it wants". Default to custom
      // tools only (no ambient shell/file/URL tools), the multi-tenant guidance.
      sessionConfig.availableTools = ['custom:*'];
    }
    if (config.sessionGithubToken) sessionConfig.gitHubToken = config.sessionGithubToken;

    // Routes permission requests into the active turn's stream and to client listeners.
    /** @type {{ queuePush: ((event: HarnessEvent) => void) | null, deliver: (event: HarnessEvent) => void }} */
    const permissionSink = {
      queuePush: null,
      deliver(event) {
        // The turn's push() feeds the stream and emits to client listeners;
        // outside a turn, fall back to client listeners only.
        if (permissionSink.queuePush) permissionSink.queuePush(event);
        else emit(event);
      }
    };
    const permissionHandler = buildPermissionHandler(config.permissions, sdk, permissionSink);
    if (permissionHandler) sessionConfig.onPermissionRequest = permissionHandler;

    const session = opts.resume
      ? await client.resumeSession(opts.resume, sessionConfig)
      : await client.createSession(sessionConfig);

    let turnCounter = 0;
    /** Serializes turns: each stream() waits for the previous one to end. */
    let lastTurn = Promise.resolve();
    /** @type {Set<(reason: 'SESSION_CLOSED' | 'ABORTED') => void>} */
    const activeFinishers = new Set();

    /**
     * @param {string} prompt
     * @param {{ timeoutMs?: number, attachments?: any[], agentMode?: 'interactive' | 'plan' | 'autopilot' }} [sendOpts]
     * @returns {AsyncIterableIterator<HarnessEvent>}
     */
    function stream(prompt, sendOpts = {}) {
      const turn = ++turnCounter;
      const mapper = createSdkEventMapper({ turn });
      const timeoutMs = sendOpts.timeoutMs ?? config.turnTimeoutMs ?? 5 * 60_000;
      let finished = false;
      let sent = false;
      /** @type {(() => void) | undefined} */
      let off;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      /** @type {() => void} */
      let releaseTurn = () => {};

      const queue = createEventQueue({
        onReturn() {
          // Consumer broke out early: stop the SDK turn and clean up.
          finishWithReason('ABORTED', true);
        }
      });

      const push = (/** @type {HarnessEvent} */ ev) => {
        queue.push(ev);
        emit(ev);
      };

      const idleEvent = () => /** @type {HarnessEvent} */ ({ type: 'idle', text: mapper.finalText, aborted: true, source: 'copilot-sdk', raw: null, turn });

      /**
       * End the turn. Terminal error paths push `error` then `idle` so idle is always last.
       * @param {'SESSION_CLOSED' | 'ABORTED' | 'TURN_TIMEOUT' | 'SEND_FAILED' | undefined} reason
       * @param {boolean} [abortSdk]
       * @param {Error} [error]
       */
      function finishWithReason(reason, abortSdk = false, error) {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        off?.();
        activeFinishers.delete(finisher);
        if (permissionSink.queuePush === push) permissionSink.queuePush = null;
        if (reason) {
          const message = reason === 'SESSION_CLOSED' ? 'Session closed while a turn was open' : reason === 'ABORTED' ? 'Turn aborted' : reason;
          push({ type: 'error', error: error || new Error(message), code: reason, source: 'copilot-sdk', raw: null, turn });
          push(idleEvent());
        }
        queue.close();
        const settle = abortSdk && sent ? abortAndWaitForIdle() : Promise.resolve();
        settle.finally(() => releaseTurn());
      }
      const finisher = (/** @type {'SESSION_CLOSED' | 'ABORTED'} */ reason) => finishWithReason(reason, reason === 'ABORTED');
      activeFinishers.add(finisher);

      /** Abort the in-flight SDK turn and wait (bounded) for its idle so the next turn starts clean. */
      async function abortAndWaitForIdle() {
        const idle = new Promise((resolve) => {
          const unsub = session.on((/** @type {any} */ e) => {
            if (e.type === 'session.idle') {
              unsub();
              resolve(undefined);
            }
          });
          const t = setTimeout(() => {
            unsub();
            resolve(undefined);
          }, 5_000);
          t.unref?.();
        });
        try {
          await session.abort();
        } catch {
          // best effort
        }
        await idle;
      }

      const previous = lastTurn;
      lastTurn = new Promise((resolve) => {
        releaseTurn = resolve;
      });

      (async () => {
        await previous;
        if (finished) return;
        permissionSink.queuePush = push;
        off = session.on((/** @type {any} */ event) => {
          if (finished) return;
          if (event.type === 'session.idle' && !sent) return; // stale idle from before our send landed
          const { event: mapped, done } = mapper.map(event);
          push(mapped);
          if (done) finishWithReason(undefined);
        });
        timer = setTimeout(() => finishWithReason('TURN_TIMEOUT', true, new Error(`Turn timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
        /** @type {any} */
        const message = { prompt };
        if (sendOpts.attachments) message.attachments = sendOpts.attachments;
        if (sendOpts.agentMode) message.agentMode = sendOpts.agentMode;
        try {
          await session.send(message);
          sent = true;
        } catch (err) {
          finishWithReason('SEND_FAILED', false, err instanceof Error ? err : new Error(String(err)));
        }
      })().catch((err) => finishWithReason('SEND_FAILED', false, err instanceof Error ? err : new Error(String(err))));

      return queue.iterator();
    }

    const handle = {
      id: session.sessionId,
      conversationId: session.sessionId,
      mode: /** @type {const} */ ('copilot-sdk'),
      stream,
      /** @param {string} prompt @param {any} [sendOpts] */
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
        for (const f of [...activeFinishers]) f('ABORTED');
        try {
          await session.abort();
        } catch {
          // best effort
        }
      },
      /** @param {'SESSION_CLOSED' | 'ABORTED'} [reason] */
      async close(reason = 'SESSION_CLOSED') {
        for (const f of [...activeFinishers]) f(reason);
        openSessions.delete(handle);
        await session.disconnect();
      },
      native: session
    };
    openSessions.add(handle);
    return handle;
  }

  return {
    mode: /** @type {const} */ ('copilot-sdk'),
    createSession,
    /** @param {(event: HarnessEvent) => void} listener */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async preflight() {
      const started = Date.now();
      const status = await client.getStatus();
      const auth = await client.getAuthStatus().catch(() => undefined);
      return { ok: true, mode: 'copilot-sdk', elapsedMs: Date.now() - started, details: { status, auth } };
    },
    async listSessions() {
      return client.listSessions();
    },
    async deleteSession(/** @type {string} */ id) {
      await client.deleteSession(id);
    },
    async close() {
      for (const s of [...openSessions]) await s.close('SESSION_CLOSED');
      await client.stop();
    },
    native: client,
    resolved: { clientOptions }
  };
}
