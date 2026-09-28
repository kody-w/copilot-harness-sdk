// Serve a harness agent to Teams and Microsoft 365 Copilot through the Microsoft 365 Agents SDK.
//
//   npm install @microsoft/agents-hosting @microsoft/agents-hosting-express
//   npm run example:host
//
// Local testing needs no settings: with no clientId the Agents SDK accepts anonymous requests
// (never when NODE_ENV=production). For Teams and Microsoft 365 Copilot, set the Azure Bot's
// app registration in the environment: clientId, tenantId, clientSecret. PORT defaults to 3978.
import { startServer } from '@microsoft/agents-hosting-express';
import { HarnessClient, createAgentsSdkAgent } from '../index.js';

const client = await HarnessClient.create({
  mode: 'copilot-sdk',
  copilotSdk: {
    model: 'auto',
    instructions: 'You are a helpful assistant inside Microsoft Teams. Answer in under 100 words.',
    // One runtime serves every conversation: custom tools only, no ambient shell, file or URL tools.
    runtime: { mode: 'empty' },
    permissions: 'deny'
  }
});

const hosted = await createAgentsSdkAgent({
  client,
  greeting: 'Hi. Ask me anything.',
  onError: (error) => console.error(`[turn failed] ${error.message}`)
});

const server = startServer(hosted.agent);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.close?.();
    await hosted.close();
    await client.close();
    process.exit(0);
  });
}
