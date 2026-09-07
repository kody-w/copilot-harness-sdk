// No-auth agentic Direct Line diagnostic (final-only responses expected).
// env: COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME
import { HarnessClient } from '../index.js';

const { COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME } = process.env;
const client = await HarnessClient.create({
  mode: 'agentic-directline',
  copilotStudio: { environmentId: COPILOT_ENVIRONMENT_ID, schemaName: COPILOT_SCHEMA_NAME }
});
console.error(client.describe());
console.error('preflight:', await client.preflight());
const session = await client.createSession();
const { text, events } = await session.send(process.argv[2] || 'Hello.');
console.log(text);
console.error('event types:', events.map((e) => e.type).join(' → '));
await client.close();
