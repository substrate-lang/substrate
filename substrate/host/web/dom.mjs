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
//       event came from is a ticked checkbox.
//   prevent_default ()
//       Cancels the browser's default action for the event being handled.
//
// How events reach the program: a "listen" patch (number 9) attaches a
// listener to a node, with a number chosen by the program. When the event
// fires, this module calls the program's exported function `on-event`
// with that number. The call happens inside the browser's event dispatch,
// so the program can still call prevent_default.
const text = new TextDecoder();
const utf8 = new TextEncoder();

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
  // The DOM event that the program is handling right now, or null.
  let event = null;
  let app = null;
  // `applying` is true while a batch of patches is being applied. A DOM
  // event that fires during that time must not be passed to the program
  // straight away: the program would answer by writing new patches into
  // the buffer that is being read. Such events are queued in `waiting`,
  // each with the node it fired on, and delivered when the batch is done.
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
    if (applying) waiting.push([e, e.currentTarget]);
    else heard(e, e.currentTarget);
  };

  // Delivers the event e, which fired on `node`, if the node still has a
  // listener for that type of event.
  const heard = (e, node) => {
    const messages = node.subListeners;
    if (messages && e.type in messages) give(e, messages[e.type]);
  };

  // Forgets the listeners of the node numbered `id`. Called when the
  // number is freed.
  const unlisten = (id) => {
    const n = nodes.get(id);
    if (n instanceof Node && n.subListeners) n.subListeners = null;
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
    while (waiting.length > 0) heard(...waiting.shift());
  }

  // The functions the program imports. `caller` gives access to the
  // memory of the instance that calls them; `theApp` is the running
  // program.
  return (caller, theApp) => {
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
          (event.target && event.target.checked === true ? 16 : 0);
      },
      prevent_default() {
        if (event) event.preventDefault();
      },
    };
  };
}
