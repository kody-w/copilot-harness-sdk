import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessClient, validateConfig, recommendMode, capabilitiesFor, MODES, allCapabilities } from '../index.js';
import { explainStatus } from '../src/adapters/copilot-studio.js';

const ENV = '11111111-2222-3333-4444-555555555555';
const token = async () => 'delegated-token';

test('every mode has a capability record with sources', () => {
  assert.equal(allCapabilities().length, MODES.length);
  for (const mode of MODES) {
    const c = capabilitiesFor(mode);
    assert.equal(c.mode, mode);
    assert.ok(c.sources.length > 0, `${mode} must cite sources`);
    assert.ok(['ga', 'preview', 'private-preview', 'experimental', 'unsupported'].includes(c.support));
  }
  assert.throws(() => capabilitiesFor('nope'), /Unknown harness mode/);
});

test('capabilities encode the findings that matter for routing', () => {
  assert.equal(capabilitiesFor('copilot-sdk').codeTools, true);
  assert.equal(capabilitiesFor('copilot-sdk').appOnly, true);
  assert.equal(capabilitiesFor('copilot-studio-3p').support, 'experimental');
  assert.equal(capabilitiesFor('copilot-studio-3p').appOnly, false);
  assert.equal(capabilitiesFor('copilot-studio-standard').support, 'ga');
  assert.equal(capabilitiesFor('copilot-studio-s2s').support, 'private-preview');
  assert.equal(capabilitiesFor('agentic-directline').streaming, 'final-only');
});

test('validateConfig reports every problem at once', () => {
  assert.deepEqual(validateConfig(/** @type {any} */ ({ mode: 'bogus' })), ['mode must be one of ' + MODES.join(', ')]);
  assert.deepEqual(validateConfig({ mode: 'copilot-sdk' }), []);
  assert.deepEqual(validateConfig({ mode: 'copilot-sdk', copilotSdk: { byok: { baseUrl: 'https://x' } } }), ['copilot-sdk with byok requires model']);
  const problems = validateConfig({ mode: 'copilot-studio-3p', copilotStudio: {} });
  assert.equal(problems.length, 2);
  assert.deepEqual(validateConfig({ mode: 'copilot-studio-standard', copilotStudio: { environmentId: ENV, schemaName: 'a_b', getAccessToken: token } }), []);
  assert.deepEqual(validateConfig({ mode: 'agentic-directline', copilotStudio: { environmentId: ENV, schemaName: 'a_b' } }), []);
});

test('recommendMode follows the decision guide', () => {
  assert.equal(recommendMode({ hasGithubIdentity: true }).mode, 'copilot-sdk');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'github-copilot' }).mode, 'copilot-studio-3p');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'standard' }).mode, 'copilot-studio-standard');
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
function fakeStudioClient(log) {
  return (settings, tok) => {
    log.push({ settings, token: tok });
    const client = {
      conversationId: undefined,
      token: tok,
      async *startConversationStreaming(emit) {
        client.conversationId = 'conv-1';
        yield { type: 'event', name: 'startConversation' };
        yield { type: 'message', text: 'Hi, I am the agent.', channelData: { streamType: 'final', streamId: 'g1' } };
      },
      async *executeStreaming(activity, conversationId) {
        log.push({ sent: activity, conversationId, tokenAtSend: client.token });
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

test('copilot-studio-3p: preflight, guarded URL, delegated token refresh per turn, normalized stream', async () => {
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
  assert.equal(sent.conversationId, 'conv-1');
  assert.equal(sent.tokenAtSend, 'tok-2', 'token re-acquired before the turn');

  const result = await session.send('again');
  assert.equal(result.text, 'The answer is 42.');
  assert.equal(result.events.filter((e) => e.type === 'text.delta').length, 3);
});

test('copilot-studio-3p: a 403 preflight fails fast with the sharing hint', async () => {
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-3p', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token } },
    { clientFactory: fakeStudioClient([]), fetchImpl: fakeFetch(403, 'Forbidden') }
  );
  await assert.rejects(client.createSession(), (err) => err.httpStatus === 403 && /shared/.test(err.hint));
});

test('copilot-studio-standard: uses environmentId + schemaName and no /3p preflight', async () => {
  const log = [];
  const fetchImpl = fakeFetch(200);
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-standard', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token } },
    { clientFactory: fakeStudioClient(log), fetchImpl }
  );
  const session = await client.createSession();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(log[0].settings.environmentId, ENV);
  assert.equal(log[0].settings.schemaName, 'cr123_agent');
  assert.equal(log[0].settings.directConnectUrl, undefined);
  assert.equal(session.conversationId, 'conv-1');
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

test('copilot-studio: resume skips the greeting and targets the given conversation', async () => {
  const log = [];
  const client = await HarnessClient.create(
    { mode: 'copilot-studio-3p', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent', getAccessToken: token, preflight: false } },
    { clientFactory: fakeStudioClient(log), fetchImpl: fakeFetch(200) }
  );
  const session = await client.createSession({ resume: 'conv-existing' });
  assert.equal(session.conversationId, 'conv-existing');
  assert.deepEqual(session.greeting, []);
  const result = await session.send('hi');
  assert.equal(log.find((l) => l.sent).conversationId, 'conv-existing');
  assert.equal(result.text, 'The answer is 42.');
});

test('agentic-directline: token endpoint, Direct Line REST, final-only normalization', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    const u = String(url);
    if (u.includes('/directline/token')) return { ok: true, status: 200, json: async () => ({ token: 'dl-token' }) };
    if (u.endsWith('/conversations') && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ conversationId: 'dl-conv' }) };
    if (u.endsWith('/activities') && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'a1' }) };
    if (u.includes('/activities')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          watermark: '2',
          activities: [
            { type: 'message', from: { id: 'copilot-harness-sdk' }, text: 'hello' },
            { type: 'typing', from: { id: 'bot' } },
            { type: 'message', from: { id: 'bot' }, text: 'Complete answer.' },
            { type: 'event', name: 'turn.complete', from: { id: 'bot' } }
          ]
        })
      };
    }
    throw new Error('unexpected ' + u);
  };
  const client = await HarnessClient.create(
    { mode: 'agentic-directline', copilotStudio: { environmentId: ENV, schemaName: 'cr123_agent' } },
    { fetchImpl }
  );
  assert.equal(client.capabilities().streaming, 'final-only');
  const session = await client.createSession();
  assert.equal(session.conversationId, 'dl-conv');
  const result = await session.send('hello');
  assert.equal(result.text, 'Complete answer.');
  assert.deepEqual(result.events.map((e) => e.type), ['raw', 'text.delta', 'text.final', 'raw', 'idle']);
  assert.ok(calls.some((c) => c.url.includes('/directline/token')));
});
