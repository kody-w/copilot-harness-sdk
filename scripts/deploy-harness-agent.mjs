#!/usr/bin/env node
// Deploy a Copilot Studio agent that can ONLY be a GitHub Copilot harness agent.
//
// The exact sequence that was proven live on 2026-09-07 (kodyv8, pac 2.10.1):
//   1. pac copilot init --authoring-mode cli-copilot        → template cliagent-1.0.0, CLICopilotRecognizer
//   2. pac copilot pack                                     → solution zip (pac 2.10.1 writes <language>0</language>; fixed here)
//   3. guard: refuse the zip unless bot.xml says template=cliagent-*
//   4. pac solution import --async --force-overwrite
//   5. PATCH bots(<id>).configuration with the instructions  (pac push drops agentSettings.instructions in 2.10.1)
//   6. pac copilot publish --bot <schemaName>
//   7. read the live record back and assert harness + instructions present
//
// Usage:
//   node scripts/deploy-harness-agent.mjs --name "My Agent" --publisher-prefix cr8c1 \
//     --instructions-file ./instructions.md --environment https://org.crm.dynamics.com/ [--schema-name cr8c1_MyAgent] \
//     [--model Sonnet46] [--language 1033] [--solution-name MyAgentHarness] [--work-dir ./.deploy]
//
// Token for step 5/7: `az account get-access-token --resource <environment>` (same user as the pac auth profile).
// Override with --token-command "<shell command that prints a bearer token>".
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { assertHarnessAgent, classifyBot, HARNESS_TEMPLATE } from '../src/harness-guard.js';

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
if (args['authoring-mode'] && args['authoring-mode'] !== 'cli-copilot') {
  console.error(`Refusing --authoring-mode ${args['authoring-mode']}: this script only produces GitHub Copilot harness agents.`);
  process.exit(3);
}
let instructions = instructionsFile ? readFileSync(instructionsFile, 'utf8').trim() : '';

const projectDir = join(workDir, 'workspace');
const outDir = join(workDir, 'out');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const workspaceDir = args['workspace-dir'] ? resolve(args['workspace-dir']) : null;
if (workspaceDir) {
  step('1/7 copy pre-authored harness workspace');
  if (!existsSync(join(workspaceDir, 'settings.mcs.yml'))) fail(`${workspaceDir} has no settings.mcs.yml`);
  cpSync(workspaceDir, projectDir, { recursive: true, filter: (src) => !/\/\.mcs(\/|$)/.test(src) });
  console.log(`   ${workspaceDir}`);
} else {
  step('1/7 scaffold harness workspace');
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
writeFileSync(settingsPath, settings);
const settingsDoc = parseSettings(settings);
if (!instructions) instructions = (settingsDoc.instructions || '').trim();
if (!instructions) fail('No instructions: pass --instructions-file or put them in settings.mcs.yml');
const greetingText = settingsDoc.greetingText;
const conversationStarters = settingsDoc.conversationStarters;

// pac 2.10.1 `pack` cannot resolve a WorkflowTool's flow from an init-style workspace ("workflow link(s) without typed workflow(s)");
// those tools plus the workflows/ folder are pushed after import through a cloned (synced) workspace instead.
const deferredDir = join(workDir, 'deferred');
const deferred = deferWorkflowTools(projectDir, deferredDir);
if (deferred.length) console.log(`   deferred for push after import: ${deferred.join(', ')}`);

step('2/7 pack solution');
pac(['copilot', 'pack', '--publisher-prefix', publisherPrefix, '--project-dir', projectDir, '--solution-name', solutionName, '--output-path', outDir]);
const zipPath = join(outDir, `${solutionName}.zip`);
if (!existsSync(zipPath)) fail(`pack did not produce ${zipPath}`);

step('3/7 guard the packed solution');
const unpacked = join(outDir, 'unpacked');
sh('unzip', ['-q', '-o', zipPath, '-d', unpacked]);
const botXmlPath = execSync(`find "${unpacked}/bots" -name bot.xml`, { encoding: 'utf8' }).trim().split('\n')[0];
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
sh('zip', ['-q', '-r', fixedZip, '.'], unpacked);
console.log(`   template=${template} ✓`);

step('4/7 import solution');
// Dataverse serialises solution operations per environment: "another [PublishAll] running" → wait and retry.
pac(['solution', 'import', '--path', fixedZip, '--async', '--force-overwrite', '--environment', environment], { retries: 6, delayMs: 30000 });

if (deferred.length) {
  step('4b/7 push deferred workflow tools through a synced clone');
  const cloneRoot = join(workDir, 'clone');
  rmSync(cloneRoot, { recursive: true, force: true }); mkdirSync(cloneRoot, { recursive: true });
  pac(['copilot', 'clone', '--bot', schemaName, '--environment', environment, '--output-dir', cloneRoot, '--display-name', 'synced'], { retries: 4, delayMs: 15000 });
  const synced = join(cloneRoot, 'synced');
  cpSync(deferredDir, synced, { recursive: true });
  pac(['copilot', 'push', '--project-dir', synced], { retries: 4, delayMs: 15000 });
}

step('5/7 write instructions to the live record');
const getToken = async () => execSync(tokenCommand, { encoding: 'utf8' }).trim();
const token = await getToken();
const api = `${environment}api/data/v9.2/`;
const lookup = await fetch(`${api}bots?$filter=schemaname eq '${schemaName}'&$select=botid,template,configuration`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
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
const patch = await fetch(`${api}bots(${bot.botid})`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'If-Match': '*' },
  body: JSON.stringify({ configuration: JSON.stringify(configuration) })
});
if (!patch.ok) fail(`PATCH configuration failed: HTTP ${patch.status} ${await patch.text()}`);

step('6/7 publish (retries while the new bot is still provisioning)');
pac(['copilot', 'publish', '--bot', schemaName, '--environment', environment], { retries: 14, delayMs: 30000 });

step('7/7 verify the live record');
const info = await assertHarnessAgent({ environmentUrl: environment, schemaName, getDataverseToken: getToken, requireInstructions: true, requirePublished: true });
if (info.instructionChars !== instructions.length) fail(`Instructions on the live record are ${info.instructionChars} chars, expected ${instructions.length}.`);
const comps = await fetch(`${api}botcomponents?$filter=_parentbotid_value eq ${info.bot.botid}&$select=schemaname,componenttype,statecode`, { headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' } }).then((r) => r.json());
const expected = [...countWorkspaceComponents(projectDir), ...deferred];
const live = (comps.value || []).map((c) => c.schemaname.replace(`${schemaName}.`, ''));
console.log(`   components on the live record: ${live.length} (${live.join(', ') || 'none'})`);
for (const e of expected) if (!live.some((l) => l.endsWith(e))) fail(`Component ${e} from the workspace is missing on the live record.`);
const envId = environmentIdFor(environment);
console.log('\nDEPLOYED (GitHub Copilot harness)');
console.log(`  schemaName   ${schemaName}`);
console.log(`  botId        ${info.bot.botid}`);
console.log(`  template     ${info.template}   recognizer ${info.recognizer}   model ${info.model}`);
console.log(`  instructions ${info.instructionChars} chars   published ${info.bot.publishedon}`);
console.log(`  components   ${live.length}: ${live.join(', ') || 'none'}`);
if (envId) console.log(`  maker        https://copilotstudio.microsoft.com/environments/${envId}/agents/${info.bot.botid}`);

// ---------------------------------------------------------------------------
function deferWorkflowTools(dir, deferredDir) {
  const names = [];
  const toolsDir = join(dir, 'capabilities', 'tools');
  if (existsSync(toolsDir)) {
    for (const f of execSync(`ls "${toolsDir}"`, { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.mcs.yml'))) {
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
function countWorkspaceComponents(dir) {
  const names = [];
  for (const sub of ['capabilities/tools', 'capabilities/knowledge', 'behaviors']) {
    const d = join(dir, sub); if (!existsSync(d)) continue;
    for (const f of execSync(`ls "${d}"`, { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.mcs.yml'))) names.push(f.replace(/\.mcs\.yml$/, ''));
  }
  return names;
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; out[k] = v; }
  }
  return out;
}
function sh(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd });
  if (r.status !== 0) fail(`${cmd} ${argv.join(' ')} failed: ${r.stderr || r.stdout}`);
}
function step(label) { console.log(`\n▶ ${label}`); }
function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
function pac(argv, { retries = 0, delayMs = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync('pac', argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const failed = r.status !== 0 || /non-recoverable error|Error:/.test(out);
    // pac 2.10.1 `copilot publish` dies with "Invalid response format" while Dataverse is still provisioning a freshly imported bot.
    if (failed && attempt < retries) { console.log(`   attempt ${attempt + 1} failed; retrying in ${delayMs / 1000}s`); spawnSync('sleep', [String(delayMs / 1000)]); continue; }
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
