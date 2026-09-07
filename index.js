// @ts-check
/**
 * copilot-harness-sdk
 *
 * One client for every way to reach a GitHub Copilot harness. Pick a mode,
 * ask `capabilities()` what it can do, open a session, and consume one
 * normalized event stream no matter which wire is underneath.
 *
 *   copilot-sdk              in-process Copilot CLI harness via @github/copilot-sdk
 *   copilot-studio-3p        Copilot Studio GitHub Copilot harness agent, /3p, delegated Entra user
 *   copilot-studio-standard  Copilot Studio standard-harness agent, official client library
 *   copilot-studio-s2s       Copilot Studio harness agent, /3p, app-only (private preview, no-auth agents)
 *   agentic-directline       no-auth agentic Direct Line token endpoint (diagnostic, final-only)
 *
 * Grounding: docs/ghcp-harness-copilot-sdk-reference.md in this repository.
 */
import { MODES, capabilitiesFor, allCapabilities } from './src/modes.js';
import { build3pUrl, buildAgenticDirectLineTokenUrl, environmentHost, guard3pUrl, powerPlatformScope, CLOUD_SUFFIX } from './src/url.js';
import { TextAccumulator, normalizeStudioActivity, createEventQueue, safeEmit } from './src/events.js';
import { createDeviceCodeTokenProvider, createClientCredentialTokenProvider, staticToken } from './src/auth/entra.js';
import { createCopilotSdkAdapter } from './src/adapters/copilot-sdk.js';
import { createSdkEventMapper } from './src/adapters/copilot-sdk-map.js';
import { createCopilotStudioAdapter, resolveStudioConnection, preflight3p, explainStatus } from './src/adapters/copilot-studio.js';
import { classifyBot, assertHarnessBot, inspectAgentHarness, assertHarnessAgent, ClassicAgentError, HARNESS_TEMPLATE, HARNESS_RECOGNIZERS } from './src/harness-guard.js';

export {
  MODES,
  capabilitiesFor,
  allCapabilities,
  build3pUrl,
  buildAgenticDirectLineTokenUrl,
  environmentHost,
  guard3pUrl,
  powerPlatformScope,
  CLOUD_SUFFIX,
  TextAccumulator,
  normalizeStudioActivity,
  createEventQueue,
  safeEmit,
  createSdkEventMapper,
  createDeviceCodeTokenProvider,
  createClientCredentialTokenProvider,
  staticToken,
  resolveStudioConnection,
  preflight3p,
  explainStatus,
  classifyBot,
  assertHarnessBot,
  inspectAgentHarness,
  assertHarnessAgent,
  ClassicAgentError,
  HARNESS_TEMPLATE,
  HARNESS_RECOGNIZERS
};

/** @typedef {import('./index.js').HarnessClientConfig} HarnessClientConfig */
/** @typedef {import('./index.js').HarnessMode} HarnessMode */
/** @typedef {import('./index.js').HarnessEvent} HarnessEvent */

/**
 * Validate a config before any network or process is touched. Returns the
 * list of problems (empty = valid) so callers can show all of them at once.
 * `HarnessClient.create` throws with exactly this list.
 * @param {HarnessClientConfig} config
 * @returns {string[]}
 */
/** The sentence every classic-agent refusal carries. */
export const CLASSIC_REFUSAL =
  'copilot-studio-standard targets a classic (standard-harness) agent, which this SDK treats as deprecated: ' +
  'build the agent on the GitHub Copilot harness (scripts/deploy-harness-agent.mjs) and use copilot-studio-3p. ' +
  'Only for a legacy agent that cannot be recreated yet, pass copilotStudio.allowClassicAgent: true.';

export function validateConfig(config) {
  const problems = [];
  if (!config || typeof config !== 'object') return ['config must be an object'];
  if (!MODES.includes(/** @type {any} */ (config.mode))) {
    problems.push(`mode must be one of ${MODES.join(', ')}`);
    return problems;
  }
  if (config.mode === 'copilot-sdk') {
    const c = config.copilotSdk || {};
    if (c.byok && !c.model && !c.session?.model) problems.push('copilot-sdk with byok requires model');
    if (c.runtime?.uri && (c.runtime.cliPath || c.runtime.args || c.runtime.env)) {
      problems.push('copilot-sdk runtime.uri (external runtime) cannot be combined with cliPath/args/env (spawned runtime)');
    }
    return problems;
  }
  const s = config.copilotStudio || {};
  if (config.mode === 'agentic-directline') {
    if (!s.directLineTokenUrl && (!s.environmentId || !s.schemaName)) {
      problems.push('agentic-directline requires copilotStudio.environmentId and schemaName, or directLineTokenUrl');
    }
    if (s.directConnectUrl) problems.push('agentic-directline does not use directConnectUrl (that is for the /3p modes)');
    return problems;
  }
  if (typeof s.getAccessToken !== 'function') {
    problems.push(`${config.mode} requires copilotStudio.getAccessToken`);
  }
  if (config.mode === 'copilot-studio-standard') {
    if (s.allowClassicAgent !== true) {
      problems.push(CLASSIC_REFUSAL);
    }
    if (!s.environmentId || !s.schemaName) problems.push('copilot-studio-standard requires copilotStudio.environmentId and schemaName');
    if (s.directConnectUrl) problems.push('copilot-studio-standard uses environmentId + schemaName; directConnectUrl is for the /3p modes');
    return problems;
  }
  if (!s.directConnectUrl && (!s.environmentId || !s.schemaName)) {
    problems.push(`${config.mode} requires copilotStudio.environmentId and schemaName (or directConnectUrl)`);
  }
  return problems;
}

export class HarnessClient {
  /**
   * @param {HarnessClientConfig} config
   * @param {any} adapter
   */
  constructor(config, adapter) {
    this.config = config;
    this.mode = /** @type {HarnessMode} */ (config.mode);
    this._adapter = adapter;
  }

  /**
   * Build a client for the chosen mode. Validates the config, then starts the
   * underlying runtime (Copilot SDK) or resolves the Copilot Studio connection.
   * @param {HarnessClientConfig} config
   * @param {{ clientFactory?: any, fetchImpl?: typeof fetch, sdk?: any }} [deps] test seams
   */
  static async create(config, deps = {}) {
    const problems = validateConfig(config);
    if (problems.length) throw new Error(`Invalid HarnessClient config: ${problems.join('; ')}`);
    const adapter =
      config.mode === 'copilot-sdk'
        ? await createCopilotSdkAdapter(config.copilotSdk || {}, { sdk: deps.sdk })
        : await createCopilotStudioAdapter(config.mode, config.copilotStudio || {}, deps);
    return new HarnessClient(config, adapter);
  }

  /** What this mode can do, with sources. Never guess: branch on this. */
  capabilities() {
    return capabilitiesFor(this.mode);
  }

  /** Human-readable one-liner for logs and UIs. */
  describe() {
    const c = this.capabilities();
    return `${c.mode} · ${c.harness} · support=${c.support} · identity=${c.identity.join('|')} · streaming=${c.streaming}`;
  }

  /** Cheap connectivity check with the failure table applied (401/403/404 hints). */
  preflight() {
    return this._adapter.preflight();
  }

  /**
   * Open (or resume) a session. Copilot SDK sessions resume by sessionId;
   * Copilot Studio sessions resume by conversationId.
   * @param {import('./index.js').CreateSessionOptions} [opts]
   * @returns {Promise<import('./index.js').HarnessSession>}
   */
  createSession(opts) {
    return this._adapter.createSession(opts);
  }

  /**
   * Subscribe to every normalized event from every session on this client.
   * Listener exceptions are isolated (see copilotSdk/copilotStudio.onListenerError).
   * @param {(event: HarnessEvent) => void} listener
   * @returns {() => void}
   */
  onEvent(listener) {
    return this._adapter.onEvent(listener);
  }

  listSessions() {
    return this._adapter.listSessions();
  }

  /** @param {string} id */
  deleteSession(id) {
    return this._adapter.deleteSession(id);
  }

  /** The underlying @github/copilot-sdk CopilotClient, when the mode has one. */
  get native() {
    return this._adapter.native;
  }

  /** Resolved connection details (Copilot Studio: settings + guarded URL; Copilot SDK: client options). */
  get resolved() {
    return this._adapter.resolved;
  }

  close() {
    return this._adapter.close();
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

/**
 * Convenience: `const client = await createHarnessClient({ mode, ... })`.
 * @param {HarnessClientConfig} config
 * @param {{ clientFactory?: any, fetchImpl?: typeof fetch, sdk?: any }} [deps]
 */
export function createHarnessClient(config, deps) {
  return HarnessClient.create(config, deps);
}

/**
 * Pick a mode from what you have. Encodes the decision guide (§8):
 *   - a GitHub token, a BYOK provider, or nothing but a local CLI login → copilot-sdk
 *   - a Copilot Studio agent + a delegated user token → 3p for harness agents, standard otherwise
 *   - a Copilot Studio agent + app credentials → s2s (only if the agent is No Authentication)
 *   - a Copilot Studio agent and no identity at all → agentic-directline (diagnostic)
 * @param {{ hasGithubIdentity?: boolean, hasByok?: boolean, hasCopilotStudioAgent?: boolean, agentHarness?: 'github-copilot' | 'standard', hasDelegatedEntraToken?: boolean, hasAppOnlyEntraCredentials?: boolean, agentAuthentication?: 'microsoft' | 'none', allowClassicAgent?: boolean }} facts
 * @returns {{ mode: HarnessMode, why: string }}
 */
export function recommendMode(facts) {
  if (!facts.hasCopilotStudioAgent) {
    return { mode: 'copilot-sdk', why: 'No Copilot Studio agent involved: run the harness in-process with the Copilot SDK (GitHub identity, org token, or BYOK).' };
  }
  if (facts.hasDelegatedEntraToken) {
    if (facts.agentHarness === 'standard') {
      if (facts.allowClassicAgent === true) {
        return { mode: 'copilot-studio-standard', why: 'Legacy classic (standard-harness) agent, explicitly allowed: the client-library path. Recreate it on the GitHub Copilot harness when you can.' };
      }
      return { mode: 'copilot-studio-3p', why: 'A classic (standard-harness) agent is deprecated here: recreate it on the GitHub Copilot harness and use /3p. Pass allowClassicAgent: true only for a legacy agent you cannot recreate yet.' };
    }
    return { mode: 'copilot-studio-3p', why: 'GitHub Copilot harness agent with a delegated user token: the /3p Direct-to-Engine route (experimental, verified live from the playground).' };
  }
  if (facts.hasAppOnlyEntraCredentials) {
    if (facts.agentAuthentication === 'none') {
      return { mode: 'copilot-studio-s2s', why: 'App-only identity against a No Authentication agent: S2S private preview over /3p.' };
    }
    return { mode: 'copilot-studio-3p', why: 'App-only tokens are rejected by the authenticated /3p route; you still need a delegated user token for this agent.' };
  }
  return { mode: 'agentic-directline', why: 'No identity available: only the no-auth agentic Direct Line diagnostic applies (final-only responses).' };
}
