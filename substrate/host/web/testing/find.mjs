// Finds the elements that browser tests' finders describe (std/test/browser.sub), in both browsers.

const arity = { css: 1, text: 1, 'text-containing': 1, role: 2, label: 1, 'test-id': 1 };

// parse reads the finder that starts at fields[k], and gives it with the index of the field after it.
export function parse(fields, k) {
  const kind = fields[k];
  if (kind === 'within') {
    const [outer, a] = parse(fields, k + 1);
    const [inner, b] = parse(fields, a);
    return [{ kind, outer, inner }, b];
  }
  if (kind === 'nth') {
    const [of, a] = parse(fields, k + 1);
    return [{ kind, of, n: Number(fields[a]) }, a + 1];
  }
  const n = arity[kind];
  if (n === undefined || k + n >= fields.length) throw new Error(`a finder is cut short or unknown: ${JSON.stringify(fields.slice(k))}`);
  return [{ kind, args: fields.slice(k + 1, k + 1 + n) }, k + 1 + n];
}

export function describe(f) {
  if (f.kind === 'within') return `(within ${describe(f.outer)} ${describe(f.inner)})`;
  if (f.kind === 'nth') return `(nth ${describe(f.of)} ${f.n})`;
  return `(by-${f.kind} ${f.args.map((a) => JSON.stringify(a)).join(' ')})`;
}

const normal = (s) => s.replace(/\s+/g, ' ').trim();
const unseen = new Set(['script', 'style', 'template', 'head', 'title', 'meta', 'link', 'base', 'noscript']);

const hidden = (e) => {
  for (let n = e; n && n.nodeType === 1; n = n.parentNode) {
    if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') return true;
    if (/(^|;)\s*display\s*:\s*none/.test(n.getAttribute('style') || '')) return true;
    if (n.localName === 'input' && n.type === 'hidden') return true;
  }
  return false;
};

const shown = (scope) => [...scope.querySelectorAll('*')].filter((e) => !unseen.has(e.localName) && !hidden(e));

const ownText = (e) => [...e.childNodes].filter((c) => c.nodeType === 3).map((c) => c.data).join('');

// The text that names an element: its text and its images' alt text, without hidden text or the control that a label
// is for.
function textOf(e, leaving = null) {
  let s = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1 && c !== leaving && !unseen.has(c.localName) && !hidden(c)) {
        if (c.localName === 'img') s += c.getAttribute('alt') || '';
        else walk(c);
      }
    }
  };
  walk(e);
  return s;
}

function labelsOf(e) {
  const out = [];
  const id = e.getAttribute('id');
  if (id) for (const l of e.ownerDocument.querySelectorAll('label')) if (l.getAttribute('for') === id) out.push(textOf(l, e));
  const wrapping = e.parentNode ? e.parentNode.nodeType === 1 && e.parentNode.closest('label') : null;
  if (wrapping && !wrapping.hasAttribute('for')) out.push(textOf(wrapping, e));
  return out.map(normal).filter(Boolean);
}

const textual = new Set(['email', 'tel', 'text', 'url']);

export function role(e) {
  const given = (e.getAttribute('role') || '').trim().split(/\s+/)[0];
  if (given) return given;
  switch (e.localName) {
    case 'a':
    case 'area':
      return e.hasAttribute('href') ? 'link' : '';
    case 'button':
      return 'button';
    case 'input':
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'checkbox' || e.type === 'radio') return e.type;
      if (e.type === 'range') return 'slider';
      if (e.type === 'number') return 'spinbutton';
      if (e.type === 'search') return 'searchbox';
      if (textual.has(e.type)) return e.hasAttribute('list') ? 'combobox' : 'textbox';
      return '';
    case 'textarea':
      return 'textbox';
    case 'select':
      return e.hasAttribute('multiple') || Number(e.getAttribute('size')) > 1 ? 'listbox' : 'combobox';
    case 'option':
      return 'option';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      return e.getAttribute('alt') === '' ? 'presentation' : 'img';
    case 'ul':
    case 'ol':
    case 'menu':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'thead':
    case 'tbody':
    case 'tfoot':
      return 'rowgroup';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return 'columnheader';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'aside':
      return 'complementary';
    case 'header':
      return e.closest('article, aside, main, nav, section') ? '' : 'banner';
    case 'footer':
      return e.closest('article, aside, main, nav, section') ? '' : 'contentinfo';
    case 'form':
      return 'form';
    case 'section':
      return e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby') ? 'region' : '';
    case 'article':
      return 'article';
    case 'dialog':
      return 'dialog';
    case 'p':
      return 'paragraph';
    case 'progress':
      return 'progressbar';
    case 'hr':
      return 'separator';
    case 'fieldset':
      return 'group';
    case 'output':
      return 'status';
    default:
      return '';
  }
}

const namedByContent = new Set(['button', 'link', 'heading', 'cell', 'columnheader', 'rowheader', 'row', 'option',
  'listitem', 'tab', 'menuitem', 'switch', 'tooltip', 'treeitem']);

export function accessibleName(e) {
  const by = e.getAttribute('aria-labelledby');
  if (by) {
    return normal(by.split(/\s+/).map((id) => {
      const t = e.ownerDocument.getElementById(id);
      return t ? textOf(t) : '';
    }).join(' '));
  }
  const label = e.getAttribute('aria-label');
  if (label && label.trim()) return normal(label);
  if (e.localName === 'input' && ['button', 'submit', 'reset'].includes(e.type)) {
    return normal(e.getAttribute('value') ?? (e.type === 'submit' ? 'Submit' : e.type === 'reset' ? 'Reset' : ''));
  }
  if (e.localName === 'input' && e.type === 'image') return normal(e.getAttribute('alt') || '');
  if (['input', 'select', 'textarea'].includes(e.localName)) {
    const labels = labelsOf(e);
    if (labels.length > 0) return labels.join(' ');
    return normal(e.getAttribute('title') || e.getAttribute('placeholder') || '');
  }
  if (e.localName === 'img') return normal(e.getAttribute('alt') || e.getAttribute('title') || '');
  if (namedByContent.has(role(e))) {
    const t = normal(textOf(e));
    if (t) return t;
  }
  return normal(e.getAttribute('title') || '');
}

const labelled = (e, want) => {
  if (normal(e.getAttribute('aria-label') || '') === want) return true;
  if (e.hasAttribute('aria-labelledby')) return accessibleName(e) === want;
  return ['input', 'select', 'textarea'].includes(e.localName) && labelsOf(e).includes(want);
};

function inOrder(doc, list) {
  const order = new Map([...doc.querySelectorAll('*')].map((e, k) => [e, k]));
  return [...new Set(list)].sort((a, b) => order.get(a) - order.get(b));
}

// findAll gives the elements f finds under scope, in document order.
export function findAll(doc, f, scope = doc) {
  switch (f.kind) {
    case 'css':
      return [...scope.querySelectorAll(f.args[0])];
    case 'text': {
      const want = normal(f.args[0]);
      return shown(scope).filter((e) => normal(ownText(e)) === want && want !== '');
    }
    case 'text-containing': {
      const want = normal(f.args[0]);
      return shown(scope).filter((e) => normal(ownText(e)).includes(want));
    }
    case 'role': {
      const want = normal(f.args[1]);
      return shown(scope).filter((e) => role(e) === f.args[0] && (want === '' || accessibleName(e) === want));
    }
    case 'label': {
      const want = normal(f.args[0]);
      return shown(scope).filter((e) => labelled(e, want));
    }
    case 'test-id':
      return [...scope.querySelectorAll('*')].filter((e) => e.getAttribute('data-testid') === f.args[0]);
    case 'within':
      return inOrder(doc, findAll(doc, f.outer, scope).flatMap((outer) => findAll(doc, f.inner, outer)));
    case 'nth': {
      const all = findAll(doc, f.of, scope);
      return f.n >= 1 && f.n <= all.length ? [all[f.n - 1]] : [];
    }
    default:
      throw new Error(`no finder ${f.kind}`);
  }
}
