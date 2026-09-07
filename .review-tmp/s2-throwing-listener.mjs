// A throwing onEvent listener prevents finish(): stream does not end at idle.
import { HarnessClient } from '../index.js';
import { ev, tick } from './fake-sdk.mjs';
const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 400 } });
const session = await client.createSession();
const native = session.native;
const second = [];
client.onEvent((e) => { if (e.type === 'idle') throw new Error('listener bug'); });
client.onEvent((e) => second.push(e.type));
native.script = async (s) => { s._dispatch(ev.delta('a')); await tick(); s._dispatch(ev.msg('a')); await tick(); s._dispatch(ev.idle()); };
const t0 = Date.now(); const types = [];
for await (const e of session.stream('x')) types.push(`${e.type}${e.code ? '(' + e.code + ')' : ''}@${Date.now() - t0}ms`);
console.log('stream yielded:', types);
console.log('second listener saw:', second, '| handlers still attached:', native.handlers.size);
await client.close();
