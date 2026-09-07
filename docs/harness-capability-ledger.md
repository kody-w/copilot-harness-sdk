# Harness capability ledger

What this SDK can do to a Copilot Studio **GitHub Copilot harness** agent, with the evidence for each line. Nothing here is inferred from documentation: every "proved" row was exercised against a live environment (kodyv8, `pac` 2.10.1, 2026-09-07) and, where the row says so, driven through the SDK's own `copilot-studio-3p` route with a delegated token. The ten sample use cases under [`usecases/`](../usecases/) are the reproduction.

## How to reproduce

The Dataverse steps mint tokens with `az account get-access-token --resource <environmentUrl>`; make sure `az account show` is on the environment's tenant first (a second cached identity silently yields 403 "not a member of the organization").

```bash
# 1. generate the ten workspaces (parent agent + child data agent + proof spec each)
node scripts/build-usecase-workspaces.mjs
# 2. deploy them (child first, then parent); every deploy refuses anything that is not cliagent-*
node scripts/deploy-usecases.mjs --concurrency 3
# 3. prove them through the SDK: one device-code sign-in, then scripted turns per component
ENTRA_CLIENT_ID=… ENTRA_TENANT_ID=… COPILOT_ENVIRONMENT_ID=… \
node scripts/prove-usecase.mjs --environment-url https://<org>.crm.dynamics.com/ \
  $(for d in usecases/*/proof.json; do echo --spec $d; done) --out proof-results.json
```

## Component matrix

| Capability | How the SDK does it | Status | Evidence |
| --- | --- | --- | --- |
| Create a harness agent (never classic) | `scripts/deploy-harness-agent.mjs`: `pac copilot init --authoring-mode cli-copilot` → `pack` → **refuse non-`cliagent-*`** → `pac solution import` → PATCH instructions → `pac copilot publish` → `assertHarnessAgent` | proved | 21 agents created this way (10 parents, 10 children, 1 throwaway); every live record `template=cliagent-1.0.0`, `CLICopilotRecognizer` |
| Instructions, greeting, conversation starters, model | PATCH `bots(<id>).configuration.agentSettings` after import (pac `pack` and `push` both drop them) | proved | readback shows segments, `greetingText`, 2 starters, `Sonnet46` |
| Knowledge: public website | `capabilities/knowledge/<Name>.mcs.yml` → `KnowledgeSourceConfiguration` / `WebsiteKnowledgeSource`, carried by `pack` | proved | `knowledge.<Name>` botcomponent on every parent; knowledge turn in the proof |
| Tool: MCP server (custom connector) | `capabilities/tools/<Name>.mcs.yml` → `McpTool` + `infrastructure/connections/<ref>.sync.yaml` | proved | `tool.<Name>` botcomponent; Dataverse MCP on all 10, domain MCP on 4 |
| Tool: connector action | `ConnectorTool` (same connection-reference rule) | shape proved by clone of a live agent; not exercised in the samples | RAPP News Memory Pilot clone: `CreateRecordWithOrganization` |
| Tool: agent flow | `WorkflowTool` + `workflows/<Name>-<id>/`; **pac `pack` rejects it**, so the deploy script clones the imported agent and `pac copilot push`es the tool | proved | `tool.SiteWeather` on every parent; workflow turn in the proof |
| Connected agent | `ConnectedAgentTool` → `botSchemaName` of the child, `historyType: ConversationHistory` | proved | `tool.connected-agent.<Name>` on every parent; compare turn answers from the child's dataset |
| Skill | `behaviors/<name>.mcs.yml` → `InlineAgentSkill` with a SKILL.md body | proved | `skill.<name>` botcomponent; report turn follows the skill's template |
| Connection references | `infrastructure/connections/*.sync.yaml`; import binds to the existing connection | proved | `Assets/botcomponent_connectionreferenceset.xml` in every packed solution |
| Environment variables | `upsertEnvironmentVariable()` (Dataverse definitions + values); the workspace form is ignored by `pack` | proved | `cr8c1_RenewalNoticeDays` created and set |
| Solution packaging | `pac copilot pack` → one unmanaged solution per agent, `<language>0</language>` fixed before import | proved | 10 solutions imported |
| Sharing | `shareAgent()` → Dataverse `GrantAccess` | proved | 204 on the throwaway agent |
| Security groups | `setAccessControl({ policy, securityGroupIds })` → `accesscontrolpolicy` + `authorizedsecuritygroupids` | proved | readback on the throwaway agent |
| Channels (Teams, Microsoft 365 Copilot) | `setChannels()` → `configuration.channels[]` + publish | declared and published; the Teams app package itself is portal-owned | readback shows both `ChannelDefinition`s after publish |
| Talk to the agent from code | `HarnessClient` mode `copilot-studio-3p`, delegated token with `CopilotStudio.Copilots.Invoke` | proved | see results below |

## Live records (Dataverse, read through `assertHarnessAgent` + `listComponents`, 2026-09-07)

All twenty records are `cliagent-1.0.0` / `CLICopilotRecognizer`, published, with instructions; every parent carries a knowledge source, an MCP tool, an agent-flow tool, a connected agent, and a skill.

| Use case | Agent | Template | Model | Instructions | Components |
| --- | --- | --- | --- | --- | --- |
| claims-intake-reconciliation | `cr8c1_ClaimsIntakeReconciliationCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1614 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,McpTool,WorkflowTool |
| claims-intake-reconciliation | `cr8c1_ClaimsIntakeReconciliationDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 912 chars | (child: instructions only) |
| clinical-trial-site-activation | `cr8c1_ClinicalTrialSiteActivationCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1628 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,McpTool,WorkflowTool |
| clinical-trial-site-activation | `cr8c1_ClinicalTrialSiteActivationDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 951 chars | (child: instructions only) |
| grant-compliance-reporting | `cr8c1_GrantComplianceReportingCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1677 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,WorkflowTool |
| grant-compliance-reporting | `cr8c1_GrantComplianceReportingDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 901 chars | (child: instructions only) |
| hr-policy-change-rollout | `cr8c1_HRPolicyChangeRolloutCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1650 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,WorkflowTool |
| hr-policy-change-rollout | `cr8c1_HRPolicyChangeRolloutDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 959 chars | (child: instructions only) |
| loan-servicing-exception | `cr8c1_LoanServicingExceptionCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1615 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,McpTool,WorkflowTool |
| loan-servicing-exception | `cr8c1_LoanServicingExceptionDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 843 chars | (child: instructions only) |
| manufacturing-bom-change | `cr8c1_ManufacturingBOMChangeCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1589 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,WorkflowTool |
| manufacturing-bom-change | `cr8c1_ManufacturingBOMChangeDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 1045 chars | (child: instructions only) |
| retail-media-campaign-trafficking | `cr8c1_RetailMediaCampaignCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1604 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,WorkflowTool |
| retail-media-campaign-trafficking | `cr8c1_RetailMediaCampaignDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 1032 chars | (child: instructions only) |
| store-merchandising-reset | `cr8c1_StoreMerchandisingResetCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1636 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,WorkflowTool |
| store-merchandising-reset | `cr8c1_StoreMerchandisingResetDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 1015 chars | (child: instructions only) |
| supplier-onboarding-compliance | `cr8c1_SupplierOnboardingComplianceCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1685 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,WorkflowTool |
| supplier-onboarding-compliance | `cr8c1_SupplierOnboardingComplianceDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 892 chars | (child: instructions only) |
| vendor-contract-renewal | `cr8c1_VendorContractRenewalCopilot` (parent) | cliagent-1.0.0 | Sonnet46 | 1598 chars | ConnectedAgentTool,InlineAgentSkill,Knowledge,McpTool,McpTool,WorkflowTool |
| vendor-contract-renewal | `cr8c1_VendorContractRenewalDataAgent` (child) | cliagent-1.0.0 | Sonnet46 | 1075 chars | (child: instructions only) |

## Proof results (SDK turns over `/3p`)

_Filled in by `scripts/prove-usecase.mjs --out`; see the table appended at the bottom of this file._

## What still needs a person or the portal

- **Connection consent.** A connection reference binds to a connection that someone created and consented in the portal. The SDK can reference and reuse them; it cannot create them.
- **Flow authoring.** There is no `pac flow create`; the SDK links an existing activated flow. Shipping a new flow means adding its `workflow.json` to the solution.
- **Teams app package.** `setChannels` declares the channel; the portal builds the app manifest on first publish.
- **Skill bundles with files.** Inline skills work from YAML; zip-bundled skills with Python resources are portal upload only in pac 2.10.1.
- **Device-code sign-in.** Every new process that calls an agent needs one interactive sign-in (the SDK's MSAL cache is in-process).

## pac 2.10.1 defects the SDK works around

1. `pac copilot pack` writes `<language>0</language>`; import rejects it. Patched in the zip.
2. `pack` and `push` drop `agentSettings.instructions`, `greetingText`, `conversationStarters`. Re-applied by PATCH.
3. `pack` cannot resolve a `WorkflowTool` from an init workspace. Deferred to clone → push.
4. `pac copilot publish` crashes with "Invalid response format" while a freshly imported bot is still provisioning. Retried with back-off.
5. `pac copilot push` returns `ConcurrencyVersionMismatch` if the clone happened during provisioning. Retried.
6. A bot whose **display name is longer than 42 characters never finishes provisioning** (44 stalled for 40+ minutes, 41 provisioned in a minute; bisected with identical instructions). `pac` gives no error; publish just keeps failing. The deploy script and the generator refuse names over 42 characters.
7. `pac copilot init --environment` creates the bot remotely before the solution import, so a failed first run cannot be retried ("already exists"). The script scaffolds locally and lets the import create the bot.
8. Solution unique names of 50+ characters are rejected at import; the script truncates to 49.
9. Dataverse serialises solution operations per environment ("another [PublishAll] running"); imports are retried with back-off.
