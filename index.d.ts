import type { CopilotClient, CopilotClientOptions, SessionConfig, Tool, MCPServerConfig, CustomAgentConfig, ProviderConfig, SessionHooks, PermissionHandler } from '@github/copilot-sdk';

export type HarnessMode =
  | 'copilot-sdk'
  | 'copilot-studio-3p'
  | 'copilot-studio-standard'
  | 'copilot-studio-s2s'
  | 'agentic-directline';

export type SupportLevel = 'ga' | 'preview' | 'private-preview' | 'experimental' | 'unsupported' | 'deprecated';
export type Identity = 'github-user' | 'github-app-installation' | 'byok' | 'entra-delegated' | 'entra-app' | 'none';
export type StreamingShape = 'delta' | 'typing' | 'final-only';
export type OnAgent = boolean | 'on-agent';

export interface HarnessCapabilities {
  mode: HarnessMode;
  harness: string;
  support: SupportLevel;
  identity: Identity[];
  appOnly: boolean;
  streaming: StreamingShape;
  codeTools: boolean;
  mcp: OnAgent;
  skills: OnAgent;
  subAgents: OnAgent;
  resume: boolean;
  permissions: 'callback' | 'none';
  hooks: boolean;
  notes: string[];
  sources: string[];
}

export interface CopilotSdkConfig {
  /** Model id or "auto". Required with byok. */
  model?: string;
  /** Appended to the system message. */
  instructions?: string;
  /** Custom tools (see defineTool in @github/copilot-sdk). */
  tools?: Tool<any>[];
  mcpServers?: Record<string, MCPServerConfig>;
  skillDirectories?: string[];
  customAgents?: CustomAgentConfig[];
  hooks?: SessionHooks;
  /** Bring your own key. */
  byok?: ProviderConfig;
  /**
   * "deny" (SDK default), "approve-all", "emit" (raise permission.request
   * events carrying respond() into the active stream and to onEvent), or
   * your own PermissionHandler. With "emit", an unanswered request is denied
   * after 60 s.
   */
  permissions?: 'deny' | 'approve-all' | 'emit' | PermissionHandler;
  /** Client-level GitHub token (sets useLoggedInUser=false). */
  githubToken?: string;
  /** Per-session GitHub token for multi-user runtimes. */
  sessionGithubToken?: string;
  runtime?: {
    /** Connect to a running `copilot --headless --port N` runtime. */
    uri?: string;
    connectionToken?: string;
    cliPath?: string;
    args?: string[];
    /** Environment for a spawned CLI (e.g. COPILOT_GITHUB_TOKEN for installation tokens). */
    env?: Record<string, string>;
    /**
     * "empty" for shared multi-user runtimes; default "copilot-cli". In "empty"
     * mode the SDK requires an explicit availableTools per session; this SDK
     * defaults it to ["custom:*"] (override via session.availableTools).
     */
    mode?: 'empty' | 'copilot-cli';
    /**
     * Session-state directory (default ~/.copilot). Required by the SDK in
     * "empty" mode for spawned runtimes; this SDK defaults it to
     * <tmpdir>/copilot-harness-sdk/empty-mode. Ignored for uri runtimes.
     */
    baseDirectory?: string;
  };
  /** Raw passthrough merged into CopilotClientOptions. */
  client?: CopilotClientOptions;
  /** Raw passthrough merged into SessionConfig. */
  session?: Partial<SessionConfig>;
  /** Per-turn timeout (default 5 minutes). Ends the turn with error TURN_TIMEOUT then idle. */
  turnTimeoutMs?: number;
  /** Called when an onEvent listener throws; listener errors never break a turn. */
  onListenerError?: (error: unknown, event: HarnessEvent) => void;
}

export interface CopilotStudioConfig {
  environmentId?: string;
  /** Case-sensitive agent schema name, e.g. cr123_myAgent_aB3xY. */
  schemaName?: string;
  cloud?: 'Prod' | 'FirstRelease' | 'Test' | 'Preprod' | 'Dev' | 'Exp' | 'Prv';
  /** Override the derived /3p URL (must still pass the guard). /3p modes only. */
  directConnectUrl?: string;
  agentType?: 'Published' | 'Prebuilt';
  /** Returns a bearer token: delegated user token (3p, standard) or app-only (s2s). Called before every turn. */
  getAccessToken?: () => Promise<string>;
  /**
   * copilot-studio-standard only. Classic (standard-harness) agents are deprecated in this SDK and
   * HarnessClient.create refuses the mode unless this is exactly true. Use only for a legacy agent
   * you cannot yet recreate on the GitHub Copilot harness.
   */
  allowClassicAgent?: boolean;
  /** Skip the one-shot /3p preflight (default: run it on new conversations; never on resume). */
  preflight?: boolean;
  diagnostics?: boolean;
  /** agentic-directline only: full token endpoint URL (alternative to environmentId + schemaName). */
  directLineTokenUrl?: string;
  directLineBase?: string;
  userId?: string;
  /** Per-turn timeout: 5 minutes for the client-library modes, 60 s for agentic-directline. */
  turnTimeoutMs?: number;
  /** Called when an onEvent listener throws; listener errors never break a turn. */
  onListenerError?: (error: unknown, event: HarnessEvent) => void;
}

export interface HarnessClientConfig {
  mode: HarnessMode;
  copilotSdk?: CopilotSdkConfig;
  copilotStudio?: CopilotStudioConfig;
}

export interface CreateSessionOptions {
  /** Copilot SDK: stable session id for later resume. */
  sessionId?: string;
  /** Resume: Copilot SDK sessionId or Copilot Studio conversationId. */
  resume?: string;
}

export type EventSource = 'copilot-sdk' | 'copilot-studio';

interface EventBase {
  source: EventSource;
  raw: unknown;
  turn?: number;
}

export type HarnessEvent =
  | (EventBase & { type: 'text.delta'; delta: string; snapshot: string; replaced?: boolean; sequence?: number; streamId?: string; messageId?: string })
  | (EventBase & { type: 'text.final'; text: string; streamId?: string; messageId?: string; model?: string; citations?: unknown; attachments?: unknown[]; suggestedActions?: unknown[] })
  | (EventBase & { type: 'status'; text: string })
  | (EventBase & { type: 'reasoning.delta'; delta: string })
  | (EventBase & { type: 'tool.start'; id: string; name: string; args?: unknown; mcpServer?: string })
  | (EventBase & { type: 'tool.end'; id: string; success: boolean; result?: unknown; error?: unknown })
  | (EventBase & { type: 'permission.request'; request: unknown; sessionId: string; respond: (decision: 'approve' | 'deny') => void })
  | (EventBase & { type: 'usage'; model?: string; inputTokens?: number; outputTokens?: number; cost?: number; byok: boolean })
  | (EventBase & { type: 'context'; currentTokens: number; tokenLimit: number })
  | (EventBase & { type: 'idle'; text: string; aborted?: boolean })
  | (EventBase & { type: 'error'; error: Error; code?: string; statusCode?: number; hint?: string })
  | (EventBase & { type: 'raw' });

export interface SendResult {
  text: string;
  events: HarnessEvent[];
}

export interface StreamOptions {
  timeoutMs?: number;
  /** Copilot SDK only. */
  attachments?: unknown[];
  /** Copilot SDK only. */
  agentMode?: 'interactive' | 'plan' | 'autopilot';
}

export interface HarnessSession {
  id: string;
  conversationId: string;
  mode: HarnessMode;
  /** Copilot Studio modes: greeting events captured while starting the conversation (empty on resume). */
  greeting?: HarnessEvent[];
  /**
   * One turn. Always ends with `idle`; error paths yield `error` then `idle`.
   * Breaking out early aborts the turn and cleans up. Turns on one session are serialized.
   */
  stream(prompt: string, opts?: StreamOptions): AsyncIterableIterator<HarnessEvent>;
  /** Waits for the turn; returns the final text. Throws only when no text arrived and an error did. */
  send(prompt: string, opts?: StreamOptions): Promise<SendResult>;
  abort(): Promise<void>;
  close(): Promise<void>;
  native: unknown;
}

export interface PreflightResult {
  ok: boolean;
  mode: HarnessMode | string;
  elapsedMs: number;
  endpoint?: string;
  status?: number;
  details?: unknown;
}

export interface CreateDeps {
  /** Copilot Studio modes: replaces the client-library constructor. */
  clientFactory?: (settings: any, token: string) => any;
  /** Copilot Studio modes: replaces global fetch. */
  fetchImpl?: typeof fetch;
  /** copilot-sdk mode: an object shaped like the @github/copilot-sdk module. */
  sdk?: unknown;
}

export declare class HarnessClient {
  readonly config: HarnessClientConfig;
  readonly mode: HarnessMode;
  static create(config: HarnessClientConfig, deps?: CreateDeps): Promise<HarnessClient>;
  capabilities(): HarnessCapabilities;
  describe(): string;
  preflight(): Promise<PreflightResult>;
  createSession(opts?: CreateSessionOptions): Promise<HarnessSession>;
  onEvent(listener: (event: HarnessEvent) => void): () => void;
  listSessions(): Promise<unknown[]>;
  deleteSession(id: string): Promise<void>;
  readonly native: CopilotClient | undefined;
  readonly resolved: unknown;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export declare function createHarnessClient(config: HarnessClientConfig, deps?: CreateDeps): Promise<HarnessClient>;
export declare function validateConfig(config: HarnessClientConfig): string[];
export declare function recommendMode(facts: {
  hasGithubIdentity?: boolean;
  hasByok?: boolean;
  hasCopilotStudioAgent?: boolean;
  agentHarness?: 'github-copilot' | 'standard';
  hasDelegatedEntraToken?: boolean;
  hasAppOnlyEntraCredentials?: boolean;
  agentAuthentication?: 'microsoft' | 'none';
  /** Only with this exactly true will recommendMode ever answer copilot-studio-standard. */
  allowClassicAgent?: boolean;
}): { mode: HarnessMode; why: string };

/** The refusal sentence validateConfig / HarnessClient.create emit for a classic agent. */
export declare const CLASSIC_REFUSAL: string;

// ---------------------------------------------------------------------------
// Harness guard: classify a Copilot Studio agent by its Dataverse bot record and
// refuse classic (standard-harness) agents. See src/harness-guard.js.
export type AgentHarness = 'github-copilot' | 'classic' | 'unknown';
export interface HarnessClassification {
  harness: AgentHarness;
  /** e.g. cliagent-1.0.0 (harness) or default-2.1.0 (classic). */
  template: string;
  /** e.g. CLICopilotRecognizer (harness) or GenerativeAIRecognizer (classic). */
  recognizer: string;
  model: string;
  instructionChars: number;
  authoringModel: string;
}
export declare const HARNESS_TEMPLATE: RegExp;
export declare const HARNESS_RECOGNIZERS: readonly string[];
export declare class ClassicAgentError extends Error {
  code: 'CLASSIC_AGENT' | 'NO_INSTRUCTIONS';
  classification?: HarnessClassification;
}
export declare function classifyBot(bot: { template?: string | null; configuration?: string | Record<string, unknown> | null }): HarnessClassification;
export declare function assertHarnessBot(bot: { template?: string | null; configuration?: string | Record<string, unknown> | null; name?: string; schemaname?: string }, opts?: { requireInstructions?: boolean }): HarnessClassification;
export interface InspectAgentOptions {
  /** Dataverse org URL, e.g. https://<org>.crm.dynamics.com/ */
  environmentUrl: string;
  schemaName?: string;
  botId?: string;
  /** Bearer token for the Dataverse org (e.g. az account get-access-token --resource <environmentUrl>). */
  getDataverseToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}
export declare function inspectAgentHarness(opts: InspectAgentOptions): Promise<HarnessClassification & { bot: { botid: string; name: string; schemaname: string; publishedon: string | null; authenticationmode: number } }>;
export declare function assertHarnessAgent(opts: InspectAgentOptions & { requireInstructions?: boolean; requirePublished?: boolean }): ReturnType<typeof inspectAgentHarness>;

export declare const MODES: readonly HarnessMode[];
export declare function capabilitiesFor(mode: HarnessMode | string): HarnessCapabilities;
export declare function allCapabilities(): HarnessCapabilities[];

export declare const CLOUD_SUFFIX: Record<'Prod' | 'FirstRelease' | 'Test' | 'Preprod' | 'Dev' | 'Exp' | 'Prv', string>;
export declare function environmentHost(environmentId: string, cloud?: keyof typeof CLOUD_SUFFIX): string;
export declare function powerPlatformScope(cloud?: keyof typeof CLOUD_SUFFIX): string;
export declare function build3pUrl(opts: { environmentId: string; schemaName: string; cloud?: keyof typeof CLOUD_SUFFIX }): string;
export declare function buildAgenticDirectLineTokenUrl(opts: { environmentId: string; schemaName: string; cloud?: keyof typeof CLOUD_SUFFIX }): string;
export declare function guard3pUrl(directConnectUrl: string): URL;

export declare class TextAccumulator {
  snapshot: string;
  shape: 'unknown' | 'delta' | 'cumulative';
  chunks: number;
  lastReplaced: boolean;
  streamId: string | undefined;
  finalized: boolean;
  reset(): void;
  push(text: string, opts?: { mode?: 'delta' | 'cumulative' | 'auto'; streamId?: string }): string;
  finalize(text: string | undefined): string;
}
export declare function normalizeStudioActivity(activity: unknown, acc: TextAccumulator): HarnessEvent[];
export declare function createEventQueue<T>(opts?: { onReturn?: () => void }): { push(item: T): void; close(err?: Error): void; readonly closed: boolean; iterator(): AsyncIterableIterator<T> };
export declare function safeEmit(listeners: Iterable<(event: HarnessEvent) => void>, event: HarnessEvent, onListenerError?: (err: unknown, event: HarnessEvent) => void): void;
export declare function createSdkEventMapper(opts?: { turn?: number }): {
  readonly snapshot: string;
  readonly finalText: string;
  map(event: { type: string; data?: any }): { event: HarnessEvent; done: boolean };
};

export declare function staticToken(token: string): () => Promise<string>;
export declare function createDeviceCodeTokenProvider(
  opts: { clientId: string; tenantId: string; cloud?: keyof typeof CLOUD_SUFFIX; scopes?: string[]; onDeviceCode?: (message: string) => void },
  deps?: { pcaFactory?: (config: any) => any; now?: () => number }
): () => Promise<string>;
export declare function createClientCredentialTokenProvider(
  opts: { clientId: string; tenantId: string; clientSecret: string; cloud?: keyof typeof CLOUD_SUFFIX; scopes?: string[] },
  deps?: { ccaFactory?: (config: any) => any; now?: () => number }
): () => Promise<string>;

export declare function resolveStudioConnection(mode: HarnessMode, config: CopilotStudioConfig): { settings?: Record<string, unknown>; conversationsUrl?: URL; tokenUrl?: string };
export declare function preflight3p(conversationsUrl: URL, token: string, fetchImpl?: typeof fetch): Promise<PreflightResult>;
export declare function explainStatus(status: number, detail?: string): string;

// ---------------------------------------------------------------------------
// Harness admin: the operations that have no `pac copilot` verb. Dataverse Web API, see src/harness-admin.js.
export interface DataverseOptions {
  /** Dataverse org URL, e.g. https://<org>.crm.dynamics.com/ */
  environmentUrl: string;
  getDataverseToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}
export type AgentRef = { schemaName: string; botId?: string } | { schemaName?: string; botId: string };
export declare const ACCESS_CONTROL_POLICY: { readonly Any: 0; readonly AgentReaders: 1; readonly GroupMembership: 2; readonly AnyMultiTenant: 3 };
export declare const CHANNELS: { readonly Teams: 'MsTeams'; readonly Microsoft365Copilot: 'Microsoft365Copilot' };
export declare function resolveHarnessBot(opts: DataverseOptions & AgentRef): Promise<{ botid: string; name: string; schemaname: string; template: string; configuration: string; accesscontrolpolicy: number; authorizedsecuritygroupids: string | null; publishedon: string | null }>;
export declare function shareAgent(opts: DataverseOptions & AgentRef & ({ userId: string; teamId?: undefined } | { teamId: string; userId?: undefined }) & { access?: string }): Promise<{ botId: string; principal: string; access: string }>;
export declare function setAccessControl(opts: DataverseOptions & AgentRef & { policy: keyof typeof ACCESS_CONTROL_POLICY; securityGroupIds?: string[] }): Promise<{ botId: string; policy: string; securityGroupIds: string[] }>;
export declare function setChannels(opts: DataverseOptions & AgentRef & { channels: Array<keyof typeof CHANNELS> }): Promise<{ botId: string; channels: string[] }>;
export declare function upsertEnvironmentVariable(opts: DataverseOptions & { schemaName: string; displayName?: string; type?: 'String' | 'Number' | 'Boolean' | 'JSON' | 'DataSource' | 'Secret'; defaultValue?: string; value?: string; description?: string }): Promise<{ schemaName: string; definitionId: string; valueId: string | null }>;
export declare function listComponents(opts: DataverseOptions & AgentRef): Promise<Array<{ schemaName: string; name: string; displayName: string; kind: string; componentType: number }>>;
