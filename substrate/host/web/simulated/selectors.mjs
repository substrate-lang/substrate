// CSS selectors for the simulated document: types, ids, classes, attributes, the four combinators, selector lists,
// and the structural, state and logical pseudo-classes.
const unsupported = (text, why) => new Error(`the simulated browser does not support the selector ${JSON.stringify(text)}: ${why}`);

const identChar = /[A-Za-z0-9_\-\u0080-￿]/;

function parser(text) {
  let i = 0;
  const peek = () => text[i];
  const ident = () => {
    let s = '';
    while (i < text.length) {
      if (text[i] === '\\' && i + 1 < text.length) {
        s += text[i + 1];
        i += 2;
      } else if (identChar.test(text[i])) {
        s += text[i++];
      } else break;
    }
    if (s === '') throw unsupported(text, `expected a name at ${i + 1}`);
    return s;
  };
  const space = () => {
    const at = i;
    while (i < text.length && /\s/.test(text[i])) i++;
    return i > at;
  };
  const quoted = () => {
    const q = text[i++];
    let s = '';
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\' && i + 1 < text.length) i++;
      s += text[i++];
    }
    if (text[i] !== q) throw unsupported(text, 'a quote is not closed');
    i++;
    return s;
  };
  const nth = (arg) => {
    const s = arg.replace(/\s+/g, '').toLowerCase();
    if (s === 'odd') return [2, 1];
    if (s === 'even') return [2, 0];
    const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
    if (m) return [m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]), m[2] ? Number(m[2]) : 0];
    if (/^[+-]?\d+$/.test(s)) return [0, Number(s)];
    throw unsupported(text, `${arg} is not an+b`);
  };
  const argument = () => {
    let depth = 1;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      if (depth > 0) i++;
    }
    if (text[i] !== ')') throw unsupported(text, 'a parenthesis is not closed');
    return text.slice(start, i++);
  };
  const compound = () => {
    const c = { tag: null, tests: [] };
    if (peek() === '*') {
      i++;
      c.tag = '*';
    } else if (i < text.length && identChar.test(peek())) {
      c.tag = ident().toLowerCase();
    }
    for (;;) {
      const ch = peek();
      if (ch === '#') {
        i++;
        const id = ident();
        c.tests.push((e) => e.getAttribute('id') === id);
      } else if (ch === '.') {
        i++;
        const name = ident();
        c.tests.push((e) => (e.getAttribute('class') || '').split(/\s+/).includes(name));
      } else if (ch === '[') {
        i++;
        space();
        const name = ident().toLowerCase();
        space();
        let op = null;
        let value = null;
        let fold = false;
        if (peek() !== ']') {
          const m = /^([~|^$*]?=)/.exec(text.slice(i));
          if (!m) throw unsupported(text, `expected an operator at ${i + 1}`);
          op = m[1];
          i += op.length;
          space();
          value = peek() === '"' || peek() === "'" ? quoted() : ident();
          space();
          if (/[iI]/.test(peek() || '')) {
            fold = true;
            i++;
            space();
          }
        }
        if (peek() !== ']') throw unsupported(text, `expected ] at ${i + 1}`);
        i++;
        c.tests.push(attributeTest(name, op, value, fold));
      } else if (ch === ':') {
        i++;
        if (peek() === ':') throw unsupported(text, 'pseudo-elements select no elements');
        const name = ident().toLowerCase();
        const arg = peek() === '(' ? (i++, argument()) : null;
        c.tests.push(pseudoTest(text, name, arg, nth));
      } else break;
    }
    if (c.tag === null && c.tests.length === 0) throw unsupported(text, `expected a selector at ${i + 1}`);
    return c;
  };
  const complex = () => {
    space();
    const parts = [{ combinator: null, compound: compound() }];
    for (;;) {
      const spaced = space();
      const ch = peek();
      if (i >= text.length || ch === ',') break;
      let combinator = ' ';
      if (ch === '>' || ch === '+' || ch === '~') {
        combinator = ch;
        i++;
        space();
      } else if (!spaced) {
        throw unsupported(text, `unexpected ${ch} at ${i + 1}`);
      }
      parts.push({ combinator, compound: compound() });
    }
    return parts;
  };
  return () => {
    const list = [complex()];
    while (peek() === ',') {
      i++;
      list.push(complex());
    }
    if (i < text.length) throw unsupported(text, `unexpected ${peek()} at ${i + 1}`);
    return list;
  };
}

function attributeTest(name, op, value, fold) {
  const norm = (s) => (fold ? s.toLowerCase() : s);
  return (e) => {
    const v = e.getAttribute(name);
    if (v === null) return false;
    if (op === null) return true;
    const a = norm(v);
    const b = norm(value);
    switch (op) {
      case '=': return a === b;
      case '~=': return a.split(/\s+/).includes(b);
      case '|=': return a === b || a.startsWith(`${b}-`);
      case '^=': return b !== '' && a.startsWith(b);
      case '$=': return b !== '' && a.endsWith(b);
      default: return b !== '' && a.includes(b);
    }
  };
}

const siblings = (e) => (e.parentNode ? e.parentNode.childNodes.filter((n) => n.nodeType === 1) : [e]);
const fits = ([a, b], k) => (a === 0 ? k === b : (k - b) / a >= 0 && (k - b) % a === 0);
const controls = new Set(['button', 'input', 'select', 'textarea', 'option', 'optgroup', 'fieldset']);

function pseudoTest(text, name, arg, nth) {
  const position = (of, last) => (e) => {
    const list = siblings(e).filter((s) => !of || s.localName === e.localName);
    const k = list.indexOf(e);
    return last ? list.length - k : k + 1;
  };
  const needs = () => {
    if (arg === null) throw unsupported(text, `:${name} needs an argument`);
    return arg;
  };
  switch (name) {
    case 'first-child': return (e) => position(false, false)(e) === 1;
    case 'last-child': return (e) => position(false, true)(e) === 1;
    case 'only-child': return (e) => siblings(e).length === 1;
    case 'first-of-type': return (e) => position(true, false)(e) === 1;
    case 'last-of-type': return (e) => position(true, true)(e) === 1;
    case 'only-of-type': return (e) => siblings(e).filter((s) => s.localName === e.localName).length === 1;
    case 'nth-child': { const f = nth(needs()); return (e) => fits(f, position(false, false)(e)); }
    case 'nth-last-child': { const f = nth(needs()); return (e) => fits(f, position(false, true)(e)); }
    case 'nth-of-type': { const f = nth(needs()); return (e) => fits(f, position(true, false)(e)); }
    case 'nth-last-of-type': { const f = nth(needs()); return (e) => fits(f, position(true, true)(e)); }
    case 'not': { const list = compileList(needs()); return (e) => !list(e); }
    case 'is':
    case 'where': { const list = compileList(needs()); return (e) => list(e); }
    case 'has': {
      const list = compileList(needs());
      return (e) => descendants(e).some(list);
    }
    case 'checked': return (e) => (e.localName === 'input' && e.checked === true) || (e.localName === 'option' && e.hasAttribute('selected'));
    case 'disabled': return (e) => controls.has(e.localName) && e.hasAttribute('disabled');
    case 'enabled': return (e) => controls.has(e.localName) && !e.hasAttribute('disabled');
    case 'focus': return (e) => e.ownerDocument && e.ownerDocument.activeElement === e;
    case 'empty': return (e) => e.childNodes.every((n) => n.nodeType === 8 || (n.nodeType === 3 && n.data === ''));
    case 'root': return (e) => e.ownerDocument && e.ownerDocument.documentElement === e;
    case 'hover':
    case 'active':
    case 'visited':
    case 'focus-visible':
    case 'focus-within':
      return () => false;
    default: throw unsupported(text, `no pseudo-class :${name}`);
  }
}

function descendants(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 1) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

const previous = (e) => {
  const list = siblings(e);
  return list[list.indexOf(e) - 1] || null;
};

function matchesFrom(e, parts, k) {
  const { compound } = parts[k];
  if (compound.tag !== null && compound.tag !== '*' && e.localName !== compound.tag) return false;
  for (const test of compound.tests) if (!test(e)) return false;
  if (k === 0) return true;
  const up = (n) => (n.parentNode && n.parentNode.nodeType === 1 ? n.parentNode : null);
  switch (parts[k].combinator) {
    case '>': { const p = up(e); return p !== null && matchesFrom(p, parts, k - 1); }
    case '+': { const s = previous(e); return s !== null && matchesFrom(s, parts, k - 1); }
    case '~':
      for (let s = previous(e); s; s = previous(s)) if (matchesFrom(s, parts, k - 1)) return true;
      return false;
    default:
      for (let p = up(e); p; p = up(p)) if (matchesFrom(p, parts, k - 1)) return true;
      return false;
  }
}

const compiled = new Map();

// compileList gives a test of whether an element matches the selector list text.
export function compileList(text) {
  let list = compiled.get(text);
  if (!list) {
    const parsed = parser(text)();
    list = (e) => parsed.some((parts) => matchesFrom(e, parts, parts.length - 1));
    compiled.set(text, list);
  }
  return list;
}

// select gives the elements under root that match text, in document order.
export function select(root, text) {
  const test = compileList(text);
  return descendants(root).filter(test);
}

export { descendants };
