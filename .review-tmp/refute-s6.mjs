import { createCopilotStudioAdapter } from '../src/adapters/copilot-studio.js';
import { TextAccumulator, normalizeStudioActivity } from '../src/events.js';

// 1. Pure accumulator/normalizer check
const acc = new TextAccumulator();
const evs = [
  { type: 'typing', text: 'The answer is 42', channelData: { streamType: 'streaming', streamId: 's1', streamSequence: 1 } },
  { type: 'message', text: 'The answer is 42.', channelData: { streamType: 'final', streamId: 's1' } },
  { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard' } }] },
  { type: 'event', name: 'turn.complete' }
].flatMap((a) => normalizeStudioActivity(a, acc));
console.log('normalize:', evs.map((e) => `${e.type}(${JSON.stringify(e.text ?? e.delta ?? '')})`));
console.log('acc.snapshot after turn:', JSON.stringify(acc.snapshot));

// 2. Adapter-level check with a fake client (copilot-studio-standard, no preflight since conversationsUrl undefined)
const turnActivities = [
  { type: 'typing', text: 'The answer is 42', channelData: { streamType: 'streaming', streamId: 's1', streamSequence: 1 } },
  { type: 'message', text: 'The answer is 42.', channelData: { streamType: 'final', streamId: 's1' } },
  { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard' } }] },
  { type: 'event', name: 'turn.complete' }
];
const fakeClient = {
  conversationId: 'conv-1',
  token: 't',
  async *startConversationStreaming() { yield { type: 'event', name: 'startConversation' }; },
  async *executeStreaming() { for (const a of turnActivities) yield a; }
};
const adapter = await createCopilotStudioAdapter('copilot-studio-standard', {
  environmentId: 'env', schemaName: 'schema', getAccessToken: async () => 'tok'
}, { clientFactory: () => fakeClient });
const session = await adapter.createSession();
const res = await session.send('q');
console.log('send().text =', JSON.stringify(res.text));
console.log('events:', res.events.map((e) => `${e.type}(${JSON.stringify(e.text ?? e.delta ?? '')})`));

// 3. Control: same turn WITHOUT the trailing card message
const fakeClient2 = { ...fakeClient, async *executeStreaming() { for (const a of turnActivities.filter((x) => !x.attachments)) yield a; } };
const adapter2 = await createCopilotStudioAdapter('copilot-studio-standard', {
  environmentId: 'env', schemaName: 'schema', getAccessToken: async () => 'tok'
}, { clientFactory: () => fakeClient2 });
const s2 = await adapter2.createSession();
console.log('control send().text =', JSON.stringify((await s2.send('q')).text));
