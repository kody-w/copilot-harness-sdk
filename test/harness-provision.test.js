import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanWorkspace, scopedReferenceName, rebindConnectionReferences, workflowIdFor, rebindWorkflows, resolveConnection, ensureConnectionReference, connectorExists, ensureWorkflow, listBotComponents, linkComponentConnectionReference, linkComponentWorkflow, deleteStaleComponents, expectedComponents } from '../index.js';

const OLD_WF = 'bbbbbbbb-0000-4000-8000-000000000001';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ws-'));
  mkdirSync(join(dir, 'capabilities', 'tools'), { recursive: true });
  mkdirSync(join(dir, 'behaviors'), { recursive: true });
  mkdirSync(join(dir, 'infrastructure', 'connections'), { recursive: true });
  mkdirSync(join(dir, 'workflows', `RAPPHackerNewsWorkflow-${OLD_WF}`), { recursive: true });
  mkdirSync(join(dir, 'connectors', 'new_rapp-20hacker-20news-cccccccc'), { recursive: true });
  writeFileSync(join(dir, 'settings.mcs.yml'), 'displayName: Pilot\nschemaName: aibast_Pilot\npublishedOn: 2026-09-10T14:59:00Z\n');
  writeFileSync(join(dir, 'capabilities', 'tools', 'aibast_dataverse-add-memory.mcs.yml'), 'mcs.metadata:\n  componentName: Add a row\nkind: ConnectorTool\nauthMode: Invoker\nconnectionReference: aibast_Pilot.cr.shared_commondataserviceforapps\nconnectorId: /providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps\noperationId: CreateRecordWithOrganization\n');
  writeFileSync(join(dir, 'capabilities', 'tools', 'SharedMcp.mcs.yml'), 'kind: McpTool\nconnectionReference: cr8c1_sharedmcp\nconnectorId: /providers/Microsoft.PowerApps/apis/shared_new-5fmcp-5f0000000000000000\n');
  writeFileSync(join(dir, 'capabilities', 'tools', 'HackerNewsWorkflow.mcs.yml'), `mcs.metadata:\n  componentName: Run RAPP Hacker News workflow\nkind: WorkflowTool\nworkflowId: ${OLD_WF}\ntoolOutputs:\n  - name: status\n`);
  writeFileSync(join(dir, 'behaviors', 'aibast_fetch-hacker-news.mcs.yml'), 'kind: InlineAgentSkill\ncontent: |\n  x\n');
  writeFileSync(join(dir, 'infrastructure', 'connections', 'aibast_Pilot.cr.shared_new_rapp_hn.sync.yaml'), 'connectionReferences:\n  - connectionReferenceLogicalName: aibast_Pilot.cr.shared_new_rapp_hn\n    connectorId: /providers/Microsoft.PowerApps/apis/shared_new-5frapp-20hacker-20news-5f0000000000000000\n');
  writeFileSync(join(dir, 'workflows', `RAPPHackerNewsWorkflow-${OLD_WF}`, 'workflow.json'), '﻿' + JSON.stringify({ properties: { connectionReferences: { 'shared_new-5frapp-20hacker-20news-5f0000000000000000': { runtimeSource: 'invoker', connection: { connectionReferenceLogicalName: 'aibast_Pilot.cr.shared_new_rapp_hn' } } }, definition: { triggers: { manual: {} } } }, schemaVersion: '1.0.0.0' }, null, 2));
  writeFileSync(join(dir, 'workflows', `RAPPHackerNewsWorkflow-${OLD_WF}`, 'metadata.yml'), `﻿jsonFileName: workflows/RAPPHackerNewsWorkflow-${OLD_WF}/workflow.json\nworkflowId: ${OLD_WF}\nname: RAPP Hacker News Workflow\ndescription: Runs HN.\n`);
  writeFileSync(join(dir, 'connectors', 'new_rapp-20hacker-20news-cccccccc', 'metadata.yml'), '﻿' + JSON.stringify({ connectorid: 'cccccccc-0000-4000-8000-000000000001', name: 'new_rapp-20hacker-20news', displayname: 'RAPP Hacker News', connectorinternalid: 'shared_new-5frapp-20hacker-20news-5f0000000000000000' }));
  return dir;
}

function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); const method = init.method || 'GET';
    calls.push({ url: decodeURIComponent(u), method, body: init.body ? JSON.parse(init.body) : null });
    for (const r of routes) {
      if ((r.method || 'GET') === method && r.match.test(decodeURIComponent(u))) {
        const headers = new Map(Object.entries(r.headers || {}));
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)), headers: { get: (k) => headers.get(k) ?? null } };
      }
    }
    return { ok: false, status: 404, text: async () => `no route for ${method} ${u}`, headers: { get: () => null } };
  };
  return { fetchImpl, calls };
}
const base = (fetchImpl) => ({ environmentUrl: 'https://org.crm.dynamics.com/', getDataverseToken: async () => 'dv', fetchImpl });

test('scanWorkspace collects tools, references from every source, workflows and custom connectors', () => {
  const s = scanWorkspace(fixture());
  assert.deepEqual(s.tools.map((t) => [t.name, t.kind]), [['HackerNewsWorkflow', 'WorkflowTool'], ['SharedMcp', 'McpTool'], ['aibast_dataverse-add-memory', 'ConnectorTool']]);
  assert.deepEqual([...s.connectionRefs.keys()].sort(), ['aibast_Pilot.cr.shared_commondataserviceforapps', 'aibast_Pilot.cr.shared_new_rapp_hn', 'cr8c1_sharedmcp']);
  assert.equal(s.connectionRefs.get('aibast_Pilot.cr.shared_new_rapp_hn').connectorId, '/providers/Microsoft.PowerApps/apis/shared_new-5frapp-20hacker-20news-5f0000000000000000');
  assert.equal(s.workflows[0].id, OLD_WF);
  assert.equal(s.workflows[0].name, 'RAPP Hacker News Workflow');
  assert.deepEqual(s.workflows[0].connectionRefs.map((r) => r.logical), ['aibast_Pilot.cr.shared_new_rapp_hn']);
  assert.equal(s.customConnectors[0].internalId, 'shared_new-5frapp-20hacker-20news-5f0000000000000000');
  assert.deepEqual(expectedComponents(fixture(), 'aibast_Core').map((e) => e.schemaName), ['aibast_Core.tool.HackerNewsWorkflow', 'aibast_Core.tool.SharedMcp', 'aibast_Core.tool.aibast_dataverse-add-memory', 'aibast_Core.skill.aibast_fetch-hacker-news']);
});

test('rebindConnectionReferences rescopes agent references everywhere and leaves shared ones alone', () => {
  const dir = fixture();
  assert.equal(scopedReferenceName('aibast_Pilot.cr.shared_new_rapp_hn', 'aibast_Core'), 'aibast_Core.cr.shared_new_rapp_hn');
  assert.equal(scopedReferenceName('cr8c1_sharedmcp', 'aibast_Core'), 'cr8c1_sharedmcp');
  const mapping = rebindConnectionReferences(dir, 'aibast_Core');
  assert.deepEqual(mapping, { 'aibast_Pilot.cr.shared_commondataserviceforapps': 'aibast_Core.cr.shared_commondataserviceforapps', 'aibast_Pilot.cr.shared_new_rapp_hn': 'aibast_Core.cr.shared_new_rapp_hn' });
  assert.match(readFileSync(join(dir, 'capabilities', 'tools', 'aibast_dataverse-add-memory.mcs.yml'), 'utf8'), /connectionReference: aibast_Core\.cr\.shared_commondataserviceforapps/);
  assert.match(readFileSync(join(dir, 'capabilities', 'tools', 'SharedMcp.mcs.yml'), 'utf8'), /connectionReference: cr8c1_sharedmcp/);
  assert.ok(existsSync(join(dir, 'infrastructure', 'connections', 'aibast_Core.cr.shared_new_rapp_hn.sync.yaml')));
  assert.ok(!existsSync(join(dir, 'infrastructure', 'connections', 'aibast_Pilot.cr.shared_new_rapp_hn.sync.yaml')));
  const wf = readFileSync(join(dir, 'workflows', `RAPPHackerNewsWorkflow-${OLD_WF}`, 'workflow.json'), 'utf8');
  assert.equal(wf.charCodeAt(0), 0xfeff, 'BOM preserved');
  assert.match(wf, /aibast_Core\.cr\.shared_new_rapp_hn/);
  assert.deepEqual(rebindConnectionReferences(dir, 'aibast_Core'), {}, 'idempotent');
});

test('workflowIdFor is a stable v5 UUID per agent and workflow folder', () => {
  const a = workflowIdFor('aibast_Core', `RAPPHackerNewsWorkflow-${OLD_WF}`);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, workflowIdFor('aibast_Core', 'RAPPHackerNewsWorkflow'));
  assert.notEqual(a, workflowIdFor('aibast_Other', 'RAPPHackerNewsWorkflow'));
});

test('rebindWorkflows renames the folder and rewrites metadata, definition and the WorkflowTool', () => {
  const dir = fixture();
  const out = rebindWorkflows(dir, (wf) => workflowIdFor('aibast_Core', wf.folder));
  const id = workflowIdFor('aibast_Core', 'RAPPHackerNewsWorkflow');
  assert.equal(out[0].id, id); assert.equal(out[0].oldId, OLD_WF); assert.equal(out[0].folder, `RAPPHackerNewsWorkflow-${id}`);
  assert.deepEqual(readdirSync(join(dir, 'workflows')), [`RAPPHackerNewsWorkflow-${id}`]);
  const meta = readFileSync(join(dir, 'workflows', `RAPPHackerNewsWorkflow-${id}`, 'metadata.yml'), 'utf8');
  assert.match(meta, new RegExp(`workflowId: ${id}`)); assert.match(meta, new RegExp(`jsonFileName: workflows/RAPPHackerNewsWorkflow-${id}/workflow.json`));
  assert.match(readFileSync(join(dir, 'capabilities', 'tools', 'HackerNewsWorkflow.mcs.yml'), 'utf8'), new RegExp(`workflowId: ${id}`));
  const again = rebindWorkflows(dir, (wf) => wf.id);
  assert.equal(again[0].id, id, 'keeps the id when resolveId returns it');
});

test('resolveConnection prefers the explicit map, then the source reference, then any bound reference for the connector', async () => {
  const src = { match: /connectionreferencelogicalname eq 'aibast_Pilot.cr.shared_new_rapp_hn'/, body: { value: [{ connectionreferenceid: '1', connectionid: 'conn-src', connectorid: '/providers/Microsoft.PowerApps/apis/x' }] } };
  const any = { match: /connectorid eq '\/providers\/Microsoft.PowerApps\/apis\/x' and connectionid ne null/, body: { value: [{ connectionreferencelogicalname: 'other', connectionid: 'conn-env', connectorid: '/providers/Microsoft.PowerApps/apis/x' }] } };
  const { fetchImpl } = fake([src, any]);
  const opts = { ...base(fetchImpl), sourceLogicalName: 'aibast_Pilot.cr.shared_new_rapp_hn', connectorId: '/providers/Microsoft.PowerApps/apis/x', suffix: 'shared_new_rapp_hn' };
  assert.equal((await resolveConnection({ ...opts, connections: { shared_new_rapp_hn: 'conn-map' } })).connectionId, 'conn-map');
  assert.equal((await resolveConnection(opts)).connectionId, 'conn-src');
  assert.equal((await resolveConnection({ ...opts, sourceLogicalName: undefined })).connectionId, 'conn-env');
  assert.equal(await resolveConnection({ ...base(fake([{ match: /connectorid eq '\/providers\/Microsoft.PowerApps\/apis\/y'/, body: { value: [] } }]).fetchImpl), connectorId: '/providers/Microsoft.PowerApps/apis/y', suffix: 'y' }), null);
});

test('ensureConnectionReference creates, updates when bound elsewhere, and reports existing', async () => {
  const created = fake([{ match: /connectionreferencelogicalname eq 'aibast_Core.cr.hn'/, body: { value: [] } }, { method: 'POST', match: /connectionreferences$/, body: { connectionreferenceid: 'new-id' } }]);
  const r = await ensureConnectionReference({ ...base(created.fetchImpl), logicalName: 'aibast_Core.cr.hn', displayName: 'Core - hn', connectorId: '/providers/Microsoft.PowerApps/apis/x', connectionId: 'c1' });
  assert.equal(r.operation, 'created'); assert.equal(r.id, 'new-id');
  assert.deepEqual(created.calls.find((c) => c.method === 'POST').body, { connectionreferencedisplayname: 'Core - hn', connectionreferencelogicalname: 'aibast_Core.cr.hn', connectorid: '/providers/Microsoft.PowerApps/apis/x', connectionid: 'c1' });
  const row = { connectionreferenceid: 'e1', connectionid: 'c1', connectorid: '/providers/Microsoft.PowerApps/apis/x' };
  const same = fake([{ match: /connectionreferencelogicalname eq/, body: { value: [row] } }]);
  assert.equal((await ensureConnectionReference({ ...base(same.fetchImpl), logicalName: 'aibast_Core.cr.hn', connectorId: row.connectorid, connectionId: 'c1' })).operation, 'existing');
  const upd = fake([{ match: /connectionreferencelogicalname eq/, body: { value: [row] } }, { method: 'PATCH', match: /connectionreferences\(e1\)$/, status: 204 }]);
  assert.equal((await ensureConnectionReference({ ...base(upd.fetchImpl), logicalName: 'aibast_Core.cr.hn', connectorId: row.connectorid, connectionId: 'c2' })).operation, 'updated');
});

test('connectorExists only queries custom connectors', async () => {
  const { fetchImpl, calls } = fake([{ match: /connectorinternalid eq 'shared_new-5frapp-20hacker-20news-5f0000000000000000'/, body: { value: [{ connectorid: 'cid', displayname: 'RAPP Hacker News' }] } }]);
  assert.deepEqual(await connectorExists({ ...base(fetchImpl), connectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' }), { custom: false, exists: true, internal: 'shared_commondataserviceforapps' });
  assert.equal(calls.length, 0);
  const r = await connectorExists({ ...base(fetchImpl), connectorId: '/providers/Microsoft.PowerApps/apis/shared_new-5frapp-20hacker-20news-5f0000000000000000' });
  assert.equal(r.custom, true); assert.equal(r.exists, true); assert.equal(r.connectorId, 'cid');
  assert.equal((await connectorExists({ ...base(fake([{ match: /connectorinternalid/, body: { value: [] } }]).fetchImpl), connectorId: '/providers/Microsoft.PowerApps/apis/shared_new-5fmissing-5f0000000000000000' })).exists, false);
});

test('ensureWorkflow posts a new agent flow and activates it, or updates and re-activates an existing one', async () => {
  const def = { properties: { definition: {} }, schemaVersion: '1.0.0.0' };
  const fresh = fake([{ match: /workflows\?\$filter=workflowid eq/, body: { value: [] } }, { method: 'POST', match: /workflows$/, status: 204 }, { method: 'PATCH', match: /workflows\(/, status: 204 }]);
  const r = await ensureWorkflow({ ...base(fresh.fetchImpl), workflowId: OLD_WF, name: 'HN', description: 'd', definition: def });
  assert.equal(r.operation, 'created');
  const post = fresh.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.category, 5); assert.equal(post.body.workflowid, OLD_WF); assert.equal(post.body.clientdata, JSON.stringify(def));
  assert.deepEqual(fresh.calls.filter((c) => c.method === 'PATCH').map((c) => c.body), [{ statecode: 1, statuscode: 2 }]);
  const live = fake([{ match: /workflows\?\$filter=workflowid eq/, body: { value: [{ workflowid: OLD_WF, statecode: 1 }] } }, { method: 'PATCH', match: /workflows\(/, status: 204 }]);
  assert.equal((await ensureWorkflow({ ...base(live.fetchImpl), workflowId: OLD_WF, name: 'HN', definition: def })).operation, 'updated');
  assert.deepEqual(live.calls.filter((c) => c.method === 'PATCH').map((c) => c.body), [{ statecode: 0, statuscode: 1 }, { name: 'HN', description: '', clientdata: JSON.stringify(def) }, { statecode: 1, statuscode: 2 }]);
});

test('component links: connection reference added once, workflow links converge, stale components deleted', async () => {
  const comps = { value: [
    { botcomponentid: 'c1', schemaname: 'aibast_Core.tool.aibast_dataverse-add-memory', name: 'Add', componenttype: 9, data: 'kind: ConnectorTool\n', botcomponent_workflow: [], botcomponent_connectionreference: [] },
    { botcomponentid: 'c2', schemaname: 'aibast_Core.tool.HackerNewsWorkflow', name: 'HN', componenttype: 9, data: 'kind: WorkflowTool\n', botcomponent_workflow: [{ workflowid: OLD_WF, name: 'old', statecode: 1 }], botcomponent_connectionreference: [] },
    { botcomponentid: 'c3', schemaname: 'aibast_Core.skill.stale', name: 'stale', componenttype: 9, data: 'kind: InlineAgentSkill\n', botcomponent_workflow: [], botcomponent_connectionreference: [] }
  ] };
  const { fetchImpl, calls } = fake([
    { match: /botcomponents\?\$filter=_parentbotid_value eq bot1/, body: comps },
    { match: /connectionreferencelogicalname eq 'aibast_Core.cr.dv'/, body: { value: [{ connectionreferenceid: 'r1' }] } },
    { method: 'POST', match: /botcomponent_connectionreference\/\$ref$/, status: 204 },
    { method: 'DELETE', match: /botcomponent_workflow\(.*\)\/\$ref$/, status: 204 },
    { method: 'POST', match: /botcomponent_workflow\/\$ref$/, status: 204 },
    { method: 'DELETE', match: /botcomponents\(c3\)$/, status: 204 }
  ]);
  const list = await listBotComponents({ ...base(fetchImpl), botId: 'bot1' });
  assert.deepEqual(list.map((c) => c.kind), ['ConnectorTool', 'WorkflowTool', 'InlineAgentSkill']);
  const link = await linkComponentConnectionReference({ ...base(fetchImpl), component: list[0], logicalName: 'aibast_Core.cr.dv' });
  assert.equal(link.operation, 'linked');
  assert.equal(calls.find((c) => /botcomponent_connectionreference\/\$ref$/.test(c.url)).body['@odata.id'], 'https://org.crm.dynamics.com/api/data/v9.2/connectionreferences(r1)');
  assert.equal((await linkComponentConnectionReference({ ...base(fetchImpl), component: { ...list[0], connectionReferences: [{ id: 'r1' }] }, logicalName: 'aibast_Core.cr.dv' })).operation, 'existing');
  const newId = workflowIdFor('aibast_Core', 'RAPPHackerNewsWorkflow');
  const wl = await linkComponentWorkflow({ ...base(fetchImpl), component: list[1], workflowId: newId });
  assert.equal(wl.operation, `unlinked ${OLD_WF}, linked ${newId}`);
  assert.equal((await linkComponentWorkflow({ ...base(fetchImpl), component: { ...list[1], workflows: [{ id: newId }] }, workflowId: newId })).operation, 'existing');
  const removed = await deleteStaleComponents({ ...base(fetchImpl), botId: 'bot1', keep: ['aibast_Core.tool.aibast_dataverse-add-memory', 'AIBAST_CORE.TOOL.HACKERNEWSWORKFLOW'] });
  assert.deepEqual(removed, [{ schemaName: 'aibast_Core.skill.stale', kind: 'InlineAgentSkill' }]);
});
