import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  ms, checkAllowedActions, inferAllowedActions, setConnectorAllowedActions, setTableAllowedActions, gitAuthEnv, deploy,
  pushApp, playUrl, MANAGED_APPS_GIT_CLIENT_ID, TABLE_VERBS
} from '../src/managed-apps.js';
import { createInteractiveTokenProvider } from '../src/auth/entra.js';
import { managedApps } from '../index.js';

const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const DV = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps';
const SITE = 'https://contoso.sharepoint.com/sites/ops';
const CONNECTOR_ACTIONS = [{ id: 'ListFolder', behavior: 'Allow' }];
const fixtures = join('.deploy', `managed-apps-tests-${randomUUID()}`);
after(() => rmSync(fixtures, { recursive: true, force: true }));

function workspace() {
  const d = join(fixtures, randomUUID());
  mkdirSync(d, { recursive: true });
  return resolve(d);
}

function appDir(config, files = {}) {
  const d = workspace();
  writeFileSync(join(d, 'ms.config.json'), JSON.stringify(config));
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), text); }
  return d;
}

function unchangedOnError(d, fn, error) {
  const before = readFileSync(join(d, 'ms.config.json'));
  assert.throws(fn, error);
  assert.deepEqual(readFileSync(join(d, 'ms.config.json')), before);
}

function cli(...args) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/managed-apps.mjs', import.meta.url)), ...args], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: '' }
  });
}

test('managedApps runtime members match the declared public API in both directions and kinds', () => {
  const declarations = readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8');
  const block = declarations.match(/export declare const managedApps:\s*Readonly<\{([\s\S]*?)^\}>;/m);
  assert.ok(block, 'managedApps Readonly declaration exists');
  const members = [...block[1].matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*(\(|:)/gm)];
  assert.ok(members.length > 0, 'declaration contains public members');
  assert.deepEqual(Object.getOwnPropertyNames(managedApps).sort(), members.map((m) => m[1]).sort());
  for (const [, name, syntax] of members) {
    assert.equal(typeof managedApps[name] === 'function', syntax === '(', `${name} matches its declared kind`);
  }
  assert.ok(Object.isFrozen(managedApps));
});

test('checkAllowedActions mirrors the CLI: only shared references need a policy, per table or per connector', () => {
  assert.equal(checkAllowedActions({ connectionReferences: { a: { id: SP, displayName: 'SharePoint', dataSets: {} } } }).ok, true, 'not shared');
  assert.equal(checkAllowedActions({ connectionReferences: { a: { id: SP, sharedConnectionId: '  ' } } }).ok, true, 'blank id is not shared');
  const actionRef = { id: SP, displayName: 'S', sharedConnectionId: 'c1' };
  assert.deepEqual(checkAllowedActions({ connectionReferences: { a: actionRef } }).issues, [{ reference: 'a', problem: 'missing-connector' }]);
  assert.equal(checkAllowedActions({ connectionReferences: { a: { ...actionRef, allowedActions: ['ListFolder'] } } }).ok, true);
  assert.deepEqual(checkAllowedActions({ connectionReferences: { a: { ...actionRef, allowedActions: [] } } }).issues, [{ reference: 'a', problem: 'invalid-connector' }], 'empty list: invalid, not also missing');
  assert.equal(checkAllowedActions({ connectionReferences: { a: { ...actionRef, allowedActions: [' '] } } }).ok, false, 'blank entry');
  const tableRef = { ...actionRef, dataSets: { site: { dataSources: { Orders: { tableName: 'Orders', allowedActions: ['get'] }, Customers: { tableName: 'Customers' } } } } };
  assert.deepEqual(checkAllowedActions({ connectionReferences: { t: tableRef } }).issues, [{ reference: 't', table: 'site/Customers', problem: 'missing-table' }]);
  assert.deepEqual(TABLE_VERBS, ['get', 'post', 'patch', 'delete']);
});

test('checkAllowedActions rejects non-verb table policies without checking non-shared references', () => {
  for (const allowedActions of [['GetItems'], ['GET'], ['get', 'patch', 'put']]) {
    const ref = { id: SP, sharedConnectionId: 'fake-shared-id', allowedActions: ['ListFolder'],
      dataSets: { [SITE]: { dataSources: { contosorules: { allowedActions } } } } };
    assert.deepEqual(checkAllowedActions({ connectionReferences: { shared: ref } }), {
      ok: false, issues: [{ reference: 'shared', table: `${SITE}/contosorules`, problem: 'invalid-table' }]
    });
    assert.equal(checkAllowedActions({ connectionReferences: { local: { ...ref, sharedConnectionId: null } } }).ok, true);
  }
});

test('inferAllowedActions reads only what src/ calls, and maps table methods to the four verbs', () => {
  const d = appDir({ connectionReferences: {} }, {
    'src/App.tsx': 'await SharePointService.ListFolder(s, id); const x = await SharePointService.GetFileContentByPath(s, p)',
    'src/lib/more.ts': 'SharePointService.GetFolderMetadataByPath(s, f); OtherService.DeleteItem(1)',
    'node_modules/pkg/index.js': 'SharePointService.DeleteFile(x)',
    'generated/services/SharePointService.ts': 'SharePointService.HttpRequest(x)'
  });
  const r = inferAllowedActions(d, 'SharePointService');
  assert.deepEqual(r.actions, ['GetFileContentByPath', 'GetFolderMetadataByPath', 'ListFolder']);
  assert.deepEqual(r.files, ['src/App.tsx', 'src/lib/more.ts']);
  const t = appDir({}, { 'src/a.ts': 'OrdersService.GetAll(); OrdersService.UpdateOrder(); OrdersService.ListAll()' });
  assert.deepEqual(inferAllowedActions(t, 'OrdersService', { kind: 'table' }).actions, ['get', 'patch']);
});

test('inferAllowedActions escapes dollar identifiers and uses identifier boundaries', () => {
  const d = appDir({}, { 'src/app.ts': `
    Share$PointService.ListFolder();
    SharePointService.DeleteFile();
    PrefixShare$PointService.HttpRequest();
    $Service.GetItems();
    Other$Service.DeleteItems();
    _Service.GetAll();
    Other_Service.DeleteAll();
    SharePointService.GetItems();
    $SharePointService.HttpRequest();
  ` });
  assert.deepEqual(inferAllowedActions(d, 'Share$PointService').actions, ['ListFolder']);
  assert.deepEqual(inferAllowedActions(d, '$Service').actions, ['GetItems']);
  assert.deepEqual(inferAllowedActions(d, '_Service').actions, ['GetAll']);
  assert.deepEqual(inferAllowedActions(d, 'SharePointService').actions, ['DeleteFile', 'GetItems']);
});

test('inferAllowedActions rejects invalid service identifiers before reading source', () => {
  const d = appDir({}, { 'src/app.ts': 'ShareXPoint.ListFolder(); Share.Point.DeleteFile();' });
  for (const name of [undefined, null, '', ' ', '1Service', 'Share.Point', 'Service|Other', 'Service()', 'Service\n']) {
    assert.throws(() => inferAllowedActions(d, name), /serviceName.*identifier/, String(name));
  }
});

test('setConnectorAllowedActions refuses unknown or policy-denied actions and writes the rest sorted', () => {
  const d = appDir({ connectionReferences: { r1: { id: SP, displayName: 'SharePoint', sharedConnectionId: 'c1' } } });
  const connectorActions = [{ id: 'ListFolder', behavior: 'Allow' }, { id: 'GetFileContentByPath', behavior: 'Allow' }, { id: 'HttpRequest', behavior: 'Deny' }];
  assert.throws(() => setConnectorAllowedActions(d, { connector: 'sharepointonline', actions: ['ListFolder', 'HttpRequest'], connectorActions }), /HttpRequest/);
  assert.throws(() => setConnectorAllowedActions(d, { connector: 'sharepointonline', actions: [], connectorActions }), /at least one/);
  const r = setConnectorAllowedActions(d, { connector: 'sharepointonline', actions: ['ListFolder', 'GetFileContentByPath'], connectorActions });
  assert.deepEqual(r, { reference: 'r1', allowedActions: ['GetFileContentByPath', 'ListFolder'] });
  const cfg = JSON.parse(readFileSync(join(d, 'ms.config.json'), 'utf8'));
  assert.deepEqual(cfg.connectionReferences.r1.allowedActions, ['GetFileContentByPath', 'ListFolder']);
  assert.equal(checkAllowedActions(cfg).ok, true);
});

test('setConnectorAllowedActions targets the action owner, not the first table reference', () => {
  const tableRef = { id: SP, displayName: 'SharePoint', dataSources: ['contosorules'],
    dataSets: { [SITE]: { dataSources: { contosorules: { tableName: 'Contoso Rules' } } } } };
  const d = appDir({ connectionReferences: {
    localTables: tableRef,
    sharedActions: { id: SP, dataSources: ['sharepointonline'], sharedConnectionId: 'fake-shared-id' }
  } });
  const result = setConnectorAllowedActions(d, { connector: 'shared_sharepointonline', actions: ['ListFolder'], connectorActions: CONNECTOR_ACTIONS });
  assert.deepEqual(result, { reference: 'sharedActions', allowedActions: ['ListFolder'] });
  const config = JSON.parse(readFileSync(join(d, 'ms.config.json'), 'utf8'));
  assert.deepEqual(config.connectionReferences.localTables, tableRef);
  assert.equal(checkAllowedActions(config).ok, true);

  const mixed = { ...tableRef, sharedConnectionId: 'fake-mixed-id', dataSources: ['sharepointonline', 'contosorules'] };
  mixed.dataSets[SITE].dataSources.contosorules.allowedActions = ['get'];
  const both = appDir({ connectionReferences: { tables: tableRef, both: mixed } });
  assert.equal(setConnectorAllowedActions(both, { connector: 'sharepointonline', actions: ['ListFolder'], connectorActions: CONNECTOR_ACTIONS }).reference, 'both');
  assert.deepEqual(JSON.parse(readFileSync(join(both, 'ms.config.json'), 'utf8')).connectionReferences.both.dataSets, mixed.dataSets);
});

test('setConnectorAllowedActions rejects ambiguous owners and ambiguous fallback references', () => {
  for (const dataSources of [['sharepointonline'], ['contosorules']]) {
    const ref = { id: SP, sharedConnectionId: 'fake-shared-id', dataSources };
    const d = appDir({ connectionReferences: { first: ref, second: ref } });
    unchangedOnError(d, () => setConnectorAllowedActions(d, {
      connector: 'sharepointonline', actions: ['ListFolder'], connectorActions: CONNECTOR_ACTIONS
    }), /ambiguous: pass reference \(first, second\)/);
  }
});

test('setConnectorAllowedActions falls back only to a unique connector reference', () => {
  const d = appDir({ connectionReferences: {
    sole: { id: SP, sharedConnectionId: 'fake-shared-id', dataSources: ['contosorules'] },
    other: { id: DV, sharedConnectionId: 'fake-other-id' }
  } });
  assert.equal(setConnectorAllowedActions(d, { connector: 'sharepointonline', actions: ['ListFolder'], connectorActions: CONNECTOR_ACTIONS }).reference, 'sole');
  unchangedOnError(d, () => setConnectorAllowedActions(d, { connector: 'office365users', actions: ['ListFolder'], connectorActions: CONNECTOR_ACTIONS }), /No connection reference for office365users/);
});

test('setConnectorAllowedActions honors an explicit reference and rejects missing or foreign references', () => {
  const ref = { id: SP, sharedConnectionId: 'fake-shared-id' };
  const d = appDir({ connectionReferences: {
    owner: { ...ref, dataSources: ['sharepointonline'] }, chosen: ref,
    foreign: { ...ref, id: DV }
  } });
  const opts = { connector: 'sharepointonline', actions: ['ListFolder'], connectorActions: CONNECTOR_ACTIONS };
  for (const reference of ['missing', '', 'toString']) {
    unchangedOnError(d, () => setConnectorAllowedActions(d, { ...opts, reference }), /No connection reference/);
  }
  unchangedOnError(d, () => setConnectorAllowedActions(d, { ...opts, reference: 'foreign' }), /foreign.*not for connector sharepointonline/);
  assert.deepEqual(setConnectorAllowedActions(d, { ...opts, reference: 'chosen' }), { reference: 'chosen', allowedActions: ['ListFolder'] });
  assert.equal(JSON.parse(readFileSync(join(d, 'ms.config.json'), 'utf8')).connectionReferences.owner.allowedActions, undefined);
});

test('both policy setters refuse non-shared references before writing or invoking ms', () => {
  for (const sharedConnectionId of [undefined, null, '', '  ']) {
    const d = appDir({ connectionReferences: {
      nonShared: { id: SP, sharedConnectionId, dataSources: ['sharepointonline', 'contosorules'],
        dataSets: { [SITE]: { dataSources: { contosorules: { tableName: 'Contoso Rules' } } } } }
    } });
    let calls = 0;
    const msOpts = { run: () => { calls++; throw new Error('CLI lookup must not run'); } };
    unchangedOnError(d, () => setConnectorAllowedActions(d, {
      connector: 'sharepointonline', reference: 'nonShared', actions: ['ListFolder'], msOpts
    }), /nonShared is not shared.*allowed-actions\.md/);
    unchangedOnError(d, () => setTableAllowedActions(d, {
      connector: 'sharepointonline', reference: 'nonShared', table: 'contosorules', verbs: ['get']
    }), /nonShared is not shared.*allowed-actions\.md/);
    assert.equal(calls, 0);
  }
});

test('setTableAllowedActions writes verbs on exactly one table, refuses operation ids, and satisfies the check', () => {
  const org = 'https://contoso.api.crm.dynamics.com';
  const cfg = { connectionReferences: {
    sp: { id: SP, displayName: 'SharePoint', sharedConnectionId: 's1', dataSources: ['sharepointonline', 'rules'],
      dataSets: { 'https://contoso.sharepoint.com/sites/ops': { dataSources: { rules: { tableName: 'Contoso Rules' } } },
        'https://contoso.sharepoint.com/sites/hr': { dataSources: { rules2: { tableName: 'Contoso Rules' } } } } },
    dv: { id: DV, displayName: 'Microsoft Dataverse', sharedConnectionId: 'd1',
      dataSets: { [org]: { dataSources: { cr123_task: { tableName: 'cr123_tasks' } } } } } } };
  const d = appDir(cfg);
  assert.throws(() => setTableAllowedActions(d, { connector: 'commondataserviceforapps', table: 'cr123_task', verbs: ['GetItems'] }), /only the verbs .*GetItems/);
  assert.throws(() => setTableAllowedActions(d, { connector: 'commondataserviceforapps', table: 'cr123_task', verbs: [] }), /at least one verb/);
  assert.throws(() => setTableAllowedActions(d, { connector: 'commondataserviceforapps', table: 'nope', verbs: ['get'] }), /No table nope/);
  assert.throws(() => setTableAllowedActions(d, { connector: 'sharepointonline', table: 'Contoso Rules', verbs: ['get'] }), /ambiguous/, 'same list name on two sites');
  const dv = setTableAllowedActions(d, { connector: 'commondataserviceforapps', table: 'cr123_task', verbs: ['delete', 'get', 'post', 'patch', 'get'] });
  assert.deepEqual(dv, { reference: 'dv', dataset: org, table: 'cr123_task', allowedActions: ['get', 'post', 'patch', 'delete'] });
  const sp = setTableAllowedActions(d, { connector: 'sharepointonline', table: 'Contoso Rules', dataset: 'https://contoso.sharepoint.com/sites/OPS/', verbs: ['get'] });
  assert.deepEqual([sp.reference, sp.table, sp.allowedActions], ['sp', 'rules', ['get']]);
  const after = JSON.parse(readFileSync(join(d, 'ms.config.json'), 'utf8'));
  assert.deepEqual(after.connectionReferences.dv.dataSets[org].dataSources.cr123_task.allowedActions, ['get', 'post', 'patch', 'delete']);
  assert.deepEqual(checkAllowedActions(after).issues, [{ reference: 'sp', table: 'https://contoso.sharepoint.com/sites/hr/rules2', problem: 'missing-table' }], 'the other site\'s table is untouched, and still flagged');
});

test('setTableAllowedActions honors an explicit reference and rejects missing or foreign references', () => {
  const ref = { id: SP, sharedConnectionId: 'fake-shared-id', allowedActions: ['ListFolder'],
    dataSets: { [SITE]: { dataSources: { contosorules: { tableName: 'Contoso Rules' } } } } };
  const d = appDir({ connectionReferences: { first: ref, chosen: ref, foreign: { ...ref, id: DV } } });
  const opts = { connector: 'sharepointonline', table: 'contosorules', verbs: ['get'] };
  unchangedOnError(d, () => setTableAllowedActions(d, opts), /ambiguous.*first.*chosen/);
  for (const reference of ['missing', '', 'toString']) {
    unchangedOnError(d, () => setTableAllowedActions(d, { ...opts, reference }), /No connection reference/);
  }
  unchangedOnError(d, () => setTableAllowedActions(d, { ...opts, reference: 'foreign' }), /foreign.*not for connector sharepointonline/);
  unchangedOnError(d, () => setTableAllowedActions(d, { ...opts, reference: 'chosen', dataset: '' }), /No table/);
  assert.deepEqual(setTableAllowedActions(d, { ...opts, reference: 'chosen' }), { reference: 'chosen', dataset: SITE, table: 'contosorules', allowedActions: ['get'] });
  const config = JSON.parse(readFileSync(join(d, 'ms.config.json'), 'utf8'));
  assert.deepEqual(config.connectionReferences.first, ref);
  assert.deepEqual(config.connectionReferences.chosen.allowedActions, ['ListFolder']);
});

test('CLI allow-table routes reference and dataset and prints only its JSON result', () => {
  const dataset = `${SITE}?view=a=b`;
  const ref = { id: SP, sharedConnectionId: 'fake-shared-id',
    dataSets: {
      [dataset]: { dataSources: { contosorules: { tableName: 'Contoso Rules' } } },
      'https://contoso.sharepoint.com/sites/hr': { dataSources: { contosorules: { tableName: 'Contoso Rules' } } }
    } };
  for (const flags of [['--reference', 'chosen', '--dataset', dataset], ['--reference=chosen', `--dataset=${dataset}`]]) {
    const config = { connectionReferences: { first: ref, chosen: structuredClone(ref) } };
    const d = appDir(config);
    const result = cli('allow-table', d, 'sharepointonline', 'Contoso Rules', 'patch,get', ...flags);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { reference: 'chosen', dataset, table: 'contosorules', allowedActions: ['get', 'patch'] });
    config.connectionReferences.chosen.dataSets[dataset].dataSources.contosorules.allowedActions = ['get', 'patch'];
    assert.deepEqual(JSON.parse(readFileSync(join(d, 'ms.config.json'), 'utf8')), config);
  }
});

test('CLI allow routes an explicit non-shared reference before any connector lookup', () => {
  const d = appDir({ connectionReferences: {
    owner: { id: SP, sharedConnectionId: 'fake-shared-id', dataSources: ['sharepointonline'] },
    nonShared: { id: SP, dataSources: ['contosorules'] }
  } });
  const before = readFileSync(join(d, 'ms.config.json'));
  const result = cli('allow', d, 'sharepointonline', 'ListFolder', '--reference', 'nonShared');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /nonShared is not shared.*allowed-actions\.md/);
  assert.deepEqual(readFileSync(join(d, 'ms.config.json')), before);
});

test('CLI rejects missing, empty, unknown, or misplaced flag values and malformed arguments', () => {
  const d = appDir({ connectionReferences: { nonShared: { id: SP,
    dataSets: { [SITE]: { dataSources: { contosorules: {} } } } } } });
  const base = ['allow-table', d, 'sharepointonline', 'contosorules', 'get'];
  const cases = [
    [[...base, '--reference', '--dataset', SITE], /--reference.*(?:argument|value)/],
    [[...base, '--reference'], /--reference.*(?:argument|value)/],
    [[...base, '--dataset'], /--dataset.*(?:argument|value)/],
    [[...base, '--reference='], /--reference needs a non-empty value/],
    [[...base, '--dataset', ' '], /--dataset needs a non-empty value/],
    [[...base, '--refrence', 'nonShared'], /Unknown option.*--refrence/],
    [[...base, 'extra'], /needs 4 positional argument/],
    [['allow', d, 'sharepointonline'], /needs 3 positional argument/],
    [['allow', d, 'sharepointonline', 'ListFolder', '--dataset', SITE], /Unknown option.*--dataset/],
    [['infer', d, 'OrdersService', '--table=false'], /--table.*argument/],
    [['allow', d, 'sharepointonline', 'ListFolder,,'], /at least one action id/],
    [['allow-table', d, 'sharepointonline', 'contosorules', 'get,,patch'], /at least one verb/]
  ];
  const before = readFileSync(join(d, 'ms.config.json'));
  for (const [args, error] of cases) {
    const result = cli(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, error, args.join(' '));
  }
  assert.deepEqual(readFileSync(join(d, 'ms.config.json')), before);
});

test('CLI infer forwards the table flag and returns JSON', () => {
  const d = appDir({}, { 'src/app.ts': 'OrdersService.GetAll(); OrdersService.UpdateRecord();' });
  const result = cli('infer', d, 'OrdersService', '--table');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { actions: ['get', 'patch'], files: ['src/app.ts'] });
});

test('gitAuthEnv carries the token only in git environment config (never argv) and disables helpers and prompts', () => {
  const env = gitAuthEnv('tok123');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.extraHeader');
  assert.equal(env.GIT_CONFIG_VALUE_1, `Authorization: Basic ${Buffer.from('OAUTH_USER:tok123').toString('base64')}`);
  assert.throws(() => gitAuthEnv(''), /access token/);
  assert.match(MANAGED_APPS_GIT_CLIENT_ID, /^[0-9a-f-]{36}$/);
});

test('ms() runs non-interactively with JSON, and turns success:false into an error with the CLI message', () => {
  const calls = [];
  const run = (bin, args, opts) => { calls.push({ bin, args, env: opts.env }); return { status: 0, stdout: 'banner\n{"success":true,"items":[1]}\n' }; };
  assert.deepEqual(ms(['app', 'list'], { run }), { success: true, items: [1] });
  assert.deepEqual(calls[0].args, ['app', 'list', '--non-interactive', '--json']);
  assert.equal(calls[0].env.MS_CLI_ORIGIN, process.env.MS_CLI_ORIGIN || 'sdk/copilot-harness-sdk');
  const bad = () => ({ status: 1, stdout: '{"success":false,"errorMessage":"External artifact deployment is not enabled"}' });
  assert.throws(() => ms(['app', 'deploy'], { run: bad }), /External artifact deployment is not enabled/);
  assert.throws(() => ms(['app', 'list'], { run: () => ({ status: 1, stdout: 'boom', stderr: '' }) }), /returned no JSON/);
  assert.throws(() => ms(['x'], { run: () => ({ error: new Error('ENOENT') }) }), /npm install -g @microsoft\/managed-apps-cli/);
});

test('ms rejects a failing exit even when the JSON claims success', () => {
  const result = { success: true, items: [] };
  assert.throws(() => ms(['app', 'list'], { run: () => ({ status: 2, stdout: JSON.stringify(result), stderr: 'fake failure' }) }), (error) => {
    assert.match(error.message, /failed \(exit 2\).*fake failure/);
    assert.deepEqual(error.result, result);
    return true;
  });
});

test('managed-app CLI calls stay bound to appDir despite msOpts.cwd', () => {
  const d = appDir({ repoType: 'native', connectionReferences: { shared: { id: SP, sharedConnectionId: 'fake-shared-id' } } });
  const calls = [];
  const msOpts = { cwd: 'wrong-workspace', run: (bin, args, opts) => {
    calls.push({ bin, args, cwd: opts.cwd });
    return { status: 0, stdout: JSON.stringify({ success: true, items: CONNECTOR_ACTIONS, url: 'https://contoso.example/play' }) };
  } };
  setConnectorAllowedActions(d, { connector: 'sharepointonline', actions: ['ListFolder'], msOpts });
  const run = (_bin, args) => ({ status: 0, stdout: args[0] === 'status' ? '' : args[0] === 'branch' ? 'origin/main' : 'a'.repeat(40) });
  deploy(d, { msOpts, run });
  assert.equal(playUrl(d, { msOpts }), 'https://contoso.example/play');
  const noRepo = appDir({ repoType: 'none' });
  deploy(noRepo, { msOpts });
  assert.deepEqual(calls.map((call) => call.cwd), [d, d, d, noRepo]);
  assert.ok(calls.every((call) => call.bin === 'ms'));
});

function repo() {
  const d = workspace();
  const g = (...a) => { const r = spawnSync('git', a, { cwd: d, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T');
  g('config', 'core.autocrlf', 'false');   // the same bytes on every OS (Windows runners default to true)
  return { d, g };
}

test('deploy refuses a missing policy, a dirty tree and an unpushed commit before calling ms', () => {
  const { d, g } = repo();
  writeFileSync(join(d, 'ms.config.json'), JSON.stringify({ repoType: 'native', connectionReferences: { r: { id: SP, displayName: 'S', sharedConnectionId: 'c' } } }));
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  const msOpts = { run: () => { throw new Error('ms must not run'); } };
  assert.throws(() => deploy(d, { msOpts }), /shared connection policy missing: r \(missing-connector\)/);
  writeFileSync(join(d, 'ms.config.json'), JSON.stringify({ repoType: 'native', connectionReferences: {} }));
  assert.throws(() => deploy(d, { msOpts }), /uncommitted changes/);
  g('commit', '-q', '-am', 'policy');
  assert.throws(() => deploy(d, { msOpts }), /not on the remote/);
  const sha = g('rev-parse', 'HEAD');
  g('update-ref', 'refs/remotes/other/main', sha);
  assert.throws(() => deploy(d, { msOpts }), /not on the remote/);
  g('update-ref', 'refs/remotes/origin/main', sha);
  const deployed = deploy(d, { msOpts: { run: (_bin, args) => {
    assert.deepEqual(args, ['app', 'deploy', '--commit', sha, '--non-interactive', '--json']);
    return { status: 0, stdout: '{"success":true}' };
  } } });
  assert.deepEqual(deployed, { success: true });
});

test('deploy requires the selected commit on origin, not another remote', () => {
  const d = appDir({ repoType: 'native' });
  const run = (_bin, args) => ({ status: 0, stdout: args[0] === 'status' ? '' :
    args[0] === 'rev-parse' ? 'a'.repeat(40) : args.includes('origin/*') ? '' : 'other/main' });
  const msOpts = { run: () => { throw new Error('ms must not run'); } };
  assert.throws(() => deploy(d, { run, msOpts }), /not on the remote/);
});

test('deploy refuses a commit selector for an app without a repository', () => {
  const d = appDir({ repoType: 'none' });
  const msOpts = { run: () => { throw new Error('ms must not run'); } };
  assert.throws(() => deploy(d, { commit: 'a'.repeat(40), msOpts }), /repoType:none.*omit commit/);
  const result = cli('deploy', d, '--commit', 'a'.repeat(40));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repoType:none.*omit commit/);
});

test('playUrl refuses ignored or conflicting preview selectors and preserves valid arguments', () => {
  const d = appDir({});
  const calls = [];
  const msOpts = { run: (_bin, args) => { calls.push(args); return { status: 0, stdout: '{"success":true,"url":"https://contoso.example/play"}' }; } };
  assert.throws(() => playUrl(d, { commit: 'abc123', msOpts }), /requires preview mode/);
  assert.throws(() => playUrl(d, { mode: 'live', branch: 'main', msOpts }), /requires preview mode/);
  assert.throws(() => playUrl(d, { mode: 'preview', commit: 'abc123', branch: 'main', msOpts }), /either commit or branch/);
  assert.equal(calls.length, 0);
  for (const selector of [{ commit: 'abc123' }, { branch: 'main' }]) {
    assert.equal(playUrl(d, { mode: 'preview', ...selector, msOpts }), 'https://contoso.example/play');
  }
  assert.deepEqual(calls, [
    ['app', 'play', '--no-browser', '--mode', 'preview', '--commit', 'abc123', '--non-interactive', '--json'],
    ['app', 'play', '--no-browser', '--mode', 'preview', '--branch', 'main', '--non-interactive', '--json']
  ]);
  const result = cli('play-url', d, '--commit', 'abc123');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires preview mode/);
});

test('pushApp rebases a first push onto the platform initial commit (README only) and keeps the app README', () => {
  const remote = workspace();
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = repo();
  writeFileSync(join(seed.d, 'README.md'), '# platform readme\n'); seed.g('add', '-A'); seed.g('commit', '-q', '-m', 'Initial commit');
  seed.g('remote', 'add', 'origin', remote); seed.g('push', '-q', 'origin', 'main');
  const app = repo();
  writeFileSync(join(app.d, 'README.md'), '# my app\n'); writeFileSync(join(app.d, 'index.html'), '<p>x</p>');
  app.g('add', '-A'); app.g('commit', '-q', '-m', 'app'); app.g('remote', 'add', 'origin', remote);
  const sha = pushApp(app.d);
  assert.equal(app.g('rev-parse', 'origin/main'), sha);
  assert.equal(readFileSync(join(app.d, 'README.md'), 'utf8'), '# my app\n');
  assert.equal(app.g('log', '--format=%s', '-2'), 'app\nInitial commit');
});

test('createInteractiveTokenProvider goes silent from the cache and only opens the browser when it must', async () => {
  let interactive = 0; let opened;
  const account = { username: 'User@Contoso.com' };
  const pca = (hasAccount) => ({
    getTokenCache: () => ({ getAllAccounts: async () => (hasAccount ? [account] : []) }),
    acquireTokenSilent: async () => ({ accessToken: 'silent', expiresOn: new Date(Date.now() + 3600e3) }),
    acquireTokenInteractive: async (req) => { interactive++; await req.openBrowser('https://login/x'); return { accessToken: 'interactive', expiresOn: new Date(Date.now() + 3600e3) }; }
  });
  const silent = createInteractiveTokenProvider({ clientId: 'c', tenantId: 't', scopes: ['s'], loginHint: 'user@contoso.com' }, { pcaFactory: () => pca(true) });
  assert.equal(await silent(), 'silent');
  const fresh = createInteractiveTokenProvider({ clientId: 'c', tenantId: 't', scopes: ['s'], openBrowser: async (u) => { opened = u; } }, { pcaFactory: () => pca(false) });
  assert.equal(await fresh(), 'interactive');
  assert.equal(interactive, 1); assert.equal(opened, 'https://login/x');
  assert.throws(() => createInteractiveTokenProvider({ clientId: 'c', tenantId: 't', scopes: [] }), /scopes/);
});

test('the vendored microsoft/managed-apps plugin is byte-for-byte what VENDOR.json pins', () => {
  const root = new URL('../vendor/managed-apps/', import.meta.url);
  const v = JSON.parse(readFileSync(new URL('VENDOR.json', root), 'utf8'));
  assert.match(v.commit, /^[0-9a-f]{40}$/);
  for (const [p, h] of Object.entries(v.files)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex'), h, p);
  }
  assert.ok(v.files['plugins/microsoft-managed-apps/skills/add-sharepoint/SKILL.md']);
  assert.ok(v.files['plugins/microsoft-managed-apps/skills/add-mcscopilot/SKILL.md']);
});
