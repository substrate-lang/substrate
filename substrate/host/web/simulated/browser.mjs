// The simulated browser: one page on its own thread, the real web host running a program over the simulated
// document and clock. It answers substrate/host/node/page.mjs: it opens the page, then carries out requests to act on
// the page, read it and check it, settling the page after each.
import { workerData } from 'node:worker_threads';
import { Document, Event, Node, NodeFilter, Window, parseInto } from './document.mjs';
import { makeClock } from './clock.mjs';
import { describe, findAll, parse } from './find.mjs';
import { user as userOf } from './user.mjs';
import { run } from '../subhost-web.mjs';
import { dom } from '../dom.mjs';
import { clock as clockModule } from '../../modules/clock.mjs';
import { random } from '../../modules/random.mjs';
import { timer } from '../../modules/timer.mjs';
import { entries } from '../../entries.mjs';

const { port, signal } = workerData;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const quote = (s) => JSON.stringify(s);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
const short = (e) => clip(e.outerHTML, 160);

const lines = [];
const partial = { 1: '', 2: '' };
const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
let document = null;
let clock = null;
let user = null;
let pending = 0;
let activity = 0;
let ended = null;

const say = (line) => lines.push(line);
const consoleText = () => [...lines, ...[partial[1], partial[2]].filter((p) => p !== '')].join('\n');

function output(fd, bytes) {
  partial[fd] += decoders[fd].decode(bytes, { stream: true });
  for (let k = partial[fd].indexOf('\n'); k >= 0; k = partial[fd].indexOf('\n')) {
    say(partial[fd].slice(0, k));
    partial[fd] = partial[fd].slice(k + 1);
  }
}

function install(seed) {
  clock = makeClock();
  document = new Document();
  const window = new Window(document);
  document.hooks = {
    later(f) {
      pending++;
      setImmediate(() => {
        pending--;
        activity++;
        f();
      });
    },
    download() {},
    error: (e) => say(`uncaught: ${e && e.message ? e.message : e}`),
  };
  const RealDate = Date;
  class SimulatedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.epoch + Math.floor(clock.now()));
      else super(...args);
    }

    static now() {
      return clock.epoch + Math.floor(clock.now());
    }
  }
  let state = (seed >>> 0) || 1;
  const nextByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 0xff;
  };
  const g = globalThis;
  Object.assign(g, {
    document,
    window,
    Node,
    NodeFilter,
    Event,
    Date: SimulatedDate,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    console: { log: (...a) => say(a.join(' ')), info: (...a) => say(a.join(' ')), warn: (...a) => say(a.join(' ')),
      error: (...a) => say(a.join(' ')), debug: (...a) => say(a.join(' ')) },
  });
  Object.defineProperty(g, 'performance', { value: { now: () => clock.now(), timeOrigin: clock.epoch }, configurable: true, writable: true });
  Object.defineProperty(g, 'crypto', {
    value: {
      getRandomValues(a) {
        const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = nextByte();
        return a;
      },
    },
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

async function open({ markup, names, wasm, files, seed }) {
  install(seed);
  placeMarkup(markup);
  const root = document.getElementById('root');
  if (!root) throw new Error('the page has no element with the id root');
  run({
    files: new Map(files),
    cwd: '/',
    args: [],
    output,
    onEnd: (code, reason) => {
      ended = { code, reason };
    },
    delivered: () => {
      activity++;
    },
    modules: { dom: dom(root), clock: clockModule(), random: random(), timer: timer() },
  }, names, new Map(wasm));
  await settle();
  if (ended && ended.code !== 0) throw new Error(`the program ended with ${ended.code}\n${consoleText()}`);
  const autofocus = document.body.querySelector('[autofocus]');
  if (autofocus && document.activeElement === document.body) {
    autofocus.focus();
    await settle();
  }
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

async function handle(text) {
  const fields = entries(text);
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
      await settle();
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
    case 'drawing': {
      const [f] = found();
      const e = one(f);
      if (e.localName !== 'canvas') throw new Error(`${describe(f)} is not a canvas\n  it is ${short(e)}`);
      return e.context ? e.context.commands.join('\n') : '';
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
      const want = fields[k] === 'true';
      if (e.checked !== want) throw new Error(`${describe(f)} is ${e.checked ? '' : 'not '}checked\n  it is ${short(e)}`);
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

process.on('uncaughtException', (e) => say(`uncaught: ${e && e.message ? e.message : e}`));
process.on('unhandledRejection', (e) => say(`uncaught: ${e && e.message ? e.message : e}`));

port.on('message', async (m) => {
  let reply;
  try {
    reply = { ok: true, text: m.type === 'open' ? (await open(m), '') : await handle(m.fields) };
  } catch (e) {
    reply = { ok: false, message: e && e.message ? e.message : String(e) };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
