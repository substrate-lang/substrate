// Drives a headless Chromium over the DevTools protocol, for the browser tests.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const webgpuFlags = process.platform === 'darwin' ? ['--enable-unsafe-webgpu'] : [
  '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
  '--use-angle=vulkan',
];

export const hardwareGpuFlags = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-angle=vulkan'];

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

export async function withBrowser(use, options = {}) {
  const profile = fs.mkdtempSync(path.join(options.dir || os.tmpdir(), 'chromium-'));
  const browser = spawn(options.chromium || process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', ...(options.gpu ? [] : ['--disable-gpu']), '--no-sandbox',
    ...(options.flags || []), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
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
      let chooser = null;
      listeners.set(sessionId, (message) => {
        if (message.method === 'Page.fileChooserOpened' && chooser) {
          chooser(message.params);
        } else if (message.method === 'Runtime.consoleAPICalled') {
          log.push(message.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description)).join(' '));
        } else if (message.method === 'Runtime.exceptionThrown') {
          const d = message.params.exceptionDetails;
          log.push(`uncaught: ${d.exception && d.exception.description ? d.exception.description : d.text}`);
        }
      });
      const command = (method, params) => send(method, params, sessionId);
      await command('Runtime.enable');
      await command('Page.enable');
      await send('Target.activateTarget', { targetId });
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
        command,
        grant: (permissions) => send('Browser.grantPermissions', { permissions, origin: new URL(url).origin }),
        downloadsTo: (dir) => send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }),
        async chooseFiles(files) {
          await command('Page.setInterceptFileChooserDialog', { enabled: true });
          chooser = ({ backendNodeId }) => {
            chooser = null;
            command('DOM.setFileInputFiles', { files, backendNodeId }).catch((e) => log.push(`files: ${e.message}`));
          };
        },
        async waitFor(js, ms = 10000) {
          const until = Date.now() + ms;
          const late = {};
          for (;;) {
            let timer;
            const answer = evaluate(js);
            answer.catch(() => {});
            const r = await Promise.race([answer, new Promise((resolve) => {
              timer = setTimeout(() => resolve(late), Math.max(1, until - Date.now()));
            })]);
            clearTimeout(timer);
            if (r && r !== late) return;
            if (Date.now() >= until) throw new Error(`waited ${ms} ms for ${js}\n${log.join('\n')}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
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
        async keyDown(key, modifiers = 0) {
          const k = keys[key] || { code: `Key${key.toUpperCase()}`, text: key };
          await command('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key, modifiers, ...k });
        },
        async keyUp(key, modifiers = 0) {
          const k = keys[key] || { code: `Key${key.toUpperCase()}`, text: key };
          await command('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, ...k });
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
        async close() {
          listeners.delete(sessionId);
          await send('Target.closeTarget', { targetId });
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
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
