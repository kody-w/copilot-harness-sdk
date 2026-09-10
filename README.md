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
git clone https://github.com/kody-w/copilot-harness-sdk.git
cd copilot-harness-sdk
npm install
npm test            # unit tests (no network, no credentials)
npm run check       # syntax check + the tutorial's fetch-only smoke (public registry, no environment needed)
npm run test:live   # also runs the real Copilot SDK turn (needs a Copilot login); PowerShell: $env:COPILOT_HARNESS_LIVE=1; npm test
```

Or, once published to npm, without cloning: `npm install copilot-harness-sdk` for the library, and
`npx -p copilot-harness-sdk copilot-harness-tutorial --environment https://<org>.crm.dynamics.com/` or
`copilot-harness-deploy ...` for the two command-line entry points.

### Prerequisites

| For | You need | Checked by |
| --- | --- | --- |
| the library (`HarnessClient`) | Node `^20.19 \|\| >=22.12` (the `@github/copilot-sdk` requirement) | `npm install` |
| `copilot-sdk` mode | GitHub Copilot CLI signed in | the adapter |
| `copilot-studio-3p` / `standard` modes | an Entra app with delegated `CopilotStudio.Copilots.Invoke`; the agent published and shared with the user | `client.preflight()` |
| deploying (`deploy:harness`, `tutorial`) | [Power Platform CLI](https://aka.ms/PowerPlatformCLI) 2.10+ with an auth profile for the environment (`pac auth create --environment <url>`), and a Dataverse bearer token: [Azure CLI](https://aka.ms/azure-cli) signed in as the same user (`az login --tenant <tenant>`) or any command that prints one (`--token-command`) | step 0 of each script prints what is missing and how to install it |
| the tutorial's agent-contract read | `python3` (or `python` / `py -3`); without it parameters are read statically | step 0 |

The deploy and tutorial scripts are plain Node with no shell dependencies (no `ls`, `unzip`, `zip` or `sleep`; the solution zip is handled by `pac solution unpack/pack`). Verified: the unit tests and the tutorial's fetch-only smoke on ubuntu, windows and macos in CI, and the full deploy and tutorial on macOS against two environments. A full deploy from Windows PowerShell has not been run yet; if you run one, open an issue with the log either way.

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

Recipes 1, 4, 5 and 6 are runnable files under `examples/` (`npm run example:<name>`); 2, 3 and 7 are snippets. They read their inputs from environment variables and never embed tenant ids.

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

Classic agents are deprecated in this SDK: `HarnessClient.create` refuses the mode unless the config also carries `allowClassicAgent: true` (the example file sets it). Recreate the agent on the GitHub Copilot harness when you can.

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

1. **Deploy only the harness.** `npm run deploy:harness -- --name "My Agent" --publisher-prefix cr8c1 --instructions-file ./instructions.md --environment https://<org>.crm.dynamics.com/` runs the ten-step sequence in the script header and in [Infrastructure by default](#infrastructure-by-default-every-deploy-comes-out-like-the-reference-pilot) below (`pac copilot init --authoring-mode cli-copilot` or a copied workspace → provision references and flows → `pack` → **refuse the zip unless `bot.xml` says `cliagent-*`** → `pac solution import` → push workflow tools → write the instructions onto the live record → bind and clean components → `pac copilot publish` → read the record back and assert harness + instructions + published + every link). It exits non-zero at the first sign of a classic template, never accepts `--authoring-mode classic`, and refuses display names over 42 characters (longer names never finish provisioning). Two `pac` 2.10.1 defects it works around: `pack` writes `<language>0</language>` (import rejects it) and `push` drops `agentSettings.instructions`.
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
  else { /* missing instructions or not published: a plain Error with the reason */ }
}
```

Reaching a harness agent from code still needs an Entra app with the delegated `CopilotStudio.Copilots.Invoke` permission (the Azure CLI's own app only carries `CopilotStudio.Copilots.Test`, which the `/3p` route rejects with `InsufficientDelegatedPermissions`).

## Infrastructure by default: every deploy comes out like the reference pilot

`npm run deploy:harness` does not stop at skills. Since 10 September 2026 it provisions, binds and verifies the infrastructure a harness workspace declares, the way the reference pilot (`RAPP News Memory Pilot`) was built, so an agent with connector tools and agent flows comes out of the script working, not "skills only":

| Workspace declares | The script does, before `pack` | After `push` |
| --- | --- | --- |
| `ConnectorTool` bound to `<other>.cr.<suffix>` | rebinds it to **`<schemaName>.cr.<suffix>`**, creates that connection reference bound to a real connection (from `--connections`, the reference it was copied from, or any bound reference for the same connector in the environment) | links the component to the reference on the live record (`pac push` leaves that empty) |
| `WorkflowTool` + `workflows/<Name>-<id>/workflow.json` | reuses the flow when it exists in the environment, otherwise mints a per-agent id (UUID v5 of schema name + folder; `--fork-workflows` always mints), rewrites the tool and folder, creates or updates the flow from the definition and **activates** it | links the component to exactly that flow |
| a shared reference without `.cr.` (the use cases' MCP references) | verifies it exists and is bound, fails early with the reason otherwise | — |
| custom connectors (`connectors/`, or a `.cr.` reference to `shared_<name>-5f…`) | verifies the connector exists in the environment; creating one is `pac connector create` (see the tutorial) | — |
| components no longer in the workspace | — | deletes them (`--keep-extra-components` to skip) |
| everything | — | reads the record back: harness template, instructions, published, every component with its kind and its reference/flow link, or exits non-zero |

```bash
# a workspace cloned from another agent, deployed as a new agent with its own references and flow
npm run deploy:harness -- --name "Brainstem Core" --publisher-prefix aibast --schema-name aibast_BrainstemCore \
  --workspace-dir ./brainstem-core --environment https://<org>.crm.dynamics.com/ [--connections ./connections.json] [--fork-workflows]
```

`connections.json` maps a reference suffix, connector id or source logical name to a connection id (`pac connection list`) for references the script cannot resolve from the environment. The same operations are exported for your own scripts. Workspace helpers edit files only: `scanWorkspace(dir)`, `scopedReferenceName`, `rebindConnectionReferences(dir, schemaName)`, `rebindWorkflows(dir, resolveId)`, `workflowIdFor(schemaName, folder)`, `expectedComponents(dir, schemaName)`. The rest are Dataverse Web API calls taking `{ environmentUrl, getDataverseToken }` like the admin operations: `findBot`, `findConnectionReference`, `resolveConnection`, `ensureConnectionReference`, `connectorExists`, `findWorkflow`, `ensureWorkflow`, `listBotComponents`, `linkComponentConnectionReference`, `linkComponentWorkflow`, `deleteStaleComponents`.

| `deploy:harness` flag | Default | Effect |
| --- | --- | --- |
| `--name`, `--publisher-prefix`, `--environment` | required | display name (42 characters max), solution publisher prefix, `https://<org>.crm.dynamics.com/` |
| `--schema-name` | `<prefix>_<Name without spaces>` | the bot's schema name; a copied workspace is renamed to it |
| `--instructions-file` or `--workspace-dir` | one required | instructions for a scaffolded agent, or a pre-authored harness workspace to deploy |
| `--connections <file.json>` | none | `{ "<suffix | connector id | source logical name>": "<connection id>" }` for references the environment cannot resolve |
| `--fork-workflows` | off | always mint a per-agent flow instead of reusing one that exists in the environment |
| `--keep-extra-components` | off | leave components on the live record that the workspace no longer declares |
| `--model`, `--language` | `Sonnet46`, `1033` | model series and language written to the record |
| `--solution-name` | `<schema>Harness` (49 chars max) | unique name of the solution that carries the bot |
| `--work-dir` | `.deploy/<schema>` | scratch folder; only its `workspace/`, `out/`, `deferred/` and `clone/` sub-folders are recreated |
| `--token-command "..."` | `az account get-access-token --resource <environment> --query accessToken -o tsv` | any command that prints a Dataverse bearer token |

`--key=value` is accepted as well as `--key value`.

Proof (10 September 2026, kodyv8, pac 2.10.1): `aibast_BrainstemCore`, three RAPP agents (Hacker News, ManageMemory, ContextMemory) as three skills, one `WorkflowTool` on a custom-connector flow and two Dataverse `ConnectorTool`s, deployed and re-deployed through this script (references `existing`, flow `updated` in place, no stale components), and the Studio test pane answered all three prompts through the real tools: live Hacker News stories from the flow, a memory row written to Dataverse, the same row recalled by keyword.

### Try it with nothing of your own: the RAR tutorial

```bash
npm run tutorial -- --environment https://<org>.crm.dynamics.com/ --name "RAR Starter Agent" --publisher-prefix rapp
```

[`tutorial/README.md`](tutorial/README.md): pulls the three agents above from the public RAPP Agent Registry (sha256-verified), reads their contracts, matches them to the proven infrastructure profiles, creates the custom connector when it is missing, waits for you to create the two connections it cannot create for you, builds the workspace and deploys it through the script above. Any other RAR agent you name is deployed as a reasoning-only skill that carries its `agent.py`.

Proof (10 September 2026, a second environment with none of this in it, `kodyv4`): the tutorial created the custom connector with `pac connector create`, waited for the two connections, built the workspace, and the deploy created both agent-scoped references, created and activated the flow, imported, pushed, bound and published `rapp_RARStarterAgent`; a re-run reported everything `existing`/`updated` with nothing to push. The Studio test pane answered the three prompts through the new connector, flow and Dataverse rows. Two more pac 2.10.1 behaviours the script now works around: `copilot push` crashes with `ArgumentException: An item with the same key has already been added` when a workspace carries the same flow under two folder names (pac names the folder after the flow's display name), and a long publish wait leaves the next Dataverse read with `EPIPE`, so every Dataverse call retries transient network failures.

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

`shareAgent`, `setAccessControl`, `setChannels` and `listComponents` resolve the bot first and throw `ClassicAgentError` for a classic agent; `upsertEnvironmentVariable` is solution-scoped and does not touch the bot. `dataverse({ environmentUrl, getDataverseToken })` returns the same authenticated Web API caller they use.

## Choosing a mode without guessing

```js
import { recommendMode } from 'copilot-harness-sdk';
recommendMode({ hasCopilotStudioAgent: true, hasDelegatedEntraToken: true, agentHarness: 'github-copilot' });
// → { mode: 'copilot-studio-3p', why: '...' }
```

`validateConfig(config)` returns every problem at once; `HarnessClient.create` throws with the same list.

## Verification status (10 September 2026)

78 unit tests (`npm test`; 77 offline plus one live-gated), no network or credentials needed; CI runs them on ubuntu, windows and macos with Node 20 and 22. The guard, admin and provisioning suites replay recorded Dataverse Web API shapes against a fake `fetch` and edit real temporary workspaces on disk. The `copilot-sdk` adapter is tested offline against a fake runtime whose dispatch/abort/disconnect semantics mirror `@github/copilot-sdk` `dist/session.js`, and the Copilot Studio adapters against fakes that replay the wire shapes recorded in the playground.

| Mode | Unit tests | Live |
| --- | --- | --- |
| `copilot-sdk` | event mapping; turn serialization; early break aborts and cleans up; autopilot idle; turn timeout; close during a stream; throwing listener isolation; permissions `emit` / `approve-all` / `deny`; empty-mode defaults; `runtime.env`; send failure; config validation | Passed 6 Sep 2026 on Copilot CLI 1.0.84 / SDK 1.0.13: `npm run test:live` streamed deltas → final → idle for a real prompt, and `examples/copilot-sdk.mjs` ran the full custom-tool loop: `tool.start lookupOrder` → `permission.request` (`kind=custom-tool`) → approve (`approve-once`) → `tool.end success=true` → "Order 9 is shipped and is expected to arrive in 2 days." (`model: auto` resolved to `mai-code-1.1-flash` and later `gpt-5.6-luna`). Denying the same request produced `success=false` and an explanation. |
| `copilot-studio-3p` | preflight and 403 hint, guard, token refresh per turn, outbound activity shape, cumulative→delta normalization, onEvent parity and unsubscribe, resume without preflight, turn failure with status, token-provider failure in-stream, turn timeout | Same route verified live from the playground on 5 Aug 2026 (Node) and 6 Aug 2026 (.NET); not yet re-run through this SDK (no Entra credentials on the build machine) |
| `copilot-studio-standard` | settings shape, no preflight, start failure propagates with status and hint | Not run in this session |
| `copilot-studio-s2s` | app-only token to the guarded route | Requires Microsoft's private-preview enablement |
| `agentic-directline` | watermark priming, greeting capture, resume discards history, HTTP failures (401/403/500) and timeout as error then idle | Route observed final-only from the playground; not yet re-run through this SDK |
| token providers | cache, refresh skew, in-flight dedupe, failure recovery, silent-before-device-code | — |

An adversarial review pass (four lenses, 6 Sep 2026) produced 43 candidate defects; each was checked against the code and the installed dependency sources, and the confirmed ones were fixed with the regression tests above (turn cross-talk after an early break, leaked listeners and timers, autopilot idle, permission events invisible to stream consumers, swallowed start-conversation errors, card-only messages wiping the answer, cumulative snapshots that do not extend, Direct Line history replay on resume, silent timeouts, queue double-rejection).

## Publishing (maintainers)

The package is meant to be published to npm as `copilot-harness-sdk` (public). Publish from GitHub, not from a laptop whose npm points at a private registry:

1. Create an npm automation token and add it to the repository as the `NPM_TOKEN` secret.
2. Bump `version` in `package.json` and `package-lock.json` on `main`; CI must be green.
3. Create a GitHub release whose tag is `v<version>`: `.github/workflows/publish.yml` runs the tests and `npm publish --access public --provenance`.

`npm pack --dry-run` lists what ships: the library, types, the two command-line entry points, the tutorial profiles and the docs (see `files` in `package.json`).

## Provenance

- Research and live `/3p` observations come from the public playground [jzh24516/copilot-streaming-chat-playground](https://github.com/jzh24516/copilot-streaming-chat-playground), used as context for this work; the `/3p` URL guard in `src/url.js` mirrors its `ghcp3p-url.js` so both stay equally strict.
- The `/3p` URL shape and the 30/2 environment-host split come from Microsoft's experimental [copilot-studio-plugin](https://github.com/microsoft/copilot-studio-plugin) (MIT).
- The rendered reference page is regenerated from the Markdown with `python3 docs/build-reference-html.py` (needs the `markdown` package).

## License

MIT. See [LICENSE](LICENSE).
