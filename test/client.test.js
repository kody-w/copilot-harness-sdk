import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessClient, validateConfig, recommendMode, capabilitiesFor, MODES, allCapabilities } from '../index.js';
import { explainStatus } from '../src/adapters/copilot-studio.js';

const ENV = '11111111-2222-3333-4444-555555555555';
const token = async () => 'delegated-token';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('every mode has a capability record with sources', () => {
  assert.equal(allCapabilities().length, MODES.length);
  for (const mode of MODES) {
    const c = capabilitiesFor(mode);
    assert.equal(c.mode, mode);
    assert.ok(c.sources.length > 0, `${mode} must cite sources`);
    assert.ok(['ga', 'preview', 'private-preview', 'experimental', 'unsupported', 'deprecated'].includes(c.support));
  }
  assert.throws(() => capabilitiesFor('nope'), /Unknown harness mode/);
});

test('capabilities encode the findings that matter for routing', () => {
  assert.equal(capabilitiesFor('copilot-sdk').codeTools, true);
  assert.equal(capabilitiesFor('copilot-sdk').appOnly, true);
  assert.equal(capabilitiesFor('copilot-studio-3p').support, 'experimental');
  assert.equal(capabilitiesFor('copilot-studio-3p').appOnly, false);
  assert.equal(capabilitiesFor('copilot-studio-standard').support, 'deprecated');
  assert.equal(capabilitiesFor('copilot-studio-s2s').support, 'private-preview');
  assert.equal(capabilitiesFor('agentic-directline').streaming, 'final-only');
});

test('validateConfig reports every problem at once and agrees with create()', async () => {
  assert.deepEqual(validateConfig(/** @type {any} */ ({ mode: 'bogus' })), ['mode must be one of ' + MODES.join(', ')]);
  assert.deepEqual(validateConfig({ mode: 'copilot-sdk' }), []);
  assert.deepEqual(validateConfig({ mode: 'copilot-sdk', copilotSdk: { byok: { baseUrl: 'https://x' } } }), ['copilot-sdk with byok requires model']);
  assert.equal(validateConfig({ mode: 'copilot-sdk', copilotSdk: { runtime: { uri: 'localhost:1', env: { A: '1' } } } }).length, 1);
  assert.equal(validateConfig({ mode: 'copilot-studio-3p', copilotStudio: {} }).length, 2);
  assert.deepEqual(validateConfig({ mode: 'copilot-studio-standard', copilotStudio: { environmentId: ENV, schemaName: 'a_b', getAccessToken: token, allowClassicAgent: true } }), []);
  assert.equal(validateConfig({ mode: 'copilot-studio-standard', copilotStudio: { directConnectUrl: 'https://x', getAccessToken: token, allowClassicAgent: true } }).length, 2);
  assert.deepEqual(validateConfig({ mode: 'agentic-directline', copilotStudio: { environmentId: ENV, schemaName: 'a_b' } }), []);
  assert.deepEqual(validateConfig({ mode: 'agentic-directline', copilotStudio: { directLineTokenUrl: 'https://x/token' } }), []);
  const badDl = validateConfig({ mode: 'agentic-directline', copilotStudio: { directConnectUrl: 'https://x' } });
  assert.equal(badDl.length, 2);
  await assert.rejects(HarnessClient.create({ mode: 'agentic-directline', copilotStudio: { directConnectUrl: 'https://x' } }), /Invalid HarnessClient config/);
});

test('recommendMode follows the decision guide', () => {
  assert.equal(recommendMode({ hasGithubIdentity: true }).mode, 'copilot-sdk');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'github-copilot' }).mode, 'copilot-studio-3p');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'standard' }).mode, 'copilot-studio-3p');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'standard', allowClassicAgent: true }).mode, 'copilot-studio-standard');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasAppOnlyEntraCredentials: true, agentAuthentication: 'none' }).mode, 'copilot-studio-s2s');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasAppOnlyEntraCredentials: true, agentAuthentication: 'microsoft' }).mode, 'copilot-studio-3p');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true }).mode, 'agentic-directline');
});

test('explainStatus applies the 401/403/404 and S2S failure table', () => {
  assert.match(explainStatus(401), /app-only/);
  assert.match(explainStatus(403), /shared/);
  assert.match(explainStatus(404), /published/);
  assert.match(explainStatus(400, 'S2SDirectEngineRequiresNoAuthentication'), /No Authentication/);
});

/** A fake Copilot Studio client that replays the verified /3p wire shapes. */
function fakeStudioClient(log, opts = {}) {
  return (settings, tok) => {
    log.push({ settings, token: tok });
    const client = {
      conversationId: '',
      token: tok,
      async *startConversationStreaming(emit) {
        if (opts.startError) throw opts.startError;
        client.conversationId = 'conv-1';
        yield { type: 'event', name: 'startConversation' };
        yield { type: 'message', text: 'Hi, I am the agent.', channelData: { streamType: 'final', streamId: 'g1' } };
      },
      async *executeStreaming(activity, conversationId) {
        if (activity.type !== 'message' || !activity.text) throw new Error('fake: executeStreaming needs a message activity with text');
        log.push({ sent: activity, conversationId, tokenAtSend: client.token });
        if (opts.turnError) throw opts.turnError;
        if (opts.hang) {
          await new Promise(() => {});
        }
        yield { type: 'typing', text: 'Searching…', channelData: { streamType: 'informative', streamId: 's1', streamSequence: 1 } };
        yield { type: 'typing', text: 'The an', channelData: { streamType: 'streaming', streamId: 's1', streamSequence: 2 } };
        yield { type: 'typing', text: 'The answer is 42', channelData: { streamType: 'streaming', streamId: 's1', streamSequence: 3 } };
        yield { type: 'message', text: 'The answer is 42.', channelData: { streamType: 'final', streamId: 's1' } };
        yield { type: 'event', name: 'turn.complete' };
      }
    };
    return client;
  };
}

function fakeFetch(status = 200, body = '') {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, text: async () => body, body: { cancel: async () => {} } };
  };
  impl.calls = calls;
  return impl;
}

test('copilot-studio-3p: preflight, guarded URL, delegated token refresh per turn, outbound activity, normalized stream', async () => {
  const log = [];
  const fetchImpl = fakeFetch(200);
  let tokenCalls = 0;
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-3p', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: async () => `tok-${++tokenCalls}` } },
    { clientFactory: fakeStudioClient(log), fetchImpl }
  );
  assert.equal(client.describe().startsWith('copilot-studio-3p'), true);
  assert.equal(client.resolved.conversationsUrl.href, 'https://111111112222333344445555555555.55.environment.api.powerplatform.com/copilotstudio/agenticruntime/3p/dataverse-backed/authenticated/bots/cr123_agent/conversations?api-version=1');

  const session = await client.createSession();
  assert.equal(fetchImpl.calls.length, 1, 'one-shot preflight POST');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer tok-1');
  assert.equal(session.conversationId, 'conv-1');
  assert.deepEqual(session.greeting.map((e) => e.type), ['raw', 'text.delta', 'text.final', 'idle']);
  assert.equal(log[0].settings.directConnectUrl, client.resolved.settings.directConnectUrl);

  const seen = [];
  for await (const ev of session.stream('question')) seen.push(ev);
  assert.deepEqual(seen.map((e) => e.type), ['status', 'text.delta', 'text.delta', 'text.delta', 'text.final', 'raw', 'idle']);
  assert.equal(seen[4].text, 'The answer is 42.');
  assert.equal(seen[6].text, 'The answer is 42.');
  const sent = log.find((l) => l.sent);
  assert.deepEqual(sent.sent, { type: 'message', text: 'question', conversation: { id: 'conv-1' } });
  assert.equal(sent.conversationId, 'conv-1');
  assert.equal(sent.tokenAtSend, 'tok-2', 'token re-acquired before the turn');

  const result = await session.send('again');
  assert.equal(result.text, 'The answer is 42.');
  assert.equal(result.events.filter((e) => e.type === 'text.delta').length, 3);
});

test('copilot-studio-3p: onEvent receives the same sequence as the stream, with turn numbers, and unsubscribe stops delivery', async () => {
  const log = [];
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-3p', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token } },
    { clientFactory: fakeStudioClient(log), fetchImpl: fakeFetch(200) }
  );
  const viaListener = [];
  const off = client.onEvent((e) => viaListener.push(`${e.turn}:${e.type}`));
  const session = await client.createSession();
  const viaStream = [];
  for await (const ev of session.stream('q')) viaStream.push(`${ev.turn}:${ev.type}`);
  assert.deepEqual(viaListener.slice(-viaStream.length), viaStream);
  assert.ok(viaStream.every((s) => s.startsWith('2:')));
  off();
  await session.send('q2');
  assert.equal(viaListener.length, 4 + viaStream.length, 'no events after unsubscribe');
});

test('copilot-studio-3p: a 403 preflight fails fast with the sharing hint', async () => {
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-3p', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token } },
    { clientFactory: fakeStudioClient([]), fetchImpl: fakeFetch(403, 'Forbidden') }
  );
  await assert.rejects(client.createSession(), (err) => err.httpStatus === 403 && /shared/.test(err.hint));
});

test('copilot-studio-standard: uses environmentId + schemaName, no /3p preflight, and start failures propagate with status and hint', async () => {
  const log = [];
  const fetchImpl = fakeFetch(200);
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-standard', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token, allowClassicAgent: true } },
    { clientFactory: fakeStudioClient(log), fetchImpl }
  );
  const session = await client.createSession();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(log[0].settings.environmentId, ENV);
  assert.equal(log[0].settings.schemaName, 'cr123_agent');
  assert.equal(log[0].settings.directConnectUrl, undefined);
  assert.equal(session.conversationId, 'conv-1');

  const failing = await HarnessClient.create(
    { mode: 'copilot-studio-standard', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token, allowClassicAgent: true } },
    { clientFactory: fakeStudioClient([], { startError: Object.assign(new Error('Request failed with status 403 Forbidden'), { httpStatus: 403 }) }), fetchImpl }
  );
  await assert.rejects(failing.createSession(), (err) => /403/.test(err.message) && err.httpStatus === 403 && /shared/.test(err.hint));
});

test('copilot-studio-s2s: app-only token flows to the same guarded /3p route', async () => {
  const log = [];
  const fetchImpl = fakeFetch(200);
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-s2s', copilotStudio: { environmentId: ENV, schemaName: 'cr123_noauth', getAccessToken: async () => 'app-token' } },
    { clientFactory: fakeStudioClient(log), fetchImpl }
  );
  assert.equal(client.capabilities().identity[0], 'entra-app');
  await client.createSession();
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer app-token');
  assert.match(log[0].settings.directConnectUrl, /cr123_noauth\?api-version=1$/);
});

test('copilot-studio: resume skips the preflight and the greeting, and targets the given conversation', async () => {
  const log = [];
  const fetchImpl = fakeFetch(200);
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-3p', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token } },
    { clientFactory: fakeStudioClient(log), fetchImpl }
  );
  const session = await client.createSession({ resume: 'conv-existing' });
  assert.equal(fetchImpl.calls.length, 0, 'no throwaway preflight conversation on resume');
  assert.equal(session.conversationId, 'conv-existing');
  assert.deepEqual(session.greeting, []);
  const result = await session.send('hi');
  assert.equal(log.find((l) => l.sent).conversationId, 'conv-existing');
  assert.equal(result.text, 'The answer is 42.');
});

test('copilot-studio: a turn failure is an in-stream error with status, then idle; send() rejects', async () => {
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-3p', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token, preflight: false } },
    { clientFactory: fakeStudioClient([], { turnError: Object.assign(new Error('boom'), { httpStatus: 429 }) }), fetchImpl: fakeFetch(200) }
  );
  const listener = [];
  client.onEvent((e) => listener.push(e.type));
  const session = await client.createSession();
  const events = [];
  for await (const ev of session.stream('q')) events.push(ev);
  assert.deepEqual(events.map((e) => e.type), ['error', 'idle']);
  assert.equal(events[0].statusCode, 429);
  assert.ok(listener.includes('error'));
  await assert.rejects(session.send('q'), /boom/);
});

test('copilot-studio: a token-provider failure surfaces in-stream, not as a thrown next()', async () => {
  let calls = 0;
  const client = await HarnessClient.create(
    {
      mode: 'copilot-studio-3p',
      copilotStudio: {
        environmentId: ENV,
        schemaName: 'cr123_agent',
        preflight: false,
        getAccessToken: async () => {
          calls += 1;
          if (calls > 1) throw new Error('silent refresh failed');
          return 'tok';
        }
      }
    },
    { clientFactory: fakeStudioClient([]), fetchImpl: fakeFetch(200) }
  );
  const session = await client.createSession();
  const events = [];
  for await (const ev of session.stream('q')) events.push(ev);
  assert.deepEqual(events.map((e) => e.type), ['error', 'idle']);
  assert.match(events[0].error.message, /silent refresh failed/);
});

test('copilot-studio: turnTimeoutMs ends a stalled turn with TURN_TIMEOUT then idle', async () => {
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-3p', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token, preflight: false, turnTimeoutMs: 40 } },
    { clientFactory: fakeStudioClient([], { hang: true }), fetchImpl: fakeFetch(200) }
  );
  const session = await client.createSession();
  const events = [];
  for await (const ev of session.stream('q')) events.push(ev);
  assert.deepEqual(events.map((e) => e.type), ['error', 'idle']);
  assert.equal(events[0].code, 'TURN_TIMEOUT');
  const perCall = [];
  for await (const ev of session.stream('q', { timeoutMs: 20 })) perCall.push(ev.type);
  assert.deepEqual(perCall, ['error', 'idle']);
});

/** Watermark-aware Direct Line fake: history only when no watermark is present. */
function fakeDirectLine(opts = {}) {
  const calls = [];
  const history = opts.history || [];
  let posted = 0;
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET' });
    if (u.includes('/directline/token')) {
      if (opts.tokenStatus && opts.tokenStatus !== 200) return { ok: false, status: opts.tokenStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ token: 'dl-token' }) };
    }
    if (u.endsWith('/conversations') && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ conversationId: 'dl-conv' }) };
    if (u.endsWith('/activities') && init.method === 'POST') {
      if (opts.postStatus && opts.postStatus !== 200) return { ok: false, status: opts.postStatus, json: async () => ({}) };
      posted += 1;
      return { ok: true, status: 200, json: async () => ({ id: `a${posted}` }) };
    }
    if (u.includes('/activities')) {
      if (opts.pollStatus && opts.pollStatus !== 200) return { ok: false, status: opts.pollStatus, json: async () => ({}) };
      const hasWatermark = /[?&]watermark=/.test(u);
      if (!hasWatermark) return { ok: true, status: 200, json: async () => ({ watermark: 'w-history', activities: history }) };
      if (!posted || opts.neverAnswer) return { ok: true, status: 200, json: async () => ({ watermark: 'w-history', activities: [] }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          watermark: 'w-new',
          activities: [
            { type: 'message', from: { id: 'copilot-harness-sdk' }, text: 'new question' },
            { type: 'typing', from: { id: 'bot' } },
            { type: 'message', from: { id: 'bot' }, text: 'NEW answer' },
            { type: 'event', name: 'turn.complete', from: { id: 'bot' } }
          ]
        })
      };
    }
    throw new Error('unexpected ' + u);
  };
  impl.calls = calls;
  return impl;
}

test('agentic-directline: primes the watermark, keeps the greeting, and returns only this turn\'s answer', async () => {
  const fetchImpl = fakeDirectLine({ history: [{ type: 'message', from: { id: 'bot' }, text: 'Welcome!' }] });
  const client = await HarnessClient.create({ mode: 'agentic-directline', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent' } }, { fetchImpl });
  assert.equal(client.capabilities().streaming, 'final-only');
  const session = await client.createSession();
  assert.equal(session.conversationId, 'dl-conv');
  assert.deepEqual(session.greeting.filter((e) => e.type === 'text.final').map((e) => e.text), ['Welcome!']);
  const result = await session.send('new question');
  assert.equal(result.text, 'NEW answer');
  assert.deepEqual(result.events.map((e) => e.type), ['raw', 'text.delta', 'text.final', 'raw', 'idle']);
  const polls = fetchImpl.calls.filter((c) => c.method === 'GET' && c.url.includes('/activities'));
  assert.ok(polls[0].url.endsWith('/activities'), 'first GET primes without a watermark');
  assert.ok(polls.slice(1).every((c) => /watermark=/.test(c.url)), 'every later poll carries the watermark');
});

test('agentic-directline: resume discards history instead of returning a stale answer', async () => {
  const fetchImpl = fakeDirectLine({
    history: [
      { type: 'message', from: { id: 'copilot-harness-sdk' }, text: 'old question' },
      { type: 'message', from: { id: 'bot' }, text: 'OLD answer from yesterday' }
    ]
  });
  const client = await HarnessClient.create({ mode: 'agentic-directline', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent' } }, { fetchImpl });
  const session = await client.createSession({ resume: 'old-conv' });
  assert.deepEqual(session.greeting, []);
  const result = await session.send('new question');
  assert.equal(result.text, 'NEW answer');
});

test('agentic-directline: HTTP failures and timeouts surface as error then idle', async () => {
  await assert.rejects(
    HarnessClient.create({ mode: 'agentic-directline', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent' } }, { fetchImpl: fakeDirectLine({ tokenStatus: 401 }) }).then((c) => c.createSession()),
    (err) => err.httpStatus === 401
  );
  const post403 = await HarnessClient.create({ mode: 'agentic-directline', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent' } }, { fetchImpl: fakeDirectLine({ postStatus: 403 }) });
  const s1 = await post403.createSession();
  const e1 = [];
  for await (const ev of s1.stream('x')) e1.push(ev);
  assert.deepEqual(e1.map((e) => e.type), ['error', 'idle']);
  assert.equal(e1[0].statusCode, 403);
  await assert.rejects(s1.send('x'), /403/);

  const timeout = await HarnessClient.create({ mode: 'agentic-directline', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', turnTimeoutMs: 30 } }, { fetchImpl: fakeDirectLine({ neverAnswer: true }) });
  const s2 = await timeout.createSession();
  const e2 = [];
  for await (const ev of s2.stream('x')) e2.push(ev);
  assert.deepEqual(e2.map((e) => e.type), ['error', 'idle']);
  assert.equal(e2[0].code, 'TURN_TIMEOUT');
  await tick(1);
});
