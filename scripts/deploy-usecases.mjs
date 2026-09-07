#!/usr/bin/env node
// Deploy every generated use case (child data agent first, then the parent with all components).
//   node scripts/deploy-usecases.mjs [--only <slug>] [--concurrency 3] [--log-dir <dir>]
// Each deploy is scripts/deploy-harness-agent.mjs, so the same guards apply: harness template or nothing.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'usecases/usecases.json'), 'utf8'));
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const concurrency = Number(argv.includes('--concurrency') ? argv[argv.indexOf('--concurrency') + 1] : 3);
const logDir = argv.includes('--log-dir') ? argv[argv.indexOf('--log-dir') + 1] : join(root, '.deploy', 'logs');
mkdirSync(logDir, { recursive: true });

function run(label, args) {
  return new Promise((resolve) => {
    const log = join(logDir, `${label}.log`);
    const chunks = [];
    const p = spawn('node', [join(root, 'scripts/deploy-harness-agent.mjs'), ...args], { cwd: root });
    p.stdout.on('data', (d) => chunks.push(d)); p.stderr.on('data', (d) => chunks.push(d));
    p.on('close', (code) => { writeFileSync(log, Buffer.concat(chunks)); resolve({ label, code, log }); });
  });
}

const jobs = cfg.usecases.filter((u) => !only || u.slug === only).map((u) => async () => {
  const proof = JSON.parse(readFileSync(join(root, 'usecases', u.slug, 'proof.json'), 'utf8'));
  const dir = join(root, 'usecases', u.slug);
  const child = await run(`${u.slug}.child`, ['--name', u.childDisplayName || `${u.name.replace(/ Copilot$/, '')} Data Agent`, '--publisher-prefix', cfg.publisherPrefix, '--schema-name', proof.childSchemaName, '--instructions-file', join(dir, 'child-instructions.md'), '--environment', cfg.environmentUrl, '--work-dir', join(root, '.deploy', `${u.slug}-child`)]);
  console.log(`${child.code === 0 ? '✔' : '✖'} ${child.label} (exit ${child.code}) → ${child.log}`);
  if (child.code !== 0) return { slug: u.slug, ok: false, stage: 'child' };
  const parent = await run(`${u.slug}.parent`, ['--name', u.name, '--publisher-prefix', cfg.publisherPrefix, '--schema-name', proof.schemaName, '--workspace-dir', join(dir, 'agent'), '--environment', cfg.environmentUrl, '--work-dir', join(root, '.deploy', `${u.slug}-parent`)]);
  console.log(`${parent.code === 0 ? '✔' : '✖'} ${parent.label} (exit ${parent.code}) → ${parent.log}`);
  return { slug: u.slug, ok: parent.code === 0, stage: parent.code === 0 ? 'done' : 'parent' };
});

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (next < jobs.length) { const job = jobs[next++]; results.push(await job()); }
}));
console.log('\n' + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.slug}${r.ok ? '' : ` (${r.stage})`}`).join('\n'));
process.exit(results.every((r) => r.ok) ? 0 : 1);
