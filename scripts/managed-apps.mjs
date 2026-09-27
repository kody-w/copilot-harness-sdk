#!/usr/bin/env node
// Managed apps (Copilot Managed Runtime) from the SDK: the microsoft-managed-apps plugin skills as commands, driving
// Microsoft's own CLI (`ms`, @microsoft/managed-apps-cli) non-interactively with the plugin's rules enforced.
//
//   node scripts/managed-apps.mjs skills                               list the vendored skills (vendor/managed-apps)
//   node scripts/managed-apps.mjs verify-vendor                        re-hash vendor/managed-apps against VENDOR.json
//   node scripts/managed-apps.mjs check <app-dir>                      shared-connection policy (allowedActions) check
//   node scripts/managed-apps.mjs infer <app-dir> <Service> [--table]  least-privilege actions from src/ calls
//   node scripts/managed-apps.mjs allow <app-dir> <connector> <ActionId,...> [--reference <name>]
//                                                                      write shared connector-level allowedActions
//                                                                      (validated against `ms connector list-actions`); JSON result
//   node scripts/managed-apps.mjs allow-table <app-dir> <connector> <table> <verb,...> [--reference <name>] [--dataset <d>]
//                                                                      write one shared table's allowedActions (get, post,
//                                                                      patch, delete); table = data source key or name; JSON result
//   node scripts/managed-apps.mjs push <app-dir> --tenant <id> [--login-hint <upn>] [--cache <file>]
//                                                                      push to the app's platform repo (Entra token, no
//                                                                      Git Credential Manager needed)
//   node scripts/managed-apps.mjs deploy <app-dir> [--commit <sha>]   policy + clean tree + pushed commit, then deploy
//   node scripts/managed-apps.mjs play-url <app-dir> [--preview [--commit <sha>]]
//
// Flags are command-specific; unknown flags, missing/empty values and extra positional arguments are errors.
//
// Creating the app and binding connectors stay Microsoft's CLI verbs (see the vendored create-app and add-* skills):
//   ms app create <dir> --display-name "<name>" [--environment-id <id>] --non-interactive
//   ms app add data-source --connector sharepointonline --as action --use-sso --non-interactive
//   ms app add data-source --connector sharepointonline --as table --dataset <site> --table "<list>" --use-sso ...
//   ms app add data-source --connector commondataserviceforapps --as table --table <logical name>
//       --dataverse-environment-id <env> --use-sso ...   (`--connector dataverse` is ambiguous in ms 0.25.1)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import {
  checkAllowedActions, inferAllowedActions, setConnectorAllowedActions, setTableAllowedActions, pushApp, deploy,
  playUrl, readConfig, MANAGED_APPS_GIT_CLIENT_ID, MANAGED_APPS_GIT_SCOPE
} from '../src/managed-apps.js';
import { createInteractiveTokenProvider } from '../src/auth/entra.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'managed-apps');
const argv = process.argv.slice(2);
const cmd = argv[0];
const COMMANDS = {
  skills: { count: 0, strings: [], booleans: [] },
  'verify-vendor': { count: 0, strings: [], booleans: [] },
  check: { count: 1, strings: [], booleans: [] },
  infer: { count: 2, strings: [], booleans: ['table'] },
  allow: { count: 3, strings: ['reference'], booleans: [] },
  'allow-table': { count: 4, strings: ['reference', 'dataset'], booleans: [] },
  push: { count: 1, strings: ['tenant', 'login-hint', 'cache'], booleans: [] },
  deploy: { count: 1, strings: ['commit'], booleans: [] },
  'play-url': { count: 1, strings: ['commit'], booleans: ['preview'] }
};

function fail(msg) { console.error(msg); process.exit(1); }

async function main() {
  if (!Object.hasOwn(COMMANDS, cmd)) fail(`unknown command: ${cmd || '(missing)'} (see the header of this file for usage)`);
  const spec = COMMANDS[cmd];
  const { values: flags, positionals: pos } = parseArgs({
    args: argv.slice(1), allowPositionals: true, strict: true,
    options: Object.fromEntries([
      ...spec.strings.map((name) => [name, { type: 'string' }]),
      ...spec.booleans.map((name) => [name, { type: 'boolean' }])
    ])
  });
  if (pos.length !== spec.count) fail(`${cmd} needs ${spec.count} positional argument(s); see the header of this file for usage.`);
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === 'string' && !value.trim()) fail(`--${name} needs a non-empty value.`);
  }
  const flag = (/** @type {string} */ name) => (typeof flags[name] === 'string' ? flags[name] : undefined);
  const has = (/** @type {string} */ name) => flags[name] === true;
  if (cmd === 'skills') {
    const dir = join(VENDOR, 'plugins', 'microsoft-managed-apps', 'skills');
    const v = JSON.parse(readFileSync(join(VENDOR, 'VENDOR.json'), 'utf8'));
    console.log(`microsoft/managed-apps @ ${v.commit.slice(0, 7)} (${v.license})`);
    for (const s of readdirSync(dir).sort()) {
      const text = readFileSync(join(dir, s, 'SKILL.md'), 'utf8');
      const desc = (text.match(/^description:\s*(.*)$/m) || [])[1] || '';
      console.log(`  /${s.padEnd(20)} ${desc.slice(0, 110)}`);
    }
    return;
  }
  if (cmd === 'verify-vendor') {
    const v = JSON.parse(readFileSync(join(VENDOR, 'VENDOR.json'), 'utf8'));
    const bad = Object.entries(v.files).filter(([p, h]) => !existsSync(join(VENDOR, p)) ||
      createHash('sha256').update(readFileSync(join(VENDOR, p))).digest('hex') !== h);
    if (bad.length) fail(`vendored files changed or missing: ${bad.map(([p]) => p).join(', ')}`);
    console.log(`OK: ${Object.keys(v.files).length} vendored files match microsoft/managed-apps @ ${v.commit.slice(0, 7)}`);
    return;
  }
  const dir = pos[0];
  if (!dir) fail('usage: node scripts/managed-apps.mjs <command> <app-dir> ... (see the header of this file)');
  if (cmd === 'check') {
    const r = checkAllowedActions(readConfig(dir));
    if (!r.ok) fail(r.issues.map((i) => `MISSING/INVALID ${i.problem}: ${i.reference}${i.table ? ` -> ${i.table}` : ''}`).join('\n'));
    console.log('OK: all shared references declare allowedActions');
    return;
  }
  if (cmd === 'infer') {
    const r = inferAllowedActions(dir, pos[1], { kind: has('table') ? 'table' : 'action' });
    console.log(JSON.stringify(r, null, 1));
    return;
  }
  if (cmd === 'allow') {
    const r = setConnectorAllowedActions(dir, { connector: pos[1], actions: pos[2].split(','), reference: flag('reference') });
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === 'allow-table') {
    const r = setTableAllowedActions(dir, { connector: pos[1], table: pos[2], verbs: pos[3].split(','), dataset: flag('dataset'), reference: flag('reference') });
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === 'push') {
    const tenant = flag('tenant') || readConfig(dir).tenantId;
    if (!tenant) fail('push needs --tenant <tenant id> (the account that owns the app).');
    const getToken = createInteractiveTokenProvider({
      clientId: MANAGED_APPS_GIT_CLIENT_ID, tenantId: tenant, scopes: [MANAGED_APPS_GIT_SCOPE], loginHint: flag('login-hint'),
      cacheFile: flag('cache') || join(homedir(), '.copilot-harness-sdk', 'managed-apps-git-msal.json')
    });
    const sha = pushApp(dir, { token: await getToken() });
    console.log(`pushed ${sha}`);
    return;
  }
  if (cmd === 'deploy') {
    const r = deploy(dir, { commit: flag('commit') });
    console.log(JSON.stringify(r, null, 1));
    return;
  }
  if (cmd === 'play-url') {
    console.log(playUrl(dir, { mode: has('preview') ? 'preview' : 'live', commit: flag('commit') }));
    return;
  }
  fail(`unknown command: ${cmd}`);
}

main().catch((e) => fail(e.message));
