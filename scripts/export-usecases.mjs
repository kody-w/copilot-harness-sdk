#!/usr/bin/env node
// Export the deployed solution of every use case (parent + child) as the reference .zip people
// compare their own deployments against:  usecases/<slug>/exports/<SolutionName>.zip
//
//   node scripts/export-usecases.mjs [--only <slug>]
//
// Components that were pushed after import (the WorkflowTool goes through `pac copilot push`) are
// added to the agent's solution first, so the export is the complete agent, not just what `pack` carried.
import { readFileSync, mkdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'usecases/usecases.json'), 'utf8'));
// Real environment identity lives in usecases/usecases.local.json (gitignored); usecases.json ships placeholders.
{ const localPath = join(root, 'usecases/usecases.local.json'); if (existsSync(localPath)) { const local = JSON.parse(readFileSync(localPath, 'utf8')); Object.assign(cfg, local, { shared: { ...cfg.shared, environmentMcp: { ...cfg.shared?.environmentMcp, ...local.shared?.environmentMcp } } }); } }
if (/<org>|<environment-id>|YourSolution/.test(`${cfg.environmentUrl}${cfg.environmentId}${cfg.shared?.environmentMcp?.connectionReference}`)) { console.error('usecases.json holds placeholders. Put your environmentUrl, environmentId and connection reference in usecases/usecases.local.json (see usecases/README.md).'); process.exit(2); }
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const env = cfg.environmentUrl.replace(/\/+$/, '');
const api = `${env}/api/data/v9.2/`;
const token = () => execSync(`az account get-access-token --resource ${env} --query accessToken -o tsv`, { encoding: 'utf8' }).trim();
const dv = async (path, init = {}) => {
  const res = await fetch(api + path, { ...init, headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json', 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
};
const solutionNameFor = (schemaName) => `${schemaName.replace(/[^A-Za-z0-9]/g, '')}Harness`.slice(0, 49);
const botcomponentTypeCode = (await dv(`EntityDefinitions(LogicalName='botcomponent')?$select=ObjectTypeCode`)).ObjectTypeCode;
const connectorTypeCode = (await dv(`EntityDefinitions(LogicalName='connector')?$select=ObjectTypeCode`)).ObjectTypeCode;
async function ensureInSolution(objectId, componentType, solution) {
  const rows = (await dv(`solutioncomponents?$filter=objectid eq ${objectId}&$select=solutioncomponentid&$expand=solutionid($select=uniquename)`)).value || [];
  if (rows.some((r) => r.solutionid.uniquename === solution)) return false;
  await dv('AddSolutionComponent', { method: 'POST', body: JSON.stringify({ ComponentId: objectId, ComponentType: componentType, SolutionUniqueName: solution, AddRequiredComponents: false }) });
  return true;
}

for (const u of cfg.usecases) {
  if (only && u.slug !== only) continue;
  const proof = JSON.parse(readFileSync(join(root, 'usecases', u.slug, 'proof.json'), 'utf8'));
  const outDir = join(root, 'usecases', u.slug, 'exports');
  mkdirSync(outDir, { recursive: true });
  for (const schemaName of [proof.childSchemaName, proof.schemaName]) {
    const solution = solutionNameFor(schemaName);
    const bot = (await dv(`bots?$filter=schemaname eq '${schemaName}'&$select=botid`)).value?.[0];
    if (!bot) { console.error(`✖ ${schemaName}: no live bot`); continue; }
    // bring every component of the bot into its solution (no-op for the ones the import created)
    const comps = (await dv(`botcomponents?$filter=_parentbotid_value eq ${bot.botid}&$select=botcomponentid,schemaname,data`)).value || [];
    let added = 0;
    for (const c of comps) {
      if (await ensureInSolution(c.botcomponentid, botcomponentTypeCode, solution)) added++;
      // a tool bound to a custom connector can only be exported when the connector is in the solution too
      const connectorId = (String(c.data || '').match(/^connectorId:\s*\S+\/apis\/(\S+)/m) || [])[1];
      if (connectorId) {
        const custom = (await dv(`connectors?$filter=connectorinternalid eq '${connectorId}'&$select=connectorid`)).value?.[0];
        if (custom) {
          if (await ensureInSolution(custom.connectorid, connectorTypeCode, solution)) added++;
          // export also requires the connection reference's CustomConnectorId lookup to point at the connector
          const refName = (String(c.data || '').match(/^connectionReference:\s*(\S+)/m) || [])[1];
          const ref = refName && (await dv(`connectionreferences?$filter=connectionreferencelogicalname eq '${refName}'&$select=connectionreferenceid,_customconnectorid_value`)).value?.[0];
          if (ref && !ref._customconnectorid_value) {
            await dv(`connectionreferences(${ref.connectionreferenceid})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: JSON.stringify({ 'CustomConnectorId@odata.bind': `/connectors(${custom.connectorid})` }) });
            console.log(`   linked connection reference ${refName} → connector ${custom.connectorid}`);
          }
        }
      }
    }
    const target = join(outDir, `${solution}.zip`);
    rmSync(target, { force: true });
    const r = spawnSync('pac', ['solution', 'export', '--name', solution, '--path', target, '--environment', env, '--overwrite'], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(target)) { console.error(`✖ ${solution}: ${(r.stdout + r.stderr).split('\n').filter((l) => /Error|error/.test(l)).join(' | ')}`); continue; }
    console.log(`✔ ${u.slug}: ${solution}.zip (${comps.length} components, ${added} added to the solution before export)`);
  }
}
