import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { retryingNetworkClient } from '../src/auth/entra.js';
import { flowRunOutputs, workflowIdFromComponent } from '../src/flow-runs.js';

const json = (status, body) => ({ status, ok: status < 400, headers: new Map([['content-type', 'application/json']]),
  text: async () => JSON.stringify(body), json: async () => body });
const noSleep = async () => {};

test('MSAL network client retries a dropped connection and keeps the device-code poll alive', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) throw new TypeError('fetch failed');
    return json(200, { access_token: 'tok' });
  };
  const net = retryingNetworkClient({ fetchImpl, sleep: noSleep });
  const res = await net.sendPostRequestAsync('https://login.microsoftonline.com/t/oauth2/v2.0/token', { body: 'x=1' });
  assert.equal(calls, 3);
  assert.equal(res.status, 200);
  assert.equal(res.body.access_token, 'tok');
});

test('MSAL network client passes HTTP answers through, including authorization_pending', async () => {
  let calls = 0;
  const net = retryingNetworkClient({ fetchImpl: async () => { calls += 1; return json(400, { error: 'authorization_pending' }); }, sleep: noSleep });
  const res = await net.sendPostRequestAsync('https://login/token', { body: '' });
  assert.equal(calls, 1);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'authorization_pending');
});

test('MSAL network client retries 503 and gives up after its attempts', async () => {
  let calls = 0;
  const net = retryingNetworkClient({ attempts: 3, fetchImpl: async () => { calls += 1; throw new TypeError('fetch failed'); }, sleep: noSleep });
  await assert.rejects(net.sendGetRequestAsync('https://login/x'), /after 3 attempts/);
  assert.equal(calls, 3);
  calls = 0;
  const flaky = retryingNetworkClient({ fetchImpl: async () => (++calls === 1 ? json(503, {}) : json(200, { ok: 1 })), sleep: noSleep });
  assert.equal((await flaky.sendGetRequestAsync('https://login/x')).status, 200);
});

test('device-code provider wires the retrying network client into MSAL', async () => {
  const { createDeviceCodeTokenProvider } = await import('../src/auth/entra.js');
  let seen;
  const pcaFactory = (config) => {
    seen = config;
    return { getTokenCache: () => ({ getAllAccounts: async () => [] }),
      acquireTokenByDeviceCode: async () => ({ accessToken: 't', expiresOn: new Date(Date.now() + 3600_000) }) };
  };
  await createDeviceCodeTokenProvider({ clientId: 'c', tenantId: 't' }, { pcaFactory })();
  assert.equal(typeof seen.system.networkClient.sendPostRequestAsync, 'function');
});

test('flow run outputs: only runs since the turn, the Respond action output, and its SHA-256', async () => {
  const out = 'Contoso $22,400.00: queue APPROVAL, needs AP manager sign-off (limit $10,000).';
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push([url.split('?')[0], init.headers.Authorization || 'unsigned']);
    if (/\/runs\?/.test(url)) return json(200, { value: [
      { name: 'new', properties: { status: 'Succeeded', startTime: '2026-10-06T15:36:06Z',
        trigger: { outputsLink: { uri: 'https://blob/trigger?sig=2' } } } },
      { name: 'old', properties: { status: 'Succeeded', startTime: '2026-10-05T10:00:00Z' } }] });
    if (/\/runs\/new\/actions/.test(url)) return json(200, { value: [
      { name: 'Run_a_script', properties: { outputsLink: { uri: 'https://blob/script' } } },
      { name: 'Respond_to_agent', properties: { outputsLink: { uri: 'https://blob/respond?sig=1' } } }] });
    if (url.startsWith('https://blob/respond')) return json(200, { statusCode: '200', body: { result: out } });
    if (url.startsWith('https://blob/trigger')) return json(200, { body: { vendor: 'Contoso', amount: 22400 } });
    throw new Error('unexpected ' + url);
  };
  const runs = await flowRunOutputs({ environmentId: 'env', workflowId: 'wf', since: new Date('2026-10-06T15:36:00Z'),
    getFlowToken: async () => 'flow-token', fetchImpl });
  assert.deepEqual(runs.map((r) => r.runId), ['new']);
  assert.equal(runs[0].output, out);
  assert.deepEqual(runs[0].inputs, { vendor: 'Contoso', amount: 22400 });
  assert.equal(runs[0].sha256, createHash('sha256').update(out).digest('hex'));
  assert.ok(urls.every(([u, a]) => (u.startsWith('https://blob/') ? a === 'unsigned' : a === 'Bearer flow-token')),
    'the signed outputs link gets no bearer token');
});

test('workflowIdFromComponent reads the tool YAML', () => {
  assert.equal(workflowIdFromComponent('kind: WorkflowTool\nworkflowId: 971f1514-d4b1-5e75-8836-3ee6304551da\n'),
    '971f1514-d4b1-5e75-8836-3ee6304551da');
  assert.equal(workflowIdFromComponent('kind: InlineAgentSkill\n'), null);
});

test('flow run reads retry a dropped connection', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    if (/\/runs\?/.test(url) && ++n === 1) throw new TypeError('fetch failed');
    if (/\/runs\?/.test(url)) return json(200, { value: [] });
    throw new Error('unexpected');
  };
  const runs = await flowRunOutputs({ environmentId: 'e', workflowId: 'w', since: 0, getFlowToken: async () => 't', fetchImpl, sleep: async () => {} });
  assert.deepEqual(runs, []);
  assert.equal(n, 2);
});
