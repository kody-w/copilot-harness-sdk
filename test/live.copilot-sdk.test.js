/**
 * Live verification of mode "copilot-sdk" against the real Copilot CLI
 * harness. Runs only when COPILOT_HARNESS_LIVE=1 (needs a Copilot login or
 * COPILOT_GITHUB_TOKEN, and spends a small amount of Copilot usage).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessClient } from '../index.js';

const live = process.env.COPILOT_HARNESS_LIVE === '1';

test('copilot-sdk: real turn streams deltas, a final message, and idle', { skip: !live && 'set COPILOT_HARNESS_LIVE=1' }, async () => {
  const client = await HarnessClient.create({
    mode: 'copilot-sdk',
    copilotSdk: {
      model: process.env.COPILOT_HARNESS_MODEL || 'auto',
      instructions: 'Answer in one short sentence.',
      permissions: 'deny',
      runtime: { mode: 'empty' },
      turnTimeoutMs: 120_000
    }
  });
  try {
    const pre = await client.preflight();
    assert.equal(pre.ok, true);
    const session = await client.createSession({ sessionId: `harness-sdk-live-${Date.now()}` });
    const types = [];
    let text = '';
    for await (const ev of session.stream('Reply with exactly the single word PONG.')) {
      types.push(ev.type);
      if (ev.type === 'text.final') text = ev.text;
      if (ev.type === 'error') throw ev.error;
    }
    assert.ok(types.includes('text.final'), `expected a final message, saw ${types.join(',')}`);
    assert.equal(types.at(-1), 'idle');
    assert.match(text, /PONG/i);
    await session.close();
  } finally {
    await client.close();
  }
});
