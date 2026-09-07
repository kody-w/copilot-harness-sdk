// session.close() while a stream is open: consumer hangs until turn timeout.
import { HarnessClient } from '../index.js';
import { ev, tick } from './fake-sdk.mjs';
const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 400 } });
const session = await client.createSession();
const native = session.native;
native.script = async (s) => { s._dispatch(ev.delta('a')); await tick(); await tick(); s._dispatch(ev.msg('a')); s._dispatch(ev.idle()); };
const t0 = Date.now(); const types = [];
for await (const e of session.stream('x')) {
  types.push(`${e.type}${e.code ? '(' + e.code + ')' : ''}@${Date.now() - t0}ms`);
  if (e.type === 'text.delta') await session.close();
}
console.log('stream yielded:', types);
await client.close();
