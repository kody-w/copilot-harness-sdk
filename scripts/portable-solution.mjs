#!/usr/bin/env node
// Make a Copilot Studio solution zip portable, or localize a portable one for import.
//
//   node scripts/portable-solution.mjs strip  <in.zip> <out.zip> --org-url https://org.crm.dynamics.com/ [--hn-connector shared_new-5frapp...]
//   node scripts/portable-solution.mjs localize <in.zip> <out.zip> --org-url https://yourorg.crm.dynamics.com/ [--hn-connector <internal id>]
//
// strip replaces the environment's org URL (the memory tools name it in the instructions and tool data) and the custom
// connector's internal id with {{ORG_URL}} / {{HN_CONNECTOR}}; localize writes real values back so `pac solution import`
// accepts the package. Everything else in the zip is byte-identical. Text files only; binary entries pass through.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [mode, input, output, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, '')] = rest[i + 1];
if (!['strip', 'localize'].includes(mode) || !input || !output || !opts['org-url']) {
  console.error('usage: portable-solution.mjs strip|localize <in.zip> <out.zip> --org-url <url> [--hn-connector <internal id>]');
  process.exit(2);
}
const orgUrl = opts['org-url'].replace(/\/+$/, '') + '/';
const pairs = [[orgUrl, '{{ORG_URL}}'], [orgUrl.replace(/\/$/, ''), '{{ORG_URL_NO_SLASH}}']];
if (opts['hn-connector']) pairs.push([opts['hn-connector'], '{{HN_CONNECTOR}}']);
const work = mkdtempSync(join(tmpdir(), 'portable-'));
execFileSync('unzip', ['-q', '-o', input, '-d', work]);
const files = execFileSync('find', [work, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n');
let hits = 0;
for (const f of files) {
  const raw = readFileSync(f);
  if (raw.includes(0)) continue;                       // binary
  let text = raw.toString('utf8');
  const before = text;
  for (const [real, token] of pairs) text = mode === 'strip' ? text.split(real).join(token) : text.split(token).join(real);
  if (text !== before) { hits++; writeFileSync(f, text); }
}
rmSync(output, { force: true });
execFileSync('zip', ['-q', '-r', '-X', output, '.'], { cwd: work });
rmSync(work, { recursive: true, force: true });
const left = mode === 'strip' ? pairs.filter(([real]) => execFileSync('unzip', ['-p', output]).toString('latin1').includes(real)).map(([real]) => real) : [];
console.log(`${mode}: ${hits} file(s) rewritten → ${output}${left.length ? `\n  WARNING still present: ${left.join(', ')}` : ''}`);
process.exit(left.length ? 1 : 0);
