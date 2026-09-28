/**
 * Offline tests for the copilot-sdk adapter using a fake @github/copilot-sdk
 * module whose dispatch/disconnect semantics mirror dist/session.js:
 * handlers registered with session.on(), disconnect() clears them, abort()
 * dispatches an aborted idle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessClient } from '../index.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {(prompt: string, dispatch: (e: any) => void) => void | Promise<void>} script
 * @param {{ sendError?: Error }} [opts]
 */
function fakeSdk(script, opts = {}) {
  const log = { clientOptions: null, sessionConfigs: [], sent: [], aborts: 0, disconnects: 0, stops: 0 };
  class FakeSession {
    constructor(config) {
      this.sessionId = config.sessionId || 'fake-session';
      this.config = config;
      this.handlers = new Set();
      this.inFlight = null;
    }
    on(handler) {
      this.handlers.add(handler);
      return () => this.handlers.delete(handler);
    }
    dispatch(event) {
      for (const h of [...this.handlers]) {
        try {
          h(event);
        } catch {
          // mirrors dist/session.js _dispatchEvent: listener errors are swallowed
        }
      }
    }
    async send(message) {
      if (opts.sendError) throw opts.sendError;
      log.sent.push(message);
      const messageId = `msg-${log.sent.length}`;
      const generation = messageId;
      this.currentGeneration = generation;
      // Runtime replies asynchronously, after send() has resolved. Like the
      // real runtime, an aborted turn stops producing events.
      this.inFlight = (async () => {
        await tick(1);
        await script(message.prompt, (e) => {
          if (this.currentGeneration === generation) this.dispatch(e);
        }, this);
      })();
      return messageId;
    }
    async abort() {
      log.aborts += 1;
      this.currentGeneration = null;
      await tick(1);
      this.dispatch({ type: 'session.idle', data: { aborted: true } });
    }
    async disconnect() {
      log.disconnects += 1;
      this.handlers.clear();
    }
  }
  class FakeClient {
    constructor(options) {
      log.clientOptions = options;
    }
    async start() {}
    async stop() {
      log.stops += 1;
      return [];
    }
    async createSession(config) {
      log.sessionConfigs.push(config);
      this.last = new FakeSession(config);
      return this.last;
    }
    async resumeSession(id, config) {
      log.sessionConfigs.push({ ...config, sessionId: id });
      this.last = new FakeSession({ ...config, sessionId: id });
      return this.last;
    }
    async getStatus() {
      return { protocolVersion: 3 };
    }
    async getAuthStatus() {
      return { isAuthenticated: true };
    }
    async listSessions() {
      return [];
    }
    async deleteSession() {}
  }
  const RuntimeConnection = {
    forUri: (url, o) => ({ kind: 'uri', url, ...o }),
    forStdio: (o) => ({ kind: 'stdio', ...o })
  };
  const approveAll = () => ({ kind: 'approve-once' });
  return { sdk: { CopilotClient: FakeClient, RuntimeConnection, approveAll }, log };
}

/** Script: two deltas, a final, idle. */
const simpleReply = (text) => async (prompt, dispatch) => {
  dispatch({ type: 'assistant.message_delta', data: { deltaContent: text.slice(0, 1), messageId: 'm' } });
  await tick(1);
  dispatch({ type: 'assistant.message_delta', data: { deltaContent: text.slice(1), messageId: 'm' } });
  dispatch({ type: 'assistant.message', data: { content: text, messageId: 'm' } });
  dispatch({ type: 'session.idle', data: {} });
};

test('copilot-sdk: a turn streams deltas, final and idle; send() returns the final text', async () => {
  const { sdk, log } = fakeSdk(simpleReply('xy'));
  const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { model: 'auto', instructions: 'Be brief.' } }, { sdk });
  const session = await client.createSession({ sessionId: 's1' });
  const types = [];
  for await (const ev of session.stream('hi')) types.push(ev.type);
  assert.deepEqual(types, ['text.delta', 'text.delta', 'text.final', 'idle']);
  const result = await session.send('again');
  assert.equal(result.text, 'xy');
  assert.equal(log.sent.length, 2);
  assert.deepEqual(log.sessionConfigs[0].systemMessage, { mode: 'append', content: 'Be brief.' });
  assert.equal(log.sessionConfigs[0].streaming, true);
  await client.close();
  assert.equal(log.stops, 1);
});

test('copilot-sdk: breaking out of a stream aborts the SDK turn, unsubscribes, and the next turn gets its own answer', async () => {
  let n = 0;
  const { sdk, log } = fakeSdk(async (prompt, dispatch) => {
    n += 1;
    const text = n === 1 ? 'ab' : 'xy';
    dispatch({ type: 'assistant.message_delta', data: { deltaContent: text[0] } });
    await tick(20);
    dispatch({ type: 'assistant.message_delta', data: { deltaContent: text[1] } });
    dispatch({ type: 'assistant.message', data: { content: text } });
    dispatch({ type: 'session.idle', data: {} });
  });
  const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 5_000 } }, { sdk });
  const session = await client.createSession();
  for await (const ev of session.stream('one')) {
    if (ev.type === 'text.delta') break;
  }
  assert.equal(log.aborts, 1, 'early break aborts the in-flight SDK turn');
  const second = await session.send('two');
  assert.equal(second.text, 'xy');
  assert.ok(second.events.every((e) => e.turn === 2));
  assert.equal(session.native.handlers.size, 0, 'no listener leaked after the break or the completed turn');
  await client.close();
});

test('copilot-sdk: turns on one session are serialized', async () => {
  const { sdk } = fakeSdk(async (prompt, dispatch) => {
    await tick(10);
    dispatch({ type: 'assistant.message', data: { content: `reply:${prompt}` } });
    dispatch({ type: 'session.idle', data: {} });
  });
  const client = await HarnessClient.create({ mode: 'copilot-sdk' }, { sdk });
  const session = await client.createSession();
  const [a, b] = await Promise.all([session.send('one'), session.send('two')]);
  assert.equal(a.text, 'reply:one');
  assert.equal(b.text, 'reply:two');
  await client.close();
});

test('copilot-sdk: an autopilot idle does not end the turn', async () => {
  const { sdk } = fakeSdk(async (prompt, dispatch) => {
    dispatch({ type: 'assistant.message_delta', data: { deltaContent: 'a' } });
    dispatch({ type: 'session.idle', data: { mode: 'autopilot' } });
    await tick(5);
    dispatch({ type: 'assistant.message_delta', data: { deltaContent: 'b' } });
    dispatch({ type: 'assistant.message', data: { content: 'ab' } });
    dispatch({ type: 'session.idle', data: { mode: 'interactive' } });
  });
  const client = await HarnessClient.create({ mode: 'copilot-sdk' }, { sdk });
  const session = await client.createSession();
  const result = await session.send('go', { agentMode: 'autopilot' });
  assert.equal(result.text, 'ab');
  assert.deepEqual(result.events.map((e) => e.type), ['text.delta', 'status', 'text.delta', 'text.final', 'idle']);
  await client.close();
});

test('copilot-sdk: a turn timeout ends the stream with error then idle and aborts the SDK turn', async () => {
  const { sdk, log } = fakeSdk(async (prompt, dispatch) => {
    dispatch({ type: 'assistant.message_delta', data: { deltaContent: 'partial' } });
    // never idles
  });
  const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 30 } }, { sdk });
  const session = await client.createSession();
  const events = [];
  for await (const ev of session.stream('hang')) events.push(ev);
  assert.deepEqual(events.map((e) => e.type), ['text.delta', 'error', 'idle']);
  assert.equal(events[1].code, 'TURN_TIMEOUT');
  assert.equal(events[2].text, 'partial');
  assert.equal(log.aborts, 1);
  await client.close();
});

test('copilot-sdk: closing the session while a stream is open ends it with SESSION_CLOSED then idle', async () => {
  const { sdk } = fakeSdk(async (prompt, dispatch) => {
    dispatch({ type: 'assistant.message_delta', data: { deltaContent: 'a' } });
    await tick(50);
    dispatch({ type: 'assistant.message', data: { content: 'ab' } });
    dispatch({ type: 'session.idle', data: {} });
  });
  const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 5_000 } }, { sdk });
  const session = await client.createSession();
  const events = [];
  for await (const ev of session.stream('x')) {
    events.push(ev.type);
    if (ev.type === 'text.delta') await session.close();
  }
  assert.deepEqual(events, ['text.delta', 'error', 'idle']);
  await client.close();
});

test('copilot-sdk: a throwing onEvent listener neither breaks the turn nor starves other listeners', async () => {
  const { sdk } = fakeSdk(simpleReply('ok'));
  const listenerErrors = [];
  const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 500, onListenerError: (e) => listenerErrors.push(e.message) } }, { sdk });
  const seenByOther = [];
  client.onEvent((e) => {
    if (e.type === 'idle') throw new Error('listener bug');
  });
  client.onEvent((e) => seenByOther.push(e.type));
  const session = await client.createSession();
  const result = await session.send('hi');
  assert.equal(result.text, 'ok');
  assert.deepEqual(seenByOther, ['text.delta', 'text.delta', 'text.final', 'idle']);
  assert.deepEqual(listenerErrors, ['listener bug']);
  await client.close();
});

test('copilot-sdk: permissions "emit" delivers permission.request to the stream and to onEvent, and respond() resolves approve-once', async () => {
  let handlerResult;
  const { sdk, log } = fakeSdk(async (prompt, dispatch, session) => {
    // The runtime asks for permission mid-turn via the session config handler.
    handlerResult = await session.config.onPermissionRequest({ kind: 'custom-tool', toolName: 'lookupOrder' }, { sessionId: session.sessionId });
    dispatch({ type: 'assistant.message', data: { content: 'done' } });
    dispatch({ type: 'session.idle', data: {} });
  });
  const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { permissions: 'emit' } }, { sdk });
  const viaListener = [];
  client.onEvent((e) => viaListener.push(e.type));
  const session = await client.createSession();
  const types = [];
  for await (const ev of session.stream('use the tool')) {
    types.push(ev.type);
    if (ev.type === 'permission.request') {
      assert.equal(ev.request.kind, 'custom-tool');
      ev.respond('approve');
    }
  }
  assert.deepEqual(types, ['permission.request', 'text.final', 'idle']);
  assert.deepEqual(handlerResult, { kind: 'approve-once' });
  assert.equal(viaListener.filter((t) => t === 'permission.request').length, 1);
  assert.equal(typeof log.sessionConfigs[0].onPermissionRequest, 'function');
  await client.close();
});

test('copilot-sdk: permissions "approve-all" and "deny" map to the SDK handler and default', async () => {
  const a = fakeSdk(simpleReply('x'));
  const clientA = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { permissions: 'approve-all' } }, { sdk: a.sdk });
  await clientA.createSession();
  assert.equal(a.log.sessionConfigs[0].onPermissionRequest, a.sdk.approveAll);
  await clientA.close();
  const d = fakeSdk(simpleReply('x'));
  const clientD = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { permissions: 'deny' } }, { sdk: d.sdk });
  await clientD.createSession();
  assert.equal(d.log.sessionConfigs[0].onPermissionRequest, undefined);
  await clientD.close();
});

test('copilot-sdk: empty mode defaults baseDirectory (spawned runtimes) and availableTools; uri runtimes skip baseDirectory', async () => {
  const spawned = fakeSdk(simpleReply('x'));
  const c1 = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { runtime: { mode: 'empty', cliPath: '/opt/copilot' } } }, { sdk: spawned.sdk });
  assert.equal(spawned.log.clientOptions.mode, 'empty');
  assert.equal(spawned.log.clientOptions.connection.kind, 'stdio');
  assert.match(spawned.log.clientOptions.baseDirectory, /copilot-harness-sdk/);
  await c1.createSession();
  assert.deepEqual(spawned.log.sessionConfigs[0].availableTools, ['custom:*']);
  await c1.close();

  const external = fakeSdk(simpleReply('x'));
  const c2 = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { runtime: { mode: 'empty', uri: 'localhost:4321' }, session: { availableTools: ['custom:lookup'] } } }, { sdk: external.sdk });
  assert.equal(external.log.clientOptions.connection.kind, 'uri');
  assert.equal(external.log.clientOptions.baseDirectory, undefined);
  await c2.createSession();
  assert.deepEqual(external.log.sessionConfigs[0].availableTools, ['custom:lookup']);
  await c2.close();
});

test('copilot-sdk: runtime.env alone spawns the CLI with that environment (installation-token path)', async () => {
  const { sdk, log } = fakeSdk(simpleReply('x'));
  const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { runtime: { env: { COPILOT_GITHUB_TOKEN: 'ghs_x' } } } }, { sdk });
  assert.equal(log.clientOptions.connection.kind, 'stdio');
  assert.deepEqual(log.clientOptions.connection.env, { COPILOT_GITHUB_TOKEN: 'ghs_x' });
  await client.close();
});

test('copilot-sdk: a rejected session.send surfaces as SEND_FAILED then idle, and send() throws', async () => {
  const { sdk } = fakeSdk(simpleReply('x'), { sendError: Object.assign(new Error('runtime gone'), { code: 'ECONN' }) });
  const client = await HarnessClient.create({ mode: 'copilot-sdk' }, { sdk });
  const session = await client.createSession();
  const events = [];
  for await (const ev of session.stream('hi')) events.push(ev);
  assert.deepEqual(events.map((e) => e.type), ['error', 'idle']);
  assert.equal(events[0].code, 'SEND_FAILED');
  await assert.rejects(session.send('hi'), /runtime gone/);
  await client.close();
});

test('copilot-sdk: githubToken sets useLoggedInUser=false; byok without model is rejected by validateConfig', async () => {
  const { sdk, log } = fakeSdk(simpleReply('x'));
  const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { githubToken: 'gho_x' } }, { sdk });
  assert.equal(log.clientOptions.gitHubToken, 'gho_x');
  assert.equal(log.clientOptions.useLoggedInUser, false);
  await client.close();
  await assert.rejects(HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { byok: { baseUrl: 'https://x' } } }, { sdk }), /requires model/);
});
