// @ts-check
/**
 * Administrative operations on a GitHub Copilot harness agent that have no `pac copilot` verb and
 * that the maker portal otherwise owns: sharing, security-group restriction, channel declaration,
 * environment variables, and listing the agent's components. All of them are plain Dataverse Web
 * API calls against the environment's org URL, proven live on 2026-09-07 (kodyv8).
 *
 * Every function takes `{ environmentUrl, getDataverseToken, fetchImpl? }` like the guard module.
 */
import { assertHarnessBot } from './harness-guard.js';

/** @typedef {{ environmentUrl: string, getDataverseToken: () => Promise<string>, fetchImpl?: typeof fetch }} DataverseOptions */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Access control policies on the bot record (Dataverse option set `accesscontrolpolicy`). */
export const ACCESS_CONTROL_POLICY = /** @type {const} */ ({ Any: 0, AgentReaders: 1, GroupMembership: 2, AnyMultiTenant: 3 });

/** Channel ids accepted in `configuration.channels[].channelId` (observed on live harness agents). */
export const CHANNELS = /** @type {const} */ ({ Teams: 'MsTeams', Microsoft365Copilot: 'Microsoft365Copilot' });

/**
 * @param {DataverseOptions} opts
 */
export function dataverse(opts) {
  return api(opts);
}

function api(opts) {
  if (!opts?.environmentUrl) throw new Error('environmentUrl is required (https://<org>.crm.dynamics.com/).');
  if (typeof opts.getDataverseToken !== 'function') throw new Error('getDataverseToken is required.');
  const base = opts.environmentUrl.replace(/\/+$/, '') + '/api/data/v9.2/';
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (path, init = {}) => {
    const token = await opts.getDataverseToken();
    const res = await fetchImpl(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', ...(init.headers || {}) }
    });
    if (!res.ok) throw new Error(`Dataverse ${init.method || 'GET'} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
}

/**
 * Resolve a bot by schema name or id and refuse classic agents.
 * @param {DataverseOptions & { schemaName?: string, botId?: string }} opts
 */
export async function resolveHarnessBot(opts) {
  const call = api(opts);
  const select = '$select=botid,name,schemaname,template,configuration,accesscontrolpolicy,authorizedsecuritygroupids,publishedon';
  const { body } = opts.botId
    ? await call(`bots(${opts.botId})?${select}`)
    : await call(`bots?$filter=schemaname eq '${String(opts.schemaName).replace(/'/g, "''")}'&${select}`);
  const bot = opts.botId ? body : body.value?.[0];
  if (!bot) throw new Error(`No bot ${opts.schemaName || opts.botId} in ${opts.environmentUrl}.`);
  assertHarnessBot(bot);
  return bot;
}

/**
 * Share the agent with a user or team (Dataverse GrantAccess). `access` defaults to read, which is
 * what "share with users" in the maker portal grants.
 * @param {DataverseOptions & { schemaName?: string, botId?: string, userId?: string, teamId?: string, access?: 'ReadAccess' | 'ReadAccess,WriteAccess' | string }} opts
 */
export async function shareAgent(opts) {
  const bot = await resolveHarnessBot(opts);
  if (!opts.userId && !opts.teamId) throw new Error('shareAgent needs userId or teamId.');
  const principal = opts.userId
    ? { systemuserid: opts.userId, '@odata.type': 'Microsoft.Dynamics.CRM.systemuser' }
    : { teamid: opts.teamId, '@odata.type': 'Microsoft.Dynamics.CRM.team' };
  await api(opts)('GrantAccess', {
    method: 'POST',
    body: JSON.stringify({ Target: { botid: bot.botid, '@odata.type': 'Microsoft.Dynamics.CRM.bot' }, PrincipalAccess: { Principal: principal, AccessMask: opts.access || 'ReadAccess' } })
  });
  return { botId: bot.botid, principal: opts.userId || opts.teamId, access: opts.access || 'ReadAccess' };
}

/**
 * Restrict who can talk to the agent: `policy` = Any | AgentReaders | GroupMembership | AnyMultiTenant,
 * plus the Entra security group ids for GroupMembership (comma-joined into `authorizedsecuritygroupids`).
 * @param {DataverseOptions & { schemaName?: string, botId?: string, policy: keyof typeof ACCESS_CONTROL_POLICY, securityGroupIds?: string[] }} opts
 */
export async function setAccessControl(opts) {
  const bot = await resolveHarnessBot(opts);
  const policy = ACCESS_CONTROL_POLICY[opts.policy];
  if (policy === undefined) throw new Error(`policy must be one of ${Object.keys(ACCESS_CONTROL_POLICY).join(', ')}`);
  const groups = opts.securityGroupIds || [];
  for (const g of groups) if (!GUID.test(g)) throw new Error(`securityGroupIds must be GUIDs; got ${g}`);
  if (opts.policy === 'GroupMembership' && !groups.length) throw new Error('GroupMembership requires at least one security group id.');
  await api(opts)(`bots(${bot.botid})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: JSON.stringify({ accesscontrolpolicy: policy, authorizedsecuritygroupids: groups.join(',') }) });
  return { botId: bot.botid, policy: opts.policy, securityGroupIds: groups };
}

/**
 * Declare the channels the agent publishes to (`configuration.channels`). Publishing to Teams /
 * Microsoft 365 Copilot afterwards still needs `pac copilot publish`; the Teams app package is
 * created by the portal on first publish.
 * @param {DataverseOptions & { schemaName?: string, botId?: string, channels: Array<keyof typeof CHANNELS> }} opts
 */
export async function setChannels(opts) {
  const bot = await resolveHarnessBot(opts);
  const ids = (opts.channels || []).map((c) => { const id = CHANNELS[c]; if (!id) throw new Error(`Unknown channel ${c}; expected ${Object.keys(CHANNELS).join(', ')}`); return id; });
  const configuration = typeof bot.configuration === 'string' ? JSON.parse(bot.configuration) : bot.configuration;
  configuration.channels = ids.map((channelId) => ({ $kind: 'ChannelDefinition', channelId }));
  await api(opts)(`bots(${bot.botid})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: JSON.stringify({ configuration: JSON.stringify(configuration) }) });
  return { botId: bot.botid, channels: ids };
}

/**
 * Create or update a solution environment variable (definition + current value).
 * @param {DataverseOptions & { schemaName: string, displayName?: string, type?: 'String' | 'Number' | 'Boolean' | 'JSON' | 'DataSource' | 'Secret', defaultValue?: string, value?: string, description?: string }} opts
 */
export async function upsertEnvironmentVariable(opts) {
  const TYPES = { String: 100000000, Number: 100000001, Boolean: 100000002, JSON: 100000003, DataSource: 100000004, Secret: 100000005 };
  const call = api(opts);
  const type = TYPES[opts.type || 'String'];
  if (!type) throw new Error(`type must be one of ${Object.keys(TYPES).join(', ')}`);
  const existing = (await call(`environmentvariabledefinitions?$filter=schemaname eq '${opts.schemaName}'&$select=environmentvariabledefinitionid`)).body.value?.[0];
  let definitionId = existing?.environmentvariabledefinitionid;
  if (!definitionId) {
    const res = await call('environmentvariabledefinitions', { method: 'POST', body: JSON.stringify({ schemaname: opts.schemaName, displayname: opts.displayName || opts.schemaName, description: opts.description, type, defaultvalue: opts.defaultValue }) });
    definitionId = (res.headers.get('odata-entityid') || '').match(/\(([0-9a-f-]{36})\)/i)?.[1];
    if (!definitionId) throw new Error('Dataverse did not return the new environment variable definition id.');
  } else if (opts.defaultValue !== undefined || opts.displayName) {
    await call(`environmentvariabledefinitions(${definitionId})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: JSON.stringify({ ...(opts.defaultValue !== undefined ? { defaultvalue: opts.defaultValue } : {}), ...(opts.displayName ? { displayname: opts.displayName } : {}) }) });
  }
  let valueId = null;
  if (opts.value !== undefined) {
    const cur = (await call(`environmentvariablevalues?$filter=_environmentvariabledefinitionid_value eq ${definitionId}&$select=environmentvariablevalueid`)).body.value?.[0];
    if (cur) { valueId = cur.environmentvariablevalueid; await call(`environmentvariablevalues(${valueId})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: JSON.stringify({ value: opts.value }) }); }
    else { const res = await call('environmentvariablevalues', { method: 'POST', body: JSON.stringify({ schemaname: opts.schemaName, value: opts.value, 'EnvironmentVariableDefinitionId@odata.bind': `/environmentvariabledefinitions(${definitionId})` }) }); valueId = (res.headers.get('odata-entityid') || '').match(/\(([0-9a-f-]{36})\)/i)?.[1] || null; }
  }
  return { schemaName: opts.schemaName, definitionId, valueId };
}

/**
 * List the agent's components (tools, knowledge, skills, connected agents) as pac names them.
 * @param {DataverseOptions & { schemaName?: string, botId?: string }} opts
 */
export async function listComponents(opts) {
  const bot = await resolveHarnessBot(opts);
  const { body } = await api(opts)(`botcomponents?$filter=_parentbotid_value eq ${bot.botid}&$select=schemaname,name,componenttype,data`);
  return (body.value || []).map((c) => {
    const short = c.schemaname.startsWith(`${bot.schemaname}.`) ? c.schemaname.slice(bot.schemaname.length + 1) : c.schemaname;
    const kind = (String(c.data || '').match(/^kind:\s*(\S+)/m) || [])[1] || (c.componenttype === 14 ? 'SkillResource' : 'unknown');
    return { schemaName: c.schemaname, name: short, displayName: c.name, kind, componentType: c.componenttype };
  });
}
