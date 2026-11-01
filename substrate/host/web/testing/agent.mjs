// The page's half of a browser test in Chromium (substrate/host/node/chromium.mjs): it reads and checks the document,
// finds where to click, and runs the page's clock, which the driver installs before the page's own scripts.
import { describe, parse } from './find.mjs';
import { documentRequest, one, short } from './requests.mjs';
import { canvasOf, drawingRequest, drawn, heard } from './logs.mjs';

const { clock, drawings, blobs, decoded, sounds, kinds, getContext, frames } = window[Symbol.for('substrate.testing')];
const channel = new MessageChannel();
const turns = [];
channel.port1.onmessage = () => turns.shift()();
// A turn of the page's event loop, through a channel, as a timer's turn would wait at least 4 ms once timers nest.
const turn = () => new Promise((resolve) => {
  turns.push(resolve);
  channel.port2.postMessage(null);
});
const quote = (s) => JSON.stringify(s);

// settle runs what the program has left to do without the clock moving: due timers, and the page's own work.
export async function settle() {
  let steps = 0;
  for (let quiet = 0; quiet < 2;) {
    let ran = false;
    while (clock.dueNow()) {
      ran = true;
      if (++steps > 100000) throw new Error('the program kept setting timers due now, so the clock could not stand still');
    }
    await turn();
    quiet = ran ? 0 : quiet + 1;
  }
}

let assets = null;
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// nameOf names bytes by the site's asset that has them, as the simulated browser names drawn images and sounds.
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

// A canvas's pixels in a rectangle, as RGBA bytes, row by row: a 2D canvas's own, a WebGPU canvas's last frame, or
// none for a canvas with neither.
async function pixels(canvas, x, y, w, h) {
  if (kinds.get(canvas) === '2d') return getContext.call(canvas, '2d').getImageData(x, y, w, h).data;
  const kept = frames.get(canvas);
  if (!kept) return new Uint8Array(w * h * 4);
  const { device, texture } = kept;
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

// The storage module's database for this page (substrate/host/web/storage.mjs), used as it uses it.
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
      return '';
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
      return { x, y };
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

// request carries out what the driver asks of the page, after settling the program, and gives its answer or what went
// wrong.
export async function request(fields) {
  try {
    await settle();
    return { ok: true, value: await carriedOut(fields) };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}
