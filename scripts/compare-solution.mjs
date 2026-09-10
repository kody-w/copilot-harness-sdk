#!/usr/bin/env node
// Compare a Copilot Studio solution export (or a live agent) with the reference export shipped
// under usecases/<slug>/exports/. Fails (exit 1) when the harness template, recognizer, model or
// the component set differ, so it doubles as the regression check after SDK changes.
//
//   node scripts/compare-solution.mjs --reference usecases/<slug>/exports/<Solution>.zip --zip my-export.zip
//   node scripts/compare-solution.mjs --reference usecases/<slug>/exports/<Solution>.zip --live <schemaName> --environment-url https://<org>.crm.dynamics.com/
//   node scripts/compare-solution.mjs --all [--environment-url …]        # every use case, live vs reference
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { classifyBot, listComponents, inspectAgentHarness } from '../index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);

/** Read a solution zip into { bot: {schemaname,template,configuration}, components: [{name, kind}] }. */
export function readSolutionZip(zipPath) {
  const dir = mkdtempSync(join(tmpdir(), 'sol-'));
  try {
    execSync(`unzip -q -o "${zipPath}" -d "${dir}"`);
    const botsDir = join(dir, 'bots');
    const botFolder = existsSync(botsDir) ? readdirSync(botsDir)[0] : null;
    if (!botFolder) throw new Error(`${zipPath} has no bots/ folder`);
    const xml = readFileSync(join(botsDir, botFolder, 'bot.xml'), 'utf8');
    const template = (xml.match(/<template>([^<]+)<\/template>/) || [])[1] || '';
    const configuration = JSON.parse(readFileSync(join(botsDir, botFolder, 'configuration.json'), 'utf8'));
    const comps = [];
    const compsDir = join(dir, 'botcomponents');
    if (existsSync(compsDir)) {
      for (const f of readdirSync(compsDir)) {
        const dataPath = join(compsDir, f, 'data');
        const data = existsSync(dataPath) ? readFileSync(dataPath, 'utf8') : '';
        const kind = (data.match(/^kind:\s*(\S+)/m) || [])[1] || 'unknown';
        comps.push({ name: f.startsWith(`${botFolder}.`) ? f.slice(botFolder.length + 1) : f, kind });
      }
    }
    return { schemaName: botFolder, ...classifyBot({ template, configuration }), components: comps.sort((a, b) => a.name.localeCompare(b.name)) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function readLive(schemaName, environmentUrl) {
  const getDataverseToken = async () => execSync(`az account get-access-token --resource ${environmentUrl.replace(/\/+$/, '')} --query accessToken -o tsv`, { encoding: 'utf8' }).trim();
  const info = await inspectAgentHarness({ environmentUrl, schemaName, getDataverseToken });
  const comps = await listComponents({ environmentUrl, schemaName, getDataverseToken });
  return { schemaName, harness: info.harness, template: info.template, recognizer: info.recognizer, model: info.model, instructionChars: info.instructionChars, components: comps.map((c) => ({ name: c.name, kind: c.kind })).sort((a, b) => a.name.localeCompare(b.name)) };
}

export function compare(reference, candidate) {
  const problems = [];
  for (const k of ['harness', 'template', 'recognizer', 'model']) if (reference[k] !== candidate[k]) problems.push(`${k}: reference ${reference[k] || '?'} vs candidate ${candidate[k] || '?'}`);
  if (reference.instructionChars && !candidate.instructionChars) problems.push('candidate has no instructions');
  const key = (c) => `${c.kind}:${c.name}`;
  const ref = new Set(reference.components.map(key)), cand = new Set(candidate.components.map(key));
  for (const k of ref) if (!cand.has(k)) problems.push(`missing component ${k}`);
  for (const k of cand) if (!ref.has(k)) problems.push(`extra component ${k}`);
  return problems;
}

function report(label, reference, candidate) {
  const problems = compare(reference, candidate);
  console.log(`${problems.length ? '✖' : '✔'} ${label}: ${candidate.template} · ${candidate.recognizer} · ${candidate.model} · ${candidate.components.length} components${problems.length ? '\n   ' + problems.join('\n   ') : ''}`);
  return problems.length === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let ok = true;
  if (args.includes('--all')) {
    const cfg = JSON.parse(readFileSync(join(root, 'usecases/usecases.json'), 'utf8'));
    // Real environment identity lives in usecases/usecases.local.json (gitignored); usecases.json ships placeholders.
    { const localPath = join(root, 'usecases/usecases.local.json'); if (existsSync(localPath)) { const local = JSON.parse(readFileSync(localPath, 'utf8')); Object.assign(cfg, local, { shared: { ...cfg.shared, environmentMcp: { ...cfg.shared?.environmentMcp, ...local.shared?.environmentMcp } } }); } }
    if (/<org>|<environment-id>|YourSolution/.test(`${cfg.environmentUrl}${cfg.environmentId}${cfg.shared?.environmentMcp?.connectionReference}`)) { console.error('usecases.json holds placeholders. Put your environmentUrl, environmentId and connection reference in usecases/usecases.local.json (see usecases/README.md).'); process.exit(2); }
    const environmentUrl = opt('--environment-url') || cfg.environmentUrl;
    for (const u of cfg.usecases) {
      const proof = JSON.parse(readFileSync(join(root, 'usecases', u.slug, 'proof.json'), 'utf8'));
      for (const schemaName of [proof.schemaName, proof.childSchemaName]) {
        const refZip = join(root, 'usecases', u.slug, 'exports', `${schemaName.replace(/[^A-Za-z0-9]/g, '')}Harness`.slice(0, 49) + '.zip');
        if (!existsSync(refZip)) { console.log(`- ${schemaName}: no reference export at ${refZip}`); ok = false; continue; }
        ok = report(schemaName, readSolutionZip(refZip), await readLive(schemaName, environmentUrl)) && ok;
      }
    }
  } else {
    const reference = readSolutionZip(opt('--reference'));
    const candidate = opt('--zip') ? readSolutionZip(opt('--zip')) : await readLive(opt('--live'), opt('--environment-url'));
    ok = report(candidate.schemaName, reference, candidate);
  }
  process.exit(ok ? 0 : 1);
}
