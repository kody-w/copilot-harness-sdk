/**
 * Offline tests for the Microsoft 365 Agents SDK host, using a fake
 * @microsoft/agents-hosting module whose StreamingResponse mirrors
 * dist/src/app/streaming/streamingResponse.js (1.8.1): chunks accumulate into
 * one message, queueing after endStream() throws, setFinalMessage() overrides
 * the accumulated text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentsSdkAgent, sessionIdForConversation } from '../index.js';

function fakeHosting() {
  class AgentApplication {
    constructor(options) {
      this.options = options;
      this.handlers = {};
    }
    onActivity(type, handler) {
      this.handlers[type] = handler;
      return this;
    }
    onConversationUpdate(event, handler) {
      this.handlers[`conversationUpdate:${event}`] = handler;
      return this;
    }
  }
  class MemoryStorage {}
  const MessageFactory = { text: (text) => ({ type: 'message', text }) };
  return { AgentApplication, MemoryStorage, MessageFactory };
}

function fakeContext(text, conversationId = 'a:1Abc;messageid=9@thread.v2') {
  const log = { informative: [], chunks: [], ended: 0, finalMessage: null, aiLabel: null, sent: [] };
  let ended = false;
  const context = {
    activity: { type: 'message', text, conversation: { id: conversationId }, channelId: 'msteams' },
    sendActivity: async (a) => { log.sent.push(a); },
    streamingResponse: {
      setGeneratedByAILabel: (v) => { log.aiLabel = v; },
      queueInformativeUpdate: (t) => { if (ended) throw new Error('stream already ended'); log.informative.push(t); },
      queueTextChunk: (t) => { if (ended) throw new Error('stream already ended'); log.chunks.push(t); },
      setFinalMessage: (a) => { log.finalMessage = a; },
      endStream: async () => { ended = true; log.ended += 1; return 'success'; }
    }
  };
  return { context, log, message: () => log.finalMessage?.text ?? log.chunks.join('') };
}

/** @param {(prompt: string, sessionId: string) => any[] | Promise<any[]>} script events for one turn (idle is appended) */
function fakeClient(script, opts = {}) {
  const log = { created: [], resumed: [], closed: [], prompts: [], streamOpts: [] };
  const open = (sessionId) => ({
    id: sessionId,
    async *stream(prompt, streamOpts) {
      log.prompts.push({ sessionId, prompt });
      log.streamOpts.push(streamOpts);
      const events = await script(prompt, sessionId);
      let last = '';
      for (const ev of events) {
        if (ev.type === 'text.final') last = ev.text;
        yield ev;
      }
      yield { type: 'idle', text: last };
    },
    async close() { log.closed.push(sessionId); }
  });
  return {
    log,
    async createSession({ sessionId, resume } = {}) {
      if (resume) {
        if (opts.resumeFails) throw new Error('no such session');
        log.resumed.push(resume);
        return open(resume);
      }
      if (opts.createFails) throw new Error('runtime is down');
      log.created.push(sessionId);
      return open(sessionId);
    }
  };
}

const host = (client, options = {}, deps = {}) =>
  createAgentsSdkAgent({ client, sweepIntervalMs: 0, ...options }, { hosting: fakeHosting(), ...deps });

test('hosting: a turn streams status as informative updates and deltas as text, then ends the stream once', async () => {
  const client = fakeClient(() => [
    { type: 'status', text: 'Searching…' },
    { type: 'text.delta', delta: 'Order 9 ', snapshot: 'Order 9 ' },
    { type: 'text.delta', delta: 'is shipped.', snapshot: 'Order 9 is shipped.' },
    { type: 'text.final', text: 'Order 9 is shipped.' }
  ]);
  const { agent } = await host(client);
  const { context, log, message } = fakeContext('  Where is order 9?  ');
  await agent.handlers.message(context);
  assert.deepEqual(log.informative, ['Searching…']);
  assert.equal(message(), 'Order 9 is shipped.', 'the final text is not repeated after its deltas');
  assert.equal(log.ended, 1);
  assert.equal(log.aiLabel, true);
  assert.equal(client.log.prompts[0].prompt, 'Where is order 9?');
});

test('hosting: a final-only mode still delivers the answer', async () => {
  const client = fakeClient(() => [{ type: 'text.final', text: 'Here is the whole answer.' }]);
  const { agent } = await host(client);
  const { context, log, message } = fakeContext('hi');
  await agent.handlers.message(context);
  assert.equal(message(), 'Here is the whole answer.');
  assert.equal(log.ended, 1);
});

test('hosting: two assistant messages in one turn are separate paragraphs, and tool use shows as an update', async () => {
  const client = fakeClient(() => [
    { type: 'text.delta', delta: 'Let me check.', snapshot: 'Let me check.' },
    { type: 'text.final', text: 'Let me check.' },
    { type: 'tool.start', id: 't1', name: 'lookupOrder' },
    { type: 'tool.end', id: 't1', success: true },
    { type: 'text.delta', delta: 'It shipped.', snapshot: 'It shipped.' },
    { type: 'text.final', text: 'It shipped.' }
  ]);
  const { agent } = await host(client);
  const { context, log, message } = fakeContext('order?');
  await agent.handlers.message(context);
  assert.equal(message(), 'Let me check.\n\nIt shipped.');
  assert.deepEqual(log.informative, ['Using lookupOrder…']);

  const quiet = await host(client, { describeTool: () => '' });
  const second = fakeContext('order?');
  await quiet.agent.handlers.message(second.context);
  assert.deepEqual(second.log.informative, [], 'describeTool can hide tool activity');
});

test('hosting: one conversation keeps one session; another conversation gets its own', async () => {
  const client = fakeClient(() => [{ type: 'text.final', text: 'ok' }]);
  const hosted = await host(client);
  await hosted.agent.handlers.message(fakeContext('one', 'conv-A').context);
  await hosted.agent.handlers.message(fakeContext('two', 'conv-A').context);
  await hosted.agent.handlers.message(fakeContext('three', 'conv-B').context);
  assert.equal(client.log.created.length, 2);
  assert.equal(hosted.sessionCount, 2);
  assert.deepEqual(client.log.prompts.map((p) => p.sessionId), [client.log.created[0], client.log.created[0], client.log.created[1]]);
  for (const id of client.log.created) assert.match(id, /^m365-[0-9a-f]{32}$/);
  assert.equal(sessionIdForConversation('conv-A'), client.log.created[0], 'the session id is stable for a conversation');
  assert.notEqual(client.log.created[0], client.log.created[1]);
});

test('hosting: a failure with no answer tells the user in plain words and reports the error', async () => {
  const client = fakeClient(() => [{ type: 'error', error: new Error('HTTP 403 InsufficientDelegatedPermissions'), statusCode: 403 }]);
  const errors = [];
  const { agent } = await host(client, { onError: (e) => { errors.push(e.message); } });
  const { context, log, message } = fakeContext('hi');
  await agent.handlers.message(context);
  assert.equal(message(), 'Sorry, something went wrong on my side. Please try again.');
  assert.doesNotMatch(message(), /403|Insufficient/, 'the technical error never reaches the user');
  assert.equal(log.ended, 1);
  assert.deepEqual(errors, ['HTTP 403 InsufficientDelegatedPermissions']);
});

test('hosting: a failure after text keeps the text, ends the stream, and reports the error', async () => {
  const client = fakeClient(() => [
    { type: 'text.delta', delta: 'Partial ans', snapshot: 'Partial ans' },
    { type: 'error', error: new Error('TURN_TIMEOUT'), code: 'TURN_TIMEOUT' }
  ]);
  const errors = [];
  const { agent } = await host(client, { onError: (e) => { errors.push(e.message); throw new Error('handler bug'); } });
  const { context, log, message } = fakeContext('hi');
  await agent.handlers.message(context);
  assert.equal(message(), 'Partial ans');
  assert.equal(log.ended, 1);
  assert.deepEqual(errors, ['TURN_TIMEOUT'], 'a throwing onError does not break the turn');
});

test('hosting: a session that cannot open answers in plain words and does not poison the conversation', async () => {
  const client = fakeClient(() => [{ type: 'text.final', text: 'ok' }], { createFails: true });
  const hosted = await host(client);
  const first = fakeContext('hi', 'conv-A');
  await hosted.agent.handlers.message(first.context);
  assert.equal(first.message(), 'Sorry, something went wrong on my side. Please try again.');
  assert.equal(first.log.ended, 1);
  assert.equal(hosted.sessionCount, 0, 'the failed session is forgotten so the next message retries');
});

test('hosting: an empty turn says so instead of leaving the user waiting', async () => {
  const client = fakeClient(() => []);
  const { agent } = await host(client);
  const { context, message } = fakeContext('hi');
  await agent.handlers.message(context);
  assert.equal(message(), 'I do not have an answer for that. Try asking in a different way.');
});

test('hosting: a blank message starts no turn', async () => {
  const client = fakeClient(() => [{ type: 'text.final', text: 'ok' }]);
  const { agent } = await host(client);
  const { context, log } = fakeContext('   ');
  await agent.handlers.message(context);
  assert.equal(client.log.prompts.length, 0);
  assert.equal(log.ended, 0);
});

test('hosting: permission requests are denied unless the host approves them', async () => {
  const decisions = [];
  const script = () => [
    { type: 'permission.request', request: { kind: 'shell' }, sessionId: 's', respond: (d) => decisions.push(d) },
    { type: 'text.final', text: 'done' }
  ];
  const denied = await host(fakeClient(script));
  await denied.agent.handlers.message(fakeContext('run it').context);
  const approved = await host(fakeClient(script), { onPermissionRequest: async () => 'approve' });
  await approved.agent.handlers.message(fakeContext('run it').context);
  const broken = await host(fakeClient(script), { onPermissionRequest: async () => { throw new Error('policy service down'); } });
  await broken.agent.handlers.message(fakeContext('run it').context);
  assert.deepEqual(decisions, ['deny', 'approve', 'deny']);
});

test('hosting: when a snapshot replaces streamed text, the final message carries the true text', async () => {
  const client = fakeClient(() => [
    { type: 'text.delta', delta: 'The answer is 41', snapshot: 'The answer is 41' },
    { type: 'text.delta', delta: '', snapshot: 'The answer is 42.', replaced: true },
    { type: 'text.final', text: 'The answer is 42.' }
  ]);
  const { agent } = await host(client);
  const { context, log, message } = fakeContext('hi');
  await agent.handlers.message(context);
  assert.deepEqual(log.finalMessage, { type: 'message', text: 'The answer is 42.' });
  assert.equal(message(), 'The answer is 42.');
});

test('hosting: idle sessions are closed by the sweep, busy and recent ones are kept', async () => {
  let clock = 1_000_000;
  const client = fakeClient(() => [{ type: 'text.final', text: 'ok' }]);
  const hosted = await host(client, { idleSessionMs: 1000 }, { now: () => clock });
  await hosted.agent.handlers.message(fakeContext('one', 'old').context);
  clock += 900;
  await hosted.agent.handlers.message(fakeContext('two', 'recent').context);
  clock += 200;
  assert.equal(await hosted.sweep(), 1);
  assert.deepEqual(client.log.closed, [sessionIdForConversation('old')]);
  assert.equal(hosted.sessionCount, 1);
  // The closed conversation simply opens a new session on its next message.
  await hosted.agent.handlers.message(fakeContext('again', 'old').context);
  assert.equal(client.log.created.length, 3);
});

test('hosting: close() closes every session and later messages start no turn', async () => {
  const client = fakeClient(() => [{ type: 'text.final', text: 'ok' }]);
  const hosted = await host(client);
  await hosted.agent.handlers.message(fakeContext('one', 'conv-A').context);
  await hosted.agent.handlers.message(fakeContext('two', 'conv-B').context);
  await hosted.close();
  assert.equal(client.log.closed.length, 2);
  assert.equal(hosted.sessionCount, 0);
  await hosted.agent.handlers.message(fakeContext('late', 'conv-A').context);
  assert.equal(client.log.prompts.length, 2);
});

test('hosting: resumeSessions resumes by the stable id and falls back to a new session', async () => {
  const resumable = fakeClient(() => [{ type: 'text.final', text: 'ok' }]);
  const a = await host(resumable, { resumeSessions: true });
  await a.agent.handlers.message(fakeContext('hi', 'conv-A').context);
  assert.deepEqual(resumable.log.resumed, [sessionIdForConversation('conv-A')]);
  assert.equal(resumable.log.created.length, 0);

  const fresh = fakeClient(() => [{ type: 'text.final', text: 'ok' }], { resumeFails: true });
  const b = await host(fresh, { resumeSessions: true });
  const { context, message } = fakeContext('hi', 'conv-A');
  await b.agent.handlers.message(context);
  assert.deepEqual(fresh.log.created, [sessionIdForConversation('conv-A')]);
  assert.equal(message(), 'ok');
});

test('hosting: greeting, turn timeout and application options are passed through', async () => {
  const client = fakeClient(() => [{ type: 'text.final', text: 'ok' }]);
  const { agent } = await host(client, { greeting: 'Hi, ask me anything.', turnTimeoutMs: 45_000, application: { agentName: 'Order Desk' }, aiLabel: false });
  const hello = fakeContext('');
  await agent.handlers['conversationUpdate:membersAdded'](hello.context);
  assert.deepEqual(hello.log.sent, ['Hi, ask me anything.']);
  const { context, log } = fakeContext('hi');
  await agent.handlers.message(context);
  assert.deepEqual(client.log.streamOpts[0], { timeoutMs: 45_000 });
  assert.equal(agent.options.agentName, 'Order Desk');
  assert.equal(log.aiLabel, null);
  const plain = await host(client);
  assert.equal(plain.agent.handlers['conversationUpdate:membersAdded'], undefined, 'no greeting handler unless asked');
});

test('hosting: a missing Agents SDK package says what to install; a missing client says so', async () => {
  const client = fakeClient(() => []);
  await assert.rejects(
    createAgentsSdkAgent({ client }, { importHosting: async () => { throw new Error("Cannot find package '@microsoft/agents-hosting'"); } }),
    /npm install @microsoft\/agents-hosting @microsoft\/agents-hosting-express/
  );
  await assert.rejects(createAgentsSdkAgent(/** @type {any} */ ({}), { hosting: fakeHosting() }), /requires options\.client/);
});
