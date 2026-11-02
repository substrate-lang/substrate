// Runs one headless Chromium for a test run, on its own thread, and drives it over the DevTools protocol on a pipe.
// Each browser a test opens gets its own browser context. It carries out the requests from browser.mjs, and
// ../web/testing/agent.mjs carries out the page's side of them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerData } from 'node:worker_threads';
import { makeClock } from '../web/testing/clock.mjs';
import { installClock, seeded } from '../web/testing/globals.mjs';
import { installRecorders } from '../web/testing/recorders.mjs';
import { parse } from '../web/testing/find.mjs';
import { ending } from '../web/testing/requests.mjs';
import { entries } from '../entries.mjs';
import { mayUrl } from '../grants.mjs';

const { port, signal, file, files, args } = workerData;
const testing = fileURLToPath(new URL('../web/testing/', import.meta.url));
const origin = 'http://localhost';
const reserved = '/.substrate-testing/';
const patience = 5000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const types = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.wasm': 'application/wasm', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.txt': 'text/plain',
};
const typeOf = (p) => types[path.extname(p).toLowerCase()] || 'application/octet-stream';

// Runs in each page before the page's own scripts, installing the test's clock, seeded random bytes and the recorders.
const before = (seed) => `(() => {
  const makeClock = ${makeClock};
  const installClock = ${installClock};
  const seeded = ${seeded};
  const installRecorders = ${installRecorders};
  const clock = makeClock();
  const real = { now: Date.now.bind(Date), setTimeout: setTimeout.bind(window) };
  installClock(window, clock);
  Object.defineProperty(Event.prototype, 'timeStamp', { get: () => clock.now(), configurable: true });
  const fill = seeded(${seed});
  Crypto.prototype.getRandomValues = function getRandomValues(a) {
    fill(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return a;
  };
  Object.defineProperty(window, Symbol.for('substrate.testing'), {
    value: { clock, real, ...installRecorders(window, clock, ${JSON.stringify(origin)}) },
  });
})();`;

// ---- Chromium and the protocol ----

let chrome = null;
let profile = null;
let said = '';
let next = 0;
const waiting = new Map();
const browsers = new Map();
const bySession = new Map();

function stopped(why) {
  for (const w of waiting.values()) w.reject(new Error(`Chromium stopped${why}\n${said.trim()}`));
  waiting.clear();
  chrome = null;
}

function send(method, params = {}, sessionId = undefined) {
  if (!chrome) return Promise.reject(new Error(`Chromium is not running\n${said.trim()}`));
  return new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject, method });
    chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  });
}

function launch() {
  profile = fs.mkdtempSync(path.join(files, 'chromium-'));
  chrome = spawn(file, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--no-sandbox', '--mute-audio', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-unsafe-webgpu', ...args,
    'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  chrome.stderr.on('data', (d) => {
    said = (said + d).slice(-4000);
  });
  chrome.on('error', (e) => stopped(`: ${e.message}`));
  chrome.on('exit', (code, sig) => stopped(sig ? ` on ${sig}` : ` with status ${code}`));
  let pending = Buffer.alloc(0);
  chrome.stdio[4].on('data', (d) => {
    pending = pending.length === 0 ? d : Buffer.concat([pending, d]);
    for (let k = pending.indexOf(0); k >= 0; k = pending.indexOf(0)) {
      const m = JSON.parse(pending.subarray(0, k).toString());
      pending = pending.subarray(k + 1);
      if (m.id === undefined) heard(m);
      else {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (!w) continue;
        if (m.error) w.reject(new Error(`${w.method}: ${m.error.message}`));
        else w.resolve(m.result);
      }
    }
  });
}

const valueOf = (a) => (a.value !== undefined ? String(a.value) : a.unserializableValue ?? a.description ?? '');
const described = (d) => (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text);

function heard(m) {
  if (m.method === 'Browser.downloadWillBegin' || m.method === 'Browser.downloadProgress') {
    for (const b of browsers.values()) {
      if (m.method === 'Browser.downloadWillBegin' && m.params.frameId === b.targetId) {
        b.downloads.set(m.params.guid, { name: m.params.suggestedFilename, state: 'inProgress' });
      } else if (m.method === 'Browser.downloadProgress' && b.downloads.has(m.params.guid)) {
        b.downloads.get(m.params.guid).state = m.params.state;
      }
    }
    return;
  }
  const b = m.sessionId ? bySession.get(m.sessionId) : null;
  if (!b) return;
  switch (m.method) {
    case 'Target.attachedToTarget':
      bySession.set(m.params.sessionId, b);
      send('Runtime.enable', {}, m.params.sessionId).catch(() => {});
      send('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId).catch(() => {});
      break;
    case 'Fetch.requestPaused':
      served(b, m).catch(() => send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Failed' }, m.sessionId)
        .catch(() => {}));
      break;
    case 'Runtime.consoleAPICalled':
      b.lines.push(m.params.args.map(valueOf).join(' '));
      break;
    case 'Runtime.exceptionThrown': {
      const line = `uncaught: ${described(m.params.exceptionDetails)}`;
      b.lines.push(line);
      b.thrown = true;
      if (b.errors) b.errors.push(line);
      break;
    }
    case 'Page.fileChooserOpened':
      chosen(b, m.params).catch((e) => b.lines.push(`files: ${e.message}`));
      break;
    case 'Page.frameNavigated':
      if (!m.params.frame.parentId) {
        b.documents += 1;
        b.landed = m.params.frame;
      }
      break;
    case 'Page.frameStoppedLoading':
      if (m.params.frameId === b.targetId) b.stops += 1;
      break;
    default:
  }
}

// served answers a page's request with, in order: the agent's modules, a test's answers, the site's files, and for a
// site opened through a test's server, the network as far as the test's grants allow. Any other request fails.
async function served(b, m) {
  const { requestId, request } = m.params;
  const url = new URL(request.url);
  const fulfil = (status, type, body, more = []) => send('Fetch.fulfillRequest', {
    requestId, responseCode: status, body: Buffer.from(body).toString('base64'),
    responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }, ...more],
  }, m.sessionId);
  const p = decodeURIComponent(url.pathname);
  if (p.startsWith(reserved) && /^[a-z]+\.mjs$/.test(p.slice(reserved.length))) {
    return fulfil(200, 'text/javascript', fs.readFileSync(path.join(testing, p.slice(reserved.length))));
  }
  const answer = b.answers.get(url.href);
  if (answer) return fulfil(answer.status, typeOf(url.pathname), answer.body, [{ name: 'Access-Control-Allow-Origin', value: '*' }]);
  if (url.origin === origin) {
    const bytes = b.site.get(p === '/' ? '/index.html' : p);
    return bytes ? fulfil(200, typeOf(p), bytes) : fulfil(404, 'text/plain', 'not found');
  }
  if (b.net && mayUrl(b.net, url)) return send('Fetch.continueRequest', { requestId }, m.sessionId);
  return send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, m.sessionId);
}

async function chosen(b, { backendNodeId }) {
  const files = b.chosen;
  b.chosen = null;
  if (files) return b.page('DOM.setFileInputFiles', { files, backendNodeId });
  const { object } = await b.page('DOM.resolveNode', { backendNodeId });
  return b.page('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.dispatchEvent(new Event(\'cancel\')); }' });
}

// ---- browsers ----

async function opened(id, site, url, seed, net) {
  if (!chrome) launch();
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const downloadPath = fs.mkdtempSync(path.join(profile, 'downloads-'));
  const b = {
    id, browserContextId, targetId, sessionId, downloadPath, site: new Map(site), net, answers: new Map(), downloads: new Map(),
    lines: [], thrown: false, errors: [], chosen: null, held: 0, mouse: { x: 0, y: 0 },
    home: new URL(url, `${origin}/index.html`).origin, documents: 0, stops: 0, landed: null,
    page: (method, params) => send(method, params, sessionId),
  };
  browsers.set(id, b);
  bySession.set(sessionId, b);
  try {
    await b.page('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await b.page('Runtime.enable');
    await b.page('Page.enable');
    await b.page('Page.setInterceptFileChooserDialog', { enabled: true });
    await b.page('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await b.page('Emulation.setFocusEmulationEnabled', { enabled: true });
    await b.page('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await b.page('Page.addScriptToEvaluateOnNewDocument', { source: before(seed) });
    await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], browserContextId });
    await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, browserContextId, eventsEnabled: true });
    await loaded(b, () => b.page('Page.navigate', { url: new URL(url, `${origin}/index.html`).href }));
  } catch (e) {
    await closed(b);
    throw e;
  }
  return b;
}

async function closed(b) {
  browsers.delete(b.id);
  for (const [s, owner] of bySession) if (owner === b) bySession.delete(s);
  await send('Target.disposeBrowserContext', { browserContextId: b.browserContextId }).catch(() => {});
  fs.rmSync(b.downloadPath, { recursive: true, force: true });
}

async function evaluated(b, expression) {
  const r = await b.page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(described(r.exceptionDetails));
  return r.result.value;
}

// loaded navigates with go and waits until the program has started.
async function loaded(b, go) {
  await evaluated(b, 'window.ready = false').catch(() => {});
  b.thrown = false;
  b.errors.length = 0;
  const r = await go();
  if (r && r.errorText) throw new Error(`the browser cannot open the page: ${r.errorText}`);
  await started(b);
}

// started waits until start.mjs sets window.ready, or until the program ends, and settles the page.
async function started(b) {
  const until = Date.now() + 30000;
  for (;;) {
    const state = await evaluated(b, 'window.ready === true ? [typeof window.ended === \'number\' ? window.ended : 0, window.endReason || \'\'] : null').catch(() => null);
    if (state !== null && state[0] === 0) break;
    if (state !== null) throw new Error(`${ending(state[0], state[1])}\n${b.lines.join('\n')}`);
    if (b.thrown) throw new Error(`the page did not start\n${b.lines.join('\n')}`);
    if (Date.now() >= until) throw new Error(`the page did not start within 30 s\n${b.lines.join('\n')}`);
    await pause(20);
  }
  await agent(b, ['settle']);
}

// The errors Chromium gives for a request to a page that a navigation has replaced.
const navigatedAway = (e) => /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/
  .test(e.message);

// acted carries out what a user does, with act, and follows the page wherever that sends it.
async function acted(b, act) {
  const { documents, stops } = b;
  try {
    await act();
  } catch (e) {
    if (b.documents === documents && !navigatedAway(e)) throw e;
  }
  return followed(b, documents, stops);
}

// followed settles the page and, when the page has started going to another page, waits for that page's program to
// start. A page of another site counts as started once it settles, and a navigation that ends without a new page, as
// a download does, ends the wait.
async function followed(b, documents, stops) {
  let leaving = false;
  try {
    leaving = (await agent(b, ['settle'])) === 'leaving';
  } catch (e) {
    if (b.documents === documents && !navigatedAway(e)) throw e;
    leaving = true;
  }
  if (!leaving && b.documents === documents) return '';
  const until = Date.now() + 30000;
  while (b.documents === documents) {
    if (b.stops !== stops) return '';
    if (Date.now() >= until) throw new Error(`the page did not reach the page it went to within 30 s\n${b.lines.join('\n')}`);
    await pause(20);
  }
  if (b.landed.unreachableUrl) throw new Error(`the page went to ${b.landed.unreachableUrl}, which the browser cannot open`);
  if (new URL(b.landed.url).origin !== b.home) return agent(b, ['settle']);
  b.thrown = false;
  await started(b);
  return '';
}

async function agent(b, fields) {
  const answer = await evaluated(b, `import(${JSON.stringify(`${reserved}agent.mjs`)}).then((a) => a.request(${JSON.stringify(fields)}))`);
  if (!answer.ok) throw new Error(answer.message);
  return answer.value;
}

// retried repeats a request for up to 5 seconds until the page can answer it, since a real browser takes its own time.
// A request that a navigation interrupts is not repeated, since it may have done what it does.
async function retried(b, fields) {
  const until = Date.now() + patience;
  for (;;) {
    try {
      return await agent(b, fields);
    } catch (e) {
      if (Date.now() >= until || navigatedAway(e)) throw e;
    }
    await pause(20);
  }
}

// ---- what a user does ----

const keyNames = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp',
  'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock',
  'ContextMenu', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
const modifiers = { Shift: 'shiftKey', Control: 'ctrlKey', Alt: 'altKey', Meta: 'metaKey' };
const punctuation = { '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote' };

const codeOf = (key) => {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  if (keyNames.has(key)) return key;
  return punctuation[key] || '';
};

// parseKey reads a key as browser-press! takes it: a key's name or one character, after any of Shift+, Control+, Alt+
// and Meta+, as in "Shift+Enter".
function parseKey(spec) {
  const m = /^((?:(?:Shift|Control|Alt|Meta)\+)*)(.+)$/.exec(spec);
  const held = {};
  if (!m) throw new Error(`${JSON.stringify(spec)} is not a key`);
  for (const name of m[1].split('+').filter(Boolean)) held[modifiers[name]] = true;
  let key = m[2] === 'Space' ? ' ' : m[2];
  if (!keyNames.has(key) && [...key].length !== 1) throw new Error(`${JSON.stringify(spec)} is not a key: a key is a name such as Enter, or one character`);
  if (held.shiftKey && /^[a-z]$/.test(key)) key = key.toUpperCase();
  return { key, held };
}

const virtual = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20,
  ContextMenu: 93, ' ': 32, '-': 189, '=': 187, '[': 219, ']': 221, '\\': 220, ';': 186, "'": 222, ',': 188, '.': 190,
  '/': 191, '`': 192,
};
const bits = { shiftKey: 8, ctrlKey: 2, altKey: 1, metaKey: 4 };
const keyCode = (key) => virtual[key] ?? (/^[a-zA-Z0-9]$/.test(key) ? key.toUpperCase().charCodeAt(0)
  : /^F([1-9]|1[0-2])$/.test(key) ? 111 + Number(key.slice(1)) : 0);
const heldBits = (held) => Object.keys(held).reduce((n, k) => n | (held[k] ? bits[k] : 0), 0);

function key(b, type, name, mods) {
  const text = name === 'Enter' ? '\r' : [...name].length === 1 ? name : '';
  const typing = type === 'keyDown' && text !== '' && (mods & (bits.ctrlKey | bits.metaKey | bits.altKey)) === 0;
  return b.page('Input.dispatchKeyEvent', {
    type: type === 'keyDown' && !typing ? 'rawKeyDown' : type, key: name, code: codeOf(name), windowsVirtualKeyCode: keyCode(name),
    modifiers: mods, ...(typing ? { text, unmodifiedText: text } : {}),
  });
}

async function pressed(b, name, held) {
  const extra = Object.keys(modifiers).filter((m) => held[modifiers[m]] && name !== m);
  let mods = b.held;
  for (const m of extra) {
    mods |= bits[modifiers[m]];
    await key(b, 'keyDown', m, mods);
  }
  await key(b, 'keyDown', name, mods);
  await key(b, 'keyUp', name, mods);
  for (const m of extra.reverse()) {
    mods &= ~bits[modifiers[m]];
    await key(b, 'keyUp', m, mods);
  }
}

// clicked moves the mouse to the point and clicks the button as many times as counts says, each click's count in turn.
// A locked pointer stays where it is.
async function clicked(b, point, button = 'left', counts = [1]) {
  const { x, y } = point.locked ? b.mouse : point;
  const mouse = (type, buttons, clickCount) => b.page('Input.dispatchMouseEvent', {
    type, x, y, button, buttons, clickCount, modifiers: b.held,
  });
  if (!point.locked) await b.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: b.held });
  for (const n of counts) {
    await mouse('mousePressed', button === 'right' ? 2 : 1, n);
    await mouse('mouseReleased', 0, n);
  }
  b.mouse = { x, y };
}

async function downloaded(b, name) {
  const until = Date.now() + patience;
  for (;;) {
    for (const [guid, d] of b.downloads) {
      if (d.name === name && d.state === 'completed') return fs.readFileSync(path.join(b.downloadPath, guid)).toString();
    }
    if (Date.now() >= until) throw new Error(`no file named ${JSON.stringify(name)} was downloaded`);
    await pause(20);
  }
}

// ---- requests ----

// handle carries out a request, which fails when the page has thrown an error that nothing caught.
async function handle(b, m) {
  const value = await carried(b, m);
  if (b.errors.length > 0) {
    const first = b.errors[0];
    b.errors.length = 0;
    throw new Error(`the page has an uncaught error: ${first.slice('uncaught: '.length)}`);
  }
  return value;
}

async function carried(b, m) {
  const fields = entries(m.fields);
  const kind = fields[0];
  const point = (end = fields.length) => retried(b, ['point', ...fields.slice(1, end)]);
  switch (kind) {
    case 'click':
      return acted(b, async () => clicked(b, await point()));
    case 'right-click':
      return acted(b, async () => clicked(b, await point(), 'right'));
    case 'double-click':
      return acted(b, async () => clicked(b, await point(), 'left', [1, 2]));
    case 'hover':
      return acted(b, async () => {
        const at = await point();
        if (at.locked) return;
        await b.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, modifiers: b.held });
        b.mouse = { x: at.x, y: at.y };
      });
    case 'wheel':
      return acted(b, async () => {
        const k = parse(fields, 1)[1];
        const found = await point(k);
        const at = found.locked ? b.mouse : found;
        await b.page('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: at.x, y: at.y, deltaX: Number(fields[k]), deltaY: Number(fields[k + 1]), modifiers: b.held,
        });
        b.mouse = { x: at.x, y: at.y };
      });
    case 'select':
    case 'focus':
    case 'fire':
      return acted(b, () => retried(b, fields));
    case 'resize':
      await b.page('Emulation.setDeviceMetricsOverride', { width: Number(fields[1]), height: Number(fields[2]), deviceScaleFactor: 1, mobile: false });
      return agent(b, ['settle']);
    case 'type':
      return acted(b, async () => {
        const k = parse(fields, 1)[1];
        await retried(b, ['focus', ...fields.slice(1, k)]);
        for (const c of fields[k]) await pressed(b, c === '\n' ? 'Enter' : c, {});
      });
    case 'press': {
      const { key: name, held } = parseKey(fields[1]);
      return acted(b, () => pressed(b, name, held));
    }
    case 'key-down':
    case 'key-up': {
      const { key: name, held } = parseKey(fields[1]);
      if (modifiers[name]) b.held = kind === 'key-down' ? b.held | bits[modifiers[name]] : b.held & ~bits[modifiers[name]];
      return acted(b, () => key(b, kind === 'key-down' ? 'keyDown' : 'keyUp', name, b.held | heldBits(held)));
    }
    case 'move-mouse':
      b.mouse = { x: b.mouse.x + Number(fields[1]), y: b.mouse.y + Number(fields[2]) };
      return acted(b, () => b.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.mouse.x, y: b.mouse.y, modifiers: b.held }));
    case 'go': {
      const url = new URL(fields[1], await agent(b, ['url'])).href;
      await loaded(b, () => b.page('Page.navigate', { url }));
      return '';
    }
    case 'reload':
      await loaded(b, () => b.page('Page.reload', {}));
      return '';
    case 'console':
      await agent(b, ['settle']);
      return b.lines.join('\n');
    case 'choose-files':
      b.chosen = m.files;
      return '';
    case 'downloaded':
      return downloaded(b, fields[1]);
    case 'pixels':
      return Buffer.from((await agent(b, fields)).pixels, 'base64');
    case 'screenshot':
      await agent(b, ['settle']);
      return Buffer.from((await b.page('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    case 'respond': {
      const url = new URL(fields[1], await agent(b, ['url'])).href;
      b.answers.set(url, { status: Number(fields[2]), body: Buffer.from(fields[3]) });
      return '';
    }
    default:
      return kind.startsWith('expect-') ? retried(b, fields) : agent(b, fields);
  }
}

// checked gives Chromium's version, and on the next line the WebGPU adapter it draws canvases with, or on the line after
// that why it cannot.
async function checked() {
  if (!chrome) launch();
  const { product } = await send('Browser.getVersion');
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const probe = { site: new Map([['/index.html', Buffer.from('<!doctype html>')]]), answers: new Map(), net: null, lines: [] };
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    bySession.set(sessionId, probe);
    await page('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await page('Page.navigate', { url: `${origin}/index.html` });
    const until = Date.now() + patience;
    for (;;) {
      const r = await page('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }).catch(() => null);
      if (r && r.result.value === origin) break;
      if (Date.now() >= until) throw new Error('Chromium did not open a page to check WebGPU on');
      await pause(20);
    }
    const r = await page('Runtime.evaluate', { expression: canvasCheck, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(described(r.exceptionDetails));
    return `${product}\n${r.result.value.adapter || ''}\n${r.result.value.why || ''}`;
  } finally {
    for (const [s, owner] of bySession) if (owner === probe) bySession.delete(s);
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

// Draws ten frames on a WebGPU canvas, copying each as recorders.mjs does, and reads the copy back, as tests read
// pixels.
const canvasCheck = `(async () => {
  const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  if (!a) return { why: 'it has no WebGPU adapter' };
  const adapter = [a.info.vendor, a.info.architecture].filter((s) => s).join(' ') || 'an adapter';
  let lost = null;
  try {
    const device = await a.requestDevice();
    device.lost.then((info) => { lost = info.message.split('\\n')[0]; });
    const canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const kept = device.createTexture({ size: [64, 64], format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    for (let frame = 0; frame < 10 && !lost; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const texture = context.getCurrentTexture();
      const e = device.createCommandEncoder();
      e.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', clearValue: [1, 0, 0, 1], storeOp: 'store' }] }).end();
      e.copyTextureToTexture({ texture }, { texture: kept }, [64, 64]);
      device.queue.submit([e.finish()]);
    }
    const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: kept }, { buffer, bytesPerRow: 256 }, [1, 1, 1]);
    device.queue.submit([e.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const p = new Uint8Array(buffer.getMappedRange());
    if (lost) return { why: 'the device was lost: ' + lost };
    return (format.startsWith('bgra') ? p[2] : p[0]) === 255 ? { adapter } : { why: 'the frames it drew read back wrong' };
  } catch (e) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { why: lost ? 'the device was lost: ' + lost : String(e && e.message || e).split('\\n')[0] };
  }
})()`;

async function ended() {
  for (const b of [...browsers.values()]) await closed(b);
  if (chrome) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    await send('Browser.close').catch(() => {});
    await Promise.race([exited, pause(5000)]);
    if (chrome) chrome.kill();
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

port.on('message', async (m) => {
  let reply;
  try {
    let value = '';
    if (m.type === 'open') await opened(m.browser, m.site, m.url, m.seed, m.net);
    else if (m.type === 'close') await closed(browsers.get(m.browser));
    else if (m.type === 'end') await ended();
    else if (m.type === 'webgpu') value = await checked();
    else value = await handle(browsers.get(m.browser), m);
    reply = value instanceof Uint8Array ? { ok: true, bytes: value } : { ok: true, text: value };
  } catch (e) {
    let message = e && e.message ? e.message : String(e);
    const b = m.type === 'request' ? browsers.get(m.browser) : null;
    if (b && b.lines.length > 0) message += `\n  the console ends with:\n    ${b.lines.slice(-10).join('\n    ')}`;
    reply = { ok: false, message };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
