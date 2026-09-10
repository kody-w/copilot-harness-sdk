import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareAgent, setAccessControl, setChannels, upsertEnvironmentVariable, listComponents, ClassicAgentError, ACCESS_CONTROL_POLICY, CHANNELS } from '../index.js';

const BOT = { botid: 'ea35ebfd-50cc-4c59-9f76-231a2d042925', name: 'H', schemaname: 'cr8c1_Harness', template: 'cliagent-1.0.0', publishedon: '2026-09-07T19:10:11Z',
  configuration: JSON.stringify({ $kind: 'BotConfiguration', recognizer: { $kind: 'CLICopilotRecognizer' }, agentSettings: { $kind: 'AgentSettings', model: { $kind: 'ModelConfig', series: 'Sonnet46' }, instructions: { $kind: 'Instructions', segments: [{ $kind: 'StaticSegment', value: 'x' }] } }, authoringModel: 'CliCopilot' }) };
const CLASSIC = { ...BOT, schemaname: 'new_Classic', template: 'default-2.1.0', configuration: JSON.stringify({ recognizer: { $kind: 'GenerativeAIRecognizer' } }) };

function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); const method = init.method || 'GET';
    calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    for (const r of routes) {
      if ((r.method || 'GET') === method && r.match.test(u)) {
        const headers = new Map(Object.entries(r.headers || {}));
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)), headers: { get: (k) => headers.get(k.toLowerCase()) ?? headers.get(k) ?? null } };
      }
    }
    return { ok: false, status: 404, text: async () => `no route for ${method} ${u}`, headers: { get: () => null } };
  };
  return { fetchImpl, calls };
}
const base = (fetchImpl) => ({ environmentUrl: 'https://org.crm.dynamics.com/', getDataverseToken: async () => 'dv', fetchImpl });
const botRoute = (bot = BOT) => ({ match: /bots\?\$filter=schemaname eq 'cr8c1_Harness'/, body: { value: [bot] } });

test('shareAgent grants read access to a user through GrantAccess and refuses classic agents', async () => {
  const { fetchImpl, calls } = fake([botRoute(), { method: 'POST', match: /GrantAccess$/, status: 204 }]);
  const r = await shareAgent({ ...base(fetchImpl), schemaName: 'cr8c1_Harness', userId: 'ebebba12-e189-f111-ab10-000d3a5b60d7' });
  assert.equal(r.access, 'ReadAccess');
  const grant = calls.find((c) => c.method === 'POST');
  assert.equal(grant.body.Target.botid, BOT.botid);
  assert.equal(grant.body.PrincipalAccess.Principal.systemuserid, 'ebebba12-e189-f111-ab10-000d3a5b60d7');
  assert.equal(grant.headers.Authorization, 'Bearer dv');
  await assert.rejects(shareAgent({ ...base(fetchImpl), schemaName: 'cr8c1_Harness' }), /userId or teamId/);
  const classic = fake([{ match: /bots\?\$filter=schemaname eq 'new_Classic'/, body: { value: [CLASSIC] } }]);
  await assert.rejects(shareAgent({ ...base(classic.fetchImpl), schemaName: 'new_Classic', userId: 'x' }), ClassicAgentError);
});

test('setAccessControl writes the policy and comma-joined security groups', async () => {
  const { fetchImpl, calls } = fake([botRoute(), { method: 'PATCH', match: /bots\(ea35ebfd/, status: 204 }]);
  await setAccessControl({ ...base(fetchImpl), schemaName: 'cr8c1_Harness', policy: 'GroupMembership', securityGroupIds: ['24ff5c70-0c86-4ba6-84bc-d98332b03f5e', '1cb6eeb9-d71d-42e5-87b5-04da38639020'] });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.accesscontrolpolicy, ACCESS_CONTROL_POLICY.GroupMembership);
  assert.equal(patch.body.authorizedsecuritygroupids, '24ff5c70-0c86-4ba6-84bc-d98332b03f5e,1cb6eeb9-d71d-42e5-87b5-04da38639020');
  await assert.rejects(setAccessControl({ ...base(fetchImpl), schemaName: 'cr8c1_Harness', policy: 'GroupMembership' }), /at least one security group/);
  await assert.rejects(setAccessControl({ ...base(fetchImpl), schemaName: 'cr8c1_Harness', policy: 'AgentReaders', securityGroupIds: ['not-a-guid'] }), /GUID/);
  await assert.rejects(setAccessControl({ ...base(fetchImpl), schemaName: 'cr8c1_Harness', policy: 'Nope' }), /policy must be/);
});

test('setChannels rewrites configuration.channels without touching the rest of the configuration', async () => {
  const { fetchImpl, calls } = fake([botRoute(), { method: 'PATCH', match: /bots\(ea35ebfd/, status: 204 }]);
  const r = await setChannels({ ...base(fetchImpl), schemaName: 'cr8c1_Harness', channels: ['Teams', 'Microsoft365Copilot'] });
  assert.deepEqual(r.channels, [CHANNELS.Teams, CHANNELS.Microsoft365Copilot]);
  const cfg = JSON.parse(calls.find((c) => c.method === 'PATCH').body.configuration);
  assert.deepEqual(cfg.channels, [{ $kind: 'ChannelDefinition', channelId: 'MsTeams' }, { $kind: 'ChannelDefinition', channelId: 'Microsoft365Copilot' }]);
  assert.equal(cfg.agentSettings.instructions.segments[0].value, 'x');
  await assert.rejects(setChannels({ ...base(fetchImpl), schemaName: 'cr8c1_Harness', channels: ['Slack'] }), /Unknown channel/);
});

test('upsertEnvironmentVariable creates definition + value, then updates in place', async () => {
  const defId = 'ce83875f-eeaa-f111-aaac-000d3a5b6830';
  const created = fake([
    { match: /environmentvariabledefinitions\?\$filter/, body: { value: [] } },
    { method: 'POST', match: /environmentvariabledefinitions$/, status: 204, headers: { 'odata-entityid': `https://org.crm.dynamics.com/api/data/v9.2/environmentvariabledefinitions(${defId})` } },
    { match: /environmentvariablevalues\?\$filter/, body: { value: [] } },
    { method: 'POST', match: /environmentvariablevalues$/, status: 204, headers: { 'odata-entityid': 'https://org.crm.dynamics.com/api/data/v9.2/environmentvariablevalues(11111111-1111-1111-1111-111111111111)' } }
  ]);
  const r = await upsertEnvironmentVariable({ ...base(created.fetchImpl), schemaName: 'cr8c1_RenewalNoticeDays', type: 'Number', defaultValue: '90', value: '60' });
  assert.equal(r.definitionId, defId);
  assert.equal(r.valueId, '11111111-1111-1111-1111-111111111111');
  const post = created.calls.find((c) => c.method === 'POST' && /definitions$/.test(c.url));
  assert.equal(post.body.type, 100000001);
  const updated = fake([
    { match: /environmentvariabledefinitions\?\$filter/, body: { value: [{ environmentvariabledefinitionid: defId }] } },
    { method: 'PATCH', match: /environmentvariabledefinitions\(/, status: 204 },
    { match: /environmentvariablevalues\?\$filter/, body: { value: [{ environmentvariablevalueid: '22222222-2222-2222-2222-222222222222' }] } },
    { method: 'PATCH', match: /environmentvariablevalues\(/, status: 204 }
  ]);
  const r2 = await upsertEnvironmentVariable({ ...base(updated.fetchImpl), schemaName: 'cr8c1_RenewalNoticeDays', defaultValue: '120', value: '45' });
  assert.equal(r2.valueId, '22222222-2222-2222-2222-222222222222');
  assert.equal(updated.calls.filter((c) => c.method === 'PATCH').length, 2);
  await assert.rejects(upsertEnvironmentVariable({ ...base(updated.fetchImpl), schemaName: 'x', type: 'Blob' }), /type must be/);
});

test('listComponents names components the way pac does and reads the kind from the YAML', async () => {
  const { fetchImpl } = fake([botRoute(), { match: /botcomponents\?\$filter=_parentbotid_value eq ea35ebfd/, body: { value: [
    { schemaname: 'cr8c1_Harness.tool.SiteWeather', name: 'Site Weather', componenttype: 9, data: 'kind: WorkflowTool\nworkflowId: x' },
    { schemaname: 'cr8c1_Harness.knowledge.FAR', name: 'FAR', componenttype: 9, data: 'kind: KnowledgeSourceConfiguration\nsource:\n  kind: WebsiteKnowledgeSource' },
    { schemaname: 'cr8c1_Harness.tool.connected-agent.Child', name: 'Child', componenttype: 9, data: 'kind: ConnectedAgentTool\nbotSchemaName: cr8c1_Child' },
    { schemaname: 'cr8c1_skill_md_abc', name: 'SKILL.md', componenttype: 14, data: null }
  ] } }]);
  const comps = await listComponents({ ...base(fetchImpl), schemaName: 'cr8c1_Harness' });
  assert.deepEqual(comps.map((c) => [c.name, c.kind]), [['tool.SiteWeather', 'WorkflowTool'], ['knowledge.FAR', 'KnowledgeSourceConfiguration'], ['tool.connected-agent.Child', 'ConnectedAgentTool'], ['cr8c1_skill_md_abc', 'SkillResource']]);
});
