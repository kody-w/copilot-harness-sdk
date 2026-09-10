# Ten harness use cases: run them, compare them, use them as the SDK's regression suite

Each folder is one Copilot Studio **GitHub Copilot harness** agent pair produced by this SDK: a parent "packet copilot" with every component type, and a child data agent it delegates to. The `exports/` zips are the solutions as they exist in the reference environment after deployment, exported with `pac solution export`. Deploy the same folder yourself and compare.

| Folder | What is in it |
| --- | --- |
| `agent/` | The pac workspace the SDK deploys: `settings.mcs.yml`, `capabilities/knowledge`, `capabilities/tools` (MCP, connected agent, agent flow), `behaviors/` (skill), `infrastructure/connections`, `workflows/` |
| `child-instructions.md` | The child data agent's instructions (a fixed synthetic dataset, cited as `<System>://<id>`) |
| `proof.json` | Scripted turns per component with the regexes the answer must satisfy |
| `exports/<Solution>.zip` | Reference exports of the deployed parent and child solutions (`pac solution export`, then `scripts/strip-connector-code.mjs` removed the custom-connector definitions: bring your own MCP connector) |

## Run

```bash
npm install
az login                                   # the Dataverse user of the target environment
pac auth create --environment <env-url>    # or reuse an existing pac profile

# put your environmentUrl, environmentId and connection reference in usecases/usecases.local.json
# (gitignored; the same keys as usecases.json, which ships placeholders). Also set the
# references for the MCP tools (pac connection list) and the workflowId of an activated agent flow.
npm run build:usecases                     # regenerate agent/ from usecases.json
npm run deploy:usecases                    # child first, then parent; harness template or nothing
```

Each deploy ends with the live record read back through `assertHarnessAgent` and the components listed through `listComponents`.

## Compare with the reference exports

```bash
# every use case: live agent vs the shipped export (template, recognizer, model, component set)
node scripts/compare-solution.mjs --all --environment-url https://<org>.crm.dynamics.com/

# one export you made yourself
pac solution export --name <Solution> --path mine.zip
node scripts/compare-solution.mjs --reference usecases/vendor-contract-renewal/exports/cr8c1VendorContractRenewalCopilotHarness.zip --zip mine.zip
```

## Prove them through the SDK

```bash
ENTRA_CLIENT_ID=<app with delegated CopilotStudio.Copilots.Invoke> ENTRA_TENANT_ID=<tenant> COPILOT_ENVIRONMENT_ID=<env id> \
node scripts/prove-usecase.mjs $(for p in usecases/*/proof.json; do echo --spec $p; done) --out proof-results.json
```

One device-code sign-in, then five turns per agent: knowledge, connected agent, skill, agent-flow tool, MCP tool. A turn passes only when the answer matches every regex in `proof.json`; the weather turn, for instance, must contain live temperatures that only the flow can produce.

## Using this as the regression suite

After a change to the SDK or its scripts:

1. `npm test` (unit tests, offline).
2. `npm run build:usecases && npm run deploy:usecases` into a scratch environment.
3. `node scripts/compare-solution.mjs --all` against the exports in this folder. A difference in template, recognizer, model or component set is a regression.
4. `npm run prove:usecase -- …` for the behavioural check.

Regenerate the exports with `node scripts/export-usecases.mjs && node scripts/strip-connector-code.mjs usecases/*/exports/*.zip` only when the change to the samples is intended. The export script first adds every pushed component and custom connector to the agent's solution and links each connection reference to its connector, because `pac solution export` refuses the solution otherwise.

## Names and limits that bite

- Agent display names longer than 42 characters never finish provisioning. Use `childDisplayName` / `schemaBase` in `usecases.json` to shorten.
- Solution unique names must be under 50 characters (the scripts truncate to 49).
- The MCP tools need connection references that already exist in the target environment; create the connections once in the portal, then point `usecases.json` at their logical names.
