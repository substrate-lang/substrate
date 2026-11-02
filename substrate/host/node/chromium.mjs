// Runs one headless Chromium for a test run, on its own thread, and drives it over the DevTools protocol on a pipe.
// Each browser a test opens gets its own browser context. It takes the same requests from browser.mjs as the simulated
// browser, and ../web/testing/agent.mjs carries out the page's side of them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerData } from 'node:worker_threads';
import { makeClock } from '../web/testing/clock.mjs';
import { installClock, seeded } from '../web/testing/globals.mjs';
import { installRecorders } from '../web/testing/recorders.mjs';
import { parse } from '../web/testing/find.mjs';
import { codeOf, modifiers, parseKey } from '../web/testing/keys.mjs';
import { entries } from '../entries.mjs';
import { mayUrl } from '../grants.mjs';

const { port, signal, file } = workerData;
const testing = fileURLToPath(new URL('../web/testing/', import.meta.url));
const origin = 'http://localhost';
const reserved = '/.substrate-testing/';
const patience = 5000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const gpuFlags = process.platform === 'darwin' ? ['--enable-unsafe-webgpu']
  : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-angle=vulkan'];

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
  installClock(window, clock, true);
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
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-chromium-'));
  chrome = spawn(file, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--no-sandbox', '--mute-audio', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...gpuFlags, 'about:blank'],
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

// loaded navigates with go and waits until start.mjs sets window.ready, or until the program ends.
async function loaded(b, go) {
  await evaluated(b, 'window.ready = false').catch(() => {});
  b.thrown = false;
  b.errors.length = 0;
  const r = await go();
  if (r && r.errorText) throw new Error(`the browser cannot open the page: ${r.errorText}`);
  const until = Date.now() + 30000;
  for (;;) {
    const state = await evaluated(b, 'window.ready === true ? (typeof window.ended === \'number\' ? window.ended : 0) : null').catch(() => null);
    if (state === 0) break;
    if (state !== null) throw new Error(`the program ended with ${state}\n${b.lines.join('\n')}`);
    if (b.thrown) throw new Error(`the page did not start\n${b.lines.join('\n')}`);
    if (Date.now() >= until) throw new Error(`the page did not start within 30 s\n${b.lines.join('\n')}`);
    await pause(20);
  }
  await agent(b, ['settle']);
}

async function agent(b, fields) {
  const answer = await evaluated(b, `import(${JSON.stringify(`${reserved}agent.mjs`)}).then((a) => a.request(${JSON.stringify(fields)}))`);
  if (!answer.ok) throw new Error(answer.message);
  return answer.value;
}

// retried repeats a request for up to 5 seconds until the page can answer it, since a real browser takes its own time.
async function retried(b, fields) {
  const until = Date.now() + patience;
  for (;;) {
    try {
      return await agent(b, fields);
    } catch (e) {
      if (Date.now() >= until) throw e;
    }
    await pause(20);
  }
}

// ---- what a user does ----

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

async function clicked(b, { x, y }) {
  const mouse = (type, buttons) => b.page('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers: b.held });
  await b.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: b.held });
  await mouse('mousePressed', 1);
  await mouse('mouseReleased', 0);
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
  switch (kind) {
    case 'click':
      await clicked(b, await retried(b, ['point', ...fields.slice(1)]));
      return agent(b, ['settle']);
    case 'type': {
      const [, k] = parse(fields, 1);
      await retried(b, ['focus', ...fields.slice(1, k)]);
      for (const c of fields[k]) await pressed(b, c === '\n' ? 'Enter' : c, {});
      return agent(b, ['settle']);
    }
    case 'press': {
      const { key: name, held } = parseKey(fields[1]);
      await pressed(b, name, held);
      return agent(b, ['settle']);
    }
    case 'key-down':
    case 'key-up': {
      const { key: name, held } = parseKey(fields[1]);
      if (modifiers[name]) b.held = kind === 'key-down' ? b.held | bits[modifiers[name]] : b.held & ~bits[modifiers[name]];
      await key(b, kind === 'key-down' ? 'keyDown' : 'keyUp', name, b.held | heldBits(held));
      return agent(b, ['settle']);
    }
    case 'move-mouse':
      b.mouse = { x: b.mouse.x + Number(fields[1]), y: b.mouse.y + Number(fields[2]) };
      await b.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.mouse.x, y: b.mouse.y, modifiers: b.held });
      return agent(b, ['settle']);
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
    case 'respond': {
      const url = new URL(fields[1], await agent(b, ['url'])).href;
      b.answers.set(url, { status: Number(fields[2]), body: Buffer.from(fields[3]) });
      return '';
    }
    default:
      return kind.startsWith('expect-') ? retried(b, fields) : agent(b, fields);
  }
}

// probed gives Chromium's version and its WebGPU adapter on two lines, the second empty when WebGPU has only a software
// adapter or none.
async function probed() {
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
      if (Date.now() >= until) throw new Error('Chromium did not open a page to look for a GPU');
      await pause(20);
    }
    const r = await page('Runtime.evaluate', { expression: adapter, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(described(r.exceptionDetails));
    return `${product}\n${r.result.value}`;
  } finally {
    for (const [s, owner] of bySession) if (owner === probe) bySession.delete(s);
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

const adapter = `(async () => {
  const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  if (!a || a.info.isFallbackAdapter) return '';
  return [a.info.vendor, a.info.architecture].filter((s) => s).join(' ') || 'a GPU';
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
    else if (m.type === 'gpu') value = await probed();
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
