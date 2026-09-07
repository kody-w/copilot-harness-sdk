// Copilot Studio: a failing startConversationStreaming is swallowed by pump(); createSession reports a misleading error.
import { HarnessClient } from '../index.js';
const ENV = '11111111-2222-3333-4444-555555555555';
const factory = () => ({
  conversationId: '', token: 't',
  async *startConversationStreaming() { const e = new Error('Request failed with status 403 Forbidden'); e.httpStatus = 403; throw e; },
  async *executeStreaming() {}
});
const client = await HarnessClient.create(
  { mode: 'copilot-studio-standard', copilotStudio: { environmentId: ENV, schemaName: 'a_b', getAccessToken: async () => 't' } },
  { clientFactory: factory }
);
const viaOnEvent = []; client.onEvent((e) => { if (e.type === 'error') viaOnEvent.push(e.error.message); });
try { await client.createSession(); console.log('createSession resolved?!'); } catch (e) { console.log('createSession rejected with:', JSON.stringify(e.message), '| httpStatus:', e.httpStatus); }
console.log('real failure only observable via onEvent:', viaOnEvent);
