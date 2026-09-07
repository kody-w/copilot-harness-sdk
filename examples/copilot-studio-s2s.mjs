// App-only S2S against a No Authentication harness agent (private preview).
// env: S2S_CLIENT_ID, S2S_TENANT_ID, S2S_CLIENT_SECRET, COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME
import { HarnessClient, createClientCredentialTokenProvider } from '../index.js';

const { S2S_CLIENT_ID, S2S_TENANT_ID, S2S_CLIENT_SECRET, COPILOT_ENVIRONMENT_ID, COPILOT_SCHEMA_NAME } = process.env;
const client = await HarnessClient.create({
  mode: 'copilot-studio-s2s',
  copilotStudio: {
    environmentId: COPILOT_ENVIRONMENT_ID,
    schemaName: COPILOT_SCHEMA_NAME,
    getAccessToken: createClientCredentialTokenProvider({ clientId: S2S_CLIENT_ID, tenantId: S2S_TENANT_ID, clientSecret: S2S_CLIENT_SECRET })
  }
});
console.error(client.describe());
try {
  console.error('preflight:', await client.preflight());
  const session = await client.createSession();
  const { text } = await session.send(process.argv[2] || 'Hello from an app-only identity.');
  console.log(text);
} catch (err) {
  console.error(`[${err.httpStatus || 'error'}] ${err.message}${err.hint ? `\nhint: ${err.hint}` : ''}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
