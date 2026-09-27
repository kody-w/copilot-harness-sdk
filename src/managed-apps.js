// @ts-check
/**
 * Managed apps (Copilot Managed Runtime) from the SDK: the same lifecycle the microsoft-managed-apps plugin skills
 * run (create → add data source → dev → deploy → play), as a library, with the plugin's rules enforced in code.
 *
 * The tooling is Microsoft's: `@microsoft/managed-apps-cli` (binary `ms`) builds, deploys and binds connectors; the
 * app itself uses `@microsoft/managed-apps` (typed connector services under `generated/`). This module drives the
 * CLI (`--non-interactive --json` only), reads and writes `ms.config.json`, and adds what the skills leave to a
 * person at a keyboard:
 *
 *   - checkAllowedActions()   the CLI's shared-connection policy validation (allowed-actions.md), run before a
 *                             deploy so it fails fast instead of after a build and push
 *   - inferAllowedActions()   least privilege from what src/ actually calls, never "grant everything"
 *   - setConnectorAllowedActions() / setTableAllowedActions()
 *                             write that policy: action ids checked against the connector's Allow list, or a table's
 *                             verbs (get, post, patch, delete) on exactly one dataset table
 *   - gitAuthEnv()            Git credentials for the app's platform repository from an Entra token (the client and
 *                             scope the CLI configures for Git Credential Manager), for headless machines where GCM's
 *                             interactive flow can't run; the token travels in git's environment, never argv
 *   - deploy()                refuses uncommitted/unpushed work and missing policies, then `ms app deploy --commit`
 *
 * The skills this mirrors are vendored unchanged, with sha256s, under vendor/managed-apps (see VENDOR.json).
 * Grounding for every rule: vendor/managed-apps/plugins/microsoft-managed-apps/shared/*.md and the verification
 * notes in docs/managed-apps.md.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The public-client app id the ms CLI configures for Git Credential Manager (credential.<host>.oauthClientId). */
export const MANAGED_APPS_GIT_CLIENT_ID = '9cee029c-6210-4654-90bb-17e6e9d36617';
/** The scope that client requests for the platform git endpoint. */
export const MANAGED_APPS_GIT_SCOPE = 'https://api.powerplatform.com/.default';
/** The four verbs a tabular data source's allowedActions may use (allowed-actions.md). */
export const TABLE_VERBS = Object.freeze(['get', 'post', 'patch', 'delete']);
/** Content security policy the deployed player enforces on app media (seen live, 26 Sep 2026): no blob: URLs. */
export const PLAYER_MEDIA_SRC = "media-src 'self' data:";

/**
 * Run the ms CLI once, non-interactively, and return its parsed JSON.
 * @param {string[]} args  e.g. ['app', 'list']
 * @param {{ cwd?: string, bin?: string, env?: Record<string, string>, run?: typeof spawnSync, timeoutMs?: number }} [opts]
 * @returns {any}
 */
export function ms(args, opts = {}) {
  const run = opts.run || spawnSync;
  const bin = opts.bin || 'ms';
  const env = { ...process.env, MS_CLI_ORIGIN: process.env.MS_CLI_ORIGIN || 'sdk/copilot-harness-sdk', ...(opts.env || {}) };
  const r = run(bin, [...args, '--non-interactive', '--json'], { cwd: opts.cwd, env, encoding: 'utf8', timeout: opts.timeoutMs ?? 30 * 60 * 1000 });
  if (r.error) throw new Error(`could not run ${bin}: ${r.error.message}. Install it with: npm install -g @microsoft/managed-apps-cli@latest`);
  const out = String(r.stdout || '');
  const start = out.indexOf('{');
  let parsed;
  try { parsed = start >= 0 ? JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)) : undefined; } catch { parsed = undefined; }
  if (!parsed) {
    throw new Error(`${bin} ${args.join(' ')} returned no JSON (exit ${r.status}): ${(out + String(r.stderr || '')).trim().slice(0, 600)}`);
  }
  if (r.status !== 0 || parsed.success === false) {
    const err = new Error(`${bin} ${args.join(' ')} failed (exit ${r.status}): ${parsed.errorMessage || parsed.message || String(r.stderr || '').trim() || JSON.stringify(parsed).slice(0, 400)}`);
    /** @type {any} */ (err).result = parsed;
    throw err;
  }
  return parsed;
}

/** @param {string} dir */
export function readConfig(dir) {
  const p = join(dir, 'ms.config.json');
  if (!existsSync(p)) throw new Error(`Not a managed app workspace (no ms.config.json in ${dir}).`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** @param {string} dir @param {any} config */
export function writeConfig(dir, config) {
  writeFileSync(join(dir, 'ms.config.json'), JSON.stringify(config, null, 2) + '\n');
}

const nonEmptyList = (/** @type {any} */ a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && /\S/.test(x));
const isShared = (/** @type {any} */ ref) => Boolean(String(ref?.sharedConnectionId || '').trim());

/** @param {Record<string, any>} refs @param {string} connector @param {string | undefined} reference */
function connectorReferences(refs, connector, reference) {
  const api = `/apis/${connector.startsWith('shared_') ? connector : `shared_${connector}`}`;
  const matches = (/** @type {string} */ name) => String(refs[name]?.id || '').endsWith(api);
  if (reference !== undefined) {
    if (!Object.hasOwn(refs, reference)) throw new Error(`No connection reference ${reference} in ms.config.json.`);
    if (!matches(reference)) throw new Error(`Connection reference ${reference} is not for connector ${connector}.`);
    return [reference];
  }
  return Object.keys(refs).filter(matches);
}

/** @param {any} ref @param {string} name */
function requireSharedReference(ref, name) {
  if (!isShared(ref)) throw new Error(`Connection reference ${name} is not shared: allowed-actions.md says not to add allowedActions to non-shared references.`);
}

/**
 * The shared-connection policy check (allowed-actions.md, "Validation rules"), including the four table verbs.
 * Only references with a non-empty sharedConnectionId are checked.
 * @param {any} config  parsed ms.config.json
 * @returns {{ ok: boolean, issues: { reference: string, table?: string, problem: 'missing-table' | 'invalid-table' | 'missing-connector' | 'invalid-connector' }[] }}
 */
export function checkAllowedActions(config) {
  const issues = [];
  for (const [name, r] of Object.entries(config?.connectionReferences || {})) {
    if (!isShared(r)) continue;
    const ref = /** @type {any} */ (r);
    const tables = Object.entries(ref.dataSets || {}).flatMap(([d, s]) =>
      Object.entries(/** @type {any} */ (s).dataSources || {}).map(([k, v]) => [`${d}/${k}`, v]));
    if (ref.allowedActions !== undefined && !nonEmptyList(ref.allowedActions)) issues.push({ reference: name, problem: /** @type {const} */ ('invalid-connector') });
    if (tables.length) {
      for (const [path, v] of tables) {
        const actions = /** @type {any} */ (v)?.allowedActions;
        if (!nonEmptyList(actions)) issues.push({ reference: name, table: String(path), problem: /** @type {const} */ ('missing-table') });
        else if (actions.some((/** @type {string} */ action) => !TABLE_VERBS.includes(action))) issues.push({ reference: name, table: String(path), problem: /** @type {const} */ ('invalid-table') });
      }
    } else if (ref.allowedActions === undefined) {
      issues.push({ reference: name, problem: /** @type {const} */ ('missing-connector') });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(n)) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const VERB_OF = [[/^(get|list|read|query|search|find|lookup)/i, 'get'], [/^(create|post|insert|add)/i, 'post'], [/^(update|patch|set)/i, 'patch'], [/^(delete|remove)/i, 'delete']];

/**
 * Least privilege from the code (allowed-actions.md, "Choosing the values"): every `<Service>.<Method>(` the app's
 * src/ calls on the given generated service. For an action connector those method names are the connector's Action
 * IDs (confirm against `ms connector list-actions`); for a table they map to the four verbs.
 * @param {string} appDir
 * @param {string} serviceName  e.g. 'SharePointService'
 * @param {{ kind?: 'action' | 'table' }} [opts]
 * @returns {{ actions: string[], files: string[] }}
 */
export function inferAllowedActions(appDir, serviceName, opts = {}) {
  if (typeof serviceName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(serviceName)) throw new Error('serviceName must be a JavaScript identifier (letters, digits, _ or $, not a dotted path).');
  const escaped = serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w$])${escaped}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  const found = new Set(); const files = new Set();
  for (const f of sourceFiles(join(appDir, 'src'))) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(re)) { found.add(m[1]); files.add(relative(appDir, f).split(sep).join('/')); }   // same on every OS
  }
  let actions = [...found].sort();
  if (opts.kind === 'table') {
    actions = [...new Set(actions.map((a) => (VERB_OF.find(([rx]) => /** @type {RegExp} */ (rx).test(a)) || [])[1]).filter(Boolean))].sort();
  }
  return { actions: /** @type {string[]} */ (actions), files: [...files].sort() };
}

/**
 * Write connector-level allowedActions on one shared reference, after checking every id against the connector's
 * own action list (only `behavior: Allow`). Prefer the reference owning the action data source; ambiguity requires
 * an explicit reference, which must belong to this connector.
 * @param {string} appDir
 * @param {{ reference?: string, connector: string, actions: string[], connectorActions?: any[], msOpts?: any }} opts
 */
export function setConnectorAllowedActions(appDir, { reference, connector, actions, connectorActions, msOpts }) {
  if (!nonEmptyList(actions)) throw new Error('allowedActions must list at least one action id.');
  const config = readConfig(appDir);
  const refs = config.connectionReferences || {};
  let names = connectorReferences(refs, connector, reference);
  if (reference === undefined) {
    const actionSource = connector.replace(/^shared_/, '');
    const owners = names.filter((name) => Array.isArray(refs[name].dataSources) && refs[name].dataSources.includes(actionSource));
    if (owners.length) names = owners;
  }
  if (!names.length) throw new Error(`No connection reference for ${connector} in ms.config.json.`);
  if (names.length > 1) throw new Error(`Connection references for ${connector} are ambiguous: pass reference (${names.join(', ')}).`);
  const name = names[0];
  requireSharedReference(refs[name], name);
  const listed = connectorActions || ms(['connector', 'list-actions', '--connector', connector], { ...(msOpts || {}), cwd: appDir }).items || [];
  const allowed = new Set(listed.filter((a) => String(a.behavior).toLowerCase() === 'allow').map((a) => a.id));
  const unknown = actions.filter((a) => !allowed.has(a));
  if (unknown.length) throw new Error(`Not allowed actions of ${connector} (unknown, or denied by policy): ${unknown.join(', ')}`);
  refs[name].allowedActions = [...actions].sort();
  writeConfig(appDir, config);
  return { reference: name, allowedActions: refs[name].allowedActions };
}

/**
 * Write per-table allowedActions on one dataset table of a shared reference (allowed-actions.md, "Tabular reference
 * — per-table actions"): the four verbs only, never operation ids. `table` is the data source key under
 * dataSets[*].dataSources (a Dataverse logical name, say) or its tableName (a SharePoint list's name).
 * @param {string} appDir
 * @param {{ reference?: string, connector: string, table: string, dataset?: string, verbs: string[] }} opts
 */
export function setTableAllowedActions(appDir, { reference, connector, table, dataset, verbs }) {
  if (!nonEmptyList(verbs)) throw new Error('allowedActions must list at least one verb.');
  const unknown = verbs.filter((v) => !TABLE_VERBS.includes(v));
  if (unknown.length) throw new Error(`Tables take only the verbs ${TABLE_VERBS.join(', ')}, not: ${unknown.join(', ')}`);
  const config = readConfig(appDir);
  const refs = config.connectionReferences || {};
  const names = connectorReferences(refs, connector, reference);
  const same = (/** @type {string} */ a, /** @type {string} */ b) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
  /** @type {[string, string, string, any][]} */
  const hits = [];
  for (const name of names) {
    for (const [d, block] of Object.entries(refs[name]?.dataSets || {})) {
      if (dataset !== undefined && !same(d, dataset)) continue;
      for (const [k, v] of Object.entries(/** @type {any} */ (block).dataSources || {})) {
        if (k === table || /** @type {any} */ (v).tableName === table) hits.push([name, d, k, v]);
      }
    }
  }
  if (hits.length === 0) throw new Error(`No table ${table} on a ${connector} reference in ms.config.json.`);
  if (hits.length > 1) throw new Error(`Table ${table} is ambiguous (${hits.map(([n, d, k]) => `${n} ${d}/${k}`).join('; ')}): pass reference or dataset.`);
  const [name, d, k, v] = hits[0];
  requireSharedReference(refs[name], name);
  v.allowedActions = TABLE_VERBS.filter((x) => verbs.includes(x));
  writeConfig(appDir, config);
  return { reference: name, dataset: d, table: k, allowedActions: v.allowedActions };
}

/**
 * Environment for git that authenticates to the app's platform repository with a bearer credential, without Git
 * Credential Manager. The token never appears in argv (errors can print argv) or in a file.
 * @param {string} accessToken  Entra token for MANAGED_APPS_GIT_SCOPE from MANAGED_APPS_GIT_CLIENT_ID (or any client
 *                              the platform git endpoint accepts)
 * @returns {Record<string, string>}
 */
export function gitAuthEnv(accessToken) {
  if (!accessToken) throw new Error('gitAuthEnv needs an access token.');
  const basic = Buffer.from(`OAUTH_USER:${accessToken}`).toString('base64');
  return {
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`
  };
}

/**
 * Run git in an app folder, optionally with gitAuthEnv(token). Throws with git's output on failure (never the token).
 * @param {string} dir @param {string[]} args @param {{ token?: string, run?: typeof spawnSync }} [opts]
 */
export function git(dir, args, opts = {}) {
  const run = opts.run || spawnSync;
  const env = { ...process.env, ...(opts.token ? gitAuthEnv(opts.token) : {}) };
  const r = run('git', args, { cwd: dir, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (exit ${r.status}): ${String(r.stderr || r.stdout || '').trim().slice(0, 600)}`);
  return String(r.stdout || '').trim();
}

/**
 * Push the app's current branch to its platform repository. The platform seeds a new repository with one
 * "Initial commit" (a README); a first push onto it is rebased, keeping the app's own README.
 * @param {string} dir @param {{ token?: string, branch?: string, run?: typeof spawnSync }} [opts]
 */
export function pushApp(dir, opts = {}) {
  const branch = opts.branch || 'main';
  const run = opts.run || spawnSync;
  git(dir, ['fetch', 'origin'], opts);
  const remote = git(dir, ['ls-remote', '--heads', 'origin', branch], opts);
  if (remote) {
    // does local history already contain the remote branch? (merge-base --is-ancestor exits 0 = yes, 1 = no)
    const contains = run('git', ['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'], { cwd: dir, encoding: 'utf8', env: process.env }).status === 0;
    if (!contains) {
      const r = run('git', ['rebase', `origin/${branch}`], { cwd: dir, encoding: 'utf8', env: process.env });
      if (r.status !== 0) {
        const conflicted = git(dir, ['diff', '--name-only', '--diff-filter=U'], { run }).split('\n').filter(Boolean);
        if (conflicted.length === 1 && conflicted[0] === 'README.md') {
          git(dir, ['checkout', '--theirs', 'README.md'], { run }); git(dir, ['add', 'README.md'], { run });
          const c = run('git', ['rebase', '--continue'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
          if (c.status !== 0) throw new Error(`rebase onto the platform's initial commit failed: ${String(c.stderr || '').slice(0, 400)}`);
        } else {
          run('git', ['rebase', '--abort'], { cwd: dir });
          throw new Error(`the remote has history this app doesn't (conflicts: ${conflicted.join(', ') || 'unknown'}); integrate it first.`);
        }
      }
    }
  }
  git(dir, ['push', '-u', 'origin', `HEAD:${branch}`], opts);
  return git(dir, ['rev-parse', 'HEAD'], { run });
}

/**
 * Deploy a git-backed managed app from a pushed commit (deploy/SKILL.md): refuses a dirty tree, an unpushed HEAD
 * and missing shared-connection policies, then runs `ms app deploy --commit <sha>` and returns its JSON.
 * @param {string} dir @param {{ msOpts?: any, run?: typeof spawnSync, token?: string, commit?: string }} [opts]
 */
export function deploy(dir, opts = {}) {
  const config = readConfig(dir);
  const policy = checkAllowedActions(config);
  if (!policy.ok) throw new Error(`shared connection policy missing: ${policy.issues.map((i) => `${i.reference}${i.table ? ` -> ${i.table}` : ''} (${i.problem})`).join('; ')}`);
  if (config.repoType === 'none') {
    if (opts.commit !== undefined) throw new Error('A repoType:none app has no deployment commit; omit commit.');
    return ms(['app', 'deploy'], { ...(opts.msOpts || {}), cwd: dir });
  }
  if (git(dir, ['status', '--porcelain'], { run: opts.run })) throw new Error('uncommitted changes: commit them before deploying.');
  const sha = opts.commit || git(dir, ['rev-parse', 'HEAD'], { run: opts.run });
  const onRemote = git(dir, ['branch', '-r', '--contains', sha, '--list', 'origin/*'], { run: opts.run });
  if (!onRemote) throw new Error(`commit ${sha.slice(0, 7)} is not on the remote: push it first (pushApp).`);
  return ms(['app', 'deploy', '--commit', sha], { ...(opts.msOpts || {}), cwd: dir });
}

/**
 * The play URL for the live app or a preview (play/SKILL.md), without opening a browser.
 * @param {string} dir @param {{ mode?: 'live' | 'preview', commit?: string, branch?: string, msOpts?: any }} [opts]
 */
export function playUrl(dir, opts = {}) {
  if (opts.mode !== 'preview' && (opts.commit !== undefined || opts.branch !== undefined)) throw new Error('commit or branch requires preview mode (mode: "preview", or --preview in the CLI).');
  if (opts.commit !== undefined && opts.branch !== undefined) throw new Error('Choose either commit or branch for a preview, not both.');
  const args = ['app', 'play', '--no-browser'];
  if (opts.mode === 'preview') args.push('--mode', 'preview', ...(opts.commit ? ['--commit', opts.commit] : opts.branch ? ['--branch', opts.branch] : []));
  return ms(args, { ...(opts.msOpts || {}), cwd: dir }).url;
}
