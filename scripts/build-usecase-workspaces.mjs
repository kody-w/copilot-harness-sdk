#!/usr/bin/env node
// Generate a GitHub Copilot harness workspace (parent agent + child data agent + proof spec) for every
// use case in usecases/usecases.json. Output: usecases/<slug>/{agent/, child-instructions.md, proof.json}.
//
// Every generated agent carries the same component set so the SDK proof covers each type:
//   settings.mcs.yml   instructions, model, greeting, conversation starters
//   knowledge/         WebsiteKnowledgeSource (public site)
//   tools/             McpTool (Dataverse MCP, plus a domain MCP when the environment has one),
//                      ConnectedAgentTool (the child data agent), WorkflowTool (agent flow)
//   behaviors/         InlineAgentSkill (the report procedure)
//   infrastructure/    connection references the tools depend on
//   workflows/         the flow definition the WorkflowTool links to (needed for pac push)
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'usecases/usecases.json'), 'utf8'));
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const y = (s) => JSON.stringify(String(s)); // YAML-safe double-quoted scalar
const block = (s, indent) => s.split('\n').map((l) => ' '.repeat(indent) + l).join('\n');
// Schema names above ~45 characters have been seen to leave the bot stuck in "Provisioning"; use `schemaBase` to shorten.
const schema = (u, suffix = '') => `${cfg.publisherPrefix}_${(u.schemaBase || u.name.replace(/ Copilot$/, '')).replace(/[^A-Za-z0-9]/g, '')}${suffix}`;

for (const u of cfg.usecases) {
  if (only && u.slug !== only) continue;
  const dir = join(root, 'usecases', u.slug);
  const ws = join(dir, 'agent');
  rmSync(ws, { recursive: true, force: true });
  for (const d of ['capabilities/knowledge', 'capabilities/tools', 'behaviors', 'infrastructure/connections', 'workflows']) mkdirSync(join(ws, d), { recursive: true });
  const parent = schema(u, 'Copilot');
  const child = schema(u, 'DataAgent');
  // Display names longer than 42 characters leave the bot stuck in "Provisioning" (44 stalled, 41 worked, 2026-09-07).
  const childName = u.childDisplayName || `${u.name.replace(/ Copilot$/, '')} Data Agent`;
  for (const n of [u.name, childName]) if (n.length > 42) throw new Error(`Display name "${n}" is ${n.length} characters; keep agent names at 42 or fewer (set childDisplayName).`);
  const skill = `${u.report.replace(/\s+/g, '-').toLowerCase()}`;
  const instructions = [
    `You are the ${u.name} for a ${u.teams} team.`,
    '',
    `Your job: help the team manage ${u.manages} and prepare the ${u.packet}. Users ask in natural language to compare ${u.compare}, flag ${u.flags}, validate ${u.validates}, and review ${u.reviews}. You produce a concise, source-cited ${u.report}.`,
    '',
    'Rules:',
    `- Ground every factual claim in a source: cite the record id, the knowledge source, or the tool that returned it. Never invent records, dates, amounts, or names.`,
    `- When asked about policy, regulation, or requirements, search the connected knowledge first and say which source you used.`,
    `- When asked for the ${u.report}, a packet review, or a comparison summary, follow the ${skill} skill exactly.`,
    `- Any question that needs the actual contents of a record id (such as ${u.idA} or ${u.idB}) is answered by delegating to the ${childName} and reporting what it returned.`,
    `- Use the Site Weather tool only when the user asks about weather at a site, store, facility, or route.`,
    `- Use the Environment Data (Dataverse MCP) tool only when the user explicitly asks to look up Dataverse tables, and never write to them.`,
    `- ${u.finalAction.charAt(0).toUpperCase() + u.finalAction.slice(1)} always remain with ${u.finalOwner}. Never say a ${u.packet} is approved, released, or final. End every ${u.report} with a line that starts "Recommended next step for ${u.finalOwner.replace(/^the /, '')}:".`,
    '- Be concise: answer in under 150 words unless the user asks for a full report.'
  ].join('\n');
  const settings = `displayName: ${y(u.name)}
schemaName: ${y(parent)}
accessControlPolicy: GroupMembership
authenticationMode: Integrated
authenticationTrigger: Always
configuration:
  authoringModel: CliCopilot
  recognizer:
    kind: CLICopilotRecognizer
  agentSettings:
    model:
      series: Sonnet46
    instructions:
      segments:
        - kind: StaticSegment
          value: |-
${block(instructions, 12)}
    greetingText: ${y(`Hi, I'm the ${u.name}. Ask me to compare ${u.compare}, check a ${u.packet}, or draft the ${u.report}.`)}
    conversationStarters:
      - title: ${y('Compare')}
        text: ${y(`Compare ${u.idA} against ${u.idB} and flag ${u.flags}.`)}
      - title: ${y('Report')}
        text: ${y(`Produce the ${u.report} for ${u.idA} -> ${u.idB}.`)}
template: cliagent-1.0.0
language: 1033
`;
  writeFileSync(join(ws, 'settings.mcs.yml'), settings);
  writeFileSync(join(ws, 'agent.sync.yaml'), '# Workspace layout marker (Sync overlay; generic YAML, never MCS-parsed).\nlayoutVersion: 1\n');
  writeFileSync(join(ws, `capabilities/knowledge/${u.knowledge.name}.mcs.yml`), `mcs.metadata:
  componentName: ${y(u.knowledge.componentName)}
  description: ${y(u.knowledge.description)}
kind: KnowledgeSourceConfiguration
source:
  kind: WebsiteKnowledgeSource
  siteUrl: ${u.knowledge.url}
`);
  const mcps = [cfg.shared.environmentMcp, ...(u.domainMcp ? [u.domainMcp] : [])];
  for (const m of mcps) {
    writeFileSync(join(ws, `capabilities/tools/${m.name}.mcs.yml`), `mcs.metadata:
  componentName: ${y(m.componentName)}
  description: ${y(m.description)}
kind: McpTool
authMode: Maker
connectionReference: ${m.connectionReference}
connectorId: ${m.connectorId}
operationId: InvokeMCP
`);
    writeFileSync(join(ws, `infrastructure/connections/${m.connectionReference}.sync.yaml`), `connectionReferences:
  - connectionReferenceLogicalName: ${m.connectionReference}
    connectorId: ${m.connectorId}
`);
  }
  writeFileSync(join(ws, `capabilities/tools/${childName.replace(/\s+/g, '')}.mcs.yml`), `mcs.metadata:
  componentName: ${y(childName)}
  description: ${y(`Fetches records by id (for example ${u.idA} or ${u.idB}) from the system of record: the full contents needed to compare ${u.compare}. Use for any question that needs the actual contents of a record. Do not use for policy or regulation questions; search knowledge for those.`)}
kind: ConnectedAgentTool
botSchemaName: ${child}
historyType:
  kind: ConversationHistory
`);
  const wf = cfg.shared.workflowTool;
  writeFileSync(join(ws, `capabilities/tools/${wf.name}.mcs.yml`), `mcs.metadata:
  componentName: ${y(wf.componentName)}
  description: ${y(wf.description)}
kind: WorkflowTool
workflowId: ${wf.workflowId}
toolInputs:
${wf.inputs.map((i) => `  - name: ${i.name}\n    displayName: ${i.name}\n    description: ${y(i.description)}`).join('\n')}
toolOutputs:
${wf.outputs.map((o) => `  - name: ${o}`).join('\n')}
`);
  cpSync(join(root, 'usecases/_shared/workflows', wf.workflowFolder), join(ws, 'workflows', wf.workflowFolder), { recursive: true });
  const skillBody = `---
name: ${skill}
description: ${`Produces the source-cited ${u.report} for ${u.manages}. Use when the user asks for the ${u.report}, a ${u.packet} review, or a comparison summary for specific record ids. Requires two record ids.`}
---
# ${u.report.charAt(0).toUpperCase() + u.report.slice(1)}

## Step 1 - Establish the inputs
You need the two record ids to compare (for example ${u.idA} and ${u.idB}). If either is missing, ask for it before doing anything else.

## Step 2 - Gather
1. Ask the ${childName} for both records.
2. Search knowledge for the applicable policy or regulation.
3. Only if the user asks for weather at a site, call Site Weather.

## Step 3 - Write the report (max 180 words)
\`\`\`
${u.report.toUpperCase()} - <first id> -> <second id>
Changes: <each change on its own line with the old -> new value>  [source]
Missing items: <list or "none">  [source]
Flags: <${u.flags}>  [source]
Rating: Low | Medium | High - one sentence why
Recommended next step for ${u.finalOwner.replace(/^the /, '')}: <one sentence>
\`\`\`

## Rules
- Lead with the differences; a list of things that are fine is noise.
- An item present in the first record but absent in the second is "missing".
- Never invent a value. If a lookup returns nothing, write "not found".
- Never say the ${u.packet} is approved, released, or final. ${u.finalAction.charAt(0).toUpperCase() + u.finalAction.slice(1)} remain with ${u.finalOwner}.
`;
  writeFileSync(join(ws, `behaviors/${skill}.mcs.yml`), `mcs.metadata:
  componentName: ${y(skill)}
  description: ${y(`Produces the source-cited ${u.report} for ${u.manages}. Use when the user asks for the ${u.report}, a ${u.packet} review, or a comparison summary for specific record ids. Requires two record ids.`)}
kind: InlineAgentSkill
content: |
${block(skillBody, 2)}
`);
  writeFileSync(join(dir, 'child-instructions.md'), `You are the ${childName}. You are called by other agents, not by end users.
You return records from the system of record. Because no live system is connected in this sample, you answer from this fixed dataset and cite it as ${u.sourcePrefix}<id>:
- ${u.idA}: ${u.recordA}
- ${u.idB}: ${u.recordB}
If asked for an id not listed, say it does not exist. Never invent fields. Answer in a compact structured list.
`);
  const proof = {
    schemaName: parent,
    childSchemaName: child,
    turns: [
      { component: 'knowledge', prompt: u.proofExpect.knowledgeQuestion, expect: u.proofExpect.knowledge },
      { component: 'connected-agent', prompt: `Compare ${u.idA} against ${u.idB} and flag ${u.flags}.`, expect: u.proofExpect.compare },
      { component: 'skill', prompt: `Produce the ${u.report} for ${u.idA} -> ${u.idB}.`, expect: [`Recommended next step for ${u.finalOwner.replace(/^the /, '')}`, 'Rating|REPORT'] },
      { component: 'workflow-tool', prompt: 'Use the Site Weather tool: what is the weather in Monterrey, Mexico for the next 2 days?', expect: ['Monterrey', '°|degrees|rain|cloud|clear|sunny|forecast|humid|wind'] },
      { component: 'mcp-tool', prompt: u.domainMcp ? `Use the ${u.domainMcp.componentName} tool and tell me what it can do; list the tools it exposes.` : 'Use the Environment Data (Dataverse MCP) tool to list the tools it exposes; do not change any data.', expect: ['tool|list|search|get|verify|log|enrich|table|record'] }
    ]
  };
  writeFileSync(join(dir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(`${u.slug}: ${parent} + ${child} → ${ws}`);
}
