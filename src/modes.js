// @ts-check
/**
 * The capability matrix behind `client.capabilities()`.
 *
 * Every value here is traceable to docs/ghcp-harness-copilot-sdk-reference.md
 * (sections 2, 3, 5, 7 and 8). The point of exposing it at runtime is that a
 * caller never has to guess what a mode can do: ask the client, branch on the
 * answer.
 */

/** @typedef {import('../index.js').HarnessMode} HarnessMode */
/** @typedef {import('../index.js').HarnessCapabilities} HarnessCapabilities */

export const MODES = /** @type {const} */ ([
  'copilot-sdk',
  'copilot-studio-3p',
  'copilot-studio-standard',
  'copilot-studio-s2s',
  'agentic-directline'
]);

/** @type {Record<HarnessMode, HarnessCapabilities>} */
const MATRIX = {
  'copilot-sdk': {
    mode: 'copilot-sdk',
    harness: 'GitHub Copilot CLI harness, in your process (Copilot SDK)',
    support: 'ga',
    identity: ['github-user', 'github-app-installation', 'byok'],
    appOnly: true,
    streaming: 'delta',
    codeTools: true,
    mcp: true,
    skills: true,
    subAgents: true,
    resume: true,
    permissions: 'callback',
    hooks: true,
    notes: [
      'Default permission handler denies shell, file and URL tools; pass permissions: "approve-all" or a handler.',
      'Set runtime.mode = "empty" when one runtime serves many users; give each session its own gitHubToken.',
      'Requires Copilot CLI (bundled with @github/copilot-sdk) and a Copilot subscription, an org-billed GitHub App/Actions token, or BYOK.'
    ],
    sources: [
      'https://github.com/github/copilot-sdk/tree/main/docs',
      'https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/'
    ]
  },
  'copilot-studio-3p': {
    mode: 'copilot-studio-3p',
    harness: 'Copilot Studio GitHub Copilot harness agent, via Agentic Runtime /3p',
    support: 'experimental',
    identity: ['entra-delegated'],
    appOnly: false,
    streaming: 'typing',
    codeTools: false,
    mcp: 'on-agent',
    skills: 'on-agent',
    subAgents: 'on-agent',
    resume: true,
    permissions: 'none',
    hooks: false,
    notes: [
      'Microsoft Learn (21 Aug 2026): the Copilot Studio client library officially supports standard-harness agents only.',
      'Agent must be published, set to Authenticate with Microsoft, and shared with the signed-in user (unshared → 403).',
      'Token: delegated user token for https://api.powerplatform.com/.default from an app with CopilotStudio.Copilots.Invoke.',
      'Verified live from the copilot-streaming-chat-playground on 5 Aug 2026 (Node) and 6 Aug 2026 (.NET Agent Framework).'
    ],
    sources: [
      'https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/integrate-with-mcs',
      'https://github.com/microsoft/copilot-studio-plugin/blob/main/scripts/src/chat-with-agent.js'
    ]
  },
  'copilot-studio-standard': {
    mode: 'copilot-studio-standard',
    harness: 'Copilot Studio classic (standard-harness) agent, via the Copilot Studio client library',
    support: 'deprecated',
    identity: ['entra-delegated'],
    appOnly: false,
    streaming: 'typing',
    codeTools: false,
    mcp: 'on-agent',
    skills: false,
    subAgents: 'on-agent',
    resume: true,
    permissions: 'none',
    hooks: false,
    notes: [
      'Deprecated in this SDK (policy, 2026-09-07): never create a classic agent; recreate it on the GitHub Copilot harness and use copilot-studio-3p. HarnessClient refuses this mode unless copilotStudio.allowClassicAgent is true. Microsoft still lists the standard harness itself as GA.',
      'The documented path: environmentId + schemaName, delegated Entra token with CopilotStudio.Copilots.Invoke.',
      'App-only tokens are on the roadmap, not available (Microsoft CAT decision guide, updated 2 Aug 2026).'
    ],
    sources: [
      'https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/integrate-with-mcs',
      'https://microsoft.github.io/mcscatblog/posts/copilot-studio-api-decision-guide/'
    ]
  },
  'copilot-studio-s2s': {
    mode: 'copilot-studio-s2s',
    harness: 'Copilot Studio GitHub Copilot harness agent, app-only S2S over /3p',
    support: 'private-preview',
    identity: ['entra-app'],
    appOnly: true,
    streaming: 'typing',
    codeTools: false,
    mcp: 'on-agent',
    skills: 'on-agent',
    subAgents: 'on-agent',
    resume: true,
    permissions: 'none',
    hooks: false,
    notes: [
      'Microsoft must enable S2S Direct-to-Engine for the tenant/environment.',
      'Only agents published with No Authentication; an authenticated agent returns S2SDirectEngineRequiresNoAuthentication.',
      'Needs the Power Platform API application permission CopilotStudio.Copilots.Invoke with admin consent, and the agent shared with the app identity.'
    ],
    sources: ['https://github.com/jzh24516/copilot-streaming-chat-playground#no-auth-ghcp-harness--s2s-app-identity-3p']
  },
  'agentic-directline': {
    mode: 'agentic-directline',
    harness: 'Copilot Studio agent, no-auth agentic Direct Line token endpoint (diagnostic)',
    support: 'experimental',
    identity: ['none'],
    appOnly: true,
    streaming: 'final-only',
    codeTools: false,
    mcp: 'on-agent',
    skills: 'on-agent',
    subAgents: 'on-agent',
    resume: true,
    permissions: 'none',
    hooks: false,
    notes: [
      'Observed wire: empty typing, one complete message, turn.complete; no streamType/streamId/streamSequence.',
      'Microsoft Learn lists Native app / Direct Line as not available for GitHub Copilot harness agents (page updated 3 Aug 2026).'
    ],
    sources: [
      'https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-channels-overview',
      'https://github.com/jzh24516/copilot-streaming-chat-playground#direct-line--live-streaming-experimental'
    ]
  }
};

/**
 * @param {string} mode
 * @returns {HarnessCapabilities}
 */
export function capabilitiesFor(mode) {
  const caps = MATRIX[/** @type {HarnessMode} */ (mode)];
  if (!caps) {
    throw new Error(`Unknown harness mode "${mode}". Expected one of: ${MODES.join(', ')}.`);
  }
  // Return a copy so callers cannot mutate the matrix.
  return JSON.parse(JSON.stringify(caps));
}

/** @returns {HarnessCapabilities[]} */
export function allCapabilities() {
  return MODES.map(capabilitiesFor);
}
