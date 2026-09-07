import type { CopilotClient, CopilotClientOptions, SessionConfig, Tool, MCPServerConfig, CustomAgentConfig, ProviderConfig, SessionHooks, PermissionHandler } from '@github/copilot-sdk';

export type HarnessMode =
  | 'copilot-sdk'
  | 'copilot-studio-3p'
  | 'copilot-studio-standard'
  | 'copilot-studio-s2s'
  | 'agentic-directline';

export type SupportLevel = 'ga' | 'preview' | 'private-preview' | 'experimental' | 'unsupported';
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
   * events carrying respond()), or your own PermissionHandler.
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
    env?: Record<string, string>;
    /**
     * "empty" for shared multi-user runtimes; default "copilot-cli". In "empty"
     * mode the SDK requires an explicit availableTools per session; this SDK
     * defaults it to ["custom:*"] (override via session.availableTools).
     */
    mode?: 'empty' | 'copilot-cli';
    /**
     * Session-state directory (default ~/.copilot). Required by the SDK in
     * "empty" mode; this SDK defaults it to <tmpdir>/copilot-harness-sdk/empty-mode.
     */
    baseDirectory?: string;
  };
  /** Raw passthrough merged into CopilotClientOptions. */
  client?: CopilotClientOptions;
  /** Raw passthrough merged into SessionConfig. */
  session?: Partial<SessionConfig>;
  turnTimeoutMs?: number;
}

export interface CopilotStudioConfig {
  environmentId?: string;
  /** Case-sensitive agent schema name, e.g. cr123_myAgent_aB3xY. */
  schemaName?: string;
  cloud?: 'Prod' | 'FirstRelease' | 'Test' | 'Preprod' | 'Dev' | 'Exp' | 'Prv';
  /** Override the derived /3p URL (must still pass the guard). */
  directConnectUrl?: string;
  agentType?: 'Published' | 'Prebuilt';
  /** Returns a bearer token: delegated user token (3p, standard) or app-only (s2s). */
  getAccessToken?: () => Promise<string>;
  /** Skip the one-shot /3p preflight (default: run it). */
  preflight?: boolean;
  diagnostics?: boolean;
  /** agentic-directline only */
  directLineTokenUrl?: string;
  directLineBase?: string;
  userId?: string;
  turnTimeoutMs?: number;
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
  | (EventBase & { type: 'text.delta'; delta: string; snapshot: string; sequence?: number; streamId?: string; messageId?: string })
  | (EventBase & { type: 'text.final'; text: string; streamId?: string; messageId?: string; model?: string; citations?: unknown; attachments?: unknown[]; suggestedActions?: unknown[] })
  | (EventBase & { type: 'status'; text: string })
  | (EventBase & { type: 'reasoning.delta'; delta: string })
  | (EventBase & { type: 'tool.start'; id: string; name: string; args?: unknown; mcpServer?: string })
  | (EventBase & { type: 'tool.end'; id: string; success: boolean; result?: unknown; error?: unknown })
  | (EventBase & { type: 'permission.request'; request: unknown; sessionId: string; respond: (decision: 'approve' | 'deny') => void })
  | (EventBase & { type: 'usage'; model?: string; inputTokens?: number; outputTokens?: number; cost?: number; byok: boolean })
  | (EventBase & { type: 'context'; currentTokens: number; tokenLimit: number })
  | (EventBase & { type: 'idle'; text: string })
  | (EventBase & { type: 'error'; error: Error; code?: string; statusCode?: number })
  | (EventBase & { type: 'raw' });

export interface SendResult {
  text: string;
  events: HarnessEvent[];
}

export interface HarnessSession {
  id: string;
  conversationId: string;
  mode: HarnessMode;
  /** Copilot Studio modes: greeting events captured while starting the conversation. */
  greeting?: HarnessEvent[];
  stream(prompt: string, opts?: { timeoutMs?: number; attachments?: unknown[]; agentMode?: 'interactive' | 'plan' | 'autopilot' }): AsyncIterableIterator<HarnessEvent>;
  send(prompt: string, opts?: { timeoutMs?: number }): Promise<SendResult>;
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

export declare class HarnessClient {
  readonly config: HarnessClientConfig;
  readonly mode: HarnessMode;
  static create(config: HarnessClientConfig, deps?: { clientFactory?: (settings: any, token: string) => any; fetchImpl?: typeof fetch }): Promise<HarnessClient>;
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

export declare function createHarnessClient(config: HarnessClientConfig, deps?: { clientFactory?: any; fetchImpl?: typeof fetch }): Promise<HarnessClient>;
export declare function validateConfig(config: HarnessClientConfig): string[];
export declare function recommendMode(facts: {
  hasGithubIdentity?: boolean;
  hasByok?: boolean;
  hasCopilotStudioAgent?: boolean;
  agentHarness?: 'github-copilot' | 'standard';
  hasDelegatedEntraToken?: boolean;
  hasAppOnlyEntraCredentials?: boolean;
  agentAuthentication?: 'microsoft' | 'none';
}): { mode: HarnessMode; why: string };

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
  push(text: string, opts?: { mode?: 'delta' | 'cumulative' | 'auto' }): string;
  finalize(text: string): string;
}
export declare function normalizeStudioActivity(activity: unknown, acc: TextAccumulator): HarnessEvent[];
export declare function createEventQueue<T>(): { push(item: T): void; close(err?: Error): void; readonly closed: boolean; iterator(): AsyncIterableIterator<T> };

export declare function staticToken(token: string): () => Promise<string>;
export declare function createDeviceCodeTokenProvider(opts: { clientId: string; tenantId: string; cloud?: keyof typeof CLOUD_SUFFIX; scopes?: string[]; onDeviceCode?: (message: string) => void }): () => Promise<string>;
export declare function createClientCredentialTokenProvider(opts: { clientId: string; tenantId: string; clientSecret: string; cloud?: keyof typeof CLOUD_SUFFIX; scopes?: string[] }): () => Promise<string>;

export declare function resolveStudioConnection(mode: HarnessMode, config: CopilotStudioConfig): { settings?: Record<string, unknown>; conversationsUrl?: URL; tokenUrl?: string };
export declare function preflight3p(conversationsUrl: URL, token: string, fetchImpl?: typeof fetch): Promise<PreflightResult>;
export declare function explainStatus(status: number, detail?: string): string;
