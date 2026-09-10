#!/usr/bin/env node
// Deploy a Copilot Studio agent that can ONLY be a GitHub Copilot harness agent, with its
// infrastructure provisioned the way the reference pilots are built.
//
// The sequence, proven live on 2026-09-07 (harness) and 2026-09-10 (infrastructure) on kodyv8, pac 2.10.1:
//    0. preflight: Node, pac CLI, and the Dataverse token command (az CLI by default) are present, or a clear message says what to install
//    1. workspace: pac copilot init --authoring-mode cli-copilot, or copy a pre-authored workspace
//       (--workspace-dir) and rename it to --name / --schema-name. Every agent-scoped connection
//       reference (`<other>.cr.<suffix>`) is rebound to `<schemaName>.cr.<suffix>`.
//    2. provision: connection references bound to a real connection, custom connectors verified,
//       agent flows created/updated and activated (workspace `workflows/*/workflow.json`);
//       WorkflowTool ids are reused when the flow exists in the environment, minted per agent otherwise
//    3. pac copilot pack                                     (pac 2.10.1 writes <language>0</language>; fixed via pac solution unpack/pack)
//    4. guard: refuse the zip unless bot.xml says template=cliagent-*
//    5. pac solution import --async --force-overwrite
//    6. push WorkflowTools through a synced clone (pack cannot resolve them)
//    7. PATCH bots(<id>).configuration with the instructions  (pac push drops agentSettings.instructions in 2.10.1)
//    8. bind: ConnectorTool → connection reference, WorkflowTool → flow; delete components the
//       workspace no longer declares (--keep-extra-components to skip)
//    9. pac copilot publish --bot <bot id>
//   10. read the live record back: harness + instructions + published + every component with its links
//
// Usage:
//   node scripts/deploy-harness-agent.mjs --name "My Agent" --publisher-prefix cr8c1 \
//     --instructions-file ./instructions.md --environment https://org.crm.dynamics.com/ [--schema-name cr8c1_MyAgent] \
//     [--workspace-dir ./agent] [--connections ./connections.json] [--fork-workflows] [--keep-extra-components] \
//     [--model Sonnet46] [--language 1033] [--solution-name MyAgentHarness] [--work-dir ./.deploy]
//
// --connections: JSON { "<cr suffix | connector id | source logical name>": "<connection id>" } for
// references that cannot be resolved from an existing reference in the environment.
// Token for the Dataverse steps: `az account get-access-token --resource <environment>` (same user as the pac auth profile).
// Override with --token-command "<shell command that prints a bearer token>".
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { assertHarnessAgent, classifyBot, HARNESS_TEMPLATE } from '../src/harness-guard.js';
import { scanWorkspace, rebindConnectionReferences, rebindWorkflows, workflowIdFor, findBot, findConnectionReference, resolveConnection, ensureConnectionReference, connectorExists, findWorkflow, ensureWorkflow, listBotComponents, linkComponentConnectionReference, linkComponentWorkflow, deleteStaleComponents, expectedComponents, AGENT_SCOPED_REF } from '../src/harness-provision.js';

const args = parseArgs(process.argv.slice(2));
const need = (k) => { if (!args[k]) { console.error(`Missing --${k}`); process.exit(2); } return args[k]; };
const name = need('name');
// Display names longer than 42 characters leave the bot stuck in "Provisioning" forever (44 stalled, 41 worked; pac 2.10.1, 2026-09-07).
if (name.length > 42) { console.error(`Refusing display name "${name}" (${name.length} chars): names over 42 characters never finish provisioning.`); process.exit(2); }
const publisherPrefix = need('publisher-prefix');
const instructionsFile = args['instructions-file'];
if (!instructionsFile && !args['workspace-dir']) { console.error('Missing --instructions-file (or --workspace-dir with instructions in settings.mcs.yml)'); process.exit(2); }
const environment = need('environment').replace(/\/+$/, '') + '/';
const model = args.model || 'Sonnet46';
const language = Number(args.language || 1033);
const schemaName = args['schema-name'] || `${publisherPrefix}_${name.replace(/[^A-Za-z0-9]/g, '')}`;
// Dataverse rejects solution unique names of 50+ characters ("must contain less than 50 characters").
const solutionName = (args['solution-name'] || `${schemaName.replace(/[^A-Za-z0-9]/g, '')}Harness`).slice(0, 49);
if ((args['solution-name'] || '').length > 49) console.error(`--solution-name truncated to 49 characters: ${solutionName}`);
const workDir = resolve(args['work-dir'] || `.deploy/${schemaName}`);
const tokenCommand = args['token-command'] || `az account get-access-token --resource ${environment} --query accessToken -o tsv`;
const connections = args.connections ? JSON.parse(readFileSync(args.connections, 'utf8')) : {};
const forkWorkflows = args['fork-workflows'] === 'true';
const keepExtra = args['keep-extra-components'] === 'true';
if (args['authoring-mode'] && args['authoring-mode'] !== 'cli-copilot') {
  console.error(`Refusing --authoring-mode ${args['authoring-mode']}: this script only produces GitHub Copilot harness agents.`);
  process.exit(3);
}
let instructions = instructionsFile ? readFileSync(instructionsFile, 'utf8').trim() : '';

step('0/10 preflight');
preflight();

const projectDir = join(workDir, 'workspace');
const outDir = join(workDir, 'out');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const workspaceDir = args['workspace-dir'] ? resolve(args['workspace-dir']) : null;
if (workspaceDir) {
  step('1/10 copy pre-authored harness workspace');
  if (!existsSync(join(workspaceDir, 'settings.mcs.yml'))) fail(`${workspaceDir} has no settings.mcs.yml`);
  cpSync(workspaceDir, projectDir, { recursive: true, filter: (src) => !/[\\/]\.mcs([\\/]|$)/.test(src) });
  console.log(`   ${workspaceDir}`);
} else {
  step('1/10 scaffold harness workspace');
  // No --environment on init: with it, init also creates the bot remotely and a retry fails with "already exists".
  // The solution import is the only creator, so re-running the script is idempotent (--force-overwrite).
  pac(['copilot', 'init', '--name', name, '--publisher-prefix', publisherPrefix, '--schema-name', schemaName, '--authoring-mode', 'cli-copilot', '--project-dir', projectDir]);
}
const settingsPath = join(projectDir, 'settings.mcs.yml');
let settings = readFileSync(settingsPath, 'utf8');
if (!/kind:\s*CLICopilotRecognizer/.test(settings) || !/template:\s*cliagent-/.test(settings)) {
  fail(`pac copilot init did not scaffold a harness agent:\n${settings}`);
}
settings = settings.replace(/series:\s*\S+/, `series: ${model}`).replace(/^language:.*$/m, `language: ${language}`);
// A copied workspace keeps the identity of the agent it was cloned from; this deploy owns the name.
const sourceSchema = (settings.match(/^schemaName:\s*(\S+)/m) || [])[1];
settings = settings.replace(/^displayName:.*$/m, `displayName: ${name}`).replace(/^schemaName:.*$/m, `schemaName: ${schemaName}`);
writeFileSync(settingsPath, settings);
if (sourceSchema && sourceSchema !== schemaName) console.log(`   renamed from ${sourceSchema} → ${schemaName}`);
const rebound = rebindConnectionReferences(projectDir, schemaName);
for (const [from, to] of Object.entries(rebound)) console.log(`   connection reference ${from} → ${to}`);
const settingsDoc = parseSettings(settings);
if (!instructions) instructions = (settingsDoc.instructions || '').trim();
if (!instructions) fail('No instructions: pass --instructions-file or put them in settings.mcs.yml');
const greetingText = settingsDoc.greetingText;
const conversationStarters = settingsDoc.conversationStarters;
const scan = scanWorkspace(projectDir);
const expected = expectedComponents(projectDir, schemaName);

// pac 2.10.1 `pack` cannot resolve a WorkflowTool's flow from an init-style workspace ("workflow link(s) without typed workflow(s)");
// those tools plus the workflows/ folder are pushed after import through a cloned (synced) workspace instead.
const deferredDir = join(workDir, 'deferred');
const deferred = deferWorkflowTools(projectDir, deferredDir);
if (deferred.length) console.log(`   deferred for push after import: ${deferred.join(', ')}`);

step('2/10 provision infrastructure (connection references, custom connectors, agent flows)');
const getToken = async () => execSync(tokenCommand, { encoding: 'utf8' }).trim();
// Every Dataverse call goes through a fetch that retries transient network failures (ETIMEDOUT, EPIPE, ECONNRESET).
const fetchRetry = (url, init) => retry(() => fetch(url, init), 4, 10000);
const dv = { environmentUrl: environment, getDataverseToken: getToken, fetchImpl: fetchRetry };
const api = `${environment}api/data/v9.2/`;
const sourceOf = Object.fromEntries(Object.entries(rebound).map(([from, to]) => [to, from]));
const provisioned = { connectionReferences: [], workflows: [], connectors: [] };
for (const [logical, info] of scan.connectionRefs) {
  const scoped = AGENT_SCOPED_REF.exec(logical);
  const existing = await findConnectionReference({ ...dv, logicalName: logical });
  if (!scoped) {
    if (!existing) fail(`Connection reference ${logical} (used by ${info.sources.join(', ')}) does not exist in ${environment}. Create the connection in the maker portal and a reference with that logical name, or bind an agent-scoped name (<schemaName>.cr.<suffix>).`);
    if (!existing.connectionid) fail(`Connection reference ${logical} exists but is not bound to a connection.`);
    provisioned.connectionReferences.push({ logicalName: logical, operation: 'shared', connectionId: existing.connectionid });
    console.log(`   ${logical}: shared reference, bound`);
    continue;
  }
  const suffix = scoped[2];
  const resolved = await resolveConnection({ ...dv, sourceLogicalName: sourceOf[logical], connectorId: info.connectorId, suffix, connections });
  const connectorId = info.connectorId || resolved?.connectorId || existing?.connectorid;
  const connectionId = resolved?.connectionId || existing?.connectionid;
  if (!connectorId || !connectionId) fail(`Cannot bind ${logical} (used by ${info.sources.join(', ')}): no connection found. Pass --connections with { "${suffix}": "<connection id>" } (pac connection list).`);
  const r = await ensureConnectionReference({ ...dv, logicalName: logical, displayName: `${name} - ${suffix.replace(/^shared_/, '').replace(/_/g, ' ')}`, connectorId, connectionId });
  provisioned.connectionReferences.push({ logicalName: logical, operation: r.operation, connectionId, via: resolved?.via || 'existing reference' });
  console.log(`   ${logical}: ${r.operation} (${resolved?.via || 'already bound'})`);
}
const connectorIds = new Set([...scan.connectionRefs.values()].map((v) => v.connectorId).filter(Boolean).concat(provisioned.connectionReferences.map(() => null)).filter(Boolean));
for (const c of scan.customConnectors) if (c.internalId) connectorIds.add(`/providers/Microsoft.PowerApps/apis/${c.internalId}`);
for (const connectorId of connectorIds) {
  const r = await connectorExists({ ...dv, connectorId });
  if (r.custom && !r.exists) fail(`Custom connector ${r.internal} is not in ${environment}. Create it there first (pac connector create) and bind its connection with --connections.`);
  if (r.custom) { provisioned.connectors.push({ internal: r.internal, connectorId: r.connectorId }); console.log(`   custom connector ${r.displayName || r.internal}: present`); }
}
if (deferred.length) {
  const bound = rebindWorkflows(deferredDir, (wf) => {
    if (!wf.id) return workflowIdFor(schemaName, wf.folder);
    if (forkWorkflows) return workflowIdFor(schemaName, wf.folder);
    return wf.id;
  });
  for (const wf of bound) {
    let id = wf.id;
    if (!forkWorkflows && wf.oldId && !(await findWorkflow({ ...dv, workflowId: wf.oldId }))) {
      // The workspace came from somewhere this flow does not exist: mint a per-agent copy.
      id = workflowIdFor(schemaName, wf.folder);
      rebindWorkflows(deferredDir, (w) => (w.id === wf.oldId ? id : w.id));
    }
    const r = await ensureWorkflow({ ...dv, workflowId: id, name: wf.name, description: wf.description, definition: wf.definition });
    provisioned.workflows.push({ ...r, folder: wf.folder, oldId: wf.oldId });
    console.log(`   flow ${wf.name}: ${r.operation}, activated (${id}${wf.oldId && wf.oldId !== id ? `, was ${wf.oldId}` : ''})`);
  }
}
if (!scan.connectionRefs.size && !deferred.length) console.log('   nothing to provision');

step('3/10 pack solution');
pac(['copilot', 'pack', '--publisher-prefix', publisherPrefix, '--project-dir', projectDir, '--solution-name', solutionName, '--output-path', outDir]);
const zipPath = join(outDir, `${solutionName}.zip`);
if (!existsSync(zipPath)) fail(`pack did not produce ${zipPath}`);

step('4/10 guard the packed solution');
const unpacked = join(outDir, 'unpacked');
pac(['solution', 'unpack', '--zipfile', zipPath, '--folder', unpacked, '--packagetype', 'Unmanaged']);
const botXmlPath = findFiles(join(unpacked, 'bots'), 'bot.xml')[0];
if (!botXmlPath) fail('No bots/*/bot.xml in the packed solution.');
let botXml = readFileSync(botXmlPath, 'utf8');
const template = (botXml.match(/<template>([^<]+)<\/template>/) || [])[1] || '';
if (!HARNESS_TEMPLATE.test(template)) fail(`Packed bot.xml has template=${template || '?'}; refusing anything that is not cliagent-*.`);
if (/<language>0<\/language>/.test(botXml)) {
  botXml = botXml.replace('<language>0</language>', `<language>${language}</language>`);
  writeFileSync(botXmlPath, botXml);
  console.log(`   fixed <language>0</language> → ${language} (pac 2.10.1 pack bug)`);
}
const fixedZip = join(outDir, `${solutionName}_harness.zip`);
pac(['solution', 'pack', '--zipfile', fixedZip, '--folder', unpacked, '--packagetype', 'Unmanaged']);
console.log(`   template=${template} ✓`);

step('5/10 import solution');
// Dataverse serialises solution operations per environment: "another [PublishAll] running" → wait and retry.
pac(['solution', 'import', '--path', fixedZip, '--async', '--force-overwrite', '--environment', environment], { retries: 6, delayMs: 30000 });

if (deferred.length) {
  step('6/10 push deferred workflow tools through a synced clone');
  const cloneRoot = join(workDir, 'clone');
  rmSync(cloneRoot, { recursive: true, force: true }); mkdirSync(cloneRoot, { recursive: true });
  pac(['copilot', 'clone', '--bot', schemaName, '--environment', environment, '--output-dir', cloneRoot, '--display-name', 'synced'], { retries: 4, delayMs: 15000 });
  const synced = join(cloneRoot, 'synced');
  // Merge, do not overwrite: on a re-deploy the clone already holds the flow folder pac wrote (fuller metadata.yml than
  // a workspace carries); replacing it makes pac 2.10.1 push crash with ArgumentException. Copy only what is new or changed.
  const changed = mergeDeferred(deferredDir, synced);
  if (changed.length) { console.log(`   pushing: ${changed.join(', ')}`); pac(['copilot', 'push', '--project-dir', synced], { retries: 4, delayMs: 15000 }); }
  else console.log('   clone already matches the deferred workflow tools; nothing to push');
} else {
  step('6/10 no workflow tools to push');
}

step('7/10 write instructions to the live record');
const token = await getToken();
const lookup = await fetchRetry(`${api}bots?$filter=schemaname eq '${schemaName}'&$select=botid,template,configuration`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
if (!lookup.ok) fail(`Dataverse lookup failed: HTTP ${lookup.status} ${await lookup.text()}`);
const bot = (await lookup.json()).value?.[0];
if (!bot) fail(`Imported solution but no bot with schemaname ${schemaName} exists.`);
const before = classifyBot(bot);
if (before.harness !== 'github-copilot') fail(`Live record is not on the harness after import: ${JSON.stringify(before)}`);
const configuration = {
  $kind: 'BotConfiguration',
  recognizer: { $kind: 'CLICopilotRecognizer' },
  agentSettings: {
    $kind: 'AgentSettings',
    model: { $kind: 'ModelConfig', series: model },
    instructions: { $kind: 'Instructions', segments: [{ $kind: 'StaticSegment', value: instructions }] },
    ...(greetingText ? { greetingText } : {}),
    ...(conversationStarters?.length ? { conversationStarters: conversationStarters.map((c) => ({ $kind: 'ConversationStarter', title: c.title, text: c.text })) } : {})
  },
  authoringModel: 'CliCopilot'
};
const patch = await fetchRetry(`${api}bots(${bot.botid})`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'If-Match': '*' },
  body: JSON.stringify({ configuration: JSON.stringify(configuration) })
});
if (!patch.ok) fail(`PATCH configuration failed: HTTP ${patch.status} ${await patch.text()}`);

step('8/10 bind components to their references and flows; remove stale components');
let components = await listBotComponents({ ...dv, botId: bot.botid });
const byName = new Map(components.map((c) => [c.schemaName.toLowerCase(), c]));
for (const t of scan.tools) {
  const comp = byName.get(`${schemaName}.tool.${t.name}`.toLowerCase());
  if (!comp) fail(`Component tool.${t.name} from the workspace is missing on the live record after import/push.`);
  if (t.kind === 'ConnectorTool' && t.connectionReference) {
    const r = await linkComponentConnectionReference({ ...dv, component: comp, logicalName: t.connectionReference });
    console.log(`   tool.${t.name} → ${t.connectionReference}: ${r.operation}`);
  }
  if (t.kind === 'WorkflowTool') {
    const wf = provisioned.workflows.find((w) => w.oldId === t.workflowId || w.workflowId === t.workflowId) || { workflowId: t.workflowId };
    const r = await linkComponentWorkflow({ ...dv, component: comp, workflowId: wf.workflowId });
    console.log(`   tool.${t.name} → flow ${wf.workflowId}: ${r.operation}`);
  }
}
if (keepExtra) {
  console.log('   --keep-extra-components: leaving undeclared components in place');
} else {
  const removed = await deleteStaleComponents({ ...dv, botId: bot.botid, keep: expected.map((e) => e.schemaName) });
  console.log(removed.length ? `   removed ${removed.length} stale component(s): ${removed.map((r) => `${r.schemaName.replace(`${schemaName}.`, '')} (${r.kind})`).join(', ')}` : '   no stale components');
}

step('9/10 publish (retries while the new bot is still provisioning)');
pac(['copilot', 'publish', '--bot', bot.botid, '--environment', environment], { retries: 14, delayMs: 30000 });

step('10/10 verify the live record');
// A long publish wait can leave the keep-alive socket dead (EPIPE on the next fetch): retry the read-back.
const info = await retry(() => assertHarnessAgent({ environmentUrl: environment, schemaName, getDataverseToken: getToken, fetchImpl: fetchRetry, requireInstructions: true, requirePublished: true }), 4, 10000);
if (info.instructionChars !== instructions.length) fail(`Instructions on the live record are ${info.instructionChars} chars, expected ${instructions.length}.`);
components = await retry(() => listBotComponents({ ...dv, botId: info.bot.botid }), 4, 10000);
const liveByName = new Map(components.map((c) => [c.schemaName.toLowerCase(), c]));
for (const e of expected) {
  const c = liveByName.get(e.schemaName.toLowerCase());
  if (!c) fail(`Component ${e.schemaName} from the workspace is missing on the live record.`);
  if (e.kind && c.kind !== e.kind) fail(`Component ${e.schemaName} is ${c.kind} on the live record, expected ${e.kind}.`);
  if (c.kind === 'ConnectorTool' && !c.connectionReferences.length) fail(`ConnectorTool ${e.schemaName} has no connection reference on the live record.`);
  if (c.kind === 'WorkflowTool' && !c.workflows.some((w) => w.statecode === 1)) fail(`WorkflowTool ${e.schemaName} is not linked to an activated flow.`);
}
const extra = components.filter((c) => !expected.some((e) => e.schemaName.toLowerCase() === c.schemaName.toLowerCase()));
const envId = environmentIdFor(environment);
console.log('\nDEPLOYED (GitHub Copilot harness)');
console.log(`  schemaName   ${schemaName}`);
console.log(`  botId        ${info.bot.botid}`);
console.log(`  template     ${info.template}   recognizer ${info.recognizer}   model ${info.model}`);
console.log(`  instructions ${info.instructionChars} chars   published ${info.bot.publishedon}`);
console.log(`  components   ${components.length}:`);
for (const c of components) {
  const links = [...c.connectionReferences.map((r) => `→ ${r.logicalName}`), ...c.workflows.map((w) => `→ flow ${w.name}${w.statecode === 1 ? '' : ' (NOT activated)'}`)];
  console.log(`    ${c.kind.padEnd(16)} ${c.schemaName.replace(`${schemaName}.`, '')}${links.length ? '   ' + links.join(', ') : ''}${extra.includes(c) ? '   (not in workspace)' : ''}`);
}
if (provisioned.connectionReferences.length) console.log(`  references   ${provisioned.connectionReferences.map((r) => `${r.logicalName} (${r.operation})`).join(', ')}`);
if (provisioned.workflows.length) console.log(`  flows        ${provisioned.workflows.map((w) => `${w.name} (${w.operation}, ${w.workflowId})`).join(', ')}`);
if (envId) console.log(`  maker        https://copilotstudio.microsoft.com/environments/${envId}/agents/${info.bot.botid}`);
if (envId) console.log(`  chat         COPILOT_ENVIRONMENT_ID=${envId} COPILOT_SCHEMA_NAME=${schemaName} ENTRA_CLIENT_ID=<app with CopilotStudio.Copilots.Invoke> ENTRA_TENANT_ID=<tenant> npm run example:studio-3p`);

// ---------------------------------------------------------------------------
function deferWorkflowTools(dir, deferredDir) {
  const names = [];
  const toolsDir = join(dir, 'capabilities', 'tools');
  if (existsSync(toolsDir)) {
    for (const f of readdirSync(toolsDir).filter((f) => f.endsWith('.mcs.yml')).sort()) {
      const src = join(toolsDir, f);
      if (/^kind:\s*WorkflowTool\s*$/m.test(readFileSync(src, 'utf8'))) {
        mkdirSync(join(deferredDir, 'capabilities', 'tools'), { recursive: true });
        cpSync(src, join(deferredDir, 'capabilities', 'tools', f)); rmSync(src); names.push(f.replace(/\.mcs\.yml$/, ''));
      }
    }
  }
  const wf = join(dir, 'workflows');
  if (existsSync(wf)) { cpSync(wf, join(deferredDir, 'workflows'), { recursive: true }); rmSync(wf, { recursive: true, force: true }); }
  return names;
}
function mergeDeferred(deferredDir, synced) {
  const changed = [];
  const toolsDir = join(deferredDir, 'capabilities', 'tools');
  if (existsSync(toolsDir)) {
    for (const f of readdirSync(toolsDir).filter((f) => f.endsWith('.mcs.yml')).sort()) {
      const src = readFileSync(join(toolsDir, f), 'utf8');
      const dst = join(synced, 'capabilities', 'tools', f);
      if (!existsSync(dst) || readFileSync(dst, 'utf8').replace(/^\uFEFF/, '').trim() !== src.replace(/^\uFEFF/, '').trim()) { mkdirSync(join(synced, 'capabilities', 'tools'), { recursive: true }); writeFileSync(dst, src); changed.push(`capabilities/tools/${f}`); }
    }
  }
  const wfDir = join(deferredDir, 'workflows');
  if (existsSync(wfDir)) {
    for (const folder of readdirSync(wfDir).filter((f) => statSync(join(wfDir, f)).isDirectory()).sort()) {
      const id = (folder.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) || [])[0];
      const already = existsSync(join(synced, 'workflows')) && readdirSync(join(synced, 'workflows')).some((f) => id && f.toLowerCase().endsWith(id.toLowerCase()));
      if (!already) { cpSync(join(wfDir, folder), join(synced, 'workflows', folder), { recursive: true }); changed.push(`workflows/${folder}`); }
    }
  }
  return changed;
}
function parseSettings(text) {
  // Minimal reader for the three agentSettings fields we re-apply after import (pac pack drops them).
  const out = {};
  const seg = text.match(/segments:\s*\n\s*-\s*kind:\s*StaticSegment\s*\n\s*value:\s*\|-?\s*\n([\s\S]*?)(?=\n\s{0,4}\S)/);
  if (seg) { const lines = seg[1].split('\n'); const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length)); out.instructions = lines.map((l) => l.slice(indent)).join('\n'); }
  const g = text.match(/^\s*greetingText:\s*(.+)$/m); if (g) out.greetingText = g[1].trim().replace(/^["']|["']$/g, '');
  const cs = [...text.matchAll(/-\s*title:\s*(.+)\n\s*text:\s*(.+)/g)].map((m) => ({ title: m[1].trim().replace(/^["']|["']$/g, ''), text: m[2].trim().replace(/^["']|["']$/g, '') }));
  if (cs.length) out.conversationStarters = cs;
  return out;
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; out[k] = v; }
  }
  return out;
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function findFiles(dir, name) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, e.name); if (e.isDirectory()) out.push(...findFiles(full, name)); else if (e.name === name) out.push(full); }
  return out;
}
function tool(cmd, argv) {
  // Windows: pac is pac.exe (found by spawnSync), az is az.cmd (needs a shell). Try both ways.
  const r = spawnSync(cmd, argv, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: !r.error && r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim(), error: r.error };
}
function preflight() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) fail(`Node ${process.versions.node} is too old: this script needs Node 20.19+ or 22.12+ (https://nodejs.org).`);
  const pacv = tool('pac', ['help']);
  if (!pacv.ok) fail('Power Platform CLI (pac) is not on PATH. Install: dotnet tool install --global Microsoft.PowerApps.CLI.Tool (https://aka.ms/PowerPlatformCLI), then pac auth create --environment <url>.');
  const version = (pacv.out.match(/Version:\s*([\d.]+)/) || [])[1] || pacv.out.split('\n')[0];
  const auth = tool('pac', ['auth', 'list']);
  if (!auth.ok || !/\*/.test(auth.out)) fail('No active pac auth profile. Run: pac auth create --environment <environment url> (then pac auth select --index N).');
  if (!args['token-command']) {
    const az = tool('az', ['--version']);
    if (!az.ok) fail('Azure CLI (az) is not on PATH and no --token-command was given. Install https://aka.ms/azure-cli and run az login as the same user as the pac profile, or pass --token-command "<command that prints a Dataverse bearer token>".');
  }
  let token = '';
  try { token = execSync(tokenCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { fail(`The token command failed: ${tokenCommand}\n   ${String(e.stderr || e.message).trim().split('\n').slice(-2).join(' ')}\n   Sign in first (az login --tenant <tenant of the environment>) or pass --token-command.`); }
  if (!/^ey/.test(token)) fail(`The token command did not print a bearer token: ${tokenCommand}`);
  console.log(`   node ${process.versions.node}, pac ${version}, token command ok (${tokenCommand.split(' ')[0]})`);
}
async function retry(fn, attempts, delayMs) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const transient = /fetch failed|EPIPE|ECONNRESET|ETIMEDOUT|socket hang up|HTTP 5\d\d|HTTP 429/.test(String(e?.message || e) + String(e?.cause?.message || e?.cause?.code || ''));
      if (!transient || i >= attempts) throw e;
      console.log(`   transient failure (${e?.cause?.code || e?.message?.slice(0, 60)}); retrying in ${delayMs / 1000}s`);
      sleepSync(delayMs);
    }
  }
}
function step(label) { console.log(`\n▶ ${label}`); }
function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
function pac(argv, { retries = 0, delayMs = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync('pac', argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const failed = r.status !== 0 || /non-recoverable error|Error:/.test(out);
    // pac 2.10.1 `copilot publish` dies with "Invalid response format" while Dataverse is still provisioning a freshly imported bot.
    if (failed && attempt < retries) { console.log(`   attempt ${attempt + 1} failed; retrying in ${delayMs / 1000}s`); sleepSync(delayMs); continue; }
    const lines = out.split('\n').filter((l) => l.trim() && !/^Processing asynchronous/.test(l) && !/Online documentation|Feedback, Suggestions|^Microsoft PowerPlatform CLI|^Version:/.test(l));
    const reasons = lines.filter((l) => /reason given|FAILURE|already exists|must contain/i.test(l));
    console.log(`   ${[...new Set([...lines.slice(-4), ...reasons])].join('\n   ')}`);
    if (failed) fail(`pac ${argv.slice(0, 2).join(' ')} failed (exit ${r.status}).`);
    return;
  }
}
function environmentIdFor(envUrl) {
  const r = spawnSync('pac', ['org', 'who', '--environment', envUrl], { encoding: 'utf8' });
  const m = ((r.stdout || '') + (r.stderr || '')).match(/Environment ID\s*:?\s*([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}
