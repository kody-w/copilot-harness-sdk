// Copilot Studio: a trailing text-less message (card) wipes the streamed answer; send().text === ''.
import { HarnessClient } from '../index.js';
const ENV = '11111111-2222-3333-4444-555555555555';
const factory = () => { const c = {
  conversationId: undefined, token: 't',
  async *startConversationStreaming() { c.conversationId = 'conv-1'; yield { type: 'event', name: 'startConversation' }; },
  async *executeStreaming() {
    yield { type: 'typing', text: 'The answer is 42', channelData: { streamType: 'streaming', streamId: 's1', streamSequence: 1 } };
    yield { type: 'message', text: 'The answer is 42.', channelData: { streamType: 'final', streamId: 's1' } };
    yield { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {} }] };
    yield { type: 'event', name: 'turn.complete' };
  }
}; return c; };
const client = await HarnessClient.create(
  { mode: 'copilot-studio-standard', copilotStudio: { environmentId: ENV, schemaName: 'a_b', getAccessToken: async () => 't' } },
  { clientFactory: factory }
);
const session = await client.createSession();
const r = await session.send('q');
console.log('send().text =', JSON.stringify(r.text));
console.log('events:', r.events.map((e) => e.type + (e.type === 'text.final' || e.type === 'idle' ? `(${JSON.stringify(e.text)})` : '')));
