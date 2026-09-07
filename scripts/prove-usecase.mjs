#!/usr/bin/env node
// Prove a deployed GitHub Copilot harness agent through THIS SDK: open the /3p route with a
// delegated device-code token, send scripted turns, and check each answer against expectations.
//
//   node scripts/prove-usecase.mjs --spec usecases/vendor-contract-renewal/proof.json [--spec ...]
//
// env: ENTRA_CLIENT_ID, ENTRA_TENANT_ID, COPILOT_ENVIRONMENT_ID (or per-spec "environmentId").
// One device-code sign-in covers every spec passed in the same process.
//
// proof.json shape:
// {
//   "schemaName": "cr8c1_VendorContractRenewalCopilot",
//   "turns": [
//     { "prompt": "…", "expect": ["regex", "…"], "component": "knowledge" }
//   ]
// }
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { HarnessClient, createDeviceCodeTokenProvider, assertHarnessAgent, listComponents } from '../index.js';

const args = process.argv.slice(2);
const specs = [];
let out = null;
let environmentUrl = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--spec') specs.push(JSON.parse(readFileSync(args[++i], 'utf8')));
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--environment-url') environmentUrl = args[++i];
}
// Optional Dataverse pass (--environment-url): assert the live record is a harness agent and list its components before talking to it.
if (!specs.length) { console.error('Pass at least one --spec <proof.json>'); process.exit(2); }
const { ENTRA_CLIENT_ID, ENTRA_TENANT_ID, COPILOT_ENVIRONMENT_ID } = process.env;
if (!ENTRA_CLIENT_ID || !ENTRA_TENANT_ID) { console.error('Set ENTRA_CLIENT_ID and ENTRA_TENANT_ID'); process.exit(2); }

const getAccessToken = createDeviceCodeTokenProvider({
  clientId: ENTRA_CLIENT_ID, tenantId: ENTRA_TENANT_ID,
  onDeviceCode: (message) => { console.log(`\n${message}\n`); if (process.env.DEVICE_CODE_FILE) writeFileSync(process.env.DEVICE_CODE_FILE, String(message)); }
});

const results = [];
for (const spec of specs) {
  const environmentId = spec.environmentId || COPILOT_ENVIRONMENT_ID;
  console.log(`\n══ ${spec.schemaName}`);
  let components = null;
  if (environmentUrl) {
    const getDataverseToken = async () => execSync(`az account get-access-token --resource ${environmentUrl.replace(/\/+$/, "")} --query accessToken -o tsv`, { encoding: 'utf8' }).trim();
    const info = await assertHarnessAgent({ environmentUrl, schemaName: spec.schemaName, getDataverseToken, requireInstructions: true, requirePublished: true });
    components = await listComponents({ environmentUrl, schemaName: spec.schemaName, getDataverseToken });
    console.log(`   harness ✓ ${info.template} · ${info.model} · ${info.instructionChars} chars · components: ${components.map((c) => `${c.name} (${c.kind})`).join(', ')}`);
  }
  const client = await HarnessClient.create({ mode: 'copilot-studio-3p', turnTimeoutMs: spec.turnTimeoutMs || 180000, copilotStudio: { environmentId, schemaName: spec.schemaName, getAccessToken } });
  const pre = await client.preflight();
  console.log(`   preflight ${pre.status} in ${pre.elapsedMs} ms`);
  const session = await client.createSession({ sessionId: `prove-${spec.schemaName}-${Date.now()}` });
  const rec = { schemaName: spec.schemaName, preflight: pre.status, components, turns: [] };
  for (const t of spec.turns) {
    const started = Date.now();
    let text = '', events = [], error = null;
    try { ({ text, events } = await session.send(t.prompt)); } catch (e) { error = e.message; }
    const kinds = [...new Set(events.map((e) => e.type))];
    const rawTypes = [...new Set(events.filter((e) => e.type === 'raw').map((e) => e.raw?.type || e.raw?.activity?.type || e.raw?.valueType || '?'))];
    const expect = (t.expect || []).map((rx) => ({ rx, ok: new RegExp(rx, 'i').test(text) }));
    const ok = !error && expect.every((e) => e.ok);
    rec.turns.push({ component: t.component, prompt: t.prompt, ok, error, expect, elapsedMs: Date.now() - started, eventKinds: kinds, rawTypes, text });
    console.log(`\n   [${ok ? 'PASS' : 'FAIL'}] ${t.component || ''} · ${t.prompt}`);
    if (error) console.log(`   error: ${error}`);
    for (const e of expect) if (!e.ok) console.log(`   missing: /${e.rx}/i`);
    console.log('   ' + text.replace(/\s+/g, ' ').slice(0, 420));
  }
  await client.close();
  results.push(rec);
}
const summary = results.map((r) => `${r.schemaName}: ${r.turns.filter((t) => t.ok).length}/${r.turns.length} turns passed`);
console.log('\n' + summary.join('\n'));
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.turns.every((t) => t.ok)) ? 0 : 1);
