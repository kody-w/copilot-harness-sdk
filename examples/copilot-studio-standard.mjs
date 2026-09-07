// Standard-harness Copilot Studio agent through the official client library.
// env: ENTRA_CLIENT_ID, ENTRA_TENANT_ID, COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME
import { HarnessClient, createDeviceCodeTokenProvider } from '../index.js';

const { ENTRA_CLIENT_ID, ENTRA_TENANT_ID, COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME } = process.env;
const client = await HarnessClient.create({
  mode: 'copilot-studio-standard',
  copilotStudio: {
    environmentId: COPILOT_ENVIRONMENT_ID,
    schemaName: COPILOT_SCHEMA_NAME,
    getAccessToken: createDeviceCodeTokenProvider({ clientId: ENTRA_CLIENT_ID, tenantId: ENTRA_TENANT_ID })
  }
});
console.error(client.describe());
const session = await client.createSession();
const { text } = await session.send(process.argv[2] || 'Hello. What can you help with?');
console.log(text);
await client.close();
