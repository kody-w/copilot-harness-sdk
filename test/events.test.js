import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextAccumulator, normalizeStudioActivity, createEventQueue, safeEmit } from '../src/events.js';
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

test('TextAccumulator cumulative mode replaces (not appends) when a snapshot does not extend the previous one', () => {
  // The client library joins chunks sorted by streamSequence, so out-of-order
  // arrival produces snapshots 'The ', 'The 42', 'The answer is 42'.
  const acc = new TextAccumulator();
  assert.equal(acc.push('The ', { mode: 'cumulative' }), 'The ');
  assert.equal(acc.push('The 42', { mode: 'cumulative' }), '42');
  assert.equal(acc.push('The answer is 42', { mode: 'cumulative' }), '');
  assert.equal(acc.lastReplaced, true);
  assert.equal(acc.snapshot, 'The answer is 42');
});

test('TextAccumulator.finalize keeps the streamed text when the final has no text', () => {
  const acc = new TextAccumulator();
  acc.push('Streamed answer');
  assert.equal(acc.finalize(''), '');
  assert.equal(acc.snapshot, 'Streamed answer');
  assert.equal(acc.finalize(undefined), '');
  assert.equal(acc.snapshot, 'Streamed answer');
});

test('TextAccumulator resets for a new streamId or after a finalized message', () => {
  const acc = new TextAccumulator();
  acc.push('First', { mode: 'cumulative', streamId: 'a' });
  acc.finalize('First.');
  assert.equal(acc.push('Sec', { mode: 'cumulative', streamId: 'b' }), 'Sec');
  assert.equal(acc.push('Second', { mode: 'cumulative', streamId: 'b' }), 'ond');
  assert.equal(acc.snapshot, 'Second');
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
  assert.equal(events[2].replaced, false);
  assert.equal(events[3].delta, '.');
  assert.equal(events[4].text, 'The answer is 42.');
  assert.equal(events[4].streamId, 's1');
});

test('normalizeStudioActivity: a card-only message after the final keeps the answer text', () => {
  const acc = new TextAccumulator();
  const events = [
    { type: 'typing', text: 'The answer is 42', channelData: { streamType: 'streaming', streamId: 's1', streamSequence: 1 } },
    { type: 'message', text: 'The answer is 42.', channelData: { streamType: 'final', streamId: 's1' } },
    { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive' }] },
    { type: 'event', name: 'turn.complete' }
  ].flatMap((a) => normalizeStudioActivity(a, acc));
  assert.deepEqual(events.map((e) => e.type), ['text.delta', 'text.delta', 'text.final', 'text.final', 'raw']);
  assert.equal(events[2].text, 'The answer is 42.');
  assert.equal(events[3].text, 'The answer is 42.');
  assert.equal(events[3].attachments.length, 1);
  assert.equal(acc.snapshot, 'The answer is 42.');
});

test('normalizeStudioActivity: two streamed messages in one turn do not glue together', () => {
  const acc = new TextAccumulator();
  const events = [
    { type: 'message', text: 'First.' },
    { type: 'typing', text: 'Sec', channelData: { streamType: 'streaming', streamId: 'b', streamSequence: 1 } },
    { type: 'typing', text: 'Second', channelData: { streamType: 'streaming', streamId: 'b', streamSequence: 2 } },
    { type: 'message', text: 'Second.', channelData: { streamType: 'final', streamId: 'b' } }
  ].flatMap((a) => normalizeStudioActivity(a, acc));
  const deltas = events.filter((e) => e.type === 'text.delta').map((e) => e.delta);
  assert.deepEqual(deltas, ['First.', 'Sec', 'ond', '.']);
  assert.equal(events.at(-1).text, 'Second.');
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

test('createSdkEventMapper: an autopilot idle is not the end of the turn (mirrors SDK sendAndWait)', () => {
  const m = createSdkEventMapper();
  m.map({ type: 'assistant.message_delta', data: { deltaContent: 'a' } });
  const mid = m.map({ type: 'session.idle', data: { mode: 'autopilot' } });
  assert.equal(mid.done, false);
  assert.equal(mid.event.type, 'status');
  m.map({ type: 'assistant.message_delta', data: { deltaContent: 'b' } });
  m.map({ type: 'assistant.message', data: { content: 'ab' } });
  const end = m.map({ type: 'session.idle', data: { mode: 'interactive' } });
  assert.equal(end.done, true);
  assert.equal(end.event.text, 'ab');
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

test('createEventQueue rejects a pending next() exactly once when closed with an error', async () => {
  const q = createEventQueue();
  const it = q.iterator();
  const pending = it.next();
  q.close(new Error('nope'));
  await assert.rejects(pending, /nope/);
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test('createEventQueue settles concurrent next() calls in FIFO order', async () => {
  const q = createEventQueue();
  const it = q.iterator();
  const a = it.next();
  const b = it.next();
  q.push(1);
  q.push(2);
  q.close();
  assert.deepEqual(await a, { value: 1, done: false });
  assert.deepEqual(await b, { value: 2, done: false });
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test('createEventQueue calls onReturn when the consumer breaks early', async () => {
  let returned = 0;
  const q = createEventQueue({ onReturn: () => returned++ });
  const it = q.iterator();
  q.push(1);
  q.push(2);
  for await (const v of it) {
    if (v === 1) break;
  }
  assert.equal(returned, 1);
  assert.equal(q.closed, true);
});

test('safeEmit isolates a throwing listener and still delivers to the others', () => {
  const seen = [];
  const errors = [];
  const listeners = [
    () => {
      throw new Error('listener bug');
    },
    (e) => seen.push(e.type)
  ];
  safeEmit(listeners, { type: 'idle' }, (err) => errors.push(err.message));
  assert.deepEqual(seen, ['idle']);
  assert.deepEqual(errors, ['listener bug']);
});
