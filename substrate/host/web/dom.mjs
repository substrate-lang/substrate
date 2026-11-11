// The host module "dom": applies a program's patches to the document, and sends it the document's events.
import { resolvePath } from './fs.mjs';
import { errors } from '../errors.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

const SOURCE = 1;
const HEARD = 1;
const IMAGE_LOADED = 2;
const IMAGE_FAILED = 3;

// The node numbers of the document and of the current event (std/web/patches.sub).
const DOCUMENT = 1;
const EVENT = 2;

const imageTypes = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};

export function dom(root) {
  const templates = new Map();
  const nodes = new Map([[0, root], [DOCUMENT, root.ownerDocument]]);
  const images = new Map();
  const loading = new Map();
  const counted = (tag, n) => {
    const k = (loading.get(tag) || 0) + n;
    if (k === 0) loading.delete(tag);
    else loading.set(tag, k);
  };
  let app = null;
  let caller = null;

  const give = (e, message) => caller.event(HEARD, message, message, 0, null, e);

  const event = () => {
    const e = caller && caller.current();
    return e && e.source === SOURCE ? e.data : null;
  };

  const current = () => {
    const e = event();
    if (!e) caller.trap('dom: there is no current event');
    return e;
  };

  // A piece that a program put in the document: its first and last nodes.
  class Piece {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }

  const nodeOf = (id) => {
    if (id === EVENT) return current();
    const n = nodes.get(id);
    return n instanceof Piece ? n.start : n;
  };

  const known = (id) => {
    if (id !== EVENT && !nodes.has(id)) caller.trap(`dom: there is no node ${id}`);
    return nodeOf(id);
  };

  const kinds = ['Node', 'Event', 'NodeList', 'HTMLCollection', 'NamedNodeMap', 'DOMRectReadOnly', 'DOMRectList',
    'DOMTokenList', 'CSSStyleDeclaration', 'DOMStringMap', 'ValidityState', 'FileList', 'Blob', 'DataTransfer',
    'DataTransferItemList', 'DataTransferItem', 'TouchList', 'Touch', 'IntersectionObserverEntry', 'Selection',
    'AbstractRange', 'TimeRanges', 'MediaError', 'Array']
    .map((name) => globalThis[name]).filter((kind) => kind !== undefined);
  const reachable = (x) => kinds.some((kind) => x instanceof kind);
  const plain = (v) => v === null || v === undefined || ['number', 'string', 'boolean'].includes(typeof v);

  function guarded(path, f) {
    try {
      return f();
    } catch (e) {
      caller.trap(`dom: ${path}: ${e.message}`);
    }
  }

  // The browser's own property of x, which a form's controls or a document's named elements cannot hide: an accessor or
  // a method on x's prototypes.
  function builtin(x, name) {
    if (x === null || (typeof x !== 'object' && typeof x !== 'function')) return null;
    for (let p = Object.getPrototypeOf(x); p !== null; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (d) return d.get || d.set || typeof d.value === 'function' ? d : null;
    }
    return null;
  }

  function step(x, name, path) {
    const o = Object(x);
    if (!(name in o)) caller.trap(`dom: ${path}: there is no ${name}`);
    const d = builtin(o, name);
    return guarded(path, () => (d === null ? o[name] : d.get ? d.get.call(o) : d.value));
  }

  function owner(root, path) {
    const parts = path.split('.');
    const last = parts.pop();
    let x = root;
    for (let k = 0; k < parts.length; k++) {
      if (x === null || x === undefined) return [null, last];
      x = step(x, parts[k], path);
      if (x !== null && x !== undefined && !reachable(x)) {
        caller.trap(`dom: ${path}: ${parts.slice(0, k + 1).join('.')} is not one of the document's objects`);
      }
    }
    return [x === undefined ? null : x, last];
  }

  function walk(root, path) {
    if (path === '') return root;
    const [x, last] = owner(root, path);
    return x === null ? null : step(x, last, path);
  }

  function read(root, path) {
    const v = walk(root, path);
    if (!plain(v)) caller.trap(`dom: ${path} is not a number, text, or true or false`);
    return v;
  }

  function write(root, path, value) {
    const [x, last] = owner(root, path);
    if (x === null || !(last in x)) caller.trap(`dom: ${path}: there is no ${last} to set`);
    const d = builtin(x, last);
    guarded(path, () => {
      if (d && d.set) d.set.call(x, value);
      else x[last] = value;
    });
  }

  function call(root, path, args) {
    const [x, last] = owner(root, path);
    const d = builtin(x, last);
    const f = d && typeof d.value === 'function' ? d.value : x === null ? undefined : x[last];
    if (typeof f !== 'function') caller.trap(`dom: ${path} is not a method`);
    const result = guarded(path, () => f.apply(x, args));
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return result;
  }

  function keep(id, path, v) {
    if (!plain(v) && !reachable(v)) caller.trap(`dom: ${path}: its result is not one of the document's objects`);
    nodes.set(id, v === undefined ? null : v);
  }

  const numberOf = (v) => (v === null || v === undefined ? 0 : Number(v));
  const textOf = (v) => (v === null || v === undefined ? '' : String(v));

  const bits = new DataView(new ArrayBuffer(8));
  const float64 = (low, high) => {
    bits.setUint32(0, low, true);
    bits.setUint32(4, high, true);
    return bits.getFloat64(0, true);
  };

  const listener = (e) => {
    const messages = e.currentTarget.subListeners;
    if (messages && e.type in messages) give(e, messages[e.type]);
  };

  const windowListeners = new Map();

  const frames = new Map();
  let frameRequest = 0;

  function frame(time) {
    frameRequest = 0;
    for (const [id, message] of [...frames]) {
      if (frames.get(id) === message) give({ type: 'frame', timeStamp: time }, message);
    }
    if (frames.size > 0 && !frameRequest) frameRequest = requestAnimationFrame(frame);
  }

  function listenWindow(id, type, message) {
    if (type === 'frame') {
      frames.set(id, message);
      if (!frameRequest) frameRequest = requestAnimationFrame(frame);
      return;
    }
    const entry = { type, message, handler: null };
    entry.handler = (e) => {
      const list = windowListeners.get(id);
      if (list && list.includes(entry)) give(e, message);
    };
    windowTarget(type).addEventListener(type, entry.handler);
    if (!windowListeners.has(id)) windowListeners.set(id, []);
    windowListeners.get(id).push(entry);
  }

  const windowTarget = (type) => (type === 'pointerlockchange' || type === 'pointerlockerror' ? document : window);

  const watched = new Map();
  let observer = null;

  function watch(node, message) {
    observer ||= new IntersectionObserver((entries) => {
      for (const entry of entries) if (watched.has(entry.target)) give(entry, watched.get(entry.target));
    });
    watched.set(node, message);
    observer.observe(node);
  }

  const unlisten = (id) => {
    const n = nodes.get(id);
    if (n instanceof Node && n.subListeners) {
      for (const message of Object.values(n.subListeners)) caller.forget(message);
      n.subListeners = null;
    }
    if (watched.has(n)) {
      observer.unobserve(n);
      watched.delete(n);
    }
    for (const { type, message, handler } of windowListeners.get(id) || []) {
      windowTarget(type).removeEventListener(type, handler);
      caller.forget(message);
    }
    windowListeners.delete(id);
    if (frames.has(id)) {
      caller.forget(frames.get(id));
      frames.delete(id);
    }
  };

  function template(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    const content = t.content;
    const marked = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.COMMENT_NODE ? n.data === 't' || n.data === 'a' : n.hasAttribute('data-n')) marked.push(n);
    }
    for (let i = 0; i < marked.length; i++) {
      const n = marked[i];
      if (n.nodeType === Node.ELEMENT_NODE) {
        n.removeAttribute('data-n');
      } else if (n.data === 't') {
        marked[i] = document.createTextNode('');
        n.replaceWith(marked[i]);
      }
    }
    const first = content.firstChild;
    if (!first || (first.nodeType === Node.COMMENT_NODE && first.data === 'a')) {
      content.insertBefore(document.createTextNode(''), first);
    }
    const paths = marked.map((n) => {
      const path = [];
      for (; n !== content; n = n.parentNode) path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
      return path;
    });
    return { content, paths };
  }

  function place(what, parent, before) {
    if (before) {
      const next = nodeOf(before);
      next.parentNode.insertBefore(what, next);
    } else {
      nodeOf(parent).appendChild(what);
    }
  }

  function taken(copy) {
    const fragment = document.createDocumentFragment();
    for (let n = copy.start; ; ) {
      const next = n.nextSibling;
      fragment.appendChild(n);
      if (n === copy.end) break;
      n = next;
    }
    return fragment;
  }

  function setAttribute(node, name, value) {
    if (name === 'value') {
      if (node.value !== value) node.value = value;
    } else {
      if (name === 'checked') node.checked = true;
      node.setAttribute(name, value);
    }
  }

  function removeAttribute(node, name) {
    if (name === 'value') node.value = '';
    else {
      if (name === 'checked') node.checked = false;
      node.removeAttribute(name);
    }
  }

  function draw(ctx, w, f, i, end, string) {
    while (i < end) {
      switch (w[i]) {
        case 1: ctx.clearRect(f[i + 1], f[i + 2], f[i + 3], f[i + 4]); i += 5; break;
        case 2: ctx.fillStyle = string(i + 1); i += 3; break;
        case 3: ctx.strokeStyle = string(i + 1); i += 3; break;
        case 4: ctx.lineWidth = f[i + 1]; i += 2; break;
        case 5: ctx.fillRect(f[i + 1], f[i + 2], f[i + 3], f[i + 4]); i += 5; break;
        case 6: ctx.strokeRect(f[i + 1], f[i + 2], f[i + 3], f[i + 4]); i += 5; break;
        case 7: ctx.beginPath(); i += 1; break;
        case 8: ctx.moveTo(f[i + 1], f[i + 2]); i += 3; break;
        case 9: ctx.lineTo(f[i + 1], f[i + 2]); i += 3; break;
        case 10: ctx.arc(f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]); i += 6; break;
        case 11: ctx.closePath(); i += 1; break;
        case 12: ctx.fill(); i += 1; break;
        case 13: ctx.stroke(); i += 1; break;
        case 14: ctx.font = string(i + 1); i += 3; break;
        case 15: ctx.fillText(string(i + 1), f[i + 3], f[i + 4]); i += 5; break;
        case 16: ctx.textAlign = string(i + 1); i += 3; break;
        case 17: ctx.textBaseline = string(i + 1); i += 3; break;
        case 18: ctx.save(); i += 1; break;
        case 19: ctx.restore(); i += 1; break;
        case 20: ctx.translate(f[i + 1], f[i + 2]); i += 3; break;
        case 21: ctx.rotate(f[i + 1]); i += 2; break;
        case 22: ctx.scale(f[i + 1], f[i + 2]); i += 3; break;
        case 23: ctx.globalAlpha = f[i + 1]; i += 2; break;
        case 24: {
          const image = images.get(w[i + 1]);
          if (image && image.complete && image.naturalWidth > 0) {
            const cw = f[i + 4];
            const ch = f[i + 5];
            const columns = Math.max(1, Math.floor(image.naturalWidth / cw));
            const sx = (w[i + 2] % columns) * cw;
            const sy = Math.floor(w[i + 2] / columns) * ch;
            if (w[i + 3] & 1) {
              ctx.save();
              ctx.translate(f[i + 6] + cw, f[i + 7]);
              ctx.scale(-1, 1);
              ctx.drawImage(image, sx, sy, cw, ch, 0, 0, cw, ch);
              ctx.restore();
            } else {
              ctx.drawImage(image, sx, sy, cw, ch, f[i + 6], f[i + 7], cw, ch);
            }
          }
          i += 8;
          break;
        }
        default:
          throw new Error(`dom.apply: no drawing command ${w[i]}`);
      }
    }
  }

  function patches(memory, ptr, length, after) {
    const w = ptr % 4 === 0
      ? new Uint32Array(memory.buffer, memory.byteOffset + ptr, length >>> 2)
      : new Uint32Array(memory.slice(ptr, ptr + length).buffer);
    const string = (at) => text.decode(memory.subarray(w[at], w[at] + w[at + 1]));
    const argument = (at) => {
      if (w[at] === 0) return float64(w[at + 1], w[at + 2]);
      return w[at] === 1 ? string(at + 1) : known(w[at + 1]);
    };
    for (let i = 0; i < w.length; ) {
      switch (w[i]) {
        case 1:
          templates.set(w[i + 1], template(string(i + 2)));
          i += 4;
          break;
        case 2: {
          const t = templates.get(w[i + 1]);
          const first = w[i + 2];
          const copy = t.content.cloneNode(true);
          t.paths.forEach((path, k) => {
            let n = copy;
            for (const index of path) n = n.childNodes[index];
            nodes.set(first + 1 + k, n);
          });
          nodes.set(first, new Piece(copy.firstChild, copy.lastChild));
          place(copy, w[i + 4], w[i + 5]);
          i += 6;
          break;
        }
        case 3:
        case 4:
          for (let id = w[i + 1]; id <= w[i + 1] + w[i + 2]; id++) unlisten(id);
          if (w[i] === 3) taken(nodes.get(w[i + 1]));
          for (let id = w[i + 1]; id <= w[i + 1] + w[i + 2]; id++) nodes.delete(id);
          i += 3;
          break;
        case 5:
          place(taken(nodes.get(w[i + 1])), w[i + 2], w[i + 3]);
          i += 4;
          break;
        case 6:
          nodes.get(w[i + 1]).data = string(i + 2);
          i += 4;
          break;
        case 7:
          setAttribute(nodes.get(w[i + 1]), string(i + 2), string(i + 4));
          i += 6;
          break;
        case 8:
          removeAttribute(nodes.get(w[i + 1]), string(i + 2));
          i += 4;
          break;
        case 9: {
          const node = nodes.get(w[i + 1]);
          const type = string(i + 2);
          (node.subListeners ||= {})[type] = w[i + 4];
          if (type === 'visibility') watch(node, w[i + 4]);
          else node.addEventListener(type, listener);
          i += 5;
          break;
        }
        case 10:
          listenWindow(w[i + 1], string(i + 2), w[i + 4]);
          i += 5;
          break;
        case 11: {
          const canvas = nodes.get(w[i + 1]);
          const count = w[i + 2];
          const f = new Float32Array(w.buffer, w.byteOffset, w.length);
          draw(canvas.getContext('2d'), w, f, i + 3, i + 3 + count, string);
          i += 3 + count;
          break;
        }
        case 12: {
          const name = string(i + 2);
          const image = new Image();
          const bytes = app.files.get(resolvePath(app.cwd, name));
          const type = imageTypes[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] || '';
          const url = bytes ? URL.createObjectURL(new Blob([bytes], { type })) : app.url(name);
          const id = w[i + 1];
          const tag = w[i + 4];
          const finished = () => {
            counted(tag, -1);
            if (bytes) URL.revokeObjectURL(url);
          };
          counted(tag, 1);
          image.onload = () => {
            finished();
            caller.event(IMAGE_LOADED, id, tag, 0);
          };
          image.onerror = () => {
            finished();
            console.error(`dom: cannot load the image ${name}`);
            caller.event(IMAGE_FAILED, id, tag, errors.missing, utf8.encode(`cannot load the image ${name}`));
          };
          image.src = url;
          images.set(w[i + 1], image);
          i += 5;
          break;
        }
        case 13: {
          const style = document.createElement('style');
          style.textContent = string(i + 1);
          root.ownerDocument.head.appendChild(style);
          i += 3;
          break;
        }
        case 14: {
          const node = known(w[i + 1]);
          const path = string(i + 2);
          const value = argument(i + 4);
          after.push(() => write(node, path, value));
          i += 7;
          break;
        }
        case 15: {
          const node = known(w[i + 1]);
          const path = string(i + 2);
          const args = [];
          for (let k = 0; k < w[i + 4]; k++) args.push(argument(i + 5 + 3 * k));
          after.push(() => call(node, path, args));
          i += 5 + 3 * w[i + 4];
          break;
        }
        case 16: {
          const node = known(w[i + 1]);
          const path = string(i + 2);
          const id = w[i + 4];
          const args = [];
          for (let k = 0; k < w[i + 5]; k++) args.push(argument(i + 6 + 3 * k));
          after.push(() => keep(id, path, call(node, path, args)));
          i += 6 + 3 * w[i + 5];
          break;
        }
        default:
          throw new Error(`dom.apply: no patch ${w[i]}`);
      }
    }
  }

  function apply(memory, ptr, length) {
    const after = [];
    patches(memory, ptr, length, after);
    for (const f of after) f();
  }

  const module = (theCaller, theApp) => {
    caller = theCaller;
    app = theApp;
    const given = (s, out) => caller.give(utf8.encode(s), out);
    return {
      source: SOURCE,
      apply(ptr, length) {
        apply(caller.memory(), caller.u(ptr), length);
      },
      read_number(node, ptr, length) {
        return numberOf(read(known(node), caller.string(ptr, length)));
      },
      read_text(node, ptr, length, out) {
        return given(textOf(read(known(node), caller.string(ptr, length))), out);
      },
      is(node, from, ptr, length) {
        return walk(known(from), caller.string(ptr, length)) === known(node) ? 1 : 0;
      },
      form_data(node, ptr, length, out) {
        const path = caller.string(ptr, length);
        const form = walk(known(node), path);
        const { HTMLFormElement } = root.ownerDocument.defaultView;
        if (!(form instanceof HTMLFormElement)) caller.trap(`dom: ${path} is not a form`);
        const e = event();
        const data = new FormData(form, e && e.submitter && e.submitter.form === form ? e.submitter : null);
        const lines = (s) => s.replace(/\r\n|\r|\n/g, '\r\n');
        const query = new URLSearchParams();
        for (const [name, value] of data) {
          query.append(lines(name), lines(typeof value === 'string' ? value : value.name));
        }
        return given(query.toString(), out);
      },
      images_loading(tag) {
        return loading.get(tag) || 0;
      },
    };
  };
  module.nodeOf = (id) => (nodes.has(id) ? nodeOf(id) : null);
  return module;
}
