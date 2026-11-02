// The simulated browser, on its own thread. It runs the real web host over a simulated document, clock, storage and
// network, and carries out the requests from substrate/host/node/browser.mjs, settling the program after each.
import { resolveObjectURL } from 'node:buffer';
import { workerData } from 'node:worker_threads';
import { Document, Element, Event, Node, NodeFilter, Window, parseInto } from './document.mjs';
import { makeClock, unsettledOf } from '../testing/clock.mjs';
import { parse } from '../testing/find.mjs';
import { documentRequest, one as oneIn } from '../testing/requests.mjs';
import { canvasOf, drawingRequest } from '../testing/logs.mjs';
import { user as userOf } from './user.mjs';
import { historyOf, locationOf, makeHistory } from './navigation.mjs';
import { makeIndexedDB } from './indexeddb.mjs';
import { makeFetch, makeWebSocket, nodeFetch } from './network.mjs';
import { sizeOf } from './images.mjs';
import { installClock, installRandom } from '../testing/globals.mjs';
import { makeWorker } from './threads.mjs';
import { makeAudio, makeWebGpu } from './media.mjs';
import { importedModules, run, unpack } from '../subhost-web.mjs';
import { resolvePath } from '../fs.mjs';
import { dom } from '../dom.mjs';
import { audio } from '../audio.mjs';
import { gpu } from '../gpu.mjs';
import { workers as workerModule } from '../worker.mjs';
import { storage } from '../storage.mjs';
import { locationModule } from '../location.mjs';
import { clipboard } from '../clipboard.mjs';
import { files as filesModule } from '../files.mjs';
import { clock as clockModule } from '../../modules/clock.mjs';
import { random } from '../../modules/random.mjs';
import { timer } from '../../modules/timer.mjs';
import { websocket } from '../../modules/websocket.mjs';
import { entries } from '../../entries.mjs';
import { mayUrl } from '../../grants.mjs';

const { port, signal } = workerData;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const realSetTimeout = setTimeout;
const realNow = Date.now;
const pause = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const quote = (s) => JSON.stringify(s);
const utf8 = new TextEncoder();
const text = new TextDecoder();
const origin = 'http://localhost';

// State that lasts for the browser's whole life, through reloads and going to other URLs.
const kept = {
  databases: new Map(), clipboard: '', downloads: new Map(), answers: new Map(), chosen: null, history: null, program: null, net: null,
};

const lines = [];
const errors = [];
const partial = { 1: '', 2: '' };
let decoders = null;
let document = null;
let location = null;
let clock = null;
let user = null;
let site = null;
let pending = 0;
let activity = 0;
let ended = null;
let workers = null;
let workersSeen = false;
let sounds = [];
let realTime = [];

// The network's real-time work, which settling waits for only while it makes progress, as it does the web host's.
const network = { count: 0, done: 0, pending: () => network.count, progress: () => network.done };
const softly = (start) => {
  network.count++;
  return Promise.resolve().then(start).finally(() => {
    network.count--;
    network.done++;
  });
};
const unsettled = unsettledOf(() => [network, ...realTime], () => realNow());

const say = (line) => lines.push(line);
const consoleText = () => [...lines, ...[partial[1], partial[2]].filter((p) => p !== '')].join('\n');

function output(fd, bytes) {
  partial[fd] += decoders[fd].decode(bytes, { stream: true });
  for (let k = partial[fd].indexOf('\n'); k >= 0; k = partial[fd].indexOf('\n')) {
    say(partial[fd].slice(0, k));
    partial[fd] = partial[fd].slice(k + 1);
  }
}

function later(f) {
  pending++;
  setImmediate(() => {
    pending--;
    activity++;
    f();
  });
}

async function track(work) {
  pending++;
  try {
    return await work();
  } finally {
    pending--;
    activity++;
  }
}

const sameBytes = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));

const nameOf = (bytes, otherwise) => {
  const named = [...site].find(([, b]) => sameBytes(b, bytes));
  return named ? named[0] : otherwise;
};

class HTMLCanvasElement {
  static [Symbol.hasInstance](x) {
    return x instanceof Element && x.localName === 'canvas';
  }
}

function loadImage(img) {
  const src = img.getAttribute('src') || '';
  track(async () => {
    let bytes = null;
    if (src.startsWith('blob:')) {
      const blob = resolveObjectURL(src);
      bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } else {
      const url = new URL(src, location.href);
      if (url.origin === origin) bytes = site.get(decodeURIComponent(url.pathname)) || null;
    }
    if (img.getAttribute('src') !== src) return;
    const size = bytes && sizeOf(bytes);
    img.recordedName = bytes ? nameOf(bytes, src) : src;
    img.complete = true;
    if (size) {
      [img.naturalWidth, img.naturalHeight] = size;
      img.dispatchEvent(new Event('load'));
    } else img.dispatchEvent(new Event('error'));
  });
}

function install(seed) {
  clock = makeClock();
  document = new Document();
  const window = new Window(document);
  location = locationOf(kept.history);
  document.hooks = {
    later,
    now: () => clock.now(),
    download(name, href) {
      track(async () => {
        const blob = resolveObjectURL(href);
        if (blob) kept.downloads.set(name, new Uint8Array(await blob.arrayBuffer()));
      });
    },
    pick(input) {
      const chosen = kept.chosen;
      kept.chosen = null;
      later(() => {
        if (chosen) {
          input.files = chosen.map(([name, bytes]) => new File([bytes], name));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else input.dispatchEvent(new Event('cancel'));
      });
    },
    loadImage,
    webgpuContext: (canvas) => webgpu.context(canvas),
    error: (e) => say(`uncaught: ${e && e.message ? e.message : e}`),
  };
  const webgpu = makeWebGpu();
  const { AudioContext, OfflineAudioContext } = makeAudio({
    document: () => document, clock: () => clock, later, nameOf: (bytes) => nameOf(bytes, ''), sound: (line) => sounds.push(line),
  });
  if (workers) workers.stopAll();
  workers = makeWorker({
    later, say, seed, site: () => site, answers: () => kept.answers, url: () => location.href,
    seen: () => {
      workersSeen = true;
    },
  });
  function Image(width, height) {
    const img = document.createElement('img');
    img.complete = true;
    img.naturalWidth = 0;
    img.naturalHeight = 0;
    if (width !== undefined) img.setAttribute('width', width);
    if (height !== undefined) img.setAttribute('height', height);
    return img;
  }
  const { indexedDB, IDBKeyRange } = makeIndexedDB(kept.databases, later);
  const where = () => kept.history.current();
  const g = globalThis;
  Object.assign(g, {
    document,
    window,
    location,
    history: historyOf(kept.history, () => later(() => window.dispatchEvent(new Event('popstate')))),
    Node,
    NodeFilter,
    Event,
    Image,
    indexedDB,
    IDBKeyRange,
    fetch: makeFetch(site, kept.answers, where, track, (u) => kept.net !== null && mayUrl(kept.net, u) && nodeFetch, softly),
    WebSocket: makeWebSocket(later, where),
    Worker: workers.Worker,
    AudioContext,
    OfflineAudioContext,
    HTMLCanvasElement,
    ...webgpu.globals,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    console: { log: (...a) => say(a.join(' ')), info: (...a) => say(a.join(' ')), warn: (...a) => say(a.join(' ')),
      error: (...a) => say(a.join(' ')), debug: (...a) => say(a.join(' ')) },
  });
  installClock(g, clock);
  installRandom(g, seed);
  const clipboardOf = {
    readText: () => Promise.resolve(kept.clipboard),
    writeText: (t) => {
      kept.clipboard = String(t);
      return Promise.resolve();
    },
  };
  Object.defineProperty(g, 'navigator', {
    value: {
      userAgent: 'substrate simulated browser', language: 'en-US', languages: ['en-US'], hardwareConcurrency: 4,
      clipboard: clipboardOf, gpu: webgpu.gpu,
    },
    configurable: true,
    writable: true,
  });
  user = userOf(document, window);
}

// Fills the document's body with the HTML file's elements, leaving out its head, its scripts, and the comments and
// blank text between elements.
function placeMarkup(markup) {
  const scratch = document.createDocumentFragment();
  parseInto(markup, scratch);
  const place = (from) => {
    for (const n of [...from.childNodes]) {
      if (n.nodeType === 1 && ['html', 'head', 'body'].includes(n.localName)) place(n);
      else if (n.nodeType === 1 && ['script', 'style', 'meta', 'link', 'title', 'base'].includes(n.localName)) continue;
      else if (n.nodeType === 8 || (n.nodeType === 3 && n.data.trim() === '')) continue;
      else document.body.appendChild(n);
    }
  };
  place(scratch);
}

// settle lets the program finish what it can without moving the clock: due timers, promises, the browser's own pending
// work, and real-time work while it makes progress.
async function settle() {
  let steps = 0;
  for (let quiet = 0; quiet < 2;) {
    const before = activity;
    while (clock.dueNow()) {
      activity++;
      if (++steps > 100000) throw new Error('the program kept setting timers that are already due, so it never settled');
    }
    if (unsettled()) {
      await pause(10);
      quiet = 0;
      continue;
    }
    await turn();
    if (pending === 0 && activity === before) quiet++;
    else quiet = 0;
  }
}

const storageName = () => location.pathname.replace(/[^/]*$/, '');

// load starts the program at the history's current URL, in a new document.
async function load() {
  const { markup, names, wasm, files, seed } = kept.program;
  ended = null;
  errors.length = 0;
  sounds = [];
  decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  install(seed);
  placeMarkup(markup);
  const root = document.getElementById('root');
  if (!root) throw new Error('the HTML file has no element with the id root');
  const { fetchModule } = await import('../../modules/fetch.mjs');
  const theDom = dom(root);
  const makers = {
    dom: () => theDom, audio: () => audio(), gpu: () => gpu({ dom: theDom }), storage: () => storage(storageName()),
    location: () => locationModule(), clipboard: () => clipboard(), files: () => filesModule(), worker: () => workerModule(),
    clock: () => clockModule(), random: () => random(), timer: () => timer(), fetch: () => fetchModule(), websocket: () => websocket(),
  };
  const modules = {};
  for (const [, bytes] of wasm) {
    for (const name of importedModules(bytes)) if (Object.hasOwn(makers, name) && !modules[name]) modules[name] = await makers[name]();
  }
  realTime = run({
    files: new Map(files.map(([p, b]) => [p, b.slice()])),
    args: new URLSearchParams(location.search).getAll('arg'),
    output,
    onEnd: (code, reason) => {
      ended = { code, reason };
    },
    delivered: () => {
      activity++;
    },
    modules,
  }, names, new Map(wasm)).realTime;
  await settle();
  if (ended && ended.code !== 0) throw new Error(`the program ended with ${ended.code}\n${consoleText()}`);
  const autofocus = document.body.querySelector('[autofocus]');
  if (autofocus && document.activeElement === document.body) {
    autofocus.focus();
    await settle();
  }
}

// open opens a site at url as start.mjs starts one, giving the program the files in assets.list and files.pack.
async function open({ site: given, url, seed, net }) {
  site = new Map(given);
  kept.net = net || null;
  const file = (path) => {
    const bytes = site.get(path);
    if (!bytes) throw new Error(`the site has no ${path.slice(1)}`);
    return bytes;
  };
  const names = text.decode(file('/program/program')).split(/\r?\n/).filter((n) => n !== '');
  const files = new Map();
  for (const path of text.decode(file('/assets.list')).split('\n').filter((p) => p !== '')) {
    files.set(resolvePath('/', path), file(`/${path}`));
  }
  unpack(file('/files.pack'), '/', files);
  const wasm = names.map((n) => [n, file(`/program/${n}.wasm`)]);
  kept.program = { markup: text.decode(file('/index.html')), names, wasm, files: [...files], seed };
  kept.history = makeHistory(new URL(url, `${origin}/index.html`).href);
  await load();
}

const one = (f) => oneIn(document, f);

async function act(f) {
  f();
  await settle();
  return '';
}

function drawingOf(f) {
  const e = canvasOf(document, f);
  return e.context ? e.context.commands.join('\n') : '';
}

const storeOf = () => {
  const db = kept.databases.get(storageName()) || new Map();
  kept.databases.set(storageName(), db);
  if (!db.has('keys')) db.set('keys', new Map());
  return db.get('keys');
};

async function handle(m) {
  const fields = entries(m.fields);
  const kind = fields[0];
  const found = () => parse(fields, 1);
  const read = documentRequest(document, fields) ?? await drawingRequest(fields, drawingOf);
  if (read !== undefined) return read;
  switch (kind) {
    case 'click': {
      const [f, k] = found();
      const e = one(f);
      return act(() => user.click(e, k < fields.length ? [Number(fields[k]), Number(fields[k + 1])] : null));
    }
    case 'type': {
      const [f, k] = found();
      const e = one(f);
      return act(() => user.type(e, fields[k]));
    }
    case 'press':
      return act(() => user.press(fields[1]));
    case 'move-mouse':
      return act(() => user.moveMouse(Number(fields[1]), Number(fields[2])));
    case 'key-down':
      return act(() => user.keyDown(fields[1]));
    case 'key-up':
      return act(() => user.keyUp(fields[1]));
    case 'focus': {
      const e = one(found()[0]);
      return act(() => e.focus());
    }
    case 'fire': {
      const [f, k] = found();
      const e = one(f);
      return act(() => e.dispatchEvent(new Event(fields[k], { bubbles: true, cancelable: true })));
    }
    case 'advance':
      await clock.advance(Number(fields[1]), settle);
      await settle();
      return '';
    case 'go':
      kept.history.push(new URL(fields[1], location.href).href);
      await load();
      return '';
    case 'reload':
      await load();
      return '';
    case 'url':
      return location.href;
    case 'storage-get': {
      const v = storeOf().get(fields[1]);
      if (v === undefined) throw new Error(`the browser's storage has no key ${quote(fields[1])}`);
      return text.decode(v);
    }
    case 'storage-set':
      storeOf().set(fields[1], utf8.encode(fields[2]));
      return '';
    case 'clipboard-get':
      return kept.clipboard;
    case 'clipboard-set':
      kept.clipboard = fields[1];
      return '';
    case 'choose-files':
      kept.chosen = m.files;
      return '';
    case 'downloaded': {
      const bytes = kept.downloads.get(fields[1]);
      if (!bytes) throw new Error(`no file named ${quote(fields[1])} was downloaded`);
      return text.decode(bytes);
    }
    case 'respond':
      kept.answers.set(new URL(fields[1], location.href).href, { status: Number(fields[2]), body: utf8.encode(fields[3]) });
      return '';
    case 'console':
      return consoleText();
    case 'pixels':
    case 'expect-pixel':
      throw new Error('the simulated browser draws no pixels, so a test that reads them must be marked #:chromium and run with --browser=chromium');
    case 'box':
      throw new Error('the simulated browser does no layout, so a test that reads where elements are must be marked #:chromium and run with --browser=chromium');
    case 'sounds':
      return sounds.join('\n');
    default:
      throw new Error(`no request ${kind}`);
  }
}

// Once the program has started a worker or can reach a test's server, expectations are retried for up to 5 seconds,
// since workers and servers answer in their own time.
async function retried(m) {
  if (!(workersSeen || kept.net) || !entries(m.fields)[0].startsWith('expect-')) return handle(m);
  const until = realNow() + 5000;
  for (;;) {
    try {
      return await handle(m);
    } catch (e) {
      if (realNow() >= until) throw e;
    }
    await pause(10);
    await settle();
  }
}

// handled carries out a request, which fails when the program has ended with an error or the page has thrown an error
// that nothing caught.
async function handled(m) {
  const value = await retried(m);
  if (ended && ended.code !== 0) throw new Error(`the program ended with ${ended.code}`);
  if (errors.length > 0) {
    const first = errors[0];
    errors.length = 0;
    throw new Error(`the page has an uncaught error: ${first}`);
  }
  return value;
}

const uncaught = (e) => {
  const text = e && e.message ? e.message : String(e);
  say(`uncaught: ${text}`);
  errors.push(text);
};
process.on('uncaughtException', uncaught);
process.on('unhandledRejection', uncaught);

port.on('message', async (m) => {
  let reply;
  try {
    reply = { ok: true, text: m.type === 'open' ? (await open(m), '') : await handled(m) };
  } catch (e) {
    let message = e && e.message ? e.message : String(e);
    const shown = m.type === 'open' ? [] : consoleText().split('\n').filter((l) => l !== '');
    if (shown.length > 0) message += `\n  the console ends with:\n    ${shown.slice(-10).join('\n    ')}`;
    reply = { ok: false, message };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
