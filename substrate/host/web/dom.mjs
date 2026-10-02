// Lifecycle: experimental. The host module dom: a page's document, for a
// program whose views write patches (next/web/ui.sub, which says what
// each patch is; next/web/web.sub is what imports this). A program does
// not reach the document itself: it gives the host a batch of patches to
// apply, and the host gives it the events its listeners are for.
//
//   boot({ ..., modules: { dom: dom(root) } })
//
// root is the element the program's nodes go in, its node 0. The module's
// imports, as the others' (spec 4), take pointers into the caller's memory:
//
//   apply (ptr len)               apply the batch: len bytes of patches,
//                                 32-bit words
//   event_value (buf cap) -> len  while a listener's event is handled, the
//                                 value of the element it came from, such
//                                 as a text field's text: at most cap
//                                 bytes of it copied to buf; its length
//   event_key (buf cap) -> len    the key of a keyboard event, as its name,
//                                 such as "Enter" or "a"
//   event_flags () -> i32         what is so of it, as bits: the keys held
//                                 with it, 1 shift, 2 control, 4 alt, 8
//                                 meta; and 16, the element it came from
//                                 is checked, as a checkbox is
//   prevent_default ()            the event does not do what it would
//
// A listener gives its event to the program by calling the entry's
// on-event with the number the listener was made with (patch 9), while
// the event is being dispatched: so the program handles it, and may stop
// what it would do, before anything else happens in the page.
const text = new TextDecoder();
const utf8 = new TextEncoder();

export function dom(root) {
  // Each template, by number: its content, and the path to each of its
  // marked nodes, the indexes of the children that lead to it.
  const templates = new Map();
  // Each node, by number; a copy is { start, end }, its first and last
  // nodes, between which are the rest and those of the copies in it.
  const nodes = new Map([[0, root]]);
  // The event being handled.
  let event = null;
  let app = null;
  // Whether a batch's patches are being applied, and the events that came
  // meanwhile, each with the node it reached: the program is given those
  // once the batch is applied, since it handles an event by writing
  // another batch.
  let applying = false;
  const waiting = [];

  // The program is given event e, for the listener numbered message.
  const give = (e, message) => {
    const outer = event;
    event = e;
    try {
      app.call('on-event', message);
    } finally {
      event = outer;
    }
  };

  // A listener's number is the address of its message in the program's
  // memory, which lasts as long as its node's number does: a node whose
  // number is free has no listeners (unlisten), so an event that reaches
  // a node the program has let go of, as one can a node that is out of
  // the page, is not given to the program.
  const listener = (e) => {
    if (applying) waiting.push([e, e.currentTarget]);
    else heard(e, e.currentTarget);
  };

  // Event e reached node: the program is given it, if node has a listener
  // for it still.
  const heard = (e, node) => {
    const messages = node.subListeners;
    if (messages && e.type in messages) give(e, messages[e.type]);
  };

  const unlisten = (id) => {
    const n = nodes.get(id);
    if (n instanceof Node && n.subListeners) n.subListeners = null;
  };

  // The template of html: its marked nodes are found once, here.
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
    // A copy's first node is its own, and stays its first: what goes
    // before an anchor that starts it goes after this.
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

  // The node a number names, a copy's being its first.
  const nodeOf = (id) => {
    const n = nodes.get(id);
    return n instanceof Node ? n : n.start;
  };

  // nodes put in parent before before, or last if that is 0.
  function place(what, parent, before) {
    if (before) {
      const next = nodeOf(before);
      next.parentNode.insertBefore(what, next);
    } else {
      nodeOf(parent).appendChild(what);
    }
  }

  // A copy's nodes, from its first to its last, taken out of the page, as
  // a fragment.
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
    // What a field shows is its value, which its attribute only starts.
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

  // The patches of a batch, len bytes at ptr, applied in order; what is to
  // be done once they all are is added to after.
  function patches(memory, ptr, length, after) {
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
          // falls through: its numbers are free
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

  // A batch applied. An event that comes while its patches are waits
  // until they all are, since the program would handle it by writing
  // patches where this batch's are. What the batch's effects cause, as
  // giving an element the focus does, comes after, and is handled at
  // once: the program has let the batch go by then (web.sub, flush!).
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

  return (caller, theApp) => {
    app = theApp;
    // s, as much of it as cap bytes hold, copied to buf: its length.
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
