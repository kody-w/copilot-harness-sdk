// Copilot Studio GitHub Copilot harness agent over the /3p route, delegated user.
// env: ENTRA_CLIENT_ID, ENTRA_TENANT_ID, COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME
import { HarnessClient, createDeviceCodeTokenProvider } from '../index.js';

const { ENTRA_CLIENT_ID, ENTRA_TENANT_ID, COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME } = process.env;
if (!ENTRA_CLIENT_ID || !ENTRA_TENANT_ID || !COPILOT_ENVIRONMENT_ID || !COPILOT_SCHEMA_NAME) {
  console.error('Set ENTRA_CLIENT_ID, ENTRA_TENANT_ID, COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME.');
  process.exit(2);
}

const client = await HarnessClient.create({
  mode: 'copilot-studio-3p',
  copilotStudio: {
    environmentId: COPILOT_ENVIRONMENT_ID,
    schemaName: COPILOT_SCHEMA_NAME,
    getAccessToken: createDeviceCodeTokenProvider({ clientId: ENTRA_CLIENT_ID, tenantId: ENTRA_TENANT_ID })
  }
});

console.error(client.describe());
console.error('preflight:', await client.preflight());

const session = await client.createSession();
console.error(`conversation ${session.conversationId}; greeting:`, session.greeting.filter((e) => e.type === 'text.final').map((e) => e.text));
for await (const ev of session.stream(process.argv[2] || 'Introduce yourself in two sentences.')) {
  if (ev.type === 'status') console.error(`[status] ${ev.text}`);
  else if (ev.type === 'text.delta') process.stdout.write(ev.delta);
  else if (ev.type === 'error') console.error(`\n[error] ${ev.error.message}`);
}
console.log();
await client.close();
