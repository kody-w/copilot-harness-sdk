#!/usr/bin/env node
// Remove custom-connector definitions (Connector/*: OpenAPI, connection parameters, policy templates,
// custom code blobs) from exported solution zips before they are committed as reference exports.
// The reference is for comparing agents, and the connectors belong to whoever built the MCP server;
// bring your own connector and point usecases.json at its connection reference.
//
//   node scripts/strip-connector-code.mjs usecases/*/exports/*.zip
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

for (const zip of process.argv.slice(2).map((z) => resolve(z))) {
  const entries = execSync(`unzip -Z1 "${zip}"`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const connectorEntries = entries.filter((e) => /^Connector\//.test(e));
  if (!connectorEntries.length) { console.log(`- ${zip}: no connector files`); continue; }
  const dir = mkdtempSync(join(tmpdir(), 'strip-'));
  try {
    execSync(`unzip -q -o "${zip}" -d "${dir}"`);
    rmSync(join(dir, 'Connector'), { recursive: true, force: true });
    // keep solution.xml honest: drop the connector root components it no longer carries
    const solXml = join(dir, 'solution.xml');
    if (existsSync(solXml)) writeFileSync(solXml, readFileSync(solXml, 'utf8').replace(/\s*<RootComponent type="372"[^>]*\/>/g, ''));
    const ct = join(dir, '[Content_Types].xml');
    if (existsSync(ct)) writeFileSync(ct, readFileSync(ct, 'utf8').replace(/<Default Extension="csx"[^>]*\/>/g, ''));
    rmSync(zip);
    execSync(`cd "${dir}" && zip -q -r -X "${zip}" .`);
    console.log(`✔ ${zip}: removed ${connectorEntries.length} connector file(s)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
