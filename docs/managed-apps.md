# Managed apps: verification notes

What `managedApps` (`src/managed-apps.js`) and `scripts/managed-apps.mjs` were checked against, and what was found
along the way. The rules they enforce come from Microsoft's microsoft-managed-apps plugin, vendored unchanged under
`vendor/managed-apps` (see `VENDOR.json` for the commit and a sha256 per file). Where this page and the plugin
disagree, the plugin's text is quoted below with what was observed instead.

Verified 26 Sep 2026 in a dev environment with Dataverse, with `@microsoft/managed-apps-cli` 0.25.1,
`@microsoft/managed-apps` 0.5.17, `@microsoft/managed-apps-vite-plugin` 0.3.28 and Node 25, as the app's owner
signed in to `ms` with a delegated account.

## The lifecycle, live

| Step | How | Result |
|---|---|---|
| Register | `ms app init --display-name <name> --repo native --environment-id <id>` | An app with a platform-managed git repository. |
| Bind connectors | `ms app add data-source … --use-sso` (see the forms below) | `ms.config.json` references and typed services under `generated/`. |
| Policy | `check` (and `allow` / `allow-table` for shared references) | Single sign-on connections are not shared, so none needed one. |
| Build | `npm run build` (`tsc -b && vite build`) | Type-checked against the generated services. |
| Push | `pushApp` with a token from `createInteractiveTokenProvider` | One browser sign-in, then silent from the MSAL cache. |
| Deploy | `deploy` → `ms app deploy --commit <sha>` | `appPlayUri` and `commitHash`; a redeploy updates the same app. |
| Play | The play URL in the App Player | See the five apps below. |

rapp-brainfreeze-studio drove that lifecycle for five apps, one per connector skill, and a probe checked each in
the App Player through the app's own `data-testid` / `data-state` hooks:

| App | Connector | Checked against |
|---|---|---|
| SharePoint media player | SharePoint (actions) | A 17.7 MB MP4 plays past 10 s at 1920×1080 from a `data:` URL. |
| People directory | Office 365 Users | The card is the signed-in user; reports and manager match Microsoft Graph; a search finds the user. |
| Calendar dashboard | Office 365 Outlook | Seeded events (today, tomorrow, an all-day one): the app shows exactly what the connector returned, for 14 days and for today. |
| SharePoint list viewer | SharePoint (list table) | Every item a direct read of the list returns; filtering; dates. |
| Task tracker | Dataverse (table) | Add (with a due date), complete, delete, each read back from Dataverse; all four verbs went through the connector. |

## Findings

**The player's content security policy blocks `blob:` media.** The deployed player serves apps with
`media-src 'self' data:` (the SDK exports it as `PLAYER_MEDIA_SRC`). A video from `URL.createObjectURL` is
refused; the same bytes as a `data:` URL play. The add-office365-users skill says the same of `img-src` for profile
photos. Convert bytes to base64 in chunks (0x8000 bytes at a time): spreading millions of bytes into one
`String.fromCharCode` call overflows the stack.

**`--repo none` apps need an environment setting to deploy.** `ms app deploy` refused with "External artifact
deployment is not enabled" until the environment setting `AllowExternalArtifactDeployment` is on. `--repo native`
(a platform-managed repository) deploys without it.

**`ms app init --repo native` requires Git Credential Manager** installed and configured as the repository's
credential helper, even when nothing will use it. It can be installed as a .NET tool
(`dotnet tool install -g git-credential-manager`, which lands in `~/.dotnet/tools`). Its interactive sign-in can't
complete on a headless machine, so `pushApp` authenticates git with an Entra token instead: the public client
(`MANAGED_APPS_GIT_CLIENT_ID`) and scope (`MANAGED_APPS_GIT_SCOPE`) the CLI configures for GCM, sent as an
`http.extraHeader` through git's environment (never argv), with every credential helper disabled for that call.
The platform's git endpoint takes that token as `Authorization: Basic base64(OAUTH_USER:<token>)`. Tokens from other
clients weren't tried.

**A native app is built on the platform, from the pushed commit.** In the CLI's code, `ms app deploy` asks the
platform to build a commit (`POST …/appframework/apps/<app>/build` with its SHA, then polls that commit's build
operation), then deploys it (`…/deploy`); it never uploads `dist/`. So the local `npm run build` is a check before the
push, and the push is what the platform builds.

**The platform seeds a new repository** with one commit ("Initial commit", a README, by "Git Repository
Service"). A first push from a local repository has no common history with it; `pushApp` rebases onto it and keeps
the app's own README.

**`ms app add data-source` prints text even with `--json`.** Its exit code is the result; read `ms.config.json`
back afterwards (the allowed-actions guide says the same about `sharedConnectionId`).

**Dataverse binds as `commondataserviceforapps`.** The add-dataverse skill's `--connector dataverse` is reported as
ambiguous by `ms` 0.25.1. This binds a table:

```bash
ms app add data-source --connector commondataserviceforapps --as table --table <logical name> \
    --dataverse-environment-id <environment id> --use-sso --non-interactive
ms app add data-source --connector sharepointonline --as table --dataset <site URL> --table "<list name>" --use-sso --non-interactive
```

**Generated service names depend on the data.** Action connectors get named exports (`SharePointService`,
`Office365UsersService`, `Office365OutlookService`). A SharePoint list's service is named after the list (spaces and
punctuation dropped); a Dataverse table's is its entity set's, capitalized, and it is a **default** export. The
stable key is each service's `dataSourceName` (the connector id for actions, the data source key in
`ms.config.json` for tables); code that finds its service by that key survives a rename.

**Table references take four verbs.** `setTableAllowedActions` writes `get`, `post`, `patch`, `delete` on exactly
one dataset table, and refuses operation ids (`GetItems`, `PatchItem`) as the allowed-actions guide requires. A
generated table service's methods map onto them the way `inferAllowedActions(…, { kind: 'table' })` maps them
(`getAll`, `ListRecords` → `get`; `create`, `CreateRecord` → `post`; `update`, `UpdateRecord` → `patch`;
`delete`, `DeleteRecord` → `delete`). `checkAllowedActions` also flags non-verb table policies as `invalid-table`;
the guide's minimal CLI-mirroring check only checks that these lists are non-empty.

**SharePoint date-only columns arrive as midnight UTC** (`2026-01-01T00:00:00Z`). Shown in local time they become
the evening before, west of Greenwich; show them as a UTC date.

**Outlook's `GetEventsCalendarViewV2` takes `$filter`, then `$orderby`,** then `$top` and `$skip`: the generated
signature and the connector's own definition agree. The add-office365 skill's example labels the fifth argument
"select". Timed events come back as UTC instants with seven fractional digits (`2026-09-26T22:00:00.0000000+00:00`);
all-day events as floating dates, midnight UTC with `TimeZone: "UTC"` and an exclusive end, so a three-day event
starting on the 29th ends at `…-10-02T00:00:00…`, whatever the viewer's time zone. Show all-day events by their UTC
date, and an event on every day it covers.

**Office 365 Users' `Manager_V2` answers 404** for someone with no manager. That is an answer, not a failure.

**First run asks for consent.** The player shows "Allow <app> to access your data?" with the app's connections;
Allow stays disabled until each connection's "Refresh connection" has completed its sign-in. Allowing reloads the
app, so a reading taken just before it can be from a load about to be replaced.

**After a redeploy, a warm player runs its cached build first,** and offers "New version available" with a
Refresh link. A check that runs right after a deploy should take that refresh before it measures.

**Single sign-on connections are not shared,** so the apps bound with `--use-sso` needed no `allowedActions`.
The shared path (`allow`, `allow-table`, `check`) is covered by the unit tests, not by these live apps.

**Tenant policy decides what a managed app may call.** In the tenant used, the flows connector
(`shared_logicflows`) was blocked for managed apps, and the Copilot Studio connector offered only `ExecuteCopilot`
and `ExecuteCopilotAsyncV2`, while GitHub Copilot harness agents need its agentic-runtime action. So a managed app
there can't reach a harness agent through the Copilot Studio connector, or a Power Automate flow. It can reach one
through the Agents connector (next finding). List what is allowed with
`ms connector list-actions --connector <id> --json` (`behavior: Allow`).

**A managed app reaches a harness agent through the Agents connector** (`shared_agentnode`, data source
`agentnode`; verified 28 Sep 2026 with the chat sample in `examples/managed-app-chat`). `ms connector list-actions`
shows two actions, `InvokeAgent` and `InvokeDefinition`, and `ms app add data-source` generates a service for those
two only. The connector's definition holds eleven more operations marked internal, among them `InvokeAgent_V2`,
`GetConversationStatus_V2`, `CancelConversation_V2` and `ListAgents`. The data client builds each request from the
data source description it is given (`getClient(dataSources)`), so an app can describe those operations itself,
beside `generated/`, and call them by name; the player let all four through on a single sign-on connection.

- Running an agent is long-running. `InvokeAgent_V2` with `{ agentId, prompt }` answers `202` with
  `{ conversationId }`, a `Location` and `Retry-After: 5`. `GetConversationStatus_V2` answers `202`
  `{ status: "InProgress" }` until it answers `200` `{ status: "Completed", result }`. The data client returns each
  of those bodies as `{ success: true, data }` and does not follow `Location` itself, so the app polls.
- `agentId` is the agent's schema name. `ListAgents` returns `{ agents: [{ agentId, agentName }] }` (170 in the
  environment used).
- Both routes answered for a GitHub Copilot harness agent when called directly: the published one
  (`/copilotflows/agentnodes/published/conversations`) and the listed one
  (`/powerautomate/agentnodes/conversations`). On the listed route `result` holds the **prompt** while the run is in
  progress; read it only once the status is `Completed`.
- A run cannot be continued. `conversationId` in the request body is ignored and a new conversation starts, so a chat
  has to send the earlier turns with each message.
- `result` is the run's messages joined, including what the agent said while working ("Let me fetch both
  records…").
- Inside the player the app's storage (`localStorage`) worked, a `data:` download was saved, and the app's frame
  is on its own origin, so neither is shared with another app.
- Browsers slow the timers of a hidden tab, down to one a minute; a polling app should check again when its tab is
  shown.

**Local development and Chrome's Local Network Access checks.** `ms app dev` serves the app's config from
`http://localhost:5173/__vite_managedapps_plugin__/ms.config.json`, which the hosted dev player fetches; recent
Chrome builds can block that request as a local-network access. Automated runs used Chrome with
`--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests`.

## Offline authoring and target-selection guarantees

`managedApps` exports both setters. Its public runtime members and their function/constant kinds are checked
against the entire `managedApps: Readonly<{ … }>` declaration in `index.d.ts`, in both directions.

- **Shared references only.** Both setters refuse a missing, null or whitespace-only `sharedConnectionId`
  before any write; the connector setter does so before querying actions. The error cites `allowed-actions.md`.
  Non-shared references do not get policies added to them.
- **Exact reference targeting.** An explicit `reference` must exist and its connector id must match, for both
  setters. Otherwise the connector setter prefers references whose `dataSources` contains the action source id
  (for SharePoint, `sharepointonline`, not `shared_sharepointonline`). One matching owner wins; without an owner,
  only a single connector reference is safe. Multiple candidates are an error listing the reference names.
- **Table targeting.** `table` matches the dataset data source key or its `tableName`. `reference` and `dataset`
  narrow the match; multiple remaining matches are errors. Dataset matching preserves the existing
  case-insensitive, trailing-slash-insensitive behavior. Only the selected policy changes, even when the reference
  holds both action and table data sources.
- **Return values.** `setConnectorAllowedActions` returns `{ reference, allowedActions }`.
  `setTableAllowedActions` returns `{ reference, dataset, table, allowedActions }`, with unique verbs in
  `get`, `post`, `patch`, `delete` order. There is no `shared` field: success always means the target was shared.
- **Inference identifiers.** A service name must start with an ASCII letter, `_` or `$`, followed only by
  letters, digits, `_` or `$`. Dotted paths and regex fragments are rejected; dollar signs are matched literally,
  and a service name cannot accidentally match the suffix of a different identifier.

The studio-compatible CLI forms remain:

```bash
node scripts/managed-apps.mjs allow <app-dir> <connector> <ActionId,...> --reference <name>
node scripts/managed-apps.mjs allow-table <app-dir> <connector> <table-key-or-name> <verbs> --reference <name> --dataset <dataset>
```

Both commands print only the JSON result on success. Flags also accept `--name=value` without truncating embedded
`=` characters. Command-specific parsing rejects unknown flags, missing/blank values, a flag consumed as another
flag's value, extra positional arguments, and empty comma-separated action/verb entries. `allow` still validates
against `ms connector list-actions`; offline library callers may supply its `{ id, behavior }[]` as
`connectorActions`. No offline action-list CLI flag was added.

Lifecycle safeguards are covered with fake runners: a failed CLI exit cannot count as success even if its JSON
says otherwise; `msOpts.cwd` cannot redirect a setter, deploy or play call away from its `appDir`.
Git-backed deploy checks the selected commit on `origin`, not just any remote-tracking branch; a `repoType: "none"`
app refuses a commit selector rather than ignoring it. Play's `commit` and `branch` selectors are mutually
exclusive and require `mode: "preview"` (`--preview` in the CLI).

## Not verified

- A shared connection's policy enforced live (every live app used single sign-on connections).
- A profile photo's bytes (the tenant's users had no photos; the metadata call was made and answered).
- `ms app dev` beyond loading an app.
