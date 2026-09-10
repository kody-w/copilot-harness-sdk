import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBot, assertHarnessBot, inspectAgentHarness, assertHarnessAgent, ClassicAgentError, validateConfig, recommendMode, HarnessClient, CLASSIC_REFUSAL, capabilitiesFor } from '../index.js';

// Shapes copied from real exports (customer names removed).
const CLASSIC_BOT = {
  schemaname: 'new_ClassicAgent',
  template: 'default-2.1.0',
  configuration: JSON.stringify({ $kind: 'BotConfiguration', settings: { GenerativeActionsEnabled: true }, gPTSettings: { defaultSchemaName: 'new_ClassicAgent.gpt.default' }, aISettings: { model: { modelNameHint: 'GPT55Chat' } }, recognizer: { $kind: 'GenerativeAIRecognizer' } })
};
const HARNESS_BOT = {
  schemaname: 'cr8c1_HarnessAgent',
  template: 'cliagent-1.0.0',
  configuration: JSON.stringify({ $kind: 'BotConfiguration', recognizer: { $kind: 'CLICopilotRecognizer' }, agentSettings: { $kind: 'AgentSettings', model: { $kind: 'ModelConfig', series: 'Sonnet46' }, instructions: { $kind: 'Instructions', segments: [{ $kind: 'StaticSegment', value: 'Eres la representante virtual.' }] } }, authoringModel: 'CliCopilot' })
};
const EMPTY_HARNESS_BOT = { ...HARNESS_BOT, configuration: JSON.stringify({ $kind: 'BotConfiguration', recognizer: { $kind: 'CLICopilotRecognizer' }, agentSettings: { instructions: { $kind: 'Instructions' } } }) };

test('classifyBot tells a classic export from a harness one by template and recognizer', () => {
  const classic = classifyBot(CLASSIC_BOT);
  assert.equal(classic.harness, 'classic');
  assert.equal(classic.recognizer, 'GenerativeAIRecognizer');
  assert.equal(classic.model, 'GPT55Chat');
  const harness = classifyBot(HARNESS_BOT);
  assert.equal(harness.harness, 'github-copilot');
  assert.equal(harness.template, 'cliagent-1.0.0');
  assert.equal(harness.model, 'Sonnet46');
  assert.equal(harness.instructionChars, 'Eres la representante virtual.'.length);
  // Older recognizer name still counts as harness; an unknown record is 'unknown', not silently classic.
  assert.equal(classifyBot({ template: '', configuration: { recognizer: { kind: 'CLIAgentRecognizer' } } }).harness, 'github-copilot');
  assert.equal(classifyBot({}).harness, 'unknown');
  assert.equal(classifyBot({ configuration: 'not json' }).harness, 'unknown');
});

test('assertHarnessBot refuses classic agents and empty harness agents', () => {
  assert.throws(() => assertHarnessBot(CLASSIC_BOT), (e) => e instanceof ClassicAgentError && e.code === 'CLASSIC_AGENT' && /default-2\.1\.0/.test(e.message) && /cannot be switched in place/.test(e.message));
  assert.throws(() => assertHarnessBot({}), ClassicAgentError);
  assert.equal(assertHarnessBot(HARNESS_BOT).harness, 'github-copilot');
  assert.equal(assertHarnessBot(EMPTY_HARNESS_BOT).harness, 'github-copilot');
  assert.throws(() => assertHarnessBot(EMPTY_HARNESS_BOT, { requireInstructions: true }), (e) => e.code === 'NO_INSTRUCTIONS');
});

function fakeDataverse(record, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    if (status !== 200) return { ok: false, status, text: async () => 'nope' };
    const single = /bots\([0-9a-f-]+\)/.test(String(url));
    return { ok: true, status, json: async () => (single ? record : { value: record ? [record] : [] }), text: async () => '' };
  };
  return { fetchImpl, calls };
}

test('inspectAgentHarness reads the live record by schemaName or botId with the Dataverse token', async () => {
  const live = { botid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'H', publishedon: '2026-09-07T18:23:12Z', authenticationmode: 2, ...HARNESS_BOT };
  const { fetchImpl, calls } = fakeDataverse(live);
  const info = await inspectAgentHarness({ environmentUrl: 'https://org.crm.dynamics.com/', schemaName: "cr8c1_Harness'Agent", getDataverseToken: async () => 'dv-token', fetchImpl });
  assert.equal(info.harness, 'github-copilot');
  assert.equal(info.bot.botid, live.botid);
  assert.match(calls[0].url, /bots\?\$filter=schemaname eq 'cr8c1_Harness''Agent'/);
  assert.equal(calls[0].auth, 'Bearer dv-token');
  const byId = await inspectAgentHarness({ environmentUrl: 'https://org.crm.dynamics.com', botId: live.botid, getDataverseToken: async () => 't', fetchImpl });
  assert.match(calls[1].url, /^https:\/\/org\.crm\.dynamics\.com\/api\/data\/v9\.2\/bots\(aaaaaaaa/);
  assert.equal(byId.template, 'cliagent-1.0.0');
  await assert.rejects(inspectAgentHarness({ environmentUrl: 'https://org.crm.dynamics.com/', schemaName: 'x', getDataverseToken: async () => 't', fetchImpl: fakeDataverse(null).fetchImpl }), /No bot with schemaname x/);
  await assert.rejects(inspectAgentHarness({ environmentUrl: 'https://org.crm.dynamics.com/', schemaName: 'x', getDataverseToken: async () => 't', fetchImpl: fakeDataverse(live, { status: 403 }).fetchImpl }), /HTTP 403/);
  await assert.rejects(inspectAgentHarness({ environmentUrl: '', schemaName: 'x', getDataverseToken: async () => 't', fetchImpl }), /environmentUrl/);
});

test('assertHarnessAgent refuses a live classic record and an unpublished or empty harness record', async () => {
  const classic = { botid: 'b', name: 'C', publishedon: '2026-09-01T00:00:00Z', ...CLASSIC_BOT };
  await assert.rejects(assertHarnessAgent({ environmentUrl: 'https://o.crm.dynamics.com/', schemaName: 'new_ClassicAgent', getDataverseToken: async () => 't', fetchImpl: fakeDataverse(classic).fetchImpl }), ClassicAgentError);
  const unpublished = { botid: 'b', name: 'H', publishedon: null, ...HARNESS_BOT };
  await assert.rejects(assertHarnessAgent({ environmentUrl: 'https://o.crm.dynamics.com/', schemaName: 'x', getDataverseToken: async () => 't', fetchImpl: fakeDataverse(unpublished).fetchImpl, requirePublished: true }), /never been published/);
  const empty = { botid: 'b', name: 'H', publishedon: '2026-09-01T00:00:00Z', ...EMPTY_HARNESS_BOT };
  await assert.rejects(assertHarnessAgent({ environmentUrl: 'https://o.crm.dynamics.com/', schemaName: 'x', getDataverseToken: async () => 't', fetchImpl: fakeDataverse(empty).fetchImpl, requireInstructions: true }), (e) => e.code === 'NO_INSTRUCTIONS');
  const ok = await assertHarnessAgent({ environmentUrl: 'https://o.crm.dynamics.com/', schemaName: 'x', getDataverseToken: async () => 't', fetchImpl: fakeDataverse({ botid: 'b', name: 'H', publishedon: '2026-09-01T00:00:00Z', ...HARNESS_BOT }).fetchImpl, requireInstructions: true, requirePublished: true });
  assert.equal(ok.harness, 'github-copilot');
});

test('the client refuses the classic mode unless allowClassicAgent is exactly true', async () => {
  const ENV = '11111111-2222-3333-4444-555555555555';
  const base = { environmentId: ENV, schemaName: 'a_b', getAccessToken: async () => 't' };
  assert.deepEqual(validateConfig({ mode: 'copilot-studio-standard', copilotStudio: base }), [CLASSIC_REFUSAL]);
  assert.deepEqual(validateConfig({ mode: 'copilot-studio-standard', copilotStudio: { ...base, allowClassicAgent: 'yes' } }), [CLASSIC_REFUSAL]);
  assert.deepEqual(validateConfig({ mode: 'copilot-studio-standard', copilotStudio: { ...base, allowClassicAgent: true } }), []);
  await assert.rejects(HarnessClient.create({ mode: 'copilot-studio-standard', copilotStudio: base }), /classic \(standard-harness\) agent/);
  assert.equal(capabilitiesFor('copilot-studio-standard').support, 'deprecated');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'standard' }).mode, 'copilot-studio-3p');
  assert.equal(recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'standard', allowClassicAgent: true }).mode, 'copilot-studio-standard');
});
