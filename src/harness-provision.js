// @ts-check
/**
 * Infrastructure provisioning for a GitHub Copilot harness workspace, the pattern that makes an
 * agent "come out looking like the pilot": every ConnectorTool bound to an agent-scoped connection
 * reference (`<schemaName>.cr.<suffix>`), every WorkflowTool bound to an agent flow that exists and
 * is activated, custom connectors verified in the environment, components linked to their
 * references on the live record, and stale components removed. Everything is a plain Dataverse Web
 * API call plus edits to the workspace files, so `pac copilot pack` / `push` find every record they
 * reference. Proven live on 2026-09-10 (kodyv8, `aibast_BrainstemCore`).
 *
 * Every Dataverse function takes `{ environmentUrl, getDataverseToken, fetchImpl? }` like the guard
 * and admin modules.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { dataverse } from './harness-admin.js';

/** @typedef {{ environmentUrl: string, getDataverseToken: () => Promise<string>, fetchImpl?: typeof fetch }} DataverseOptions */

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Agent-scoped connection reference names as Copilot Studio / pac write them. */
export const AGENT_SCOPED_REF = /^([A-Za-z0-9_]+)\.cr\.(.+)$/;
const odataQuote = (s) => String(s).replace(/'/g, "''");
const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

// ---------------------------------------------------------------------------------------------
// Workspace scanning and rebinding (pure file operations; unit-tested offline)

function listYaml(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.mcs.yml')).sort() : [];
}
function yamlValue(text, key) {
  const m = text.match(new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

/**
 * Read what the workspace binds to: tools by kind, connection references (from tool YAMLs, sync
 * files and workflow definitions) and workflows.
 * @param {string} dir workspace root (holds settings.mcs.yml)
 */
export function scanWorkspace(dir) {
  const tools = listYaml(join(dir, 'capabilities', 'tools')).map((file) => {
    const text = readFileSync(join(dir, 'capabilities', 'tools', file), 'utf8');
    return { file, name: file.replace(/\.mcs\.yml$/, ''), kind: yamlValue(text, 'kind'), connectionReference: yamlValue(text, 'connectionReference'), connectorId: yamlValue(text, 'connectorId'), workflowId: yamlValue(text, 'workflowId') };
  });
  const behaviors = listYaml(join(dir, 'behaviors')).map((file) => ({ file, name: file.replace(/\.mcs\.yml$/, ''), kind: yamlValue(readFileSync(join(dir, 'behaviors', file), 'utf8'), 'kind') }));
  const knowledge = listYaml(join(dir, 'capabilities', 'knowledge')).map((file) => ({ file, name: file.replace(/\.mcs\.yml$/, ''), kind: yamlValue(readFileSync(join(dir, 'capabilities', 'knowledge', file), 'utf8'), 'kind') }));
  /** @type {Map<string, { connectorId?: string, sources: string[] }>} */
  const refs = new Map();
  const addRef = (logical, connectorId, source) => {
    if (!logical) return;
    const cur = refs.get(logical) || { connectorId: undefined, sources: [] };
    if (connectorId && !cur.connectorId) cur.connectorId = connectorId;
    cur.sources.push(source);
    refs.set(logical, cur);
  };
  for (const t of tools) if (t.connectionReference) addRef(t.connectionReference, t.connectorId, `capabilities/tools/${t.file}`);
  const syncDir = join(dir, 'infrastructure', 'connections');
  if (existsSync(syncDir)) {
    for (const f of readdirSync(syncDir).filter((f) => f.endsWith('.sync.yaml'))) {
      const text = readFileSync(join(syncDir, f), 'utf8');
      addRef(yamlValue(text, 'connectionReferenceLogicalName'), yamlValue(text, 'connectorId'), `infrastructure/connections/${f}`);
    }
  }
  const workflows = [];
  const wfDir = join(dir, 'workflows');
  if (existsSync(wfDir)) {
    for (const folder of readdirSync(wfDir).filter((f) => statSync(join(wfDir, f)).isDirectory()).sort()) {
      const jsonFile = join(wfDir, folder, 'workflow.json');
      const metaFile = join(wfDir, folder, 'metadata.yml');
      if (!existsSync(jsonFile)) continue;
      const definition = JSON.parse(stripBom(readFileSync(jsonFile, 'utf8')));
      const meta = existsSync(metaFile) ? stripBom(readFileSync(metaFile, 'utf8')) : '';
      const id = yamlValue(meta, 'workflowId') || (folder.match(GUID) || [])[0];
      const connectionRefs = Object.entries(definition.properties?.connectionReferences || {}).map(([api, v]) => ({ api, logical: v?.connection?.connectionReferenceLogicalName }));
      for (const r of connectionRefs) addRef(r.logical, undefined, `workflows/${folder}/workflow.json`);
      workflows.push({ folder, id, name: yamlValue(meta, 'name') || folder.replace(/-[0-9a-f-]{36}$/i, ''), description: yamlValue(meta, 'description') || '', connectionRefs, definition, hasMetadata: !!meta });
    }
  }
  const customConnectors = [];
  const cDir = join(dir, 'connectors');
  if (existsSync(cDir)) {
    for (const folder of readdirSync(cDir).filter((f) => statSync(join(cDir, f)).isDirectory())) {
      const metaFile = join(cDir, folder, 'metadata.yml');
      const meta = existsSync(metaFile) ? JSON.parse(stripBom(readFileSync(metaFile, 'utf8'))) : {};
      customConnectors.push({ folder, connectorId: meta.connectorid, internalId: meta.connectorinternalid, name: meta.name, displayName: meta.displayname });
    }
  }
  return { tools, behaviors, knowledge, connectionRefs: refs, workflows, customConnectors };
}

/**
 * The agent-scoped name a reference gets on this agent: `<schemaName>.cr.<suffix>`. Shared,
 * environment-level references (no `.cr.` segment) are left alone.
 */
export function scopedReferenceName(logical, schemaName) {
  const m = AGENT_SCOPED_REF.exec(logical);
  if (!m) return logical;
  return `${schemaName}.cr.${m[2]}`;
}

function rewriteFile(file, edits) {
  let text = readFileSync(file, 'utf8');
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  let body = bom ? text.slice(1) : text;
  let changed = false;
  for (const [from, to] of edits) if (from !== to && body.includes(from)) { body = body.split(from).join(to); changed = true; }
  if (changed) writeFileSync(file, bom + body);
  return changed;
}

/**
 * Rebind every agent-scoped connection reference in the workspace to this agent's schema name:
 * tool YAMLs, `infrastructure/connections/*.sync.yaml` (content and file name) and workflow
 * definitions. Returns `{ old: new }` for the names that changed.
 * @param {string} dir
 * @param {string} schemaName
 */
export function rebindConnectionReferences(dir, schemaName) {
  const scan = scanWorkspace(dir);
  /** @type {Record<string, string>} */
  const mapping = {};
  for (const logical of scan.connectionRefs.keys()) {
    const scoped = scopedReferenceName(logical, schemaName);
    if (scoped !== logical) mapping[logical] = scoped;
  }
  const edits = Object.entries(mapping);
  if (!edits.length) return mapping;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (name === '.mcs' || name === 'node_modules') continue;
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(yml|yaml|json)$/.test(name)) continue;
      rewriteFile(full, edits);
      const renamed = edits.reduce((n, [from, to]) => n.split(from).join(to), name);
      if (renamed !== name) renameSync(full, join(d, renamed));
    }
  };
  walk(dir);
  return mapping;
}

/** RFC 4122 v5 UUID over the URL namespace: the same agent + workflow folder always gets the same id. */
export function workflowIdFor(schemaName, folder) {
  const base = String(folder).replace(/-[0-9a-f-]{36}$/i, '');
  const ns = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const h = createHash('sha1').update(Buffer.concat([ns, Buffer.from(`copilot-harness-sdk:${schemaName}:${base}`, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Give each workflow folder its final id: rename the folder, rewrite metadata.yml and every
 * WorkflowTool YAML that pointed at the old id. `resolveId(workflow)` returns the id to use.
 * @param {string} dir workspace root that holds `workflows/` and the WorkflowTool YAMLs
 * @param {(wf: { folder: string, id: string, name: string }) => string} resolveId
 */
export function rebindWorkflows(dir, resolveId) {
  const scan = scanWorkspace(dir);
  const out = [];
  for (const wf of scan.workflows) {
    const newId = resolveId(wf);
    const base = wf.folder.replace(/-[0-9a-f-]{36}$/i, '');
    const newFolder = `${base}-${newId}`;
    const from = join(dir, 'workflows', wf.folder);
    const to = join(dir, 'workflows', newFolder);
    if (wf.id && wf.id !== newId) {
      const edits = [[wf.id, newId], [`workflows/${wf.folder}/`, `workflows/${newFolder}/`]];
      for (const f of ['metadata.yml', 'workflow.json']) if (existsSync(join(from, f))) rewriteFile(join(from, f), edits);
      for (const t of scan.tools) if (t.kind === 'WorkflowTool' && t.workflowId === wf.id) rewriteFile(join(dir, 'capabilities', 'tools', t.file), [[wf.id, newId]]);
      if (from !== to) renameSync(from, to);
    }
    out.push({ ...wf, folder: wf.id && wf.id !== newId ? newFolder : wf.folder, oldId: wf.id, id: newId });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dataverse operations

/** @param {DataverseOptions & { schemaName: string }} opts */
export async function findBot(opts) {
  const { body } = await dataverse(opts)(`bots?$filter=schemaname eq '${odataQuote(opts.schemaName)}'&$select=botid,name,schemaname,template,publishedon`);
  return body.value?.[0] || null;
}

/** @param {DataverseOptions & { logicalName: string }} opts */
export async function findConnectionReference(opts) {
  const { body } = await dataverse(opts)(`connectionreferences?$filter=connectionreferencelogicalname eq '${odataQuote(opts.logicalName)}'&$select=connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid,connectionid`);
  return body.value?.[0] || null;
}

/**
 * Decide which connection a new agent-scoped reference should use. Precedence: an explicit
 * `connections` map (keyed by the scoped suffix, the connector id, or the source logical name),
 * then the connection of the reference the workspace came from, then any bound reference for the
 * same connector in this environment.
 * @param {DataverseOptions & { sourceLogicalName?: string, connectorId?: string, suffix?: string, connections?: Record<string, string> }} opts
 */
export async function resolveConnection(opts) {
  const map = opts.connections || {};
  for (const key of [opts.suffix, opts.connectorId, opts.sourceLogicalName]) if (key && map[key]) return { connectionId: map[key], connectorId: opts.connectorId, via: `connections[${key}]` };
  if (opts.sourceLogicalName) {
    const src = await findConnectionReference({ ...opts, logicalName: opts.sourceLogicalName });
    if (src?.connectionid) return { connectionId: src.connectionid, connectorId: src.connectorid || opts.connectorId, via: `source reference ${opts.sourceLogicalName}` };
  }
  if (opts.connectorId) {
    const { body } = await dataverse(opts)(`connectionreferences?$filter=connectorid eq '${odataQuote(opts.connectorId)}' and connectionid ne null&$select=connectionreferencelogicalname,connectionid,connectorid&$orderby=createdon asc&$top=1`);
    const row = body.value?.[0];
    if (row?.connectionid) return { connectionId: row.connectionid, connectorId: row.connectorid, via: `environment reference ${row.connectionreferencelogicalname}` };
  }
  return null;
}

/**
 * Create or update a connection reference bound to a connection.
 * @param {DataverseOptions & { logicalName: string, displayName?: string, connectorId: string, connectionId: string }} opts
 */
export async function ensureConnectionReference(opts) {
  const call = dataverse(opts);
  const body = { connectionreferencedisplayname: opts.displayName || opts.logicalName, connectionreferencelogicalname: opts.logicalName, connectorid: opts.connectorId, connectionid: opts.connectionId };
  const existing = await findConnectionReference(opts);
  if (existing) {
    const same = existing.connectionid === opts.connectionId && existing.connectorid === opts.connectorId;
    if (!same) await call(`connectionreferences(${existing.connectionreferenceid})`, { method: 'PATCH', body: JSON.stringify(body) });
    return { operation: same ? 'existing' : 'updated', id: existing.connectionreferenceid, ...body };
  }
  const { body: created, headers } = await call('connectionreferences', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  const id = created?.connectionreferenceid || (String(headers?.get?.('OData-EntityId') || '').match(GUID) || [])[0];
  return { operation: 'created', id, ...body };
}

/** @param {DataverseOptions & { connectorId: string }} opts connectorId = `/providers/Microsoft.PowerApps/apis/<internal id>` */
export async function connectorExists(opts) {
  const internal = String(opts.connectorId).split('/').pop();
  if (!/^shared_new-|^shared_.*-5f/i.test(internal) && !/^shared_[a-z0-9]+-[0-9a-f]{8}/i.test(internal)) return { custom: false, exists: true, internal };
  const { body } = await dataverse(opts)(`connectors?$filter=connectorinternalid eq '${odataQuote(internal)}'&$select=connectorid,name,displayname`);
  const row = body.value?.[0];
  return { custom: true, exists: !!row, internal, connectorId: row?.connectorid, displayName: row?.displayname };
}

/** @param {DataverseOptions & { workflowId: string }} opts */
export async function findWorkflow(opts) {
  const { body } = await dataverse(opts)(`workflows?$filter=workflowid eq ${opts.workflowId}&$select=workflowid,name,statecode,statuscode,category`);
  return body.value?.[0] || null;
}

/**
 * Create or update an agent flow from a workspace `workflow.json` and activate it.
 * @param {DataverseOptions & { workflowId: string, name: string, description?: string, definition: any }} opts
 */
export async function ensureWorkflow(opts) {
  const call = dataverse(opts);
  const clientdata = JSON.stringify(opts.definition);
  const existing = await findWorkflow(opts);
  const body = { name: opts.name, description: opts.description || '', clientdata };
  if (existing) {
    if (existing.statecode === 1) await call(`workflows(${opts.workflowId})`, { method: 'PATCH', body: JSON.stringify({ statecode: 0, statuscode: 1 }) });
    await call(`workflows(${opts.workflowId})`, { method: 'PATCH', body: JSON.stringify(body) });
  } else {
    await call('workflows', { method: 'POST', body: JSON.stringify({ workflowid: opts.workflowId, category: 5, type: 1, mode: 0, scope: 4, primaryentity: 'none', modernflowtype: 0, ...body }) });
  }
  await call(`workflows(${opts.workflowId})`, { method: 'PATCH', body: JSON.stringify({ statecode: 1, statuscode: 2 }) });
  return { operation: existing ? 'updated' : 'created', workflowId: opts.workflowId, name: opts.name };
}

/** @param {DataverseOptions & { botId: string }} opts */
export async function listBotComponents(opts) {
  const { body } = await dataverse(opts)(`botcomponents?$filter=_parentbotid_value eq ${opts.botId}&$select=botcomponentid,schemaname,name,componenttype,data&$expand=botcomponent_workflow($select=workflowid,name,statecode),botcomponent_connectionreference($select=connectionreferenceid,connectionreferencelogicalname)`);
  return (body.value || []).map((c) => ({ id: c.botcomponentid, schemaName: c.schemaname, displayName: c.name, componentType: c.componenttype, kind: (String(c.data || '').match(/^kind:\s*(\S+)/m) || [])[1] || 'unknown', workflows: (c.botcomponent_workflow || []).map((w) => ({ id: w.workflowid, name: w.name, statecode: w.statecode })), connectionReferences: (c.botcomponent_connectionreference || []).map((r) => ({ id: r.connectionreferenceid, logicalName: r.connectionreferencelogicalname })) }));
}

/**
 * Make a ConnectorTool component point at its connection reference on the live record (pac push
 * writes the YAML but leaves this association empty).
 * @param {DataverseOptions & { component: { id: string, connectionReferences: { id: string }[] }, logicalName: string }} opts
 */
export async function linkComponentConnectionReference(opts) {
  const ref = await findConnectionReference(opts);
  if (!ref) throw new Error(`Connection reference ${opts.logicalName} does not exist in ${opts.environmentUrl}.`);
  if (opts.component.connectionReferences.some((r) => r.id === ref.connectionreferenceid)) return { operation: 'existing', logicalName: opts.logicalName };
  const base = opts.environmentUrl.replace(/\/+$/, '') + '/api/data/v9.2/';
  await dataverse(opts)(`botcomponents(${opts.component.id})/botcomponent_connectionreference/$ref`, { method: 'POST', body: JSON.stringify({ '@odata.id': `${base}connectionreferences(${ref.connectionreferenceid})` }) });
  return { operation: 'linked', logicalName: opts.logicalName };
}

/**
 * Make a WorkflowTool component point at exactly its flow: add the link if missing, drop links to
 * other flows.
 * @param {DataverseOptions & { component: { id: string, workflows: { id: string }[] }, workflowId: string }} opts
 */
export async function linkComponentWorkflow(opts) {
  const call = dataverse(opts);
  const base = opts.environmentUrl.replace(/\/+$/, '') + '/api/data/v9.2/';
  const ops = [];
  for (const w of opts.component.workflows) if (w.id.toLowerCase() !== opts.workflowId.toLowerCase()) { await call(`botcomponents(${opts.component.id})/botcomponent_workflow(${w.id})/$ref`, { method: 'DELETE' }); ops.push(`unlinked ${w.id}`); }
  if (!opts.component.workflows.some((w) => w.id.toLowerCase() === opts.workflowId.toLowerCase())) { await call(`botcomponents(${opts.component.id})/botcomponent_workflow/$ref`, { method: 'POST', body: JSON.stringify({ '@odata.id': `${base}workflows(${opts.workflowId})` }) }); ops.push(`linked ${opts.workflowId}`); }
  return { operation: ops.length ? ops.join(', ') : 'existing', workflowId: opts.workflowId };
}

/**
 * Delete components on the live record that the workspace no longer declares (a re-deploy from a
 * trimmed workspace, or leftovers from an earlier deploy). Returns what was removed.
 * @param {DataverseOptions & { botId: string, keep: Set<string> | string[] }} opts keep = component schema names to leave in place
 */
export async function deleteStaleComponents(opts) {
  const keep = new Set([...opts.keep].map((s) => s.toLowerCase()));
  const call = dataverse(opts);
  const removed = [];
  for (const c of await listBotComponents(opts)) {
    if (keep.has(c.schemaName.toLowerCase())) continue;
    await call(`botcomponents(${c.id})`, { method: 'DELETE' });
    removed.push({ schemaName: c.schemaName, kind: c.kind });
  }
  return removed;
}

/**
 * Expected component schema names for a workspace, as pac names them on the live record.
 * @param {string} dir
 * @param {string} schemaName
 */
export function expectedComponents(dir, schemaName) {
  const scan = scanWorkspace(dir);
  const out = [];
  for (const t of scan.tools) out.push({ schemaName: `${schemaName}.tool.${t.name}`, kind: t.kind });
  for (const b of scan.behaviors) out.push({ schemaName: `${schemaName}.skill.${b.name}`, kind: b.kind });
  for (const k of scan.knowledge) out.push({ schemaName: `${schemaName}.knowledge.${k.name}`, kind: k.kind });
  return out;
}
