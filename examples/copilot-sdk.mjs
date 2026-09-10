// In-process Copilot CLI harness with a custom tool and an MCP server.
// Needs a Copilot login (`copilot` CLI) or COPILOT_GITHUB_TOKEN.
import { defineTool } from '@github/copilot-sdk';
import { HarnessClient } from '../index.js';

const client = await HarnessClient.create({
  mode: 'copilot-sdk',
  copilotSdk: {
    model: process.env.COPILOT_HARNESS_MODEL || 'auto',
    instructions: 'You are a concise assistant. Use tools when they apply.',
    tools: [
      defineTool('lookupOrder', {
        description: 'Look up an order by id',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        handler: async ({ id }) => ({ id, status: 'shipped', eta: '2 days' })
      })
    ],
    permissions: 'emit',
    runtime: { mode: 'empty' }
  }
});

console.error(client.describe());
client.onEvent((ev) => {
  if (ev.type === 'permission.request') {
    // Observed request kinds include "custom-tool" (our own tools); shell, file
    // and URL requests are the built-in ambient tools. Approve only our tools.
    const kind = /** @type {any} */ (ev.request)?.kind;
    const decision = kind === 'custom-tool' ? 'approve' : 'deny';
    console.error(`\n[permission] kind=${kind} tool=${/** @type {any} */ (ev.request)?.toolName ?? '-'} → ${decision}`);
    ev.respond(decision);
  }
});

const session = await client.createSession();
for await (const ev of session.stream(process.argv[2] || 'What is the status of order 42? Answer in one sentence.')) {
  if (ev.type === 'text.delta') process.stdout.write(ev.delta);
  else if (ev.type === 'tool.start') console.error(`\n[tool.start] ${ev.name} ${JSON.stringify(ev.args)}`);
  else if (ev.type === 'tool.end') console.error(`[tool.end] ${ev.id} success=${ev.success}`);
  else if (ev.type === 'usage') console.error(`\n[usage] ${ev.model} in=${ev.inputTokens} out=${ev.outputTokens}`);
  else if (ev.type === 'error') console.error(`\n[error] ${ev.error.message}`);
}
console.log();
await session.close();
await client.close();
