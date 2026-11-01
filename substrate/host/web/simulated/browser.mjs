// The simulated browser: one page on its own thread, the real web host running a program over the simulated
// document, clock, storage, network and the rest. It answers substrate/host/node/page.mjs: it opens the page, then
// carries out requests to act on the page, read it and check it, settling the page after each.
import { resolveObjectURL } from 'node:buffer';
import { workerData } from 'node:worker_threads';
import { Document, Event, Node, NodeFilter, Window, parseInto } from './document.mjs';
import { makeClock } from './clock.mjs';
import { describe, findAll, parse } from './find.mjs';
import { user as userOf } from './user.mjs';
import { historyOf, locationOf, makeHistory } from './navigation.mjs';
import { makeIndexedDB } from './indexeddb.mjs';
import { makeFetch, makeWebSocket } from './network.mjs';
import { sizeOf } from './images.mjs';
import { installClock, installRandom } from './globals.mjs';
import { makeWorker } from './threads.mjs';
import { run } from '../subhost-web.mjs';
import { dom } from '../dom.mjs';
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

const { port, signal } = workerData;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const realSetTimeout = setTimeout;
const realNow = Date.now;
const pause = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const quote = (s) => JSON.stringify(s);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
const short = (e) => clip(e.outerHTML, 160);
const utf8 = new TextEncoder();
const text = new TextDecoder();
const origin = 'http://localhost';

// What lasts for the browser's life: what reloading the page or going to another URL keeps.
const kept = { databases: new Map(), clipboard: '', downloads: new Map(), answers: new Map(), chosen: null, history: null, program: null };

const lines = [];
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
    const named = bytes && [...site].find(([, b]) => sameBytes(b, bytes));
    img.recordedName = named ? named[0] : src;
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
    error: (e) => say(`uncaught: ${e && e.message ? e.message : e}`),
  };
  if (workers) workers.stopAll();
  workers = makeWorker({
    later, say, seed, clock: () => clock, site: () => site, answers: () => kept.answers, url: () => location.href,
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
    fetch: makeFetch(site, kept.answers, where, track),
    WebSocket: makeWebSocket(later, where),
    Worker: workers.Worker,
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
    value: { userAgent: 'substrate simulated browser', language: 'en-US', languages: ['en-US'], hardwareConcurrency: 4, clipboard: clipboardOf },
    configurable: true,
    writable: true,
  });
  user = userOf(document, window);
}

// The page's body: a page file's elements, leaving out its head, its scripts, and the comments and blank text
// around its elements.
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

// settle runs what the page has left to do without the clock moving: due timers, promises and the browser's own
// later work.
async function settle() {
  let steps = 0;
  for (let quiet = 0; quiet < 2;) {
    const before = activity;
    while (clock.dueNow()) {
      activity++;
      if (++steps > 100000) throw new Error('the page kept setting timers due now, so the clock could not stand still');
    }
    await turn();
    if (pending === 0 && activity === before) quiet++;
    else quiet = 0;
  }
}

const storageName = () => location.pathname.replace(/[^/]*$/, '');

// load starts the program at the history's current URL in a new page.
async function load() {
  const { markup, names, wasm, files, seed } = kept.program;
  ended = null;
  decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  install(seed);
  placeMarkup(markup);
  const root = document.getElementById('root');
  if (!root) throw new Error('the page has no element with the id root');
  const { fetchModule } = await import('../../modules/fetch.mjs');
  run({
    files: new Map(files.map(([p, b]) => [p, b.slice()])),
    cwd: '/',
    args: [],
    output,
    onEnd: (code, reason) => {
      ended = { code, reason };
    },
    delivered: () => {
      activity++;
    },
    modules: {
      dom: dom(root), clock: clockModule(), random: random(), timer: timer(), fetch: fetchModule(), websocket: websocket(),
      storage: storage(storageName()), location: locationModule(), clipboard: clipboard(), files: filesModule(),
      worker: workerModule(),
    },
  }, names, new Map(wasm));
  await settle();
  if (ended && ended.code !== 0) throw new Error(`the program ended with ${ended.code}\n${consoleText()}`);
  const autofocus = document.body.querySelector('[autofocus]');
  if (autofocus && document.activeElement === document.body) {
    autofocus.focus();
    await settle();
  }
}

async function open({ markup, names, wasm, files, url, seed }) {
  kept.program = { markup, names, wasm, files, seed };
  kept.history = makeHistory(new URL(url, `${origin}/index.html`).href);
  site = new Map([['/index.html', utf8.encode(markup)], ...files]);
  await load();
}

function one(f) {
  const found = findAll(document, f);
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`nothing matches ${describe(f)}\n  the page: ${clip(document.body.innerHTML, 2000)}`);
  const listed = found.slice(0, 5).map((e) => `\n  ${short(e)}`).join('');
  throw new Error(`${found.length} elements match ${describe(f)}:${listed}${found.length > 5 ? '\n  ...' : ''}`);
}

const differs = (what, f, actual, expected, e) => new Error(`${what} of ${describe(f)} is ${quote(actual)}, not ${quote(expected)}\n  it is ${short(e)}`);

async function act(f) {
  f();
  await settle();
  return '';
}

function drawingOf(f) {
  const e = one(f);
  if (e.localName !== 'canvas') throw new Error(`${describe(f)} is not a canvas\n  it is ${short(e)}`);
  return e.context ? e.context.commands.join('\n') : '';
}

const includes = (drawing, lines) => `\n${drawing}\n`.includes(`\n${lines}\n`);

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
      workers.tell(clock.now());
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
      if (v === undefined) throw new Error(`the page's storage has no key ${quote(fields[1])}`);
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
    case 'text':
      return one(found()[0]).textContent;
    case 'html':
      return one(found()[0]).outerHTML;
    case 'attribute': {
      const [f, k] = found();
      const e = one(f);
      const v = e.getAttribute(fields[k]);
      if (v === null) throw new Error(`${describe(f)} has no attribute ${fields[k]}\n  it is ${short(e)}`);
      return v;
    }
    case 'has-attribute': {
      const [f, k] = found();
      return one(f).hasAttribute(fields[k]) ? 'true' : 'false';
    }
    case 'value':
      return String(one(found()[0]).value ?? '');
    case 'checked':
      return one(found()[0]).checked ? 'true' : 'false';
    case 'count':
      return String(findAll(document, found()[0]).length);
    case 'drawing':
      return drawingOf(found()[0]);
    case 'drawn': {
      const [f, k] = found();
      return includes(drawingOf(f), fields[k]) ? 'true' : 'false';
    }
    case 'expect-drawn': {
      const [f, k] = found();
      const drawing = drawingOf(f);
      if (!includes(drawing, fields[k])) throw new Error(`the last drawing of ${describe(f)} does not include\n  ${fields[k].replace(/\n/g, '\n  ')}\nit is\n  ${drawing.replace(/\n/g, '\n  ')}`);
      return '';
    }
    case 'console':
      return consoleText();
    case 'expect-text': {
      const [f, k] = found();
      const e = one(f);
      if (e.textContent !== fields[k]) throw differs('the text', f, e.textContent, fields[k], e);
      return '';
    }
    case 'expect-html': {
      const [f, k] = found();
      const e = one(f);
      if (e.outerHTML !== fields[k]) throw new Error(`the HTML of ${describe(f)} is\n  ${e.outerHTML}\nnot\n  ${fields[k]}`);
      return '';
    }
    case 'expect-value': {
      const [f, k] = found();
      const e = one(f);
      if (String(e.value ?? '') !== fields[k]) throw differs('the value', f, String(e.value ?? ''), fields[k], e);
      return '';
    }
    case 'expect-attribute': {
      const [f, k] = found();
      const e = one(f);
      const v = e.getAttribute(fields[k]);
      if (v === null) throw new Error(`${describe(f)} has no attribute ${fields[k]}\n  it is ${short(e)}`);
      if (v !== fields[k + 1]) throw differs(`the attribute ${fields[k]}`, f, v, fields[k + 1], e);
      return '';
    }
    case 'expect-no-attribute': {
      const [f, k] = found();
      const e = one(f);
      if (e.hasAttribute(fields[k])) throw new Error(`${describe(f)} has the attribute ${fields[k]}\n  it is ${short(e)}`);
      return '';
    }
    case 'expect-checked': {
      const [f, k] = found();
      const e = one(f);
      if (e.checked !== (fields[k] === 'true')) throw new Error(`${describe(f)} is ${e.checked ? '' : 'not '}checked\n  it is ${short(e)}`);
      return '';
    }
    case 'expect-count': {
      const [f, k] = found();
      const all = findAll(document, f);
      const want = Number(fields[k]);
      if (all.length !== want) {
        const listed = all.slice(0, 5).map((e) => `\n  ${short(e)}`).join('');
        throw new Error(`${describe(f)} matches ${all.length} element${all.length === 1 ? '' : 's'}, not ${want}${listed}${all.length > 5 ? '\n  ...' : ''}`);
      }
      return '';
    }
    case 'expect-missing': {
      const [f] = found();
      const all = findAll(document, f);
      if (all.length > 0) throw new Error(`${describe(f)} matches ${short(all[0])}${all.length > 1 ? ` and ${all.length - 1} more` : ''}`);
      return '';
    }
    default:
      throw new Error(`no request ${kind}`);
  }
}

// On a page that has started a worker, an expectation is tried again for up to 10 seconds, as workers answer in
// their own time.
async function handled(m) {
  if (!workersSeen || !entries(m.fields)[0].startsWith('expect-')) return handle(m);
  const until = realNow() + 10000;
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

process.on('uncaughtException', (e) => say(`uncaught: ${e && e.message ? e.message : e}`));
process.on('unhandledRejection', (e) => say(`uncaught: ${e && e.message ? e.message : e}`));

port.on('message', async (m) => {
  let reply;
  try {
    reply = { ok: true, text: m.type === 'open' ? (await open(m), '') : await handled(m) };
  } catch (e) {
    reply = { ok: false, message: e && e.message ? e.message : String(e) };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
