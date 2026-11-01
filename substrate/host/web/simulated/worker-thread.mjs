// A simulated page's worker: one of Node's threads made to look like a Web Worker, with the page's clock, network
// and console, running the web host's worker script (../worker-script.mjs).
import { parentPort, workerData } from 'node:worker_threads';
import { makeClock } from './clock.mjs';
import { installClock, installRandom } from './globals.mjs';
import { makeFetch, makeWebSocket } from './network.mjs';

const { script, control, now, epoch, site, answers, url, seed } = workerData;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const clock = makeClock(epoch);
await clock.advance(now, async () => {});

const later = (f) => setImmediate(f);
const say = (...a) => control.postMessage({ type: 'console', line: a.join(' ') });
const where = () => new URL(url);
const g = globalThis;
installClock(g, clock);
installRandom(g, seed);
Object.assign(g, {
  self: g,
  postMessage: (m, transfer) => parentPort.postMessage(m, transfer),
  location: { href: url, origin: new URL(url).origin, toString: () => url },
  fetch: makeFetch(new Map(site), new Map(answers), where, (work) => work()),
  WebSocket: makeWebSocket(later, where),
  console: { log: say, info: say, warn: say, error: say, debug: say },
});
parentPort.on('message', (data) => {
  if (typeof g.onmessage === 'function') g.onmessage({ data });
});
control.on('message', async (m) => {
  if (m.type === 'time' && m.now > clock.now()) await clock.advance(m.now - clock.now(), turn);
});
await import(script);
