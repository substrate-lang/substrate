// Lifecycle: experimental. A browser to check pages in: Chromium, headless,
// driven over its DevTools protocol, which is all this needs of it, so
// there is nothing to install but the browser (the flake's chromium).
//
//   import { withBrowser } from './browser.mjs';
//   await withBrowser(async (open) => {
//     const page = await open('http://127.0.0.1:8000/');
//     await page.waitFor('window.ready');
//     await page.click('#run');
//     console.log(await page.evaluate('document.title'));
//   });
//
// A page has:
//
//   evaluate(js)        the value of the expression js in the page, which
//                       is awaited if it is a promise; an exception it
//                       throws is thrown here
//   waitFor(js, ms)     wait until js is true, for at most ms (10000)
//   click(selector)     a mouse click at the middle of the element
//   type(text)          text typed into the focused element, as input
//   press(key, mods)    a key pressed and released, such as "Enter" or
//                       "ArrowUp"; mods is DevTools' modifiers, 8 Shift
//   screenshot(file, width, height)
//                       the page as it looks, at that size, a PNG
//   log                 what the page wrote to its console, and its
//                       uncaught exceptions, as lines
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The keys press knows: DevTools wants a key's code and number with its name.
const keys = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
};

// The browser is started for use, a function of open, which opens a page,
// and closed after it. Its profile is a directory of its own, in
// options.dir or the system's, removed after; it runs without Chromium's
// sandbox, which needs what a build's machine may not allow, and which
// the pages it is given, this repository's, served from this machine, do
// not need.
export async function withBrowser(use, options = {}) {
  const profile = fs.mkdtempSync(path.join(options.dir || os.tmpdir(), 'chromium-'));
  const browser = spawn(options.chromium || process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    // Chromium says where its DevTools listen on its standard error.
    const endpoint = await new Promise((resolve, reject) => {
      let said = '';
      browser.stderr.on('data', (d) => {
        said += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(said);
        if (m) resolve(m[1]);
      });
      browser.on('error', reject);
      browser.on('exit', (code) => reject(new Error(`chromium exited with status ${code}: ${said}`)));
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('cannot connect to chromium'));
    });

    // Commands are numbered, and each one's answer has its number.
    let next = 0;
    const waiting = new Map();
    const listeners = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const { resolve, reject } = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else {
        const listen = listeners.get(message.sessionId);
        if (listen) listen(message);
      }
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

    const open = async (url) => {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const log = [];
      listeners.set(sessionId, (message) => {
        if (message.method === 'Runtime.consoleAPICalled') {
          log.push(message.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description)).join(' '));
        } else if (message.method === 'Runtime.exceptionThrown') {
          const d = message.params.exceptionDetails;
          log.push(`uncaught: ${d.exception && d.exception.description ? d.exception.description : d.text}`);
        }
      });
      const command = (method, params) => send(method, params, sessionId);
      await command('Runtime.enable');
      await command('Page.enable');
      const evaluate = async (js) => {
        const r = await command('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error(d.exception && d.exception.description ? d.exception.description : d.text);
        }
        return r.result.value;
      };
      const page = {
        log,
        evaluate,
        async waitFor(js, ms = 10000) {
          const until = Date.now() + ms;
          while (!(await evaluate(js))) {
            if (Date.now() > until) throw new Error(`waited ${ms} ms for ${js}\n${log.join('\n')}`);
            await new Promise((r) => setTimeout(r, 20));
          }
        },
        async click(selector) {
          const at = await evaluate(`(() => {
            const e = document.querySelector(${JSON.stringify(selector)});
            if (!e) return null;
            const r = e.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()`);
          if (!at) throw new Error(`no element ${selector}`);
          for (const type of ['mousePressed', 'mouseReleased']) {
            await command('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
          }
        },
        async type(string) {
          await command('Input.insertText', { text: string });
        },
        async press(key, modifiers = 0) {
          const k = keys[key] || { code: `Key${key.toUpperCase()}`, text: key };
          await command('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key, modifiers, ...k });
          await command('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, ...k });
        },
        async screenshot(file, width = 1000, height = 700) {
          await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          const { data } = await command('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(file, Buffer.from(data, 'base64'));
        },
      };
      await command('Page.navigate', { url });
      return page;
    };
    return await use(open);
  } finally {
    if (socket) socket.close();
    browser.kill();
    await new Promise((resolve) => browser.on('exit', resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
