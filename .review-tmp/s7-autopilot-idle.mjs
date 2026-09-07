// session.idle with data.mode === 'autopilot' ends the adapter's stream; the SDK's own sendAndWait ignores such idles.
import { HarnessClient } from '../index.js';
import { ev, tick } from './fake-sdk.mjs';
const client = await HarnessClient.create({ mode: 'copilot-sdk', copilotSdk: { turnTimeoutMs: 400 } });
const session = await client.createSession();
const native = session.native;
native.script = async (s) => { s._dispatch(ev.delta('a')); await tick(); s._dispatch(ev.idle('autopilot')); await tick(); s._dispatch(ev.delta('b')); await tick(); s._dispatch(ev.msg('ab')); await tick(); s._dispatch(ev.idle('interactive')); };
const seen = [];
for await (const e of session.stream('x', { agentMode: 'autopilot' })) seen.push(`${e.type}:${JSON.stringify(e.text ?? e.delta ?? '')}`);
console.log('stream yielded:', seen, '| sent agentMode =', native.sends[0].agentMode);
await client.close();
