import { createEventQueue } from '../src/events.js';
// (a) close(err) with a pending waiter: error surfaces twice
const q = createEventQueue(); const it = q.iterator();
const p = it.next(); q.close(new Error('nope'));
try { await p; } catch (e) { console.log('1st next() rejected:', e.message); }
try { console.log('2nd next() ->', await it.next()); } catch (e) { console.log('2nd next() rejected AGAIN:', e.message); }
try { console.log('3rd next() ->', await it.next()); } catch (e) { console.log('3rd next() rejected:', e.message); }
// (b) two concurrent next() calls: first waiter is overwritten and never settles
const q2 = createEventQueue(); const it2 = q2.iterator();
let firstSettled = false;
const a = it2.next().then((v) => { firstSettled = true; return v; });
const b = it2.next();
q2.push(1); q2.push(2); q2.close();
console.log('second next() ->', await b);
await new Promise((r) => setTimeout(r, 50));
console.log('first next() settled?', firstSettled, '| buffered item 2 reachable via 3rd next():', await it2.next());
