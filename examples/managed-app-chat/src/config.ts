// Everything a maker changes lives in this file.

export const CONFIG = {
  /** Shown at the top of the side bar and in the browser tab. */
  appName: 'Chat Assistant',
  /** One short line under the name. */
  tagline: 'GitHub Copilot harness agent',
  /** The agent's schema name in Copilot Studio (Settings > Advanced > Metadata). */
  agentId: 'cr8c1_VendorContractRenewalCopilot',
  /** What people call the agent. */
  agentName: 'Vendor Contract Renewal Copilot',
  /** Shown on an empty chat. Keep to four. */
  starters: [
    'Compare ACME-2023-014 against ACME-2026-014-DRAFT and flag pricing and SLA changes',
    'Produce the risk report for ACME-2023-014 -> ACME-2026-014-DRAFT',
    'Which clauses does the Federal Acquisition Regulation require for option periods?',
    'Explain what you can help me with',
  ],
  /**
   * The Agents connector starts a new agent run for every message, so the app
   * sends the recent turns along with each new message. These cap how much.
   */
  memoryTurns: 6,
  memoryChars: 6000,
  /** How long to wait for one answer before giving up. */
  answerTimeoutMs: 5 * 60_000,
} as const
