// The simulated browser's document: the parts of the DOM that the web host and browser tests use. It parses and
// writes HTML by Chromium's rules, and its 2D canvas records what is drawn.
import { compileList, select } from './selectors.mjs';
import { drawn } from '../testing/logs.mjs';

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
const DOCUMENT = 9;
const FRAGMENT = 11;

const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const rawText = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const escapableRaw = new Set(['textarea', 'title']);
const formControls = new Set(['button', 'input', 'select', 'textarea']);

export const NodeFilter = { SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_COMMENT: 128 };

const now = () => (typeof performance === 'undefined' ? 0 : performance.now());

export class Event {
  constructor(type, init = {}) {
    const { bubbles = false, cancelable = false, ...rest } = init;
    Object.assign(this, rest);
    this.type = type;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.isTrusted = false;
    if (this.timeStamp === undefined) this.timeStamp = now();
    this.stopped = false;
    this.stoppedNow = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this.stopped = true;
  }

  stopImmediatePropagation() {
    this.stopped = true;
    this.stoppedNow = true;
  }
}

export class EventTarget {
  #listeners = new Map();

  addEventListener(type, listener, options) {
    if (!listener) return;
    const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
    const once = !!(options && typeof options === 'object' && options.once);
    const list = this.#listeners.get(type) || [];
    if (list.some((l) => l.listener === listener && l.capture === capture)) return;
    list.push({ listener, capture, once });
    this.#listeners.set(type, list);
  }

  removeEventListener(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
    const list = this.#listeners.get(type);
    if (!list) return;
    const k = list.findIndex((l) => l.listener === listener && l.capture === capture);
    if (k >= 0) list.splice(k, 1);
  }

  dispatchEvent(event) {
    const path = [];
    for (let n = this; n; n = eventParent(n)) path.push(n);
    event.target = this;
    event.eventPhase = 1;
    for (let k = path.length - 1; k > 0 && !event.stopped; k--) path[k].#invoke(event, true, false);
    event.eventPhase = 2;
    if (!event.stopped) this.#invoke(event, true, true);
    event.eventPhase = 3;
    if (event.bubbles) for (let k = 1; k < path.length && !event.stopped; k++) path[k].#invoke(event, false, true);
    event.eventPhase = 0;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }

  #invoke(event, capture, bubble) {
    event.currentTarget = this;
    const handler = this[`on${event.type}`];
    if (bubble && typeof handler === 'function') guard(this, () => handler.call(this, event));
    for (const l of [...(this.#listeners.get(event.type) || [])]) {
      if (event.stoppedNow) break;
      if (!(l.capture ? capture : bubble)) continue;
      if (l.once) this.removeEventListener(event.type, l.listener, l.capture);
      guard(this, () => (typeof l.listener === 'function' ? l.listener.call(this, event) : l.listener.handleEvent(event)));
    }
  }
}

const eventParent = (n) => (n instanceof Window ? null : n.nodeType === DOCUMENT ? n.defaultView : n.parentNode);

function guard(target, f) {
  try {
    f();
  } catch (e) {
    const doc = target instanceof Window ? target.document : target.ownerDocument || target;
    if (doc && doc.hooks) doc.hooks.error(e);
    else throw e;
  }
}

export class Node extends EventTarget {
  static ELEMENT_NODE = ELEMENT;
  static TEXT_NODE = TEXT;
  static COMMENT_NODE = COMMENT;
  static DOCUMENT_NODE = DOCUMENT;
  static DOCUMENT_FRAGMENT_NODE = FRAGMENT;

  constructor(document, type) {
    super();
    this.ownerDocument = document;
    this.nodeType = type;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get nextSibling() {
    const p = this.parentNode;
    return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null;
  }

  get previousSibling() {
    const p = this.parentNode;
    return p ? p.childNodes[p.childNodes.indexOf(this) - 1] || null : null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT ? this.parentNode : null;
  }

  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === DOCUMENT;
  }

  get textContent() {
    let s = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === TEXT) s += c.data;
        else if (c.nodeType === ELEMENT) walk(c);
      }
    };
    walk(this);
    return s;
  }

  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== null && v !== undefined && v !== '') this.appendChild(this.#doc().createTextNode(String(v)));
  }

  #doc() {
    return this.ownerDocument || this;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, ref) {
    if (ref && ref.parentNode !== this) throw new Error('NotFoundError: the node to insert before is not a child of this node');
    if (node === ref) return node;
    for (let n = this; n; n = n.parentNode) if (n === node) throw new Error('HierarchyRequestError: a node cannot contain itself');
    const nodes = node.nodeType === FRAGMENT ? [...node.childNodes] : [node];
    for (const n of nodes) n.remove();
    let at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    for (const n of nodes) {
      this.childNodes.splice(at++, 0, n);
      n.parentNode = this;
    }
    return node;
  }

  removeChild(node) {
    if (node.parentNode !== this) throw new Error('NotFoundError: the node is not a child of this node');
    node.remove();
    return node;
  }

  replaceChild(node, old) {
    this.insertBefore(node, old);
    return this.removeChild(old);
  }

  remove() {
    const p = this.parentNode;
    if (!p) return;
    const doc = this.ownerDocument;
    const focused = doc && doc.focused && this.contains(doc.focused);
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
    if (focused) doc.focused = null;
    if (doc && doc.pointerLockElement && this.contains(doc.pointerLockElement)) doc.exitPointerLock();
  }

  replaceWith(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    for (const n of nodes) p.insertBefore(typeof n === 'string' ? this.#doc().createTextNode(n) : n, this);
    this.remove();
  }

  before(...nodes) {
    const p = this.parentNode;
    if (p) for (const n of nodes) p.insertBefore(typeof n === 'string' ? this.#doc().createTextNode(n) : n, this);
  }

  after(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    const next = this.nextSibling;
    for (const n of nodes) p.insertBefore(typeof n === 'string' ? this.#doc().createTextNode(n) : n, next);
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.#doc().createTextNode(n) : n);
  }

  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) this.insertBefore(typeof n === 'string' ? this.#doc().createTextNode(n) : n, first);
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  cloneNode(deep = false) {
    const copy = this.shallowCopy();
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
    return copy;
  }

  querySelector(selector) {
    return select(this, selector)[0] || null;
  }

  querySelectorAll(selector) {
    return select(this, selector);
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get lastElementChild() {
    const c = this.children;
    return c[c.length - 1] || null;
  }
}

export class Text extends Node {
  constructor(document, data) {
    super(document, TEXT);
    this.data = String(data);
  }

  get nodeName() {
    return '#text';
  }

  get nodeValue() {
    return this.data;
  }

  set nodeValue(v) {
    this.data = String(v);
  }

  get textContent() {
    return this.data;
  }

  set textContent(v) {
    this.data = String(v);
  }

  get length() {
    return this.data.length;
  }

  shallowCopy() {
    return new Text(this.ownerDocument, this.data);
  }
}

export class Comment extends Node {
  constructor(document, data) {
    super(document, COMMENT);
    this.data = String(data);
  }

  get nodeName() {
    return '#comment';
  }

  get nodeValue() {
    return this.data;
  }

  get textContent() {
    return this.data;
  }

  set textContent(v) {
    this.data = String(v);
  }

  shallowCopy() {
    return new Comment(this.ownerDocument, this.data);
  }
}

export class DocumentFragment extends Node {
  constructor(document) {
    super(document, FRAGMENT);
  }

  get nodeName() {
    return '#document-fragment';
  }

  getElementById(id) {
    return this.querySelectorAll('*').find((e) => e.getAttribute('id') === id) || null;
  }

  shallowCopy() {
    return new DocumentFragment(this.ownerDocument);
  }
}

// An element's inline style, kept in its style attribute in the form Chromium writes.
function styleOf(element) {
  const read = () => {
    const map = new Map();
    for (const part of (element.getAttribute('style') || '').split(';')) {
      const k = part.indexOf(':');
      if (k > 0) map.set(part.slice(0, k).trim().toLowerCase(), part.slice(k + 1).trim());
    }
    return map;
  };
  const write = (map) => {
    if (map.size === 0) element.removeAttribute('style');
    else element.setAttribute('style', [...map].map(([k, v]) => `${k}: ${v};`).join(' '));
  };
  const css = (prop) => prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'cssText') return element.getAttribute('style') || '';
      if (prop === 'getPropertyValue') return (name) => read().get(name) || '';
      if (prop === 'setProperty') {
        return (name, value) => {
          const m = read();
          if (value === '' || value === null) m.delete(name);
          else m.set(name, String(value));
          write(m);
        };
      }
      if (prop === 'removeProperty') return (name) => { const m = read(); const v = m.get(name) || ''; m.delete(name); write(m); return v; };
      return typeof prop === 'string' ? read().get(css(prop)) || '' : undefined;
    },
    set(_, prop, value) {
      if (prop === 'cssText') {
        element.setAttribute('style', String(value));
        return true;
      }
      const m = read();
      if (value === '' || value === null || value === undefined) m.delete(css(prop));
      else m.set(css(prop), String(value));
      write(m);
      return true;
    },
  });
}

export const focusable = (e) => {
  if (formControls.has(e.localName) && e.hasAttribute('disabled')) return false;
  if (e.hasAttribute('tabindex')) return true;
  switch (e.localName) {
    case 'a':
    case 'area':
      return e.hasAttribute('href');
    case 'button':
    case 'select':
    case 'textarea':
    case 'iframe':
      return true;
    case 'input':
      return e.type !== 'hidden';
    default:
      return e.getAttribute('contenteditable') === '' || e.getAttribute('contenteditable') === 'true';
  }
};

const inputTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'range', 'checkbox', 'radio',
  'button', 'submit', 'reset', 'image', 'file', 'hidden', 'color', 'date', 'datetime-local', 'month', 'week', 'time']);

export class Element extends Node {
  constructor(document, name) {
    super(document, ELEMENT);
    this.localName = name;
    this.attrs = new Map();
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 0;
    this.scrollWidth = 0;
  }

  get tagName() {
    return this.localName.toUpperCase();
  }

  get nodeName() {
    return this.tagName;
  }

  getAttribute(name) {
    const v = this.attrs.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }

  setAttribute(name, value) {
    this.attrs.set(String(name).toLowerCase(), String(value));
    if (this.attributeChanged) this.attributeChanged(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attrs.delete(String(name).toLowerCase());
  }

  hasAttribute(name) {
    return this.attrs.has(String(name).toLowerCase());
  }

  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : !!force;
    if (on) {
      if (!this.hasAttribute(name)) this.setAttribute(name, '');
    } else this.removeAttribute(name);
    return on;
  }

  getAttributeNames() {
    return [...this.attrs.keys()];
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(v) {
    this.setAttribute('id', v);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(v) {
    this.setAttribute('class', v);
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => names().includes(c),
      add: (...cs) => this.setAttribute('class', [...new Set([...names(), ...cs])].join(' ')),
      remove: (...cs) => this.setAttribute('class', names().filter((n) => !cs.includes(n)).join(' ')),
      toggle: (c, force) => {
        const on = force === undefined ? !names().includes(c) : !!force;
        this.setAttribute('class', (on ? [...new Set([...names(), c])] : names().filter((n) => n !== c)).join(' '));
        return on;
      },
    };
  }

  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(v) {
    this.toggleAttribute('hidden', !!v);
  }

  get style() {
    return styleOf(this);
  }

  get innerHTML() {
    return serializeChildren(this.localName === 'template' ? this.content : this);
  }

  set innerHTML(html) {
    const target = this.localName === 'template' ? this.content : this;
    for (const c of target.childNodes) c.parentNode = null;
    target.childNodes = [];
    parseInto(String(html), target);
  }

  get outerHTML() {
    return serialize(this);
  }

  matches(selector) {
    return compileList(selector)(this);
  }

  closest(selector) {
    const test = compileList(selector);
    for (let n = this; n && n.nodeType === ELEMENT; n = n.parentNode) if (test(n)) return n;
    return null;
  }

  get previousElementSibling() {
    const list = this.parentNode ? this.parentNode.children : [];
    return list[list.indexOf(this) - 1] || null;
  }

  get nextElementSibling() {
    const list = this.parentNode ? this.parentNode.children : [];
    const k = list.indexOf(this);
    return k >= 0 ? list[k + 1] || null : null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  get type() {
    if (this.localName === 'input') {
      const t = (this.getAttribute('type') || '').toLowerCase();
      return inputTypes.has(t) ? t : 'text';
    }
    if (this.localName === 'button') {
      const t = (this.getAttribute('type') || '').toLowerCase();
      return t === 'button' || t === 'reset' ? t : 'submit';
    }
    return this.getAttribute('type') || '';
  }

  set type(v) {
    this.setAttribute('type', v);
  }

  get value() {
    switch (this.localName) {
      case 'input':
        if (this.dirtyValue !== undefined) return this.dirtyValue;
        if (this.hasAttribute('value')) return this.getAttribute('value');
        return this.type === 'checkbox' || this.type === 'radio' ? 'on' : '';
      case 'textarea':
        return this.dirtyValue !== undefined ? this.dirtyValue : this.textContent;
      case 'select': {
        const option = this.querySelectorAll('option').find((o) => o.selected);
        return option ? option.value : '';
      }
      case 'option':
        return this.hasAttribute('value') ? this.getAttribute('value') : this.textContent.replace(/\s+/g, ' ').trim();
      case 'button':
      case 'output':
        return this.getAttribute('value') || '';
      default:
        return this.expandoValue;
    }
  }

  set value(v) {
    const s = v === null || v === undefined ? '' : String(v);
    switch (this.localName) {
      case 'input':
      case 'textarea':
        this.dirtyValue = s;
        break;
      case 'select':
        for (const o of this.querySelectorAll('option')) o.selected = o.value === s;
        break;
      case 'option':
      case 'button':
        this.setAttribute('value', s);
        break;
      default:
        this.expandoValue = v;
    }
  }

  get selected() {
    if (this.dirtySelected !== undefined) return this.dirtySelected;
    if (this.hasAttribute('selected')) return true;
    const select = this.closest('select');
    if (!select || select.hasAttribute('multiple')) return false;
    const options = select.querySelectorAll('option');
    return !options.some((o) => o.dirtySelected === true || o.hasAttribute('selected')) && options[0] === this;
  }

  set selected(v) {
    this.dirtySelected = !!v;
  }

  get checked() {
    return this.dirtyChecked !== undefined ? this.dirtyChecked : this.hasAttribute('checked');
  }

  set checked(v) {
    this.dirtyChecked = !!v;
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(v) {
    this.toggleAttribute('disabled', !!v);
  }

  get maxLength() {
    const v = Number.parseInt(this.getAttribute('maxlength'), 10);
    return Number.isNaN(v) || v < 0 ? -1 : v;
  }

  get multiple() {
    return this.hasAttribute('multiple');
  }

  set multiple(v) {
    this.toggleAttribute('multiple', !!v);
  }

  get accept() {
    return this.getAttribute('accept') || '';
  }

  set accept(v) {
    this.setAttribute('accept', v);
  }

  get href() {
    return this.getAttribute('href') || '';
  }

  set href(v) {
    this.setAttribute('href', v);
  }

  get src() {
    return this.getAttribute('src') || '';
  }

  set src(v) {
    this.setAttribute('src', v);
  }

  get alt() {
    return this.getAttribute('alt') || '';
  }

  set alt(v) {
    this.setAttribute('alt', v);
  }

  attributeChanged(name) {
    if (this.localName === 'img' && name === 'src') {
      this.complete = false;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      if (this.ownerDocument) this.ownerDocument.hooks.loadImage(this);
    }
  }

  // Opens a file input's picker, which gives the files a test chose, or is cancelled when the test chose none.
  showPicker() {
    const doc = this.ownerDocument;
    if (!doc.userActive()) throw new Error("HTMLInputElement::showPicker() requires a user gesture.");
    doc.hooks.pick(this);
  }

  get download() {
    return this.getAttribute('download') || '';
  }

  set download(v) {
    this.setAttribute('download', v);
  }

  get width() {
    const v = Number.parseInt(this.getAttribute('width'), 10);
    return Number.isNaN(v) ? (this.localName === 'canvas' ? 300 : 0) : v;
  }

  set width(v) {
    this.setAttribute('width', v);
  }

  get height() {
    const v = Number.parseInt(this.getAttribute('height'), 10);
    return Number.isNaN(v) ? (this.localName === 'canvas' ? 150 : 0) : v;
  }

  set height(v) {
    this.setAttribute('height', v);
  }

  focus() {
    const doc = this.ownerDocument;
    if (doc && this.isConnected && focusable(this)) doc.moveFocus(this);
  }

  blur() {
    const doc = this.ownerDocument;
    if (doc && doc.focused === this) doc.moveFocus(null);
  }

  click() {
    const doc = this.ownerDocument;
    if (doc) doc.clickOn(this, { detail: 0 });
  }

  // Each call starts a new drawing, since dom.mjs calls it once per drawing.
  getContext(kind) {
    if (this.localName !== 'canvas') return null;
    if (kind === 'webgpu') return this.context ? null : (this.gpuContext ||= this.ownerDocument.hooks.webgpuContext(this));
    if (kind !== '2d' || this.gpuContext) return null;
    if (!this.context) this.context = new Context2d(this);
    this.context.begin();
    return this.context;
  }

  requestPointerLock() {
    const doc = this.ownerDocument;
    if (!doc || !this.isConnected || !doc.userActive()) {
      if (doc) doc.hooks.later(() => doc.dispatchEvent(new Event('pointerlockerror')));
      return Promise.reject(new Error('the pointer can be locked only on a user gesture'));
    }
    if (doc.pointerLockElement !== this) {
      doc.pointerLockElement = this;
      doc.hooks.later(() => doc.dispatchEvent(new Event('pointerlockchange')));
    }
    return Promise.resolve();
  }

  shallowCopy() {
    const copy = this.ownerDocument.createElement(this.localName);
    for (const [k, v] of this.attrs) copy.attrs.set(k, v);
    if (this.localName === 'template') for (const c of this.content.childNodes) copy.content.appendChild(c.cloneNode(true));
    if (this.dirtyValue !== undefined) copy.dirtyValue = this.dirtyValue;
    if (this.dirtyChecked !== undefined) copy.dirtyChecked = this.dirtyChecked;
    return copy;
  }
}

export class Template extends Element {
  constructor(document) {
    super(document, 'template');
    this.content = new DocumentFragment(document);
  }
}

class TreeWalker {
  constructor(root, what) {
    this.root = root;
    this.whatToShow = what;
    this.currentNode = root;
  }

  nextNode() {
    let n = this.currentNode;
    for (;;) {
      if (n.firstChild) n = n.firstChild;
      else {
        while (n !== this.root && !n.nextSibling) n = n.parentNode;
        if (n === this.root) return null;
        n = n.nextSibling;
      }
      if ((this.whatToShow & (1 << (n.nodeType - 1))) !== 0) {
        this.currentNode = n;
        return n;
      }
    }
  }
}

export class Document extends Node {
  constructor() {
    super(null, DOCUMENT);
    this.focused = null;
    this.pointerLockElement = null;
    this.defaultView = null;
    this.activated = -Infinity;
    this.hooks = {
      later: (f) => queueMicrotask(f),
      now: () => 0,
      download: () => {},
      pick: () => {},
      loadImage: () => {},
      webgpuContext: () => null,
      error: (e) => { throw e; },
    };
    const html = this.createElement('html');
    html.appendChild(this.createElement('head'));
    html.appendChild(this.createElement('body'));
    this.appendChild(html);
  }

  get nodeName() {
    return '#document';
  }

  get documentElement() {
    return this.childNodes.find((n) => n.nodeType === ELEMENT) || null;
  }

  get head() {
    return this.documentElement.children.find((e) => e.localName === 'head') || null;
  }

  get body() {
    return this.documentElement.children.find((e) => e.localName === 'body') || null;
  }

  get activeElement() {
    return this.focused && this.focused.isConnected ? this.focused : this.body;
  }

  createElement(name) {
    const n = String(name).toLowerCase();
    return n === 'template' ? new Template(this) : new Element(this, n);
  }

  createTextNode(data) {
    return new Text(this, data);
  }

  createComment(data) {
    return new Comment(this, data);
  }

  createDocumentFragment() {
    return new DocumentFragment(this);
  }

  createTreeWalker(root, what = NodeFilter.SHOW_ALL) {
    return new TreeWalker(root, what);
  }

  getElementById(id) {
    return this.querySelectorAll('*').find((e) => e.getAttribute('id') === id) || null;
  }

  // moveFocus gives element the focus, or takes the focus away when element is null, with the events a browser sends.
  moveFocus(element) {
    const old = this.focused && this.focused.isConnected ? this.focused : null;
    if (old === element) return;
    this.focused = element;
    if (old) {
      old.dispatchEvent(new Event('blur'));
      old.dispatchEvent(new Event('focusout', { bubbles: true }));
    }
    if (element) {
      element.dispatchEvent(new Event('focus'));
      element.dispatchEvent(new Event('focusin', { bubbles: true }));
    }
  }

  // Whether a click or key press happened in the last 5 seconds, which is how long Chromium's user activation lasts.
  userActive() {
    return this.hooks.now() - this.activated <= 5000;
  }

  exitPointerLock() {
    if (this.pointerLockElement === null) return;
    this.pointerLockElement = null;
    this.hooks.later(() => this.dispatchEvent(new Event('pointerlockchange')));
  }

  // clickOn sends a click to element and carries out what a click does: toggling a checkbox or radio button, clicking
  // a label's control, and downloading a link's file.
  clickOn(element, props = {}) {
    if (formControls.has(element.localName) && element.hasAttribute('disabled')) return;
    const box = element.localName === 'input' && (element.type === 'checkbox' || element.type === 'radio') ? element : null;
    const was = box ? box.checked : false;
    const group = box && box.type === 'radio' ? radioGroup(this, box) : [];
    const before = group.map((r) => r.checked);
    if (box) {
      if (box.type === 'checkbox') box.checked = !was;
      else {
        for (const r of group) r.checked = false;
        box.checked = true;
      }
    }
    const event = new Event('click', { bubbles: true, cancelable: true, button: 0, detail: 1, view: this.defaultView, ...props });
    const done = element.dispatchEvent(event);
    if (box) {
      if (!done) {
        box.checked = was;
        group.forEach((r, k) => { r.checked = before[k]; });
      } else if (box.checked !== was) {
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    if (!done) return;
    const label = element.closest('label');
    if (label) {
      const control = labelControl(this, label);
      if (control && control !== element && !control.contains(element)) this.clickOn(control, { detail: 0 });
      return;
    }
    const link = element.closest('a');
    if (link && link.hasAttribute('download') && link.hasAttribute('href')) this.hooks.download(link.download, link.href);
  }
}

const radioGroup = (doc, box) => {
  const name = box.getAttribute('name');
  if (!name) return [box];
  const scope = box.closest('form') || doc;
  return scope.querySelectorAll('input').filter((r) => r.type === 'radio' && r.getAttribute('name') === name);
};

export function labelControl(doc, label) {
  const target = label.getAttribute('for');
  if (target !== null) return doc.getElementById(target);
  return label.querySelectorAll('button, input, select, textarea').find((e) => e.type !== 'hidden') || null;
}

export class Window extends EventTarget {
  constructor(document) {
    super();
    this.document = document;
    document.defaultView = this;
    this.innerWidth = 1000;
    this.innerHeight = 700;
    this.devicePixelRatio = 1;
  }

  get window() {
    return this;
  }

  get self() {
    return this;
  }
}

const entities = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×',
  middot: '·', laquo: '«', raquo: '»', bull: '•', deg: '°', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓',
};

const decode = (s) => s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, r) => {
  if (r[0] === '#') {
    const n = r[1] === 'x' || r[1] === 'X' ? Number.parseInt(r.slice(2), 16) : Number.parseInt(r.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�';
  }
  return Object.hasOwn(entities, r) ? entities[r] : m;
});

// parseInto parses html as Chromium parses an element's contents, adding the nodes to parent.
export function parseInto(given, parent) {
  const html = given.replace(/\r\n?/g, '\n');
  const doc = parent.nodeType === DOCUMENT ? parent : parent.ownerDocument;
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const into = (n) => (n.localName === 'template' ? n.content : n);
  const text = (s) => {
    if (s === '') return;
    const c = into(top());
    const last = c.lastChild;
    if (last && last.nodeType === TEXT) last.data += s;
    else c.appendChild(doc.createTextNode(s));
  };
  const open = (name) => {
    const e = doc.createElement(name);
    into(top()).appendChild(e);
    stack.push(e);
  };
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text(decode(html.slice(i)));
      break;
    }
    if (lt > i) text(decode(html.slice(i, lt)));
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      into(top()).appendChild(doc.createComment(html.slice(i + 4, end < 0 ? n : end)));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html[i + 1] === '/') {
      const m = /^<\/([A-Za-z][^\s/>]*)[^>]*>?/.exec(html.slice(i, i + 200));
      if (!m) {
        text('<');
        i++;
        continue;
      }
      i += m[0].length;
      const name = m[1].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].localName === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const m = /^<([A-Za-z][^\s/>]*)/.exec(html.slice(i, i + 200));
    if (!m) {
      text('<');
      i++;
      continue;
    }
    i += m[0].length;
    const name = m[1].toLowerCase();
    const attrs = [];
    for (;;) {
      while (i < n && /[\s/]/.test(html[i])) i++;
      if (i >= n || html[i] === '>') {
        i++;
        break;
      }
      const am = /^[^\s/>=][^\s/>=]*/.exec(html.slice(i, i + 200));
      if (!am) {
        i++;
        continue;
      }
      i += am[0].length;
      let value = '';
      let j = i;
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] === '=') {
        i = j + 1;
        while (i < n && /\s/.test(html[i])) i++;
        if (html[i] === '"' || html[i] === "'") {
          const end = html.indexOf(html[i], i + 1);
          value = html.slice(i + 1, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
        } else {
          value = /^[^\s>]*/.exec(html.slice(i))[0];
          i += value.length;
        }
        value = decode(value);
      }
      const attr = am[0].toLowerCase();
      if (!attrs.some(([k]) => k === attr)) attrs.push([attr, value]);
    }
    const under = top().localName;
    if (name === 'tr' && under === 'table') open('tbody');
    if ((name === 'td' || name === 'th') && under === 'table') {
      open('tbody');
      open('tr');
    }
    if ((name === 'td' || name === 'th') && (under === 'tbody' || under === 'thead' || under === 'tfoot')) open('tr');
    const e = doc.createElement(name);
    for (const [k, v] of attrs) e.setAttribute(k, v);
    into(top()).appendChild(e);
    if (voids.has(name)) continue;
    if (rawText.has(name) || escapableRaw.has(name)) {
      const rest = html.slice(i);
      const close = new RegExp(`</${name}(?=[\\s/>]|$)`, 'i').exec(rest);
      let body = close ? rest.slice(0, close.index) : rest;
      i += close ? close.index : rest.length;
      if (close) {
        const gt = html.indexOf('>', i);
        i = gt < 0 ? n : gt + 1;
      }
      if (name === 'textarea' && body.startsWith('\n')) body = body.slice(1);
      if (body !== '') e.appendChild(doc.createTextNode(escapableRaw.has(name) ? decode(body) : body));
      continue;
    }
    stack.push(e);
    if ((name === 'pre' || name === 'listing') && html[i] === '\n') i++;
  }
}

const escapeText = (s) => s.replace(/[&<> ]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', ' ': '&nbsp;' })[c]);
const escapeAttribute = (s) => s.replace(/[&"<> ]/g,
  (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', ' ': '&nbsp;' })[c]);

export function serialize(node) {
  switch (node.nodeType) {
    case ELEMENT: {
      let s = `<${node.localName}`;
      for (const [k, v] of node.attrs) s += ` ${k}="${escapeAttribute(v)}"`;
      s += '>';
      if (voids.has(node.localName)) return s;
      return `${s}${serializeChildren(node.localName === 'template' ? node.content : node)}</${node.localName}>`;
    }
    case TEXT:
      return node.parentNode && rawText.has(node.parentNode.localName) ? node.data : escapeText(node.data);
    case COMMENT:
      return `<!--${node.data}-->`;
    default:
      return serializeChildren(node);
  }
}

const serializeChildren = (node) => node.childNodes.map(serialize).join('');

// A 2D context that records each drawing as one line per call or setting, which is what browser-drawing gives.
export class Context2d {
  constructor(canvas) {
    this.canvas = canvas;
    this.drawings = 0;
    this.commands = [];
    this.settings = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, font: '10px sans-serif',
      textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1 };
  }

  begin() {
    this.drawings++;
    this.commands = [];
  }

  say(name, args) {
    const line = drawn(name, args, (image) => image.recordedName || (image.getAttribute ? image.getAttribute('src') : '') || '');
    if (line !== null) this.commands.push(line);
  }

  get fillStyle() { return this.settings.fillStyle; }

  set fillStyle(v) { this.settings.fillStyle = v; this.say('fillStyle', [v]); }

  get strokeStyle() { return this.settings.strokeStyle; }

  set strokeStyle(v) { this.settings.strokeStyle = v; this.say('strokeStyle', [v]); }

  get lineWidth() { return this.settings.lineWidth; }

  set lineWidth(v) { this.settings.lineWidth = v; this.say('lineWidth', [v]); }

  get font() { return this.settings.font; }

  set font(v) { this.settings.font = v; this.say('font', [v]); }

  get textAlign() { return this.settings.textAlign; }

  set textAlign(v) { this.settings.textAlign = v; this.say('textAlign', [v]); }

  get textBaseline() { return this.settings.textBaseline; }

  set textBaseline(v) { this.settings.textBaseline = v; this.say('textBaseline', [v]); }

  get globalAlpha() { return this.settings.globalAlpha; }

  set globalAlpha(v) { this.settings.globalAlpha = v; this.say('globalAlpha', [v]); }

  clearRect(...a) { this.say('clearRect', a); }

  fillRect(...a) { this.say('fillRect', a); }

  strokeRect(...a) { this.say('strokeRect', a); }

  moveTo(...a) { this.say('moveTo', a); }

  lineTo(...a) { this.say('lineTo', a); }

  arc(...a) { this.say('arc', a); }

  fillText(...a) { this.say('fillText', a); }

  translate(...a) { this.say('translate', a); }

  rotate(...a) { this.say('rotate', a); }

  scale(...a) { this.say('scale', a); }

  drawImage(...a) { this.say('drawImage', a); }

  beginPath() { this.say('beginPath', []); }

  closePath() { this.say('closePath', []); }

  fill() { this.say('fill', []); }

  stroke() { this.say('stroke', []); }

  save() { this.say('save', []); }

  restore() { this.say('restore', []); }

  measureText(s) { return { width: String(s).length * 8 }; }

  getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
}
