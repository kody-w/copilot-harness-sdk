// Early break out of stream(), then close: listener+timer leak, no abort, spurious TURN_TIMEOUT after close.
import { HarnessClient } from '../index.js';
import { ev, tick } from './fake-sdk.mjs';
const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 400 } });
const session = await client.createSession();
const native = session.native;
const emitted = [];
client.onEvent((e) => emitted.push(`${e.type}${e.code ? '(' + e.code + ')' : ''}@t${Date.now() - t0}ms`));
native.script = async (s) => { s._dispatch(ev.delta('a')); await tick(); s._dispatch(ev.delta('b')); await tick(); s._dispatch(ev.msg('ab')); await tick(); s._dispatch(ev.idle()); };
const t0 = Date.now();
for await (const e of session.stream('one')) { break; }
console.log('after break: handlers still attached =', native.handlers.size, '| session.abort() calls =', native.aborted);
await session.close();
await client.close();
const closedAt = Date.now() - t0;
console.log('closed at', closedAt, 'ms; events emitted so far:', emitted);
process.on('exit', () => console.log('process exit at', Date.now() - t0, 'ms; events emitted after close:', emitted.filter((s) => parseInt(s.split("@t")[1], 10) > closedAt)));
