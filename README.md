# copilot-harness-sdk

One client for every way to reach a GitHub Copilot harness. Pick a mode, ask the client what that mode can do, open a session, and read one normalized event stream regardless of which wire is underneath.

| Mode | What it reaches | Identity | Support today |
| --- | --- | --- | --- |
| `copilot-sdk` | The Copilot CLI harness in (or next to) your process via `@github/copilot-sdk` | GitHub user token, org-billed GitHub App/Actions token, or BYOK | GA |
| `copilot-studio-3p` | A Copilot Studio **GitHub Copilot harness** agent over the Agentic Runtime `/3p` route | Delegated Entra user token (`CopilotStudio.Copilots.Invoke`) | Experimental (route verified live from the playground referenced below; Microsoft: client library not yet official for this harness) |
| `copilot-studio-standard` | A Copilot Studio **classic (standard-harness)** agent via the official client library | Delegated Entra user token | **Deprecated here** (refused unless `allowClassicAgent: true`; Microsoft still lists the harness itself as GA) |
| `copilot-studio-s2s` | A Copilot Studio harness agent with **No Authentication**, app-only over `/3p` | Entra app (client credentials) | Private preview (Microsoft enables per tenant) |
| `agentic-directline` | The no-auth agentic Direct Line token endpoint | None | Diagnostic; final-only responses |

Everything the matrix says is traceable to [`docs/ghcp-harness-copilot-sdk-reference.md`](docs/ghcp-harness-copilot-sdk-reference.md).

## Install

```bash
npm install
npm test            # unit tests (no network, no credentials)
npm run test:live   # also runs the real Copilot SDK turn (needs a Copilot login)
```

Node `^20.19 || >=22.12` (the `@github/copilot-sdk` requirement).

## The one API

```js
import { HarnessClient } from 'copilot-harness-sdk';

const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { model: 'auto', permissions: 'deny' } });

console.log(client.capabilities());   // support, identity, streaming shape, tools/mcp/skills, notes, sources
await client.preflight();             // connectivity check with the 401/403/404 hint table applied

const session = await client.createSession({ sessionId: 'user-42-task-1' });
for await (const ev of session.stream('Summarize this repo in one line.')) {
  if (ev.type === 'text.delta') process.stdout.write(ev.delta);   // ev.snapshot is always the full text so far
  if (ev.type === 'tool.start') console.error(`\n[tool] ${ev.name}`);
  if (ev.type === 'error') throw ev.error;
}
const { text } = await session.send('And in three words?');       // waits for idle, returns final text + all events
await client.close();
```

### Normalized events

| `type` | Fields | Notes |
| --- | --- | --- |
| `text.delta` | `delta`, `snapshot`, `streamId?`, `sequence?`, `messageId?` | Same shape whether the wire sent deltas (Copilot SDK, Agent Framework) or cumulative snapshots (Copilot Studio client library). |
| `text.final` | `text`, `attachments?`, `suggestedActions?`, `citations?`, `model?` | The complete answer for the turn. |
| `status` | `text` | Informative typing (`Searching…`) or the SDK's `assistant.intent`. |
| `reasoning.delta` | `delta` | Copilot SDK only. |
| `tool.start` / `tool.end` | `id`, `name`, `args?` / `id`, `success`, `result?`, `error?` | Copilot SDK only (Copilot Studio runs its tools server-side). |
| `permission.request` | `request`, `respond('approve' \| 'deny')` | Copilot SDK with `permissions: 'emit'`. Delivered into the active turn's stream and to `client.onEvent`; unanswered requests are denied after 60 s. |
| `usage`, `context` | tokens, cost, `tokenLimit` | Copilot SDK only. |
| `idle` | `text`, `aborted?` | End of turn. Always last, including after an `error`. An autopilot "idle between steps" is a `status`, not an `idle` (mirrors the SDK's own `sendAndWait`). |
| `error` | `error`, `code?`, `statusCode?`, `hint?` | Surfaced in-stream, then `idle`. Codes: `TURN_TIMEOUT`, `ABORTED`, `SESSION_CLOSED`, `SEND_FAILED`, plus HTTP `statusCode` with a hint for 401/403/404. `send()` throws only if no text arrived. |
| `raw` | `raw` | Anything unmapped, with the original payload. Every event carries `raw` and `source`. |

Turn rules that hold in every mode: turns on one session are serialized; breaking out of a stream aborts the turn and cleans up (no leaked listeners or timers); `turnTimeoutMs` (or `stream(prompt, { timeoutMs })`) applies everywhere; `session.close()` and `client.close()` end open streams with `SESSION_CLOSED` then `idle` instead of hanging; a throwing `onEvent` listener never breaks a turn (see `onListenerError`).

## Scenario recipes

Each recipe is a runnable file under `examples/` (`npm run example:<name>`). They read their inputs from environment variables and never embed tenant ids.

### 1. In-process harness with your own tools (`copilot-sdk`)

```js
import { defineTool } from '@github/copilot-sdk';
const client = await HarnessClient.create({
  mode: 'copilot-sdk',
  copilotSdk: {
    model: 'auto',
    instructions: 'You are a release assistant.',
    tools: [defineTool('lookupOrder', { description: 'Look up an order', parameters: { type: 'object', properties: { id: { type: 'string' } } }, handler: async ({ id }) => ({ id, status: 'shipped' }) })],
    mcpServers: { 'microsoft-learn': { type: 'http', url: 'https://learn.microsoft.com/api/mcp', tools: ['*'] } },
    skillDirectories: ['./skills'],
    permissions: 'emit'          // shell/file/URL requests arrive as permission.request events
  }
});
```

### 2. Multi-user backend on one headless runtime

```bash
COPILOT_GITHUB_TOKEN=<service-or-installation-token> copilot --headless --port 4321 --session-idle-timeout 1800
```

```js
const client = await HarnessClient.create({
  mode: 'copilot-sdk',
  copilotSdk: { runtime: { uri: 'localhost:4321', mode: 'empty' }, sessionGithubToken: user.githubToken, session: { availableTools: ['custom:*'] } }
});
const session = await client.createSession({ sessionId: `tenant-${tenant.id}-user-${user.id}-${crypto.randomUUID()}` });
```

### 3. Bring your own key (Foundry / Azure OpenAI / Anthropic)

```js
copilotSdk: {
  model: 'gpt-5.2-codex',
  byok: { type: 'openai', baseUrl: 'https://<resource>.openai.azure.com/openai/v1/', wireApi: 'responses', apiKey: process.env.FOUNDRY_API_KEY }
}
```

For Entra-authenticated Foundry use `bearerTokenProvider` with `DefaultAzureCredential` and scope `https://ai.azure.com/.default` instead of `apiKey`.

### 4. Copilot Studio GitHub Copilot harness agent from your own UI (`copilot-studio-3p`)

```js
import { HarnessClient, createDeviceCodeTokenProvider } from 'copilot-harness-sdk';
const client = await HarnessClient.create({
  mode: 'copilot-studio-3p',
  copilotStudio: {
    environmentId: process.env.COPILOT_ENVIRONMENT_ID,
    schemaName: process.env.COPILOT_SCHEMA_NAME,            // case-sensitive
    getAccessToken: createDeviceCodeTokenProvider({ clientId: process.env.ENTRA_CLIENT_ID, tenantId: process.env.ENTRA_TENANT_ID })
  }
});
```

In a web app, pass the browser's MSAL token through instead (`getAccessToken: async () => tokenFromBrowser`). The agent must be published, set to **Authenticate with Microsoft**, and shared with the user. The client runs a one-shot preflight so a 401/403/404 fails immediately with a hint instead of hanging in the client library's reconnect loop.

### 5. Standard-harness agent, the official way (`copilot-studio-standard`)

Same config with `mode: 'copilot-studio-standard'`; the client library derives the URL from `environmentId` + `schemaName`.

### 6. Daemon with no user present (`copilot-studio-s2s`)

```js
import { createClientCredentialTokenProvider } from 'copilot-harness-sdk';
copilotStudio: { environmentId, schemaName, getAccessToken: createClientCredentialTokenProvider({ clientId, tenantId, clientSecret }) }
```

Works only after Microsoft enables S2S Direct-to-Engine for the tenant and only for agents published with **No Authentication**; an authenticated agent answers `S2SDirectEngineRequiresNoAuthentication`.

### 7. Orchestrate both worlds

Open two clients (`copilot-sdk` and `copilot-studio-3p`), subscribe with `client.onEvent(...)` on each, and route by `ev.source`. The Copilot Studio side has no client-side tools by design; give the Studio agent its tools in the Build tab.

## Never a classic agent

A Copilot Studio agent is either on the **GitHub Copilot harness** or it is a **classic (standard-harness)** agent, and it cannot be switched in place. The two are told apart by the Dataverse `bot` record, not by what a tool claimed:

| Harness | `template` | `configuration.recognizer.$kind` | Copilot Studio shows |
| --- | --- | --- | --- |
| GitHub Copilot harness | `cliagent-1.0.0` | `CLICopilotRecognizer` (older: `CLIAgentRecognizer`) | Build · Preview · Evaluate · Monitor, model picker (Sonnet/Opus/GPT), Skills, Memory |
| classic / standard | `default-2.1.0` … | `GenerativeAIRecognizer` | Topics, generative answers, the old test pane |

This SDK enforces the policy that **no new classic agent is ever created or targeted**, at three layers:

1. **Deploy only the harness.** `npm run deploy:harness -- --name "My Agent" --publisher-prefix cr8c1 --instructions-file ./instructions.md --environment https://<org>.crm.dynamics.com/` runs the proven sequence (`pac copilot init --authoring-mode cli-copilot` → `pack` → **refuse the zip unless `bot.xml` says `cliagent-*`** → `pac solution import` → write the instructions onto the live record → `pac copilot publish` → read the record back and assert harness + instructions + published). It exits non-zero at the first sign of a classic template, never accepts `--authoring-mode classic`, and refuses display names over 42 characters (longer names never finish provisioning). Two `pac` 2.10.1 defects it works around: `pack` writes `<language>0</language>` (import rejects it) and `push` drops `agentSettings.instructions`.
2. **Verify before you trust.** `assertHarnessAgent({ environmentUrl, schemaName, getDataverseToken })` reads the live record and throws `ClassicAgentError` for anything that is not the harness (optionally also for missing instructions or an unpublished agent). `classifyBot(botRecord)` is the pure version for exports you already have on disk.
3. **Refuse to talk to one.** `HarnessClient.create({ mode: 'copilot-studio-standard' })` throws with `CLASSIC_REFUSAL` and `recommendMode` never answers that mode, unless `allowClassicAgent: true` is passed for a legacy agent you cannot recreate yet.

```js
import { assertHarnessAgent, ClassicAgentError } from 'copilot-harness-sdk';
try {
  const info = await assertHarnessAgent({
    environmentUrl: 'https://<org>.crm.dynamics.com/',
    schemaName: 'cr8c1_MyAgent',
    getDataverseToken: async () => tokenFor('https://<org>.crm.dynamics.com'),   // e.g. az account get-access-token --resource <environmentUrl>
    requireInstructions: true, requirePublished: true
  });
  console.log(info.template, info.recognizer, info.model, info.instructionChars);        // cliagent-1.0.0 CLICopilotRecognizer Sonnet46 6338
} catch (e) {
  if (e instanceof ClassicAgentError) { /* recreate on the harness; do not ship */ }
}
```

Reaching a harness agent from code still needs an Entra app with the delegated `CopilotStudio.Copilots.Invoke` permission (the Azure CLI's own app only carries `CopilotStudio.Copilots.Test`, which the `/3p` route rejects with `InsufficientDelegatedPermissions`).

## Sample use cases: ten harness agents, every component, proved through the SDK

[`usecases/usecases.json`](usecases/usecases.json) describes ten "packet copilots" (vendor contract renewal, claims intake, store resets, clinical trial activation, loan servicing exceptions, supplier onboarding, retail media trafficking, HR policy rollout, manufacturing BOM changes, grant compliance). `npm run build:usecases` turns each into a parent harness agent plus a child data agent, all carrying the same component set:

| Component | File in `usecases/<slug>/agent/` | YAML kind |
| --- | --- | --- |
| Instructions, greeting, conversation starters, model | `settings.mcs.yml` | `agentSettings` |
| Public-website knowledge | `capabilities/knowledge/<Name>.mcs.yml` | `KnowledgeSourceConfiguration` / `WebsiteKnowledgeSource` |
| MCP server tool (Dataverse MCP, plus a domain MCP where one exists) | `capabilities/tools/<Name>.mcs.yml` + `infrastructure/connections/<ref>.sync.yaml` | `McpTool` |
| Agent-flow tool | `capabilities/tools/SiteWeather.mcs.yml` + `workflows/<Name>-<id>/` | `WorkflowTool` |
| Connected agent (the child) | `capabilities/tools/<Name>DataAgent.mcs.yml` | `ConnectedAgentTool` |
| Skill (the report procedure) | `behaviors/<report>.mcs.yml` | `InlineAgentSkill` |

`npm run deploy:usecases` deploys them (child first, then parent) through the same harness-only script, and `npm run prove:usecase -- --spec usecases/<slug>/proof.json …` drives each one through `HarnessClient` in `copilot-studio-3p` mode with scripted turns per component. The evidence and the remaining portal-only steps are in [`docs/harness-capability-ledger.md`](docs/harness-capability-ledger.md).

### Admin operations with no `pac copilot` verb

```js
import { shareAgent, setAccessControl, setChannels, upsertEnvironmentVariable, listComponents } from 'copilot-harness-sdk';
const dv = { environmentUrl: 'https://<org>.crm.dynamics.com/', getDataverseToken };   // az account get-access-token --resource <environmentUrl>
await shareAgent({ ...dv, schemaName, userId });                                          // Dataverse GrantAccess
await setAccessControl({ ...dv, schemaName, policy: 'GroupMembership', securityGroupIds: [groupId] });
await setChannels({ ...dv, schemaName, channels: ['Teams', 'Microsoft365Copilot'] });    // then pac copilot publish
await upsertEnvironmentVariable({ ...dv, schemaName: 'cr8c1_RenewalNoticeDays', type: 'Number', defaultValue: '90', value: '60' });
console.log(await listComponents({ ...dv, schemaName }));                                 // [{ name: 'tool.SiteWeather', kind: 'WorkflowTool' }, …]
```

Every one of them resolves the bot first and throws `ClassicAgentError` for a classic agent.

## Choosing a mode without guessing

```js
import { recommendMode } from 'copilot-harness-sdk';
recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'github-copilot' });
// → { mode: 'copilot-studio-3p', why: '...' }
```

`validateConfig(config)` returns every problem at once; `HarnessClient.create` throws with the same list.

## Verification status (6 September 2026)

58 unit tests (`npm test`), no network or credentials needed. The `copilot-sdk` adapter is tested offline against a fake runtime whose dispatch/abort/disconnect semantics mirror `@github/copilot-sdk` `dist/session.js`, and the Copilot Studio adapters against fakes that replay the wire shapes recorded in the playground.

| Mode | Unit tests | Live |
| --- | --- | --- |
| `copilot-sdk` | event mapping; turn serialization; early break aborts and cleans up; autopilot idle; turn timeout; close during a stream; throwing listener isolation; permissions `emit` / `approve-all` / `deny`; empty-mode defaults; `runtime.env`; send failure; config validation | Passed 6 Sep 2026 on Copilot CLI 1.0.84 / SDK 1.0.13: `npm run test:live` streamed deltas → final → idle for a real prompt, and `examples/copilot-sdk.mjs` ran the full custom-tool loop: `tool.start lookupOrder` → `permission.request` (`kind=custom-tool`) → approve (`approve-once`) → `tool.end success=true` → "Order 9 is shipped and is expected to arrive in 2 days." (`model: auto` resolved to `mai-code-1.1-flash` and later `gpt-5.6-luna`). Denying the same request produced `success=false` and an explanation. |
| `copilot-studio-3p` | preflight and 403 hint, guard, token refresh per turn, outbound activity shape, cumulative→delta normalization, onEvent parity and unsubscribe, resume without preflight, turn failure with status, token-provider failure in-stream, turn timeout | Same route verified live from the playground on 5 Aug 2026 (Node) and 6 Aug 2026 (.NET); not yet re-run through this SDK (no Entra credentials on the build machine) |
| `copilot-studio-standard` | settings shape, no preflight, start failure propagates with status and hint | Not run in this session |
| `copilot-studio-s2s` | app-only token to the guarded route | Requires Microsoft's private-preview enablement |
| `agentic-directline` | watermark priming, greeting capture, resume discards history, HTTP failures (401/403/500) and timeout as error then idle | Route observed final-only from the playground; not yet re-run through this SDK |
| token providers | cache, refresh skew, in-flight dedupe, failure recovery, silent-before-device-code | — |

An adversarial review pass (four lenses, 6 Sep 2026) produced 43 candidate defects; each was checked against the code and the installed dependency sources, and the confirmed ones were fixed with the regression tests above (turn cross-talk after an early break, leaked listeners and timers, autopilot idle, permission events invisible to stream consumers, swallowed start-conversation errors, card-only messages wiping the answer, cumulative snapshots that do not extend, Direct Line history replay on resume, silent timeouts, queue double-rejection).

## Provenance

- Research and live `/3p` observations come from the public playground [jzh24516/copilot-streaming-chat-playground](https://github.com/jzh24516/copilot-streaming-chat-playground), used as context for this work; the `/3p` URL guard in `src/url.js` mirrors its `ghcp3p-url.js` so both stay equally strict.
- The `/3p` URL shape and the 30/2 environment-host split come from Microsoft's experimental [copilot-studio-plugin](https://github.com/microsoft/copilot-studio-plugin) (MIT).
- The rendered reference page is regenerated from the Markdown with `python3 docs/build-reference-html.py` (needs the `markdown` package).

## License

MIT. See [LICENSE](LICENSE).
