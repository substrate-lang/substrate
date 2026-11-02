// A worker in the simulated browser: a Node thread made to look like a Web Worker, with the browser's network and
// console, running the web host's worker script (../worker-script.mjs). Its clock is real time, not the page's.
import { parentPort, workerData } from 'node:worker_threads';
import { installRandom } from '../testing/globals.mjs';
import { makeFetch, makeWebSocket } from './network.mjs';

const { script, control, site, answers, url, seed } = workerData;
const later = (f) => setImmediate(f);
const say = (...a) => control.postMessage({ type: 'console', line: a.join(' ') });
const where = () => new URL(url);
const g = globalThis;
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
await import(script);
