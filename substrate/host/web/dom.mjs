// Lifecycle: experimental.
//
// The host module "dom": the connection between a program and a web page.
//
// A program does not manipulate the page itself. Its views
// (next/web/ui.sub) produce "patches": small binary instructions such as
// "make a copy of template 3" or "set the text of node 17". The program
// hands a batch of patches to this module, which applies them to the real
// DOM. In the other direction, when a DOM event fires that the program
// asked to hear about, this module calls the program.
//
// ui.sub documents the patch format and how nodes are numbered.
// next/web/web.sub is the program-side code that imports this module.
//
// Usage, in the page:
//
//   import { dom } from './dom.mjs';
//   boot({ ..., modules: { dom: dom(rootElement) } })
//
// `rootElement` is the element that the program draws into. The program
// knows it as node 0.
//
// dom() returns the module function with one extra property, for other
// host modules that the page gives a node of the program's:
//
//   nodeOf(number)   the DOM node the program calls by that number, or
//                    null. The "gpu" module (gpu.mjs) draws on a canvas
//                    named this way.
//
// What a program can call (pointers are addresses in its memory):
//
//   apply (ptr, len)
//       Applies a batch of patches: `len` bytes of 32-bit words.
//   event_value (buf, cap) -> len
//   event_key (buf, cap) -> len
//       Only meaningful while the program is handling an event.
//       event_value gives the value of the element the event came from,
//       for example the text in a text field. event_key gives the name of
//       the key of a keyboard event, such as "Enter" or "a". Each copies
//       at most `cap` bytes to `buf` and returns the full length.
//   event_flags () -> i32
//       Yes/no facts about the event being handled, as bits: 1 = Shift
//       was held, 2 = Control, 4 = Alt, 8 = Meta, 16 = the element the
//       event came from is a ticked checkbox, 32 = the pointer is locked
//       (see patch 15).
//   event_number (which) -> f64
//       A number about the event being handled. which = 0: when the
//       event happened, in milliseconds. which = 1 and 2: the x and y
//       position of the mouse, in pixels from the top left corner of
//       the element the event came from. which = 3 and 4: how far the
//       mouse moved since the last mouse event, in pixels. which = 5:
//       the mouse button (0 left, 1 middle, 2 right).
//   images_loading () -> i32
//       How many images are still being loaded (see patch 14, below).
//   prevent_default ()
//       Cancels the browser's default action for the event being handled.
//
// How events reach the program: a "listen" patch (number 9) attaches a
// listener to a node, with a number chosen by the program. When the event
// fires, this module calls the program's exported function `on-event`
// with that number. The call happens inside the browser's event dispatch,
// so the program can still call prevent_default.
//
// A "listen-window" patch (number 12) is the same, except that the
// listener is attached to the browser window. It is used for events that
// do not belong to one element, such as a key pressed anywhere on the
// page. Its event name "frame" is special: it is not a DOM event, and
// asks for a call on every animation frame (requestAnimationFrame). The
// events pointerlockchange and pointerlockerror are listened for on the
// document, where they fire without bubbling.
//
// A "draw" patch (number 13) draws on a canvas element. It carries a
// list of drawing commands, which next/web/canvas.sub documents, and
// which `draw` below carries out on the canvas's 2D context.
//
// An "image" patch (number 14) starts loading an image file and gives it
// a number. The patch names the image by a path, such as
// "assets/sprites.png". If that is one of the program's files (the page
// usually downloads a program's assets for it before it starts: see
// next/web/site.sh), the image is made from the file's bytes, so it is
// not downloaded a second time. Otherwise the path is taken as a URL and
// fetched. A drawing command can then draw the image, or one cell of it
// if the image is a sheet of sprites. Loading takes time: until an image
// is ready, drawing it does nothing, and images_loading says how many
// are still on their way.
//
// A "pointer-lock" patch (number 15) asks the browser to lock the
// pointer to an element, or releases it. While the pointer is locked
// the cursor is hidden and mouse events report movement without limits,
// which a game that looks around with the mouse needs. Browsers only
// grant the lock while the user is clicking or typing; the patch is
// applied right after the batch it is in, so a program that asks in
// response to a click is in time. The request can fail (the browser
// then fires pointerlockerror), and the user can end the lock with
// Escape; pointerlockchange reports both, as a window event.
import { resolvePath } from './subhost-web.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

// The media type of an image file, from the end of its name. The browser
// needs it to decode an image that is given to it as bytes.
const imageTypes = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};

export function dom(root) {
  // The templates defined so far, by number. Each is { content, paths }:
  // the parsed HTML (a DocumentFragment), and, for each marked node, the
  // path to it from the top of the fragment, as a list of child indexes.
  // The paths let the marked nodes of a fresh clone be found quickly.
  const templates = new Map();
  // What each node number refers to. The number of a marked node maps to
  // the DOM node. The number of a copy maps to { start, end }: the first
  // and last of the copy's top-level nodes. A copy's nodes are consecutive
  // siblings, so `start` and `end` identify all of them, including the
  // nodes of any copies nested inside it.
  const nodes = new Map([[0, root]]);
  // The images that "image" patches have asked for, by number, and how
  // many of them are still loading.
  const images = new Map();
  let loading = 0;
  // The DOM event that the program is handling right now, or null.
  let event = null;
  let app = null;
  // `applying` is true while a batch of patches is being applied. A DOM
  // event that fires during that time must not be passed to the program
  // straight away: the program would answer by writing new patches into
  // the buffer that is being read. Such events are queued in `waiting`,
  // as functions that deliver them, and are delivered when the batch is
  // done.
  let applying = false;
  const waiting = [];

  // Calls the program's on-event for the DOM event e. `message` is the
  // number that the listen patch gave the listener.
  const give = (e, message) => {
    const outer = event;
    event = e;
    try {
      app.call('on-event', message);
    } finally {
      event = outer;
    }
  };

  // The one DOM event handler that every listener uses.
  //
  // The number that the program gives a listener is really an address in
  // the program's memory, and that memory is freed when the node's number
  // is freed. So an event must never be delivered for a node whose number
  // has been freed. This can otherwise happen: a script can fire an event
  // on a node that was removed from the page but is still referenced. To
  // prevent it, `unlisten` clears a node's listener table when its number
  // is freed, and `heard` looks in the table when it delivers an event.
  const listener = (e) => {
    // currentTarget is only set while the event is being dispatched, so
    // it is read now.
    const node = e.currentTarget;
    if (applying) waiting.push(() => heard(e, node));
    else heard(e, node);
  };

  // Delivers the event e, which fired on `node`, if the node still has a
  // listener for that type of event.
  const heard = (e, node) => {
    const messages = node.subListeners;
    if (messages && e.type in messages) give(e, messages[e.type]);
  };

  // The listeners that "listen-window" patches attached to the window.
  // A window listener belongs to a node number: it is removed when that
  // number is freed. `windowListeners` maps a node number to a list of
  // { type, handler }.
  const windowListeners = new Map();

  // The listeners for the pseudo-event "frame": a Map from a node number
  // to the listener's number. While it is not empty, `frame` runs on
  // every animation frame and calls the program once per listener.
  // `frameRequest` is the pending requestAnimationFrame, or 0.
  const frames = new Map();
  let frameRequest = 0;

  function frame(time) {
    frameRequest = 0;
    // A listener can be removed while the frame is being handled (the
    // program may unmount its element), so check before each call.
    for (const [id, message] of [...frames]) {
      if (frames.get(id) === message) give({ type: 'frame', timeStamp: time }, message);
    }
    if (frames.size > 0 && !frameRequest) frameRequest = requestAnimationFrame(frame);
  }

  // Attaches a window listener that belongs to the node numbered `id`.
  function listenWindow(id, type, message) {
    if (type === 'frame') {
      frames.set(id, message);
      if (!frameRequest) frameRequest = requestAnimationFrame(frame);
      return;
    }
    const entry = { type, handler: null };
    // The listener may be removed before a held-back event is delivered,
    // so the delivery checks that it is still there.
    const deliver = (e) => {
      const list = windowListeners.get(id);
      if (list && list.includes(entry)) give(e, message);
    };
    entry.handler = (e) => {
      if (applying) waiting.push(() => deliver(e));
      else deliver(e);
    };
    windowTarget(type).addEventListener(type, entry.handler);
    if (!windowListeners.has(id)) windowListeners.set(id, []);
    windowListeners.get(id).push(entry);
  }

  // Where a window listener is attached. The pointer lock's events fire
  // on the document and do not bubble, so they are listened for there.
  const windowTarget = (type) => (type === 'pointerlockchange' || type === 'pointerlockerror' ? document : window);

  // Forgets the listeners of the node numbered `id`, including its window
  // and frame listeners. Called when the number is freed.
  const unlisten = (id) => {
    const n = nodes.get(id);
    if (n instanceof Node && n.subListeners) n.subListeners = null;
    for (const { type, handler } of windowListeners.get(id) || []) windowTarget(type).removeEventListener(type, handler);
    windowListeners.delete(id);
    frames.delete(id);
  };

  // Parses a template's HTML and finds its marked nodes (ui.sub explains
  // the marks): <!--t--> comments, each replaced by an empty text node;
  // <!--a--> comments, which stay, as anchors; and elements with the
  // attribute data-n, which is removed.
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
    // A copy is known by its first and last nodes, so its first node must
    // stay first. If the template began with an anchor, the nodes that are
    // later inserted before that anchor would land in front of the copy's
    // first node. An empty text node placed in front prevents this. An
    // empty template gets one too, so that every copy has a node.
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

  // Returns the DOM node for a number. For a copy, that is its first node.
  const nodeOf = (id) => {
    const n = nodes.get(id);
    return n instanceof Node ? n : n.start;
  };

  // Inserts `what` (a node or a fragment) before the node numbered
  // `before`; or, if `before` is 0, at the end of the node numbered
  // `parent`.
  function place(what, parent, before) {
    if (before) {
      const next = nodeOf(before);
      next.parentNode.insertBefore(what, next);
    } else {
      nodeOf(parent).appendChild(what);
    }
  }

  // Detaches all of a copy's nodes, from its first to its last, from the
  // page, and returns them in a DocumentFragment.
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

  // Sets an attribute. `value` and `checked` are special. For a form
  // control, the attribute only gives the initial state; what the control
  // shows is a property. So `value` sets the value property instead of
  // the attribute, and `checked` sets the checked property as well.
  function setAttribute(node, name, value) {
    if (name === 'value') {
      if (node.value !== value) node.value = value;
    } else {
      if (name === 'checked') node.checked = true;
      node.setAttribute(name, value);
    }
  }

  // Removes an attribute, with the same two special cases.
  function removeAttribute(node, name) {
    if (name === 'value') node.value = '';
    else {
      if (name === 'checked') node.checked = false;
      node.removeAttribute(name);
    }
  }

  // Carries out the drawing commands of a "draw" patch on a canvas's 2D
  // context. The commands are the words w[i] up to w[end]. `f` views the
  // same words as 32-bit floats, which is how numbers are stored, and
  // `string(at)` reads a text operand (an address and a length, two
  // words). next/web/canvas.sub lists the commands and their numbers.
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
          // draw-sprite: image, frame, flags, cell width, cell height, x, y.
          // The image is a grid of equal cells, numbered from 0, left to
          // right and then top to bottom. Flag 1 mirrors the cell.
          const image = images.get(w[i + 1]);
          if (image && image.complete && image.naturalWidth > 0) {
            const cw = f[i + 4];
            const ch = f[i + 5];
            const columns = Math.max(1, Math.floor(image.naturalWidth / cw));
            const sx = (w[i + 2] % columns) * cw;
            const sy = Math.floor(w[i + 2] / columns) * ch;
            if (w[i + 3] & 1) {
              // Mirror by flipping the x axis around the cell's right edge.
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

  // Applies the patches of one batch: `length` bytes at `ptr` in the
  // program's memory. ui.sub lists the patches.
  //
  // Patches 10 (focus) and 11 (scroll to the end) are not carried out
  // here. They are added to the list `after`, which `apply` runs when the
  // whole batch has been applied. Focusing an element fires events, which
  // the program should only receive once the batch is done; and scrolling
  // to the end needs the element's final content.
  function patches(memory, ptr, length, after) {
    // View the batch as 32-bit words. A Uint32Array must start at a
    // multiple of 4, so a batch at any other address is copied first.
    const w = ptr % 4 === 0
      ? new Uint32Array(memory.buffer, memory.byteOffset + ptr, length >>> 2)
      : new Uint32Array(memory.slice(ptr, ptr + length).buffer);
    const string = (at) => text.decode(memory.subarray(w[at], w[at] + w[at + 1]));
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
          nodes.set(first, { start: copy.firstChild, end: copy.lastChild });
          place(copy, w[i + 4], w[i + 5]);
          i += 6;
          break;
        }
        case 3:
          taken(nodes.get(w[i + 1]));
          // No break here: removing a copy also frees its numbers, which is
          // what patch 4 does.
        case 4:
          for (let id = w[i + 1]; id <= w[i + 1] + w[i + 2]; id++) {
            unlisten(id);
            nodes.delete(id);
          }
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
          node.addEventListener(type, listener);
          i += 5;
          break;
        }
        case 10: {
          const node = nodes.get(w[i + 1]);
          after.push(() => node.focus());
          i += 2;
          break;
        }
        case 11: {
          const node = nodes.get(w[i + 1]);
          after.push(() => { node.scrollTop = node.scrollHeight; });
          i += 2;
          break;
        }
        case 12:
          listenWindow(w[i + 1], string(i + 2), w[i + 4]);
          i += 5;
          break;
        case 15: {
          const node = nodes.get(w[i + 1]);
          if (w[i + 2] !== 0) {
            // The failure is reported by the pointerlockerror event; the
            // promise that newer browsers return must not be left to fail
            // on its own.
            after.push(() => { const p = node.requestPointerLock(); if (p && p.catch) p.catch(() => {}); });
          } else {
            after.push(() => document.exitPointerLock());
          }
          i += 3;
          break;
        }
        case 14: {
          const name = string(i + 2);
          const image = new Image();
          // A file the program already has is loaded from its bytes,
          // through a temporary "blob" URL that stands for them. Anything
          // else is fetched as a URL.
          const bytes = app.files.get(resolvePath(app.cwd, name));
          const type = imageTypes[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] || '';
          const url = bytes ? URL.createObjectURL(new Blob([bytes], { type })) : name;
          const finished = () => {
            loading--;
            if (bytes) URL.revokeObjectURL(url);
          };
          loading++;
          image.onload = finished;
          image.onerror = () => {
            finished();
            console.error(`dom: cannot load the image ${name}`);
          };
          image.src = url;
          images.set(w[i + 1], image);
          i += 4;
          break;
        }
        case 13: {
          const canvas = nodes.get(w[i + 1]);
          const count = w[i + 2];
          // Numbers in drawing commands are 32-bit floats, in the same
          // words.
          const f = new Float32Array(w.buffer, w.byteOffset, w.length);
          draw(canvas.getContext('2d'), w, f, i + 3, i + 3 + count, string);
          i += 3 + count;
          break;
        }
        default:
          throw new Error(`dom.apply: no patch ${w[i]}`);
      }
    }
  }

  // Applies a batch, then delivers the events that were held back.
  //   1. Apply every patch. Events that fire meanwhile are queued (see
  //      `applying`).
  //   2. Run the deferred effects (focus, scroll). Events that these fire
  //      are delivered at once. That is safe: the program emptied its
  //      patch buffer before calling apply (flush! in web.sub), so it can
  //      write and apply a new batch from inside the event.
  //   3. Deliver the queued events.
  function apply(memory, ptr, length) {
    const after = [];
    applying = true;
    try {
      patches(memory, ptr, length, after);
    } finally {
      applying = false;
    }
    for (const f of after) f();
    while (waiting.length > 0) waiting.shift()();
  }

  // The functions the program imports. `caller` gives access to the
  // memory of the instance that calls them; `theApp` is the running
  // program.
  const module = (caller, theApp) => {
    app = theApp;
    // Copies the string s, as UTF-8, into the program's memory at `buf`,
    // at most `cap` bytes. Returns the full length in bytes.
    const copied = (s, buf, cap) => {
      const bytes = utf8.encode(s);
      caller.memory().set(bytes.subarray(0, cap), buf);
      return bytes.length;
    };
    return {
      apply(ptr, length) {
        apply(caller.memory(), ptr, length);
      },
      event_value(buf, cap) {
        const target = event && event.target;
        return copied(target && typeof target.value === 'string' ? target.value : '', buf, cap);
      },
      event_key(buf, cap) {
        return copied(event && typeof event.key === 'string' ? event.key : '', buf, cap);
      },
      event_flags() {
        if (!event) return 0;
        return (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0) |
          (event.target && event.target.checked === true ? 16 : 0) | (document.pointerLockElement ? 32 : 0);
      },
      event_number(which) {
        if (!event) return 0;
        switch (which) {
          case 0: return event.timeStamp || 0;
          case 1: return event.offsetX || 0;
          case 2: return event.offsetY || 0;
          case 3: return event.movementX || 0;
          case 4: return event.movementY || 0;
          case 5: return event.button || 0;
          default: return 0;
        }
      },
      images_loading() {
        return loading;
      },
      prevent_default() {
        if (event && event.preventDefault) event.preventDefault();
      },
    };
  };
  module.nodeOf = (id) => (nodes.has(id) ? nodeOf(id) : null);
  return module;
}
