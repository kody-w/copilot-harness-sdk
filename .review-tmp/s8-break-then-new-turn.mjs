// Break out of turn 1, immediately start turn 2 (runtime enqueues): turn 2's stream ends on turn 1's idle.
import { HarnessClient } from '../index.js';
import { ev, tick } from './fake-sdk.mjs';
const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 400 } });
const session = await client.createSession();
const native = session.native;
let chain = Promise.resolve();
const answers = { one: 'ab', two: 'xy' };
native.script = (s) => (chain = chain.then(async () => {
  const text = answers[s.sends[s.sends.length - 1 - (s.sends.length - chainIdx++ - 1)]?.prompt] ?? '?';
  for (const ch of text) { s._dispatch(ev.delta(ch)); await tick(); }
  s._dispatch(ev.msg(text)); await tick(); s._dispatch(ev.idle());
}));
let chainIdx = 0;
for await (const e of session.stream('one')) { break; }
const r = await session.send('two');
console.log('send("two") returned text =', JSON.stringify(r.text), '| event turns =', [...new Set(r.events.map((e) => e.turn))], '| types =', r.events.map((e) => e.type));
await new Promise((res) => setTimeout(res, 100));
await client.close();
