# Copilot Harness and SDK Map

A verified reference for the three things Microsoft and GitHub call a "harness", the packages that sit on top of them, how they map to each other, and what you can actually build on today without guessing.

- **Verified as of:** 6 September 2026. Every claim links to the source it came from. Dates in brackets are the source page's own published/updated date.
- **Conventions:** `GA` = generally available. `Preview` = production-ready preview or preview per the vendor. `Experimental` = works but not a documented support contract. `Verified here` = exercised live from this repository (dates in the README).
- **Canonical copy:** this Markdown file. The HTML rendering at `docs/ghcp-harness-copilot-sdk-reference.html` is generated from it.
- **Provenance:** live verifications described as "this repository" or "the playground" were performed in the public [jzh24516/copilot-streaming-chat-playground](https://github.com/jzh24516/copilot-streaming-chat-playground) (its README dates them); this repo holds the SDK built from those findings.

---

## 1. The five things people conflate

| Letter | Thing | What it is | Where it runs | Status |
| --- | --- | --- | --- | --- |
| **A** | **GitHub Copilot CLI harness** | The agent runtime behind Copilot CLI: agent loop, tool calling, permissions, MCP, skills, custom sub-agents, sessions, compaction. Exposed over JSON-RPC by `copilot --headless`. | Your machine, your container, or GitHub-hosted compute ("cloud sessions"). | GA. CLI v1.0.83 released 4 Sep 2026 ([releases](https://github.com/github/copilot-cli/releases)); local install on this machine is 1.0.84. |
| **B** | **GitHub Copilot SDK** | Programmatic access to A from Node, Python, Go, .NET, Java, Rust. Manages the CLI process for you or connects to a running one. | Same as A. | GA since 2 Jun 2026 ([changelog](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)). Latest v1.0.13, 4 Sep 2026. |
| **C** | **Agent Framework GitHub Copilot provider** | Wraps B as a standard Agent Framework `AIAgent` so you get instructions, tools, streaming, middleware, OpenTelemetry, and approval on top of the SDK's loop. This is what the seed blog post is about. | Same as A. | .NET package `Microsoft.Agents.AI.GitHub.Copilot` 1.20.0 (stable). Python `agent-framework-github-copilot` 1.0.3. Go via `provider/copilotprovider`. Blog dated 4 Aug 2026 ([devblogs](https://devblogs.microsoft.com/agent-framework/build-production-ready-agents-with-the-github-copilot-harness-and-agent-framework/)). |
| **D** | **Copilot Studio "GitHub Copilot harness"** | Microsoft-hosted runtime for Copilot Studio agents and workflows. Natural-language authoring, connectors, MCP, skills, memory, native Office file editing, sandboxed execution, Copilot Credits billing. Config artifacts (`cli-copilot` authoring mode, `CLICopilotRecognizer`) show it is the CLI agentic loop hosted by Copilot Studio. | Microsoft cloud (Power Platform environment). | GA 3 Aug 2026; credit billing for all such agents from 1 Sep 2026 ([Learn: harnesses](https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview) [updated 5 Sep 2026]). |
| **E** | **Copilot Studio client library / Agent Framework Copilot Studio provider** | Client for calling a *published* Copilot Studio agent from your code (Direct-to-Engine). Not a harness. | Your code, calling D or a standard-harness agent. | `Microsoft.Agents.CopilotStudio.Client` 1.9.28-beta; `@microsoft/agents-copilotstudio-client` 1.8.1; `microsoft-agents-copilotstudio-client` 1.6.0; `Microsoft.Agents.AI.CopilotStudio` 1.20.0-preview.260831.1; `agent-framework-copilotstudio` 1.0.0b260813. Officially supports **standard-harness agents only** ([Learn, 21 Aug 2026](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/integrate-with-mcs)). |

**The one sentence that resolves the confusion.** A/B/C give you the agent loop *inside your process* under GitHub identity and billing; D gives you a Microsoft-managed SaaS agent, named after the same harness, under Entra identity, Power Platform governance, and Copilot Credits. E is how code talks to D, and today it is only officially supported for the *standard* harness.

**What is documented versus inferred about A and D.** No Microsoft page states that the Copilot Studio harness *is* the Copilot CLI runtime. The evidence that they share a lineage is the name, the `cli-copilot` authoring mode that `pac copilot init` uses for it, the `CLICopilotRecognizer` / `CLIAgentRecognizer` recognizer kinds in `settings.mcs.yml`, and Microsoft's own plugin calling these "CLI (agentic-loop) agents". Treat "same runtime" as an inference; treat "different surface, identity, billing, and API" as documented. The independent verification pass run for this document reached the same conclusion ("no verified source states they are the same runtime").

Microsoft's own definition of a harness: "a runtime that exists between the two [your design and the model]: it determines when to call the model, what components to send it, interprets what comes back, and calls the right tools." ([Learn: Harnesses in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview))

The blog's split of responsibilities between B and C: "Copilot owns the agent loop (model calls, tool invocation, planning, and session state) while Agent Framework gives you a consistent surface for instructions, tools, streaming, middleware, observability, and human-in-the-loop approval." ([devblogs, 4 Aug 2026](https://devblogs.microsoft.com/agent-framework/build-production-ready-agents-with-the-github-copilot-harness-and-agent-framework/))

---

## 2. Capability map: the same idea in each surface

Read across a row to find the equivalent concept. "—" means the surface does not expose it.

| Capability | A/B: Copilot SDK (session config, TS names) | C: Agent Framework GitHub Copilot provider | D: Copilot Studio GitHub Copilot harness |
| --- | --- | --- | --- |
| Instructions / persona | `systemMessage` (mode `append` or replace) | `instructions:` (.NET `AsAIAgent(instructions:)`, Python `GitHubCopilotAgent(instructions=)`); .NET `SystemMessageConfig { Mode = SystemMessageMode.Append }` | **Build** tab → Instructions (natural-language authoring, preview) |
| Custom function tools | `tools: [...]` (name, description, JSON schema, handler) | .NET `AIFunctionFactory.Create(...)`; Python plain callables / `@tool` | — (no code tools; use Connectors, MCP servers, Workflows) |
| Approval-gated tool | `hooks.onPreToolUse` returning `"ask"` → `onPermissionRequest` | .NET `new ApprovalRequiredAIFunction(fn)`; Python `@tool(approval_mode="always_require")`. Installs a default `OnPreToolUse` hook unless you supply your own. | Governed by Copilot Studio sandbox, sharing, and DLP; no per-tool approval hook exposed |
| Built-in shell / file / URL tools | Present in `mode: "copilot-cli"` (default); absent in `mode: "empty"`; gated by `onPermissionRequest` | Same; default is deny-all until you supply a permission handler | Native Word/Excel/PowerPoint/PDF create/edit in a "secure sandbox governed by Copilot Studio" |
| MCP servers | `mcpServers: { name: { type: "stdio"|"http"|"sse", command/args or url, headers, tools: ["*"], timeout } }`; `disabledMcpServers` | .NET `SessionConfig.McpServers` with `McpStdioServerConfig` / `McpHttpServerConfig`; Python `default_options["mcp_servers"]` | **Build → Tools → Add a tool → Model Context Protocol (MCP)** tab; certification available |
| Skills | `skillDirectories: [...]` (folders containing `SKILL.md`), `disabledSkills` | Python: pass `skill_directories` through `default_options` (forwarded to `create_session`) | Skills: `SKILL.md` with YAML front matter (name, description) plus optional files, uploaded as a ZIP package |
| Sub-agents | `customAgents: [{ name, prompt, description, tools, mcpServers, skills, model, reasoningEffort, infer }]`; `agent:` to pre-select; `agents/*.md` in plugin dirs | Not surfaced in provider docs (passes through `default_options` in Python) | **Connected agents**: "you can currently only connect other agents built in Copilot Studio" |
| Parallel fan-out | Fleet mode: `session.rpc.fleet.start({ prompt })`, `subagent.*` events | — | — |
| Memory across conversations | Session persistence: `sessionId`, `client.resumeSession(id)`, state under `~/.copilot/session-state/{id}` | `AgentSession` / `agent.CreateSessionAsync(existingId)`; Python `agent.get_session(service_session_id=)` | **Memory (preview)**: per-user store, private to the user, deleted after 28 days of inactivity, off in group chats and Teams channels |
| Long-running context | `infiniteSessions: { enabled, backgroundCompactionThreshold, bufferExhaustionThreshold }`; `session.compaction_*` events | Inherited from SDK | Managed by the service |
| Model choice | `model: "auto" | "<id>"`; `capi.autoTier: efficiency|balance|intelligence`; `reasoningEffort` | `GITHUB_COPILOT_MODEL` env or `default_options={"model": ...}` | **Build → Model** list; admin gates for preview/experimental models and for external providers (Anthropic, Mistral, xAI) |
| Bring your own model key | `provider: { type: "openai"|"azure"|"anthropic", baseUrl, apiKey | bearerToken | bearerTokenProvider, wireApi: "completions"|"responses" }` | Python `GitHubCopilotOptions(provider=ProviderConfig)`; model must also be set at session level | — (models are Microsoft-hosted or admin-enabled external providers) |
| Streaming | `streaming: true`; `assistant.message_delta` and 40+ other events | `RunStreamingAsync` → `AgentResponseUpdate`; Python `agent.run(..., stream=True)` | Channel livestreaming; over `/3p` SSE as `typing` activities (see §7) |
| Permissions | `onPermissionRequest(request, invocation)` → `PermissionDecision` (approve once / reject / user not available) | .NET `PermissionDecision.ApproveOnce()` / `.Reject()`; Python `PermissionHandler.approve_all` or custom | Agent sharing, Entra auth mode, DLP policies, admin settings |
| Hooks | `onPreToolUse`, `onPostToolUse`, `onPostToolUseFailure`, `onUserPromptSubmitted`, `onUserPromptTransformed`, `onSessionStart`, `onSessionEnd`, `onErrorOccurred`, `onAgentStop` | `SessionConfig.Hooks` (.NET) / `on_pre_tool_use` (Python); supplying your own pre-tool hook disables the provider's default approval hook | — |
| Identity and billing | GitHub user token (`gho_`, `ghu_`, `github_pat_`), GitHub App installation token (org-billed), or BYOK (provider-billed). AI credits. | Same as SDK | Entra user (delegated) or no-auth; Copilot Credits from build time onward |
| Observability | OpenTelemetry guide; `assistant.usage`, `session.usage_info`, `session.usage.getMetrics()`, `account.getQuota()` | OTel built in: Python `configure_otel_providers()`; .NET via Agent Framework telemetry | **Monitor** tab; credit consumption per agent; PPAC licensing view |
| Hosting | Bundled CLI, local CLI, headless TCP server, Docker/Kubernetes, Azure with shared session storage, GitHub cloud sessions | Same, plus Agent Framework hosting/workflows | Microsoft-managed |

Sources for this table: SDK docs ([getting-started](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/getting-started.md), [features](https://github.com/github/copilot-sdk/tree/main/docs/features), [hooks](https://github.com/github/copilot-sdk/tree/main/docs/hooks), [auth](https://github.com/github/copilot-sdk/tree/main/docs/auth), [setup](https://github.com/github/copilot-sdk/tree/main/docs/setup)); Agent Framework provider page ([Learn, updated 25 Aug 2026](https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/agent-services/github-copilot)); Copilot Studio agents-experience pages ([overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/overview), [tools](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/tools-available), [skills](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/skills-overview), [memory](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/memory-overview), [connected agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/authoring-add-other-agents), [model](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/authoring-select-agent-model)).

---

## 3. GitHub Copilot SDK (B): what it is and how to drive it

### 3.1 Packages and prerequisites

| Language | Package | Install | CLI bundled? |
| --- | --- | --- | --- |
| Node / TypeScript | `@github/copilot-sdk` (1.0.13) | `npm install @github/copilot-sdk` | Yes |
| Python | `github-copilot-sdk` (1.0.13, Python ≥ 3.11) | `pip install github-copilot-sdk` | Yes |
| .NET | `GitHub.Copilot.SDK` (1.0.13-preview.2 on the feed used here) | `dotnet add package GitHub.Copilot.SDK` | Yes |
| Go | `github.com/github/copilot-sdk/go` | `go get github.com/github/copilot-sdk/go` | No (bundled runtime by default per Learn; install CLI otherwise) |
| Java | `com.github:copilot-sdk-java` | Maven/Gradle | No |
| Rust | `github-copilot-sdk` | `cargo add github-copilot-sdk` | No |

- License MIT. "All SDKs communicate with the Copilot CLI server via JSON-RPC." SDK and CLI negotiate protocol versions at startup; SDK protocol range v2–v3, CLI v3 fully supported, v2 via adapters ([compatibility](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/troubleshooting/compatibility.md)).
- Who can use it: "all existing GitHub Copilot subscribers, including Copilot Free for personal use, and non-Copilot users via BYOK" ([GA changelog, 2 Jun 2026](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)).
- Security note from Microsoft Learn: "it is recommended to run agents with shell or file permissions in a containerized environment (Docker/Dev Container)."

### 3.2 First program (TypeScript)

```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
const session = await client.createSession({ model: "auto" });
const response = await session.sendAndWait({ prompt: "What is 2 + 2?" });
console.log(response?.data.content);

await client.stop();
```

.NET equivalent uses `CopilotClient`, `CreateSessionAsync(new SessionConfig { Model = "auto", OnPermissionRequest = PermissionHandler.ApproveAll })`, and `SendAndWaitAsync(new MessageOptions { Prompt = ... })`. Python uses `CopilotClient()`, `await client.start()`, `create_session(on_permission_request=PermissionHandler.approve_all, model="auto")`, `send_and_wait(...)`. ([getting-started](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/getting-started.md))

### 3.3 Client options (process-level)

| Option (TS name) | Meaning | Source |
| --- | --- | --- |
| default constructor | SDK spawns and manages the bundled CLI | getting-started |
| `connection: RuntimeConnection.forUri("host:port")` | Attach to a running `copilot --headless --port N` server; share one runtime across many client instances | backend-services, multi-tenancy |
| `RuntimeConnection.forStdio({ args: ["--plugin-dir", ...] })` | Spawn CLI over stdio with extra args (also how plugin directories are loaded) | plugin-directories, server-to-server |
| `mode: "empty"` | Disable ambient OS tools and CLI defaults; required for shared multi-user runtimes. Default mode is `copilot-cli`. | multi-tenancy |
| `gitHubToken`, `useLoggedInUser: false` | Explicit per-user token (OAuth `gho_`, GitHub App `ghu_`, fine-grained PAT `github_pat_`; classic `ghp_` not supported) | authenticate, github-oauth |
| `sessionIdleTimeoutSeconds` | Server-wide idle cleanup (15–30 min suggested for chat) | session-persistence, multi-tenancy |
| `builtinPluginDirectories: [...]` | Trusted plugins bundled by the host app | plugin-directories |
| `baseDirectory` / `GITHUB_COPILOT_BASE_DIRECTORY` | Where session state and config live (default `~/.copilot`). Configure on the runtime process, not on a client attaching to an existing runtime. | Learn provider page, multi-tenancy |

Environment variables the runtime reads: `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` (in that order after an explicit token and a direct `GITHUB_COPILOT_API_TOKEN` + `COPILOT_API_URL`), `GITHUB_COPILOT_INTEGRATION_ID` (attribution header `Copilot-Integration-Id`), `COPILOT_PLUGIN_DIR_ONLY=true` (deterministic plugin set). ([authenticate](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/auth/authenticate.md), [cloud-sessions](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/cloud-sessions.md), [plugin-directories](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/plugin-directories.md))

### 3.4 Session options (per conversation)

| Option | Purpose |
| --- | --- |
| `sessionId` | Stable id you choose; enables `client.resumeSession(id)`. Encode tenant/user boundary in it (`user-{id}-{task}`) and enforce ownership before resume/delete. |
| `model`, `reasoningEffort`, `capi.autoTier` | Model routing. `session.setAutoTier("intelligence")` changes tier live. |
| `streaming: true` | Emit ephemeral delta events in real time alongside persisted events. |
| `systemMessage` | Persona/instructions. |
| `tools: [...]` | Custom tools; `isTerminal: true` ends the turn on success (used for context clearing). |
| `availableTools` / `excludedTools` | Allow-list or block tools by pattern, e.g. `["custom:*"]`; review `builtin:*` before granting. `defaultAgent.excludedTools` hides tools from the main agent only. |
| `mcpServers`, `disabledMcpServers` | See §2. |
| `customAgents`, `agent` | Sub-agents; pre-select one. |
| `skillDirectories`, `disabledSkills` | Skills. |
| `hooks` | Nine hook callbacks (§3.6). |
| `onPermissionRequest` | Required to allow shell/file/URL tools at all; default denies. |
| `provider` | BYOK (§3.8). API keys are not persisted; re-supply on resume. |
| `gitHubToken` / `gitHubTokenProvider` | Per-session identity for multi-user servers. Token results must include `expiresIn`. |
| `infiniteSessions` | Automatic compaction thresholds (ratios 0–1). |
| `workingDirectory` | CLI working dir for file tools. |
| `maxAiCredits` | Session budget soft cap; `session_limits_exhausted.requested` asks for a decision. |
| `cloud: { repository: { owner, name, branch? } }` | Run on GitHub-hosted compute via Mission Control; wait for `session.start` with `producer === "copilot-agent"` before sending. |
| `remote: true` | Share a locally hosted session to GitHub web/mobile. |

Sources: [session-persistence](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/session-persistence.md), [multi-tenancy](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/setup/multi-tenancy.md), [custom-agents](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/custom-agents.md), [skills](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/skills.md), [mcp](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/mcp.md), [session-limits](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/session-limits.md), [cloud-sessions](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/cloud-sessions.md), [context-management](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/context-management.md).

### 3.5 The agent loop and its events

"Each iteration of this loop is exactly one LLM API call, visible as one `assistant.turn_start` / `assistant.turn_end` pair." The loop ends with `session.idle` (always emitted, ephemeral, returned by `sendAndWait`). `session.task_complete` is optional, persisted, and requires the model to signal it. ([agent-loop](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/agent-loop.md))

Event envelope: `id`, `timestamp`, `parentId`, `type`, `data`, optional `agentId`, `ephemeral`. Ephemeral events are not replayed on resume; persisted ones are recoverable via `getMessages`.

| Group | Event types ([streaming-events](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/streaming-events.md)) |
| --- | --- |
| Assistant | `assistant.turn_start`, `assistant.intent`, `assistant.reasoning`, `assistant.reasoning_delta`, `assistant.message`, `assistant.message_delta`, `assistant.streaming_delta`, `assistant.turn_end`, `assistant.usage` |
| Tools | `tool.execution_start`, `tool.execution_partial_result`, `tool.execution_progress`, `tool.execution_complete`, `tool.user_requested` |
| Session | `session.idle`, `session.error`, `session.compaction_start`, `session.compaction_complete`, `session.title_changed`, `session.context_changed`, `session.usage_info`, `session.session_limits_changed`, `session.usage_checkpoint`, `session.task_complete`, `session.shutdown` |
| Permission and input | `permission.requested`, `permission.completed`, `user_input.requested`, `user_input.completed`, `elicitation.requested`, `elicitation.completed`, `external_tool.requested`, `external_tool.completed` |
| Sub-agents and skills | `subagent.started`, `subagent.completed`, `subagent.failed`, `subagent.selected`, `subagent.deselected`, `skill.invoked` |
| Control | `abort`, `user.message`, `system.message`, `command.queued`, `command.completed`, `session_limits_exhausted.requested`, `session_limits_exhausted.completed`, `exit_plan_mode.requested`, `exit_plan_mode.completed` |

Subscribe: TS `session.on("assistant.message_delta", e => ...)`; Python `session.on(handler)` and filter on `event.type`; .NET `session.On<AssistantMessageDeltaEvent>(...)`.

### 3.6 Hooks

Nine hooks, registered via `hooks:` in session config ([hooks-overview](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/hooks/hooks-overview.md)): `onPreToolUse`, `onPostToolUse`, `onPostToolUseFailure`, `onUserPromptSubmitted`, `onUserPromptTransformed`, `onSessionStart`, `onSessionEnd`, `onErrorOccurred`, `onAgentStop`.

`onPreToolUse` input: `timestamp`, `cwd`, `toolName`, `toolArgs` (+ invocation `sessionId`). Output: `permissionDecision` (`"allow"` | `"deny"` | `"ask"`), `permissionDecisionReason`, `modifiedArgs`, `additionalContext`, `suppressOutput`. Return `null` to allow unchanged. ([pre-tool-use](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/hooks/pre-tool-use.md))

Permission requests observed live here (SDK 1.0.13 on CLI 1.0.84, 6 Sep 2026, via `sdk/examples/copilot-sdk.mjs`): a custom tool defined with `defineTool` arrives at `onPermissionRequest` as `{ kind: "custom-tool", toolCallId, toolName, toolDescription, ... }`. Returning `{ kind: "approve-once" }` (the value the SDK's own `approveAll` helper returns) let the tool run (`tool.execution_complete` with `success: true`, answer "Order 42 is currently shipped."); returning `{ kind: "denied-interactively-by-user" }` produced `success: false` and the model explained the refusal. `approveAll` throws when managed settings are enabled and returns `{ kind: "no-result" }` when a request is flagged `managedApprovalRequired`. The full `PermissionDecision` union in the 1.0.13 typings: ApproveOnce, ApproveForSession, ApproveForLocation, ApprovePermanently, Reject, UserNotAvailable, Approved, ApprovedForSession, ApprovedForLocation, Cancelled, DeniedByRules, DeniedNoApprovalRuleAndCouldNotRequestFromUser, DeniedInteractivelyByUser, DeniedByContentExclusionPolicy, DeniedByPermissionRequestHook (kind strings are the kebab-case forms, e.g. `approve-once`, `approve-for-session`). Set `skipPermission: true` on a tool definition to bypass the prompt for that tool. `model: "auto"` resolved to `mai-code-1.1-flash` in these runs.

### 3.7 Authentication and licensing

Priority order ([authenticate](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/auth/authenticate.md)):

1. Explicit `gitHubToken` on client or session.
2. Direct API token: `GITHUB_COPILOT_API_TOKEN` with `COPILOT_API_URL`.
3. `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN`.
4. Stored credentials from `copilot` CLI login.
5. `gh auth` credentials.

| Method | Needs Copilot subscription? | Billing | Notes |
| --- | --- | --- | --- |
| Signed-in user (device flow) | Yes (the user's) | User's plan | Default. |
| OAuth App / GitHub App user token | Yes (each user's) | "Copilot usage is billed to each user's subscription" | Your app owns storage/refresh. EMU needs no special config. ([github-oauth](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/setup/github-oauth.md)) |
| Env var token (CI) | Yes | Token owner | Auto-detected. |
| Server-to-server: GitHub Actions `GITHUB_TOKEN` | No user seats | Organization | Needs `permissions: copilot-requests: write` and org policy "Allow use of Copilot CLI billed to the organization". |
| Server-to-server: GitHub App installation token | No user seats | "the account that owns the GitHub App installation" | App permission "Copilot Requests: Read & write"; install with "All repositories"; token request must include `repository_ids` and `permissions.copilot_requests: "write"`; expires in 1 hour; pass via `COPILOT_GITHUB_TOKEN`, **not** the `gitHubToken` option; set `useLoggedInUser: false`. ([server-to-server-tokens](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/auth/server-to-server-tokens.md)) |
| BYOK | No | Your model provider | See §3.8. |

Troubleshooting S2S: `401` = org does not support GitHub App auth; `403 Resource not accessible` = token in wrong env var; `403` from the Copilot API = missing `repository_ids`/permissions or installation lacks "All repositories".

### 3.8 Bring your own key

`provider` shape ([byok](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/auth/byok.md)):

| Field | Values |
| --- | --- |
| `type` | `"openai"` (OpenAI and OpenAI-compatible: Foundry, Ollama, Foundry Local, vLLM, LiteLLM), `"azure"` (native Azure OpenAI), `"anthropic"` |
| `baseUrl` | Required endpoint |
| `apiKey` | Static key (optional for local providers) |
| `bearerToken` / `bearerTokenProvider` | Bearer auth; provider callback takes precedence over both. Used for Microsoft Entra tokens against Foundry (`DefaultAzureCredential`, scope `https://ai.azure.com/.default`, `wireApi: "responses"`, base `{foundryUrl}/openai/v1/`). ([azure-managed-identity](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/setup/azure-managed-identity.md)) |
| `wireApi` | `"completions"` (default) or `"responses"`; Anthropic always uses Messages API |
| `azure.apiVersion` | For versioned Azure routes |
| `model` (session level) | Required with BYOK |

Under BYOK: model availability, rate limits, and usage tracking come from your provider; "Premium requests do not count against Copilot premium request quotas." Keys are not persisted with the session.

**Docs disagree on Entra.** The repository README says "BYOK uses key-based authentication only. Microsoft Entra ID (Azure AD), managed identities, and third-party identity providers are not supported," while `docs/setup/azure-managed-identity.md` documents `bearerTokenProvider` with `DefaultAzureCredential` for Foundry. Treat managed identity as available through the bearer-token path and test it before depending on it.

### 3.9 Running it as a service

- Start the runtime: `copilot --headless --port 4321` (binds loopback; add `--host 0.0.0.0` for other machines). Set `COPILOT_GITHUB_TOKEN` before starting. Add `--session-idle-timeout <seconds>`. There is "no built-in auth between SDK and CLI", so secure the TCP path. ([backend-services](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/setup/backend-services.md))
- Multi-user: one runtime, `mode: "empty"`, unique session ids per user, `gitHubToken` per session, explicit `availableTools`. Session state lives at `COPILOT_HOME/session-state/{sessionId}`; put it on shared storage (Azure Files, NFS, PVC) if any server must resume any session. No built-in session locking or load balancing; CLI is single-process. ([multi-tenancy](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/setup/multi-tenancy.md), [scaling](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/setup/scaling.md))
- Health: `client.getStatus()` (also returns `protocolVersion`). Cleanup: `client.listSessions()` + `client.deleteSession(id)`.
- Usage: `assistant.usage` per model call (`inputTokens`, `outputTokens`, `model`, `cost` multiplier); `session.usage_info` (`currentTokens`, `tokenLimit`); `session.usage.getMetrics()` (`totalNanoAiu`, `totalPremiumRequestCost`, `modelMetrics`); `models.list` (billing multipliers, token prices); `account.getQuota()` (`quotaSnapshots.premium_interactions`, `remainingPercentage`, `resetDate`). Nano-AI units divide by 1e9 for credits. ([usage-and-billing](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/usage-and-billing.md))
- Plugins: a directory with `plugin.json` (or `.github/plugin.json`), optional `SKILL.md`, `hooks.json`, `.mcp.json`, `agents/*.md`, `skills/*/SKILL.md`, `.lsp.json`; loaded with `--plugin-dir` (ephemeral, precedence over marketplace plugins). ([plugin-directories](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/plugin-directories.md))

---

## 4. Agent Framework GitHub Copilot provider (C)

### 4.1 Install and construct

| Language | Package | Construct |
| --- | --- | --- |
| .NET (≥ .NET 8) | `Microsoft.Agents.AI.GitHub.Copilot` 1.20.0 (first stable 1.16.0 on 30 Jul 2026; depends on `GitHub.Copilot.SDK` ≥ 1.0.5) | `await using CopilotClient copilotClient = new(); await copilotClient.StartAsync(); AIAgent agent = copilotClient.AsAIAgent(sessionConfig, ownsClient: true);` or `new GitHubCopilotAgent(copilotClient, instructions: ...)`. `AsAIAgent` has two overloads: `(SessionConfig? sessionConfig = null, bool ownsClient = false, string? id, name, description)` and `(bool ownsClient, id, name, description, IList<AIFunctionDeclaration>? tools, string? instructions)`; it returns `GitHubCopilotAgent : AIAgent, IAsyncDisposable`. There is no `AIAgentOptions` overload; the docs.github.com integration page that shows one (and `--prerelease`) is stale. |
| Python (≥ 3.11) | `agent-framework-github-copilot` 1.0.3, classifier Production/Stable (pins `github-copilot-sdk==1.0.2`) | `async with GitHubCopilotAgent(instructions=..., default_options=GitHubCopilotOptions(...), tools=[...]) as agent: await agent.run(...)` |
| Go | `github.com/microsoft/agent-framework-go` (README: public preview; `go.mod` says go 1.26.0 while Learn says 1.25+) + `github.com/github/copilot-sdk/go` | `copilotprovider.NewAgent(copilotClient, copilotprovider.AgentConfig{ Instructions, SessionConfig, Config: agent.Config{ Tools } })` |

Prerequisites (blog): Copilot CLI installed, active Copilot subscription, authenticated CLI. Python env vars: `GITHUB_COPILOT_CLI_PATH`, `GITHUB_COPILOT_MODEL` (e.g. `gpt-5`, `claude-sonnet-4`), `GITHUB_COPILOT_TIMEOUT` (default 60 s), `GITHUB_COPILOT_LOG_LEVEL`, `GITHUB_COPILOT_BASE_DIRECTORY` (default `~/.copilot`). .NET: `CopilotClientOptions { CliPath, LogLevel, BaseDirectory, WorkingDirectory }`. ([Learn provider page](https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/agent-services/github-copilot))

### 4.2 Canonical .NET sample (from the blog)

```csharp
using GitHub.Copilot;
using GitHub.Copilot.Rpc;
using Microsoft.Agents.AI;

await using CopilotClient copilotClient = new();
await copilotClient.StartAsync();

SessionConfig sessionConfig = new()
{
    OnPermissionRequest = (request, invocation) =>
        Task.FromResult(PermissionDecision.ApproveOnce()),
};

AIAgent agent = copilotClient.AsAIAgent(sessionConfig, ownsClient: true);
AgentResponse response = await agent.RunAsync("Summarize what this project does.");
Console.WriteLine(response);
```

### 4.3 Semantics you must know

- **Default is deny-all.** "By default, the agent cannot execute shell commands, read/write files, or fetch URLs" until you supply `OnPermissionRequest` / `on_permission_request`. Decision types: .NET `PermissionDecision.ApproveOnce()`, `.Reject(feedback?)`, `.UserNotAvailable()` (the default when no handler is set); Python `PermissionHandler.approve_all`, `PermissionDecisionDeniedInteractivelyByUser`, `PermissionDecisionUserNotAvailable`; Go `PermissionDecisionApproveOnce`, `PermissionDecisionReject`, `PermissionDecisionDeniedInteractivelyByUser`.
- **Tool approval runs in the SDK hook, not the framework round-trip.** Wrapping a tool in `ApprovalRequiredAIFunction` (.NET) or `@tool(approval_mode="always_require")` (Python) makes the provider install a default `OnPreToolUse` hook that returns `"ask"` and routes to your permission handler. If you register your own pre-tool hook, that default is **not** installed and you own enforcement; the agent logs a warning naming each approval-required tool.
- **`default_options` is a passthrough** to the SDK's `create_session`: `reasoning_effort`, `context_tier`, `enable_citations`, `provider`, `skill_directories`, `mcp_servers`, etc. Unknown keys raise `TypeError`.
- **Sessions:** .NET `AgentSession session = await agent.CreateSessionAsync(existingSessionId);` Python `session.service_session_id` round-trips through `agent2.get_session(service_session_id=...)`.
- **Context providers (Python):** `context_providers=[InMemoryHistoryProvider()]` run before/after each invocation.
- **Observability:** Python `configure_otel_providers(enable_console_exporters=True)`; `RawGitHubCopilotAgent` for the untraced agent.
- **Tool support table:** Function tools ✅, tool approval ✅, shell/file/URL ✅ (gated), hosted (HTTP) MCP ✅, local (stdio) MCP ✅, code interpreter ❌, file search ❌, web search ❌ ("Not a Copilot CLI capability" / "Not exposed as a hosted tool").
- Samples: .NET `samples/02-agents/AgentProviders/github-copilot`; Python `samples/02-agents/providers/github_copilot` in [microsoft/agent-framework](https://github.com/microsoft/agent-framework). Release cadence at time of writing: `dotnet-1.20.0` (31 Aug 2026), `python-1.17.0` (3 Sep 2026).

### 4.4 What Agent Framework adds versus using the SDK directly

Per the SDK's own integration page ([microsoft-agent-framework.md](https://raw.githubusercontent.com/github/copilot-sdk/main/docs/integrations/microsoft-agent-framework.md)): sequential/concurrent orchestration, multi-provider composition (Copilot beside Azure OpenAI, Anthropic, Copilot Studio), A2A protocol, one `AIAgent` abstraction. The SDK keeps: tool definition, MCP config, custom agents, infinite sessions, model selection, streaming deltas, permissions. Integration packages exist for .NET and Python only; TypeScript, Go (framework has its own provider), Java, and Rust use the SDK directly.

---

## 5. Copilot Studio GitHub Copilot harness (D)

### 5.1 What Microsoft says it is

- "The GitHub Copilot harness is the most capable option, built for reasoning-heavy agents and workflows... it can take a goal, break it into steps, call the right tools across connectors, knowledge, MCP, and connected agents, and adjust when a step fails or a request changes. It natively creates and edits Word, Excel, PowerPoint, and PDF files, supports skills and memory, and runs each task in a secure sandbox governed by Copilot Studio. Agents and workflows on this harness use Copilot Credits." ([harnesses-overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview))
- Three harnesses: GitHub Copilot harness (reasoning-heavy agents and workflows), standard harness (rule-based agents and agent flows), Copilot chat harness (extend Microsoft 365 Copilot Chat).
- Agents cannot be transferred between harnesses; you choose at creation. The GitHub Copilot harness "uses this enhanced orchestration model for all agents" (not configurable). ([agents-experience/overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/overview))
- Timeline: production-ready preview from June 2026; GA announced 3 Aug 2026; usage-based billing in Copilot Credits for all such agents from 1 Sep 2026 (agents created before 3 Aug kept old pricing only until then). ([Tech Community announcement](https://techcommunity.microsoft.com/blog/copilot-studio-blog/more-powerful-agents-and-workflows-for-autonomous-business-processes-introducing/4542969), [billing overview, 27 Aug 2026](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/billing-credit-overview))

### 5.2 Authoring surface

| Tab | Purpose |
| --- | --- |
| Build | Instructions, knowledge, tools, skills, model, memory, connected agents |
| Preview | Interactive test chat (backed by a built-in Direct Line test channel) |
| Evaluate | Test sets to measure quality |
| Monitor | Recent tasks, files accessed, activity, consumed credits |

Components and their exact scope:

- **Tools** = Connectors (Power Platform connectors), MCP servers, Workflows. Added via Build → Tools → Add a tool with Featured / MCP / Connectors / Workflows tabs. ([tools-available](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/tools-available))
- **Skills** = `SKILL.md` (YAML front matter `name`, `description`, Markdown instructions) plus optional scripts/templates/reference docs, packaged as ZIP; authored in Studio or uploaded. Same file format the Copilot SDK/CLI uses for skills. ([skills-overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/skills-overview))
- **Memory (preview)**: per-user folder in Microsoft-managed storage; capture → store → apply; private to the user; deleted after 28 days of inactivity; disabled in group chats and Teams channels; a memory portal link appears on first interaction per channel. ([memory-overview, 27 Jul 2026](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/memory-overview))
- **Connected agents**: "you can currently only connect other agents built in Copilot Studio." ([authoring-add-other-agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/authoring-add-other-agents))
- **Model**: chosen per agent; admins gate preview/experimental models (environment setting plus cross-region data movement) and external providers (Anthropic, Mistral, xAI via Microsoft 365 admin center). ([authoring-select-agent-model](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/authoring-select-agent-model))

### 5.3 Billing

"Copilot credits are charged for large language model (LLM) tokens, tools (including knowledge and MCPs), and the harness itself." "Billing starts when you start building": previewing, testing, and generating evaluations all consume credits, unlike the standard harness which bills after publish. Credits are allocated per environment in the Power Platform admin center. ([billing-credit-overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/billing-credit-overview))

### 5.4 Publishing and channels (as of the 3 Aug 2026 page update)

| Channel | Available for GitHub Copilot harness agents? |
| --- | --- |
| Microsoft 365 Copilot | Yes |
| Microsoft Teams | Yes |
| Demo website | Yes |
| Web app (iframe embed) | Yes |
| SharePoint | No |
| Native app via Direct Line | **No** |
| MCP client | No |
| Facebook, WhatsApp, Slack, Telegram | No |
| Genesys, LivePerson, Salesforce, ServiceNow | No |
| Twilio, Line, GroupMe, Direct Line Speech, Email | No |

Source: [publication-channels-overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-channels-overview). Publishing creates a versioned live copy; DLP policies are evaluated per channel; the built-in Direct Line test channel does not block publishing. ([publication-publish-agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-publish-agent), [publish overview, 31 Aug 2026](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-fundamentals-publish-channels))

---

## 6. Agents as code for the GitHub Copilot harness

The web UI is not the only authoring path. The Power Platform CLI and an experimental Microsoft plugin let you treat a harness agent as files.

### 6.1 Power Platform CLI (`pac copilot`)

Installed locally: `pac` 2.10.1. Subcommands: `list`, `init`, `status`, `pack`, `create`, `publish`, `pull`, `push`, `clone`, `delete`, `quarantine`, `model`, `mcp`, translation helpers. The plugin requires `pac` ≥ 2.9.3 ([copilot-studio-plugin README](https://github.com/microsoft/copilot-studio-plugin)).

- `pac copilot init` with authoring mode `cli-copilot` creates an empty GitHub-Copilot-harness agent workspace in a target environment (the plugin's init sub-agent uses exactly this; publisher prefix defaults to `catmgr`).
- `pac copilot clone` pulls a published agent into a local workspace; `push`/`pull` sync; `publish` publishes.

### 6.2 Workspace files that identify a harness agent

From the plugin's chat script and skills ([chat-with-agent.js](https://github.com/microsoft/copilot-studio-plugin/blob/main/scripts/src/chat-with-agent.js), [commands/chat.md](https://github.com/microsoft/copilot-studio-plugin/blob/main/commands/chat.md)):

| File | Keys that matter |
| --- | --- |
| `settings.mcs.yml` | `schemaName` (the case-sensitive id used in URLs), `displayName`, `configuration.recognizer.kind` = `CLICopilotRecognizer` (newer) or `CLIAgentRecognizer` (older). Anything else, such as `GenerativeAIRecognizer`, is a standard-harness agent. `authenticationMode: Integrated` for Entra-authenticated agents. |
| `.mcs/conn.json` | `EnvironmentId`, `TenantId`, `AgentManagementEndpoint`, `DataverseEndpoint` (the script infers the cloud from these hosts). |
| `agent.mcs.yml` | Present in classic (standard harness) workspaces; the migrate flow looks for it to find a source agent. |

### 6.3 The experimental plugin (`mcs-assistant`)

```text
/plugin marketplace add microsoft/copilot-studio-plugin
/plugin install mcs-assistant@copilot-studio-plugin
```

Works in GitHub Copilot CLI and Claude Code. Provides `/migrate` (clone a classic agent, describe it, approve a migration plan, convert actions to tools, author the new YAML, push) and `/chat` (stream a turn against the published harness agent through the `/3p` route with MSAL device-code sign-in). Sub-agents: architect, describer, init, manage. Disclaimer: "an experimental research project, not an officially supported Microsoft product... not meant for production use."

Related but different: the **Copilot Studio VS Code extension** (GA) and **microsoft/skills-for-copilot-studio** cover the *standard* harness only; the plugin README calls the latter the legacy plugin that "may conflict". ([VS Code extension overview, 24 Jul 2026](https://learn.microsoft.com/en-us/microsoft-copilot-studio/visual-studio-code-extension-overview))

---

## 7. Reaching a harness agent from code: the integration map

### 7.1 Official position

- Copilot Studio client library: "Currently, you can only use the Copilot Studio client library with Copilot Studio agents created by using the standard harness. Agents using the GitHub Copilot harness aren't yet officially supported." ([Learn, 21 Aug 2026](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/integrate-with-mcs))
- Direct Line / native app channel for harness agents: No (§5.4).
- Agent Framework Copilot Studio provider: invokes a published agent and "does not expose Agent Framework tool types... at the client"; capabilities are configured on the Copilot Studio agent. ([Learn](https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/agent-services/copilot-studio))
- Microsoft CAT decision guide (updated 2 Aug 2026): the SDK client "requires delegated (user) authentication through Entra ID, with no service principal auth, app-only tokens, or secure anonymous options"; app-only "is on the roadmap". ([mcscatblog](https://microsoft.github.io/mcscatblog/posts/copilot-studio-api-decision-guide/))

### 7.2 The experimental route that works today: Agentic Runtime `/3p`

Microsoft's own plugin talks to "the agenticruntime '3p' (third-party) Direct-to-Engine endpoint, which is how CLI-authored / agentic-loop agents are served." This repository reproduced it in three stacks.

```text
https://{env-host}/copilotstudio/agenticruntime/3p/dataverse-backed/authenticated/bots/{schemaName}?api-version=1
```

- `{env-host}` = environment GUID with dashes removed, split into the first 30 and last 2 hex characters: `{30}.{2}.environment.api.powerplatform.com` for Prod. Other clouds use `api.test.`, `api.preprod.`, `api.dev.` etc. This repo maps Prod only.
- Token: delegated Entra user token for scope `https://api.powerplatform.com/.default`, from an app registration holding the Power Platform API delegated permission `CopilotStudio.Copilots.Invoke`. Public client (SPA or native) with no secret.
- Agent prerequisites: published, **Authenticate with Microsoft**, and shared with the signed-in user. Unshared → `403`.
- The client library appends `/conversations` and `/conversations/{id}`; keep `api-version=1` pinned. The conversation id also rides the `x-ms-conversationid` response header.
- Streaming shape differs by client: Node `@microsoft/agents-copilotstudio-client` delivered cumulative `typing` snapshots; Agent Framework `CopilotStudioAgent.RunStreamingAsync` delivered delta fragments in `AgentResponseUpdate` with the original activity in `RawRepresentation` (15 fragments consolidated to a 1,164-character answer in the 6 Aug 2026 verification).

| Stack | Package | Verified here |
| --- | --- | --- |
| Node sidecar | `@microsoft/agents-copilotstudio-client` ^1.6.1 with `directConnectUrl` | 5 Aug 2026, real progressive response in Web Chat |
| .NET Agent Framework | `Microsoft.Agents.AI.CopilotStudio` 1.13.0-preview.260703.1 (POC) and 1.19.0-preview.260822.1 (latest mode); both restore `Microsoft.Agents.CopilotStudio.Client` 1.3.171-beta | 6 Aug 2026 (POC); compatibility mode checked 30 Aug 2026 |
| Dynamics 365 side pane | Same Node route behind a hardened relay on App Service | See `docs/dynamics-sidepane-deployment.html` |

### 7.3 What does not work (and the error you will see)

| Attempt | Result |
| --- | --- |
| App-only (client credentials) token against the `/authenticated/` `/3p` route | Rejected; `/3p` requires a delegated token. S2S Direct-to-Engine is a private preview that Microsoft must enable per tenant and only applies to **No Authentication** agents; an authenticated agent returns `S2SDirectEngineRequiresNoAuthentication`. |
| No-auth agentic Direct Line token endpoint (`/copilotstudio/agenticruntime/botsbyschema/{schema}/directline/token`) | Connects and answers, but final-only: empty `typing`, one `message`, `turn.complete`; no `streamType`/`streamId`/`streamSequence`. |
| `401` | Wrong audience, app credential, or preview not enabled. |
| `403` | Missing permission/consent, agent not shared, policy, or S2S ACL. |
| `404` | Wrong environment/schema, unpublished agent, or `/3p` not enabled for this harness. |

### 7.4 Client library connection settings (E)

`ConnectionSettings` in `@microsoft/agents-copilotstudio-client` ([API reference](https://learn.microsoft.com/en-us/javascript/api/@microsoft/agents-copilotstudio-client/connectionsettings?view=agents-sdk-js-latest)):

| Property | Note |
| --- | --- |
| `environmentId`, `schemaName` | Required unless `directConnectUrl` is set |
| `directConnectUrl` | "if provided all other settings are ignored" |
| `cloud` | `PowerPlatformCloud` enum: `Prod`, `FirstRelease`, `Preprod`, `Test`, `Dev`, `Gov`, `GovFR`, `High`, `DoD`, `Mooncake`, `Ex`, `Rx`, `Prv`, `Exp`, `Local`, `Other`, `Unknown` |
| `customPowerPlatformCloud` | Custom cloud URL |
| `copilotAgentType` | `AgentType.Published` or `AgentType.Prebuilt` |
| `useExperimentalEndpoint`, `enableDiagnostics` | Flags |
| `appClientId`, `tenantId`, `authority`, `agentIdentifier` | **Deprecated**; handle auth in your app and use `schemaName` |

.NET equivalents used in this repo's sidecar: `new ConnectionSettings { DirectConnectUrl, Cloud = PowerPlatformCloud.Prod, CopilotAgentType = AgentType.Published }`, `new CopilotClient(settings, httpClientFactory, logger, httpClientName)`, `new CopilotStudioAgent(client, loggerFactory)`.

Python Agent Framework: `pip install agent-framework-copilotstudio --pre`; env `COPILOTSTUDIOAGENT__ENVIRONMENTID`, `__SCHEMANAME`, `__AGENTAPPID`, `__TENANTID`; `CopilotStudioAgent()` and `agent.run(..., stream=True)`. .NET quick form: `new CopilotStudioChatClient(environmentId, agentIdentifier, credential: new AzureCliCredential()).AsAIAgent(...)`.

---

## 8. Decision guide

| You want to... | Use | Identity and billing | Watch out for |
| --- | --- | --- | --- |
| Embed the agent loop in your own app or service, keep tools in your code | **Copilot SDK** (B); add **Agent Framework provider** (C) when you want middleware, OTel, orchestration with other providers, or approval-gated `AIFunction`s | Per-user GitHub token (each user needs Copilot), org-billed GitHub App/Actions token, or BYOK | Default deny-all permissions; containerize when granting shell/file; `mode: "empty"` for shared runtimes |
| Let makers build a governed business agent over M365 data, connectors, MCP, skills, memory, Office files | **Copilot Studio GitHub Copilot harness** (D) | Entra users; Copilot Credits per environment, billed from first build | Consume through M365 Copilot, Teams, demo site, or iframe; no Direct Line; client library not officially supported yet |
| Put a harness agent inside a custom web/Dynamics surface with streaming | `/3p` route via `@microsoft/agents-copilotstudio-client` or `Microsoft.Agents.AI.CopilotStudio` (§7.2) | Delegated Entra token with `CopilotStudio.Copilots.Invoke`; agent shared with each user | Experimental; keep an official channel as fallback; verify support before production |
| Call a harness agent from a daemon with no user present | Not available today (app-only `/3p` rejected; S2S private preview is no-auth only) | — | Track the roadmap item "app-only auth" for the client library |
| Orchestrate a Copilot Studio agent alongside your own SDK-backed agent | Agent Framework with both providers (`Microsoft.Agents.AI.CopilotStudio` + `Microsoft.Agents.AI.GitHub.Copilot`) | Entra delegated for the Studio side; GitHub or BYOK for the SDK side | Studio provider exposes no tools at the client; configure them on the agent |
| Run hundreds of user sessions in one backend | Headless CLI + SDK: `copilot --headless`, `mode: "empty"`, per-session `gitHubToken`, shared `session-state` storage | Per-user or org tokens | No built-in locking, LB, or SDK↔CLI auth; secure the network path |
| Reuse prompts and playbooks across both worlds | `SKILL.md` folders: `skillDirectories` in the SDK, ZIP upload in Copilot Studio | — | Studio skills are Markdown plus optional files; keep scripts portable |
| Move a classic Copilot Studio agent onto the harness | `mcs-assistant` plugin `/migrate` with `pac` ≥ 2.9.3 | Maker identity | Experimental; review generated YAML; agents cannot be switched in place |

---

## 9. Capabilities you can leverage now, and gaps to plan around

**Available now (with the surface that provides it)**

- Streaming token deltas with 40+ typed events, per-call token usage, and account quota (SDK).
- Custom tools with JSON schemas, approval-gated tools, and nine lifecycle hooks (SDK, Agent Framework).
- Local stdio and remote HTTP/SSE MCP servers with per-server tool allow-lists (SDK, Agent Framework, Copilot Studio).
- Sub-agents with scoped tools, per-agent models, fleet-mode parallelism (SDK).
- Skills as `SKILL.md` in both worlds; plugin directories bundling skills, agents, hooks, MCP, LSP (SDK).
- Resumable sessions on disk, infinite sessions with compaction, budget caps (SDK).
- Headless multi-tenant hosting, GitHub-hosted cloud sessions with Mission Control URLs (SDK).
- BYOK to OpenAI, Azure OpenAI/Foundry (including Entra bearer tokens), Anthropic, local OpenAI-compatible servers (SDK).
- Org-billed server-to-server identity without user seats (SDK via GitHub App or Actions).
- Maker-authored agents with connectors, MCP, workflows, skills, per-user memory, native Office file editing, model choice including external providers, evaluation and monitoring (Copilot Studio).
- Delegated-token streaming into custom canvases via `/3p` (verified in this repo, experimental).

**Gaps and caveats**

- Copilot Studio harness agents: no Direct Line/native app channel, no MCP-client exposure, client library not officially supported, connected agents limited to Copilot Studio agents, memory off in Teams channels, credits consumed during authoring.
- App-only access to harness agents: not available outside a no-auth private preview.
- Agent Framework GitHub Copilot provider: no code interpreter, file search, or hosted web search; Python package pins an older `github-copilot-sdk` (1.0.2) than the SDK's latest (1.0.13).
- Agent Framework Copilot Studio provider: still preview (`1.20.0-preview.*`); tools live on the agent, not the client.
- SDK: no built-in session locking or load balancing; BYOK keys not persisted; README and setup docs disagree on Entra for BYOK; installation tokens must go through the env var, not the `gitHubToken` option.
- SDK 1.0.13 behavior verified here: constructing `CopilotClient` with `mode: "empty"` throws unless `baseDirectory` or `sessionFs` is set ("Empty mode requires an explicit per-session persistence location"), and `createSession` in that mode throws unless `availableTools` is set explicitly (for example `["custom:*"]` or `new ToolSet().addBuiltIn(BuiltInTools.Isolated)`). The multi-tenancy doc shows `availableTools` but does not state either requirement.
- SDK 1.0.13 typings expose far more event types than the ~40 the streaming-events doc lists (canvas, factory, fusion, MCP OAuth, schedules, plan mode, and more); the documented set in §3.5 is the stable subset to build on.
- Stale vendor pages: the docs.github.com Agent Framework integration page still shows `--prerelease` and an `AIAgentOptions` overload that does not exist in source.
- The Copilot Studio harness needs no GitHub Copilot seat; Copilot Credits are the only meter, and dev/trial non-billing ended 1 Sep 2026.

---

## 10. Version ledger (checked 6 September 2026)

| Package or product | Version | Source |
| --- | --- | --- |
| GitHub Copilot CLI | v1.0.83 (4 Sep 2026); local 1.0.84 | github/copilot-cli releases; `copilot --version` |
| `@github/copilot-sdk` | 1.0.13 | npm |
| `github-copilot-sdk` (PyPI) | 1.0.13 (4 Sep 2026) | PyPI |
| `GitHub.Copilot.SDK` (NuGet) | 1.0.13 (4 Sep 2026; .NET 8 / netstandard2.0). The Microsoft feed proxy used on this machine still listed 1.0.13-preview.2. | nuget.org via the verification pass; `dotnet package search` |
| github/copilot-sdk release | v1.0.13 (4 Sep 2026) | GitHub releases |
| `Microsoft.Agents.AI.GitHub.Copilot` | 1.20.0 | NuGet via dotnet |
| `agent-framework-github-copilot` | 1.0.3 (21 Aug 2026) | PyPI |
| `Microsoft.Agents.AI.CopilotStudio` | 1.20.0-preview.260831.1 | NuGet via dotnet |
| `agent-framework-copilotstudio` | 1.0.0b260813 (14 Aug 2026) | PyPI |
| `agent-framework-core` | 1.17.0 (3 Sep 2026) | PyPI |
| microsoft/agent-framework releases | dotnet-1.20.0 (31 Aug 2026), python-1.17.0 (3 Sep 2026) | GitHub releases |
| `Microsoft.Agents.CopilotStudio.Client` | 1.9.28-beta | NuGet via dotnet |
| `@microsoft/agents-copilotstudio-client` | 1.8.1 | npm |
| `microsoft-agents-copilotstudio-client` | 1.6.0 (27 Aug 2026) | PyPI |
| Power Platform CLI `pac` | 2.10.1 local; plugin needs ≥ 2.9.3 | `pac`; plugin README |
| Copilot Studio GitHub Copilot harness | GA 3 Aug 2026; credit billing 1 Sep 2026 | Tech Community; Learn |
| Copilot SDK GA | 2 Jun 2026 | GitHub changelog |
| Agent Framework GitHub Copilot blog | 4 Aug 2026 (Giles Odigwe) | devblogs |

---

## 11. Sources

GitHub

- https://github.com/github/copilot-sdk (README, MIT, language table)
- https://github.com/github/copilot-sdk/tree/main/docs (getting-started, auth/*, setup/*, features/*, hooks/*, integrations/microsoft-agent-framework.md, troubleshooting/compatibility.md)
- https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/
- https://github.com/github/copilot-cli/releases
- https://docs.github.com/copilot/how-tos/copilot-sdk

Microsoft Agent Framework

- https://devblogs.microsoft.com/agent-framework/build-production-ready-agents-with-the-github-copilot-harness-and-agent-framework/
- https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/agent-services/github-copilot
- https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/agent-services/copilot-studio
- https://github.com/microsoft/agent-framework/releases

Copilot Studio

- https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/overview
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/tools-available
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/skills-overview
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/memory-overview
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/authoring-add-other-agents
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/authoring-select-agent-model
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/billing-credit-overview
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-channels-overview
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-publish-agent
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-fundamentals-publish-channels
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/visual-studio-code-extension-overview
- https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/integrate-with-mcs
- https://learn.microsoft.com/en-us/javascript/api/@microsoft/agents-copilotstudio-client/connectionsettings?view=agents-sdk-js-latest
- https://techcommunity.microsoft.com/blog/copilot-studio-blog/more-powerful-agents-and-workflows-for-autonomous-business-processes-introducing/4542969
- https://microsoft.github.io/mcscatblog/posts/copilot-studio-api-decision-guide/
- https://github.com/microsoft/copilot-studio-plugin (README, commands/chat.md, commands/migrate.md, agents/copilot-studio-init.md, scripts/src/chat-with-agent.js)
- https://github.com/microsoft/skills-for-copilot-studio

This repository

- `README.md` (live verifications of 5, 6, and 30 Aug 2026), `sidecars/AgentFrameworkGhcp/Program.cs`, `docs/ghcp-harness-bom-and-setup.html`, `docs/dynamics-sidepane-deployment.html`
