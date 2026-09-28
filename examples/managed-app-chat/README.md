# Chat assistant: a managed app that talks to a harness agent

A chat application for the Copilot Managed Runtime. People ask, a Copilot Studio agent on the GitHub Copilot harness answers. It is the source for one managed app: copy it over Microsoft's template, name your agent, deploy.

| What people get | How |
| --- | --- |
| A chat with your agent | each message runs the agent through the **Agents** connector (`shared_agentnode`) |
| Answers laid out properly | headings, lists, tables, code and links are rendered; nothing an agent writes is treated as HTML |
| Chats that pick up where they left off | conversations are kept in the browser, with search, and the recent turns travel with each new message |
| A way out of a slow answer | Stop cancels the run |
| Light and dark | follows the device, with a switch |
| A copy to keep | Export saves the chat as Markdown |

Technical settings (which agent, which connection) sit behind **Details**.

## Make it yours

Everything a maker changes is in [`src/config.ts`](src/config.ts): the app name, the agent's schema name (`agentId`), its display name, and the four starter prompts.

## Deploy

You need the `ms` CLI (`@microsoft/managed-apps-cli`), signed in (`ms auth login`), and an environment where the Agents connector is allowed for managed apps (`ms connector list-actions --connector shared_agentnode --environment-id <id>`).

```bash
ms app create ./chat --display-name "Chat Assistant" --environment-id <environment id> --non-interactive
cd chat && npm install
ms app add data-source --connector shared_agentnode --as action --use-sso --non-interactive

cp -R <sdk>/examples/managed-app-chat/src . && cp <sdk>/examples/managed-app-chat/index.html .
# name your agent in src/config.ts

npm run build
git add -A && git commit -m "Chat assistant"
node <sdk>/scripts/managed-apps.mjs push . --tenant <tenant id>
node <sdk>/scripts/managed-apps.mjs deploy .          # prints the play URL
```

`ms app create` needs Git Credential Manager set as a git credential helper, and its last step downloads from the new repository, which opens a sign-in window. Complete it, or stop the command once the folder is written: the SDK's `push` signs in on its own.

## How it reaches the agent

Running an agent is a long-running call. The connector answers `202` with a conversation id, and the answer is read from a status operation until it says `Completed`.

| Step | Operation | Returns |
| --- | --- | --- |
| Start | `InvokeAgent_V2` with `{ agentId, prompt }` | `202`, `{ conversationId }` |
| Wait | `GetConversationStatus_V2` | `202` `{ status: "InProgress" }`, then `200` `{ status: "Completed", result }` |
| Stop | `CancelConversation_V2` | `200` |
| Choose an agent | `ListAgents` | `{ agents: [{ agentId, agentName }] }` |

The connector marks every operation but the first as internal, so `ms app add data-source` generates no code for them. [`src/agent/dataSource.ts`](src/agent/dataSource.ts) describes them for the same data source, beside the generated code and never inside it. If the environment refuses `InvokeAgent_V2`, the app falls back to `InvokeAgent`, the action the connector lists.

## What to know

- **Answers arrive whole.** The connector does not stream, so the app shows that the agent is working and how long it has been.
- **Every message is a new agent run.** The connector has no way to continue a conversation, so the app sends the last six turns with each message (`memoryTurns` and `memoryChars` in `src/config.ts`).
- **Chats live in the browser.** They are not shared between people or devices. If the player refuses storage, they last until the page closes.
- **The person's own access applies.** The connection is single sign-on, so the agent must be shared with whoever uses the app.

## Verified

28 September 2026, in a dev environment, `ms` 0.25.1, `@microsoft/managed-apps` 0.5.17, driven in the App Player through the app's `data-testid` hooks:

- the player showed the build that was just deployed
- a first question was answered by the agent over the published route (2,208 characters, rendered with headings, lists and bold)
- a follow-up named both contract ids from the first question, so the earlier turns reached the agent
- the chat was saved in the browser (one conversation, four messages), the theme switch changed the theme, Export saved a Markdown file
- Details listed the environment's 170 agents
- a timed run took 46.8 seconds: one start call, then a status call about every four seconds until `Completed`
- Stop ended a live run in half a second, sent one cancel call, and the next question was answered ("$21.75", 24 seconds)
- after a redeploy the player offered "New version available"; taking the refresh showed the new build

The first question of the first run took 298 seconds, against 47 and 24 seconds for the same kind of question afterwards. The cause was not established; a hidden browser tab slows timers to one a minute, which is why the app now checks again the moment its tab is shown.

Not verified: the fallback to `InvokeAgent` inside the player (the published route was never refused; both routes answered when called directly) and a shared connection.
