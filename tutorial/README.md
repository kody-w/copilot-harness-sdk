# Tutorial: from RAPP `agent.py` files to one Copilot Studio harness agent

You do not need an idea of your own to try the SDK. This tutorial pulls three notarized agents
out of the public RAPP Agent Registry (RAR), turns them into one **GitHub Copilot harness** agent
in your Copilot Studio environment, and deploys it with every piece of infrastructure the agents
need. It is the same shape as the reference pilot the SDK was proved against.

| RAR agent | What it becomes in Copilot Studio |
| --- | --- |
| `@rapp/hacker_news` | a custom connector (`RAPP Hacker News`, code-based, no credentials), an agent flow that runs the original aggregation, a `WorkflowTool`, and the `fetch-hacker-news` skill |
| `@kody-w/manage_memory_agent` | a Dataverse `ConnectorTool` (add a row to the `annotations` table) and the `manage-memory` skill |
| `@kody-w/context_memory_agent` | a Dataverse `ConnectorTool` (list rows) and the `recall-memory` skill |

`--agents` replaces the default list. Any RAR agent without a profile is deployed as a reasoning-only
skill that carries its `agent.py`: the agent can explain and reason with the code but has no live
tool for it, and its instructions say so. To keep the three profiles and add one more, pass all four:
`--agents "@rapp/hacker_news,@kody-w/manage_memory_agent,@kody-w/context_memory_agent,@someone/other_agent"`.
Add a profile under `tutorial/profiles/` to give such an agent real tools. Reading an agent's contract
imports its `agent.py` in a throwaway python process (its module-level code runs), so naming an
agent means trusting that code from the registry.

## Run it

```bash
npm install
az login                                     # the user of the target environment
pac auth create --environment https://<org>.crm.dynamics.com/
npm run tutorial -- --environment https://<org>.crm.dynamics.com/ --name "RAR Starter Agent" --publisher-prefix rapp
```

Without cloning, once the package is on npm: `npx -p copilot-harness-sdk copilot-harness-tutorial --environment https://<org>.crm.dynamics.com/`.
To see the first three steps with no environment, pac or az at all: `npm run tutorial -- --fetch-only`.

The script prints six steps:

1. **fetch** the agents from `https://kody-w.github.io/RAR/registry.json` and verify each file's sha256 against the registry
2. **read** each agent's contract (name, description, parameters) by importing the file in a throwaway python process with the Brainstem modules stubbed (`python3`, `python` or `py -3`; without one, only the name and description are read)
3. **match** infrastructure profiles (`hackernews`, `memory-write`, `memory-recall`)
4. **make sure the environment has what the profiles need**: creates the custom connector with `pac connector create` when it is missing, then waits for you to create the two connections it cannot create for you (the script prints the exact maker-portal link for each and polls `pac connection list`; the Hacker News connector has no credentials, Dataverse uses your signed-in account)
5. **build** the harness workspace in `.deploy/tutorial/workspace` (settings, skills, tools, connection reference, agent flow)
6. **deploy** through `scripts/deploy-harness-agent.mjs`, which provisions the agent-scoped connection references, creates and activates the flow, binds every tool, removes stale components, publishes, and verifies the live record

Re-running is safe: the connector is reused if present (delete it in the maker portal to pick up a changed definition); the references, the flow and the agent are updated in place.

## Try the agent

- Open the maker link the deploy prints and use **Preview** (the Studio test pane).
- `What are the top 3 stories on Hacker News right now?` runs the flow through the custom connector and returns live stories.
- `Remember this preference exactly: I read Hacker News every morning` writes a row to Dataverse.
- `What do you remember about my reading habits?` reads it back.
- From code: `npm run example:studio-3p` with an Entra app that has the delegated `CopilotStudio.Copilots.Invoke` permission (see the README).

## Options

| Flag | Meaning |
| --- | --- |
| `--environment` | required: `https://<org>.crm.dynamics.com/` (not needed with `--fetch-only`) |
| `--agents "<a>,<b>"` | RAR names (`@rapp/hacker_news`), install file names, or bare file names; replaces the default three |
| `--name`, `--publisher-prefix`, `--schema-name` | the agent's identity (display name ≤ 42 characters) |
| `--wait-minutes N` | how long step 4 waits for you to create each connection (default 15 per connection) |
| `--build-only` | stop after step 5 and leave the workspace on disk; still needs pac and az, and creates the custom connector if it is missing |
| `--fetch-only` | stop after step 3; needs nothing but the public registry (and a python for parameters) |
| `--token-command "..."` | any command that prints a Dataverse bearer token (default: `az account get-access-token`) |
| `--work-dir` | where the agents, workspace and deploy artifacts go (default `.deploy/tutorial`) |
| `--registry`, `--raw-base` | point at another RAR mirror |

## What the profiles are

`tutorial/profiles/hackernews/` holds the custom connector definition (`openapi.json`,
`apiProperties.json`, `script.csx`), the agent-flow definition, the `WorkflowTool` and the skill.
`tutorial/profiles/memory/` holds the two Dataverse tools and the two skills. Placeholders
(`{{SCHEMA_NAME}}`, `{{DISPLAY_NAME}}`, `{{ORG_URL}}`, `{{HN_API_NAME}}`, `{{HN_WORKFLOW_ID}}`) are filled per
environment. The skills are the ones proved live in the reference environment on 10 September 2026:
the Hacker News answer is the flow's `summary` verbatim, and memory writes and recalls go through
the `annotations` table with a deterministic `RAPP_MEMORY|scope=…|type=…` subject.
