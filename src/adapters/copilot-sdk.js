// @ts-check
/**
 * Mode "copilot-sdk": the GitHub Copilot CLI harness running in (or next to)
 * this process, driven through @github/copilot-sdk.
 *
 * Field names below are taken from @github/copilot-sdk 1.0.13
 * dist/generated/session-events.d.ts:
 *   assistant.message_delta   data.deltaContent, data.messageId
 *   assistant.message         data.content, data.messageId, data.model, data.citations
 *   assistant.reasoning_delta data.deltaContent, data.reasoningId
 *   assistant.intent          data.intent
 *   tool.execution_start      data.toolCallId, data.toolName, data.arguments, data.mcpServerName
 *   tool.execution_complete   data.toolCallId, data.success, data.result, data.error
 *   assistant.usage           data.model, data.inputTokens, data.outputTokens, data.cost, data.isByok
 *   session.usage_info        data.currentTokens, data.tokenLimit
 *   permission.requested      data.requestId, data.permissionRequest
 *   session.error             data.message, data.errorType, data.errorCode, data.statusCode
 *   session.idle              (turn complete)
 */
import { createEventQueue } from '../events.js';
import { createSdkEventMapper } from './copilot-sdk-map.js';

/** @typedef {import('../../index.js').HarnessEvent} HarnessEvent */
/** @typedef {import('../../index.js').CopilotSdkConfig} CopilotSdkConfig */

const APPROVE_ALL_KINDS = ['approve-all', 'approveAll', 'allow-all'];

/**
 * Translate the SDK's permission option into a handler the SDK accepts.
 * @param {CopilotSdkConfig['permissions']} permissions
 * @param {import('@github/copilot-sdk')} sdk
 * @param {(event: HarnessEvent) => void} emit
 */
function buildPermissionHandler(permissions, sdk, emit) {
  if (typeof permissions === 'function') return permissions;
  if (permissions && APPROVE_ALL_KINDS.includes(String(permissions))) return sdk.approveAll;
  if (permissions === 'emit') {
    // Surface every request as a normalized event that carries a resolver. If
    // nobody answers within the timeout the request is denied.
    return (request, invocation) =>
      new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
          }
        }, 60_000);
        emit({
          type: 'permission.request',
          source: 'copilot-sdk',
          request,
          sessionId: invocation.sessionId,
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
 */
export async function createCopilotSdkAdapter(config = {}) {
  const sdk = await import('@github/copilot-sdk');
  const { CopilotClient, RuntimeConnection } = sdk;

  /** @type {import('@github/copilot-sdk').CopilotClientOptions} */
  const clientOptions = { ...(config.client || {}) };
  if (config.runtime?.uri) {
    clientOptions.connection = RuntimeConnection.forUri(config.runtime.uri, {
      connectionToken: config.runtime.connectionToken
    });
  } else if (config.runtime?.cliPath || config.runtime?.args) {
    clientOptions.connection = RuntimeConnection.forStdio({
      path: config.runtime.cliPath,
      args: config.runtime.args,
      env: config.runtime.env
    });
  }
  if (config.runtime?.mode) clientOptions.mode = config.runtime.mode;
  if (config.runtime?.baseDirectory) clientOptions.baseDirectory = config.runtime.baseDirectory;
  if (clientOptions.mode === 'empty' && !clientOptions.baseDirectory && !clientOptions.sessionFs && !clientOptions.connection) {
    // Verified against @github/copilot-sdk 1.0.13: "Empty mode requires an
    // explicit per-session persistence location". Default to a per-user temp
    // directory so the mode works out of the box; override with runtime.baseDirectory.
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
  const emit = (/** @type {HarnessEvent} */ event) => listeners.forEach((l) => l(event));

  /** @param {import('../../index.js').CreateSessionOptions} [opts] */
  async function createSession(opts = {}) {
    /** @type {import('@github/copilot-sdk').SessionConfig} */
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
    const permissionHandler = buildPermissionHandler(config.permissions, sdk, emit);
    if (permissionHandler) sessionConfig.onPermissionRequest = permissionHandler;

    const session = opts.resume
      ? await client.resumeSession(opts.resume, sessionConfig)
      : await client.createSession(sessionConfig);

    let turnCounter = 0;

    /**
     * @param {string} prompt
     * @param {{ timeoutMs?: number, attachments?: any[], agentMode?: 'interactive' | 'plan' | 'autopilot' }} [sendOpts]
     * @returns {AsyncIterableIterator<HarnessEvent>}
     */
    function stream(prompt, sendOpts = {}) {
      const queue = createEventQueue();
      const turn = ++turnCounter;
      const mapper = createSdkEventMapper({ turn });
      const timeoutMs = sendOpts.timeoutMs ?? config.turnTimeoutMs ?? 5 * 60_000;

      const push = (/** @type {HarnessEvent} */ ev) => {
        queue.push(ev);
        emit(ev);
      };

      const off = session.on((event) => {
        const { event: mapped, done } = mapper.map(event);
        push(mapped);
        if (done) finish();
      });

      const timer = setTimeout(() => {
        push({ type: 'error', error: new Error(`Turn timed out after ${timeoutMs} ms`), code: 'TURN_TIMEOUT', source: 'copilot-sdk', raw: null, turn });
        finish();
      }, timeoutMs);

      function finish() {
        clearTimeout(timer);
        off();
        queue.close();
      }

      /** @type {import('@github/copilot-sdk').MessageOptions} */
      const message = { prompt };
      if (sendOpts.attachments) message.attachments = sendOpts.attachments;
      if (sendOpts.agentMode) message.agentMode = sendOpts.agentMode;
      session.send(message).catch((err) => {
        push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)), code: 'SEND_FAILED', source: 'copilot-sdk', raw: err, turn });
        finish();
      });

      return queue.iterator();
    }

    return {
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
          if (ev.type === 'text.final') text = ev.text;
          if (ev.type === 'idle' && !text) text = ev.text;
          if (ev.type === 'error') failure = ev.error;
        }
        if (failure && !text) throw failure;
        return { text, events };
      },
      async abort() {
        await session.abort();
      },
      async close() {
        await session.disconnect();
      },
      native: session
    };
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
      return {
        ok: true,
        mode: 'copilot-sdk',
        elapsedMs: Date.now() - started,
        details: { status, auth }
      };
    },
    async listSessions() {
      return client.listSessions();
    },
    async deleteSession(/** @type {string} */ id) {
      await client.deleteSession(id);
    },
    async close() {
      await client.stop();
    },
    native: client
  };
}
