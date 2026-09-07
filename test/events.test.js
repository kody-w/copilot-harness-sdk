import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextAccumulator, normalizeStudioActivity, createEventQueue } from '../src/events.js';
import { createSdkEventMapper } from '../src/adapters/copilot-sdk-map.js';

test('TextAccumulator treats cumulative snapshots as such (Node client shape, verified 5 Aug 2026)', () => {
  const acc = new TextAccumulator();
  assert.equal(acc.push('Hel'), 'Hel');
  assert.equal(acc.push('Hello, wo'), 'lo, wo');
  assert.equal(acc.push('Hello, world'), 'rld');
  assert.equal(acc.snapshot, 'Hello, world');
  assert.equal(acc.shape, 'cumulative');
  assert.equal(acc.finalize('Hello, world!'), '!');
  assert.equal(acc.snapshot, 'Hello, world!');
});

test('TextAccumulator appends delta fragments (Agent Framework shape, verified 6 Aug 2026)', () => {
  const acc = new TextAccumulator();
  assert.equal(acc.push('Hel'), 'Hel');
  assert.equal(acc.push('lo, '), 'lo, ');
  assert.equal(acc.push('world'), 'world');
  assert.equal(acc.snapshot, 'Hello, world');
  assert.equal(acc.shape, 'delta');
  assert.equal(acc.finalize('Hello, world'), '');
});

test('normalizeStudioActivity maps the Web Chat livestreaming protocol', () => {
  const acc = new TextAccumulator();
  const events = [
    { type: 'typing', text: 'Searching…', channelData: { streamType: 'informative', streamId: 's1', streamSequence: 1 } },
    { type: 'typing', text: 'The answer', channelData: { streamType: 'streaming', streamId: 's1', streamSequence: 2 } },
    { type: 'typing', text: 'The answer is 42', channelData: { streamType: 'streaming', streamId: 's1', streamSequence: 3 } },
    { type: 'message', text: 'The answer is 42.', channelData: { streamType: 'final', streamId: 's1' }, attachments: [] },
    { type: 'event', name: 'turn.complete' }
  ].flatMap((a) => normalizeStudioActivity(a, acc));
  assert.deepEqual(
    events.map((e) => e.type),
    ['status', 'text.delta', 'text.delta', 'text.delta', 'text.final', 'raw']
  );
  assert.equal(events[0].text, 'Searching…');
  assert.equal(events[1].delta, 'The answer');
  assert.equal(events[2].delta, ' is 42');
  assert.equal(events[2].snapshot, 'The answer is 42');
  assert.equal(events[3].delta, '.');
  assert.equal(events[4].text, 'The answer is 42.');
  assert.equal(events[4].streamId, 's1');
});

test('normalizeStudioActivity handles final-only agents (no-auth agentic Direct Line observation)', () => {
  const acc = new TextAccumulator();
  const events = [
    { type: 'typing' },
    { type: 'message', text: 'Complete answer.' },
    { type: 'event', name: 'turn.complete' }
  ].flatMap((a) => normalizeStudioActivity(a, acc));
  assert.deepEqual(events.map((e) => e.type), ['raw', 'text.delta', 'text.final', 'raw']);
  assert.equal(events[2].text, 'Complete answer.');
});

test('createSdkEventMapper maps Copilot SDK events using the 1.0.13 field names', () => {
  const m = createSdkEventMapper({ turn: 1 });
  const seq = [
    { type: 'assistant.turn_start', data: { turnId: 't1' } },
    { type: 'assistant.intent', data: { intent: 'Looking up the file' } },
    { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'read_file', arguments: { path: 'a.txt' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'x' } } },
    { type: 'assistant.message_delta', data: { deltaContent: 'Hello', messageId: 'm1' } },
    { type: 'assistant.message_delta', data: { deltaContent: ' world', messageId: 'm1' } },
    { type: 'assistant.message', data: { content: 'Hello world', messageId: 'm1', model: 'gpt-5.4' } },
    { type: 'assistant.usage', data: { model: 'gpt-5.4', inputTokens: 10, outputTokens: 2, cost: 1, isByok: false } },
    { type: 'session.idle', data: {} }
  ].map((e) => m.map(e));
  assert.deepEqual(
    seq.map((r) => r.event.type),
    ['raw', 'status', 'tool.start', 'tool.end', 'text.delta', 'text.delta', 'text.final', 'usage', 'idle']
  );
  assert.equal(seq[5].event.snapshot, 'Hello world');
  assert.equal(seq[6].event.text, 'Hello world');
  assert.equal(seq[6].event.model, 'gpt-5.4');
  assert.equal(seq[7].event.inputTokens, 10);
  assert.equal(seq[8].done, true);
  assert.equal(seq[8].event.text, 'Hello world');
  assert.equal(seq[2].event.name, 'read_file');
  assert.equal(seq[3].event.success, true);
});

test('createSdkEventMapper surfaces session.error with code and status', () => {
  const m = createSdkEventMapper();
  const { event } = m.map({ type: 'session.error', data: { message: 'boom', errorType: 'provider', errorCode: 'E42', statusCode: 429 } });
  assert.equal(event.type, 'error');
  assert.equal(event.error.message, 'boom');
  assert.equal(event.code, 'E42');
  assert.equal(event.statusCode, 429);
});

test('createEventQueue delivers pushed items in order and ends on close', async () => {
  const q = createEventQueue();
  const it = q.iterator();
  q.push(1);
  q.push(2);
  setTimeout(() => {
    q.push(3);
    q.close();
  }, 5);
  const seen = [];
  for await (const v of it) seen.push(v);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('createEventQueue rejects the pending next() when closed with an error', async () => {
  const q = createEventQueue();
  const it = q.iterator();
  setTimeout(() => q.close(new Error('nope')), 5);
  await assert.rejects(it.next(), /nope/);
});
