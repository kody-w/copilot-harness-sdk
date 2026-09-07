// @ts-check
/**
 * Harness guard: the one place that decides whether a Copilot Studio agent is
 * on the GitHub Copilot harness or on the classic (standard) harness, and
 * refuses the classic one.
 *
 * Policy (2026-09-07): this SDK never builds, deploys, or (by default) talks to
 * a classic agent. A classic agent is recognised by its Dataverse `bot`
 * record, not by what a tool said it did:
 *
 *   template            configuration.recognizer.$kind   harness
 *   cliagent-1.0.0      CLICopilotRecognizer             GitHub Copilot harness  (allowed)
 *   default-2.1.0 ...   GenerativeAIRecognizer           classic / standard      (refused)
 *
 * Both markers come from real exports: docs/ghcp-harness-copilot-sdk-reference.md §6.2
 * and the `pac copilot init --authoring-mode cli-copilot` scaffold (`template: cliagent-1.0.0`).
 */

/** Templates that are the GitHub Copilot harness. */
export const HARNESS_TEMPLATE = /^cliagent-/i;
/** Recognizers that are the GitHub Copilot harness (newer, older). */
export const HARNESS_RECOGNIZERS = ['CLICopilotRecognizer', 'CLIAgentRecognizer'];

export class ClassicAgentError extends Error {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ClassicAgentError';
    this.code = 'CLASSIC_AGENT';
    Object.assign(this, details);
  }
}

/**
 * Classify a bot record (or the fields of one). Pure; no network.
 * @param {{ template?: string | null, configuration?: string | Record<string, any> | null }} bot
 * @returns {{ harness: 'github-copilot' | 'classic' | 'unknown', template: string, recognizer: string, model: string, instructionChars: number, authoringModel: string }}
 */
export function classifyBot(bot) {
  const template = String(bot?.template ?? '');
  let cfg = bot?.configuration ?? {};
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
  }
  const recognizer = String(cfg?.recognizer?.$kind ?? cfg?.recognizer?.kind ?? '');
  const authoringModel = String(cfg?.authoringModel ?? '');
  const model = String(cfg?.agentSettings?.model?.series ?? cfg?.aISettings?.model?.modelNameHint ?? '');
  const segments = cfg?.agentSettings?.instructions?.segments;
  const instructionChars = Array.isArray(segments)
    ? segments.reduce((n, s) => n + String(s?.value ?? '').length, 0)
    : 0;
  let harness = /** @type {'github-copilot' | 'classic' | 'unknown'} */ ('unknown');
  if (HARNESS_TEMPLATE.test(template) || HARNESS_RECOGNIZERS.includes(recognizer)) harness = 'github-copilot';
  else if (template || recognizer) harness = 'classic';
  return { harness, template, recognizer, model, instructionChars, authoringModel };
}

/**
 * Throw unless the record is a GitHub Copilot harness agent.
 * @param {{ template?: string | null, configuration?: string | Record<string, any> | null, name?: string, schemaname?: string }} bot
 * @param {{ requireInstructions?: boolean }} [opts]
 */
export function assertHarnessBot(bot, opts = {}) {
  const c = classifyBot(bot);
  const label = bot?.schemaname || bot?.name || 'agent';
  if (c.harness !== 'github-copilot') {
    throw new ClassicAgentError(
      `${label} is a classic (standard-harness) Copilot Studio agent (template=${c.template || '?'}, recognizer=${c.recognizer || '?'}). ` +
        'This SDK refuses classic agents: recreate it on the GitHub Copilot harness ' +
        '(pac copilot init --authoring-mode cli-copilot, or scripts/deploy-harness-agent.mjs). Agents cannot be switched in place.',
      { classification: c }
    );
  }
  if (opts.requireInstructions && c.instructionChars === 0) {
    throw new ClassicAgentError(`${label} is on the harness but has no instructions; nothing would answer.`, { classification: c, code: 'NO_INSTRUCTIONS' });
  }
  return c;
}

/**
 * Read the live bot record from Dataverse and classify it.
 * @param {{ environmentUrl: string, schemaName?: string, botId?: string, getDataverseToken: () => Promise<string>, fetchImpl?: typeof fetch }} opts
 */
export async function inspectAgentHarness(opts) {
  const { environmentUrl, schemaName, botId, getDataverseToken } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!environmentUrl) throw new Error('inspectAgentHarness requires environmentUrl (https://<org>.crm.dynamics.com/).');
  if (!schemaName && !botId) throw new Error('inspectAgentHarness requires schemaName or botId.');
  const base = environmentUrl.replace(/\/+$/, '') + '/api/data/v9.2/';
  const select = '$select=botid,name,schemaname,template,configuration,publishedon,authenticationmode';
  const url = botId
    ? `${base}bots(${botId})?${select}`
    : `${base}bots?$filter=schemaname eq '${String(schemaName).replace(/'/g, "''")}'&${select}`;
  const token = await getDataverseToken();
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } });
  if (!res.ok) throw new Error(`Dataverse returned HTTP ${res.status} reading the bot record: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const bot = botId ? body : body.value?.[0];
  if (!bot) throw new Error(`No bot with schemaname ${schemaName} in ${environmentUrl}.`);
  return { bot: { botid: bot.botid, name: bot.name, schemaname: bot.schemaname, publishedon: bot.publishedon ?? null, authenticationmode: bot.authenticationmode }, ...classifyBot(bot) };
}

/**
 * Read the live record and throw unless it is a GitHub Copilot harness agent.
 * @param {Parameters<typeof inspectAgentHarness>[0] & { requireInstructions?: boolean, requirePublished?: boolean }} opts
 */
export async function assertHarnessAgent(opts) {
  const info = await inspectAgentHarness(opts);
  assertHarnessBot({ ...info.bot, template: info.template, configuration: { recognizer: { $kind: info.recognizer }, agentSettings: { instructions: { segments: [{ value: 'x'.repeat(info.instructionChars) }] } } } }, { requireInstructions: opts.requireInstructions });
  if (opts.requirePublished && !info.bot.publishedon) {
    throw new Error(`${info.bot.schemaname} is on the harness but has never been published.`);
  }
  return info;
}
