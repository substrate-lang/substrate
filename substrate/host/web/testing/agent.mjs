// The page's side of a browser test in Chromium (substrate/host/node/chromium.mjs). It reads and checks the document,
// finds where to click, and runs the clock that the driver installs before the page's scripts.
import { describe, parse } from './find.mjs';
import { advancedUntil, chose, documentRequest, one, short } from './requests.mjs';
import { canvasOf, drawingRequest, drawn, heard } from './logs.mjs';
import { unsettledOf } from './clock.mjs';

const {
  clock, real, waiting, idle, network, leaving, drawings, blobs, decoded, sounds, kinds, getContext,
} = window[Symbol.for('substrate.testing')];
const channel = new MessageChannel();
const turns = [];
channel.port1.onmessage = () => turns.shift()();
// Waits one turn of the event loop. It posts to a channel because nested timers wait at least 4 ms.
const turn = () => new Promise((resolve) => {
  turns.push(resolve);
  channel.port2.postMessage(null);
});
const quote = (s) => JSON.stringify(s);
const patience = 30000;
const unsettled = unsettledOf(() => [network, ...((window.app && window.app.realTime) || [])], real.now);

// settle lets the program finish what it can without moving the clock: due timers, the page's own tasks, the work the
// page is waiting on (recorders.mjs), for at most 30 seconds, and real-time work while it makes progress.
export async function settle() {
  let steps = 0;
  const until = real.now() + patience;
  for (let quiet = 0; quiet < 2;) {
    let ran = false;
    while (clock.dueNow()) {
      ran = true;
      if (++steps > 100000) throw new Error('the program kept setting timers that are already due, so it never settled');
    }
    if (waiting.size > 0) {
      ran = true;
      if (real.now() >= until) throw new Error(`the page waited ${patience / 1000} s for ${[...waiting.keys()].join(', ')}`);
      await Promise.race([idle(), new Promise((resolve) => real.setTimeout(resolve, until - real.now()))]);
    } else if (unsettled()) {
      ran = true;
      await new Promise((resolve) => real.setTimeout(resolve, 10));
    } else await turn();
    quiet = ran ? 0 : quiet + 1;
  }
}

let assets = null;
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// nameOf names drawn images and sounds by the path of the site's asset with the same bytes.
async function nameOf(bytes, otherwise) {
  if (!assets) {
    const listed = (await (await fetch('/assets.list')).text()).split('\n').filter((p) => p !== '');
    assets = await Promise.all(listed.map(async (p) => [`/${p}`, new Uint8Array(await (await fetch(`/${p}`)).arrayBuffer())]));
  }
  const found = assets.find(([, b]) => same(b, bytes));
  return found ? found[0] : otherwise;
}

async function imageName(image) {
  const src = (image.getAttribute && image.getAttribute('src')) || '';
  const blob = blobs.get(src);
  if (blob) return nameOf(new Uint8Array(await blob.arrayBuffer()), src);
  const url = new URL(src, location.href);
  return url.origin === location.origin ? decodeURIComponent(url.pathname) : src;
}

async function drawingOf(f) {
  const calls = drawings.get(canvasOf(document, f)) || [];
  const names = new Map();
  for (const [name, args] of calls) if (name === 'drawImage' && !names.has(args[0])) names.set(args[0], await imageName(args[0]));
  return calls.map(([name, args]) => drawn(name, args, (image) => names.get(image))).filter((l) => l !== null).join('\n');
}

async function soundLines() {
  const lines = [];
  for (const s of sounds) lines.push(heard({ ...s, name: s.buffer ? await nameOf(decoded.get(s.buffer) || new Uint8Array(), '') : '' }));
  return lines.join('\n');
}

const base64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
};

// The RGBA pixels of a rectangle of a canvas, row by row. A WebGPU canvas gives the last frame drawn into its
// offscreen surface (substrate/host/web/gpu.mjs), and a canvas with neither gives zeros.
async function pixels(canvas, x, y, w, h) {
  if (kinds.get(canvas) === '2d') return getContext.call(canvas, '2d').getImageData(x, y, w, h).data;
  const gpu = window.modules && window.modules.gpu;
  const surface = gpu && gpu.surfaceOf ? gpu.surfaceOf(canvas) : null;
  if (!surface) return new Uint8Array(w * h * 4);
  const { device, texture } = surface;
  const bytesPerRow = (w * 4 + 255) & ~255;
  const staging = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, origin: [x, y, 0] }, { buffer: staging, bytesPerRow, rowsPerImage: h }, [w, h, 1]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(staging.getMappedRange());
  const bytes = new Uint8Array(w * 4 * h);
  for (let row = 0; row < h; row++) bytes.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + w * 4), row * w * 4);
  staging.unmap();
  staging.destroy();
  if (texture.format.startsWith('bgra')) {
    for (let i = 0; i < bytes.length; i += 4) [bytes[i], bytes[i + 2]] = [bytes[i + 2], bytes[i]];
  }
  return bytes;
}

// Opens this page's database as the storage module does (substrate/host/web/storage.mjs) and runs use on it.
function stored(mode, use) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(location.pathname.replace(/[^/]*$/, ''), 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('keys');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const t = db.transaction('keys', mode);
      const r = use(t.objectStore('keys'));
      t.oncomplete = () => {
        db.close();
        resolve(r.result);
      };
      t.onerror = () => reject(t.error);
    };
  });
}

async function carriedOut(fields) {
  const read = documentRequest(document, fields) ?? await drawingRequest(fields, drawingOf);
  if (read !== undefined) return read;
  const found = () => parse(fields, 1);
  switch (fields[0]) {
    case 'settle':
      return leaving() ? 'leaving' : '';
    case 'point': {
      const [f, k] = found();
      const e = one(document, f);
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) throw new Error(`${describe(f)} is not shown, so it cannot be clicked\n  it is ${short(e)}`);
      const x = r.left + (k < fields.length ? Number(fields[k]) : r.width / 2);
      const y = r.top + (k < fields.length ? Number(fields[k + 1]) : r.height / 2);
      const at = document.elementFromPoint(x, y);
      if (at !== e && !e.contains(at)) {
        throw new Error(`${describe(f)} is covered where it would be clicked, by ${at ? short(at) : 'nothing'}\n  it is ${short(e)}`);
      }
      return { x, y, locked: document.pointerLockElement !== null };
    }
    case 'focus':
      one(document, found()[0]).focus();
      return '';
    case 'fire': {
      const [f, k] = found();
      one(document, f).dispatchEvent(new Event(fields[k], { bubbles: true, cancelable: true }));
      return '';
    }
    case 'advance':
      await clock.advance(Number(fields[1]), settle);
      await settle();
      return '';
    case 'url':
      return location.href;
    case 'sounds':
      return soundLines();
    case 'pixels': {
      const [f, k] = found();
      const [x, y, w, h] = fields.slice(k, k + 4).map(Number);
      return { pixels: base64(await pixels(canvasOf(document, f), x, y, w, h)) };
    }
    case 'expect-pixel': {
      const [f, k] = found();
      const [x, y] = [Number(fields[k]), Number(fields[k + 1])];
      const p = [...(await pixels(canvasOf(document, f), x, y, 1, 1))].join(',');
      if (p !== fields[k + 2]) throw new Error(`the pixel at ${x}, ${y} of ${describe(f)} is ${p}, not ${fields[k + 2]}`);
      return '';
    }
    case 'box': {
      const r = one(document, found()[0]).getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => n.toFixed(3)).join(' ');
    }
    case 'select':
      return chose(document, fields);
    case 'advance-until':
      return advancedUntil(document, fields, clock, settle);
    case 'storage-get': {
      const v = await stored('readonly', (s) => s.get(fields[1]));
      if (v === undefined) throw new Error(`the browser's storage has no key ${quote(fields[1])}`);
      return new TextDecoder().decode(v);
    }
    case 'storage-set':
      await stored('readwrite', (s) => s.put(new TextEncoder().encode(fields[2]), fields[1]));
      return '';
    case 'clipboard-get':
      return navigator.clipboard.readText();
    case 'clipboard-set':
      await navigator.clipboard.writeText(fields[1]);
      return '';
    default:
      throw new Error(`no request ${fields[0]}`);
  }
}

export async function request(fields) {
  try {
    await settle();
    const value = await carriedOut(fields);
    if (typeof window.ended === 'number' && window.ended !== 0) throw new Error(`the program ended with ${window.ended}`);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}
