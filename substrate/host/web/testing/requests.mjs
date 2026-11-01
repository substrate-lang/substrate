// Reading and checking a document as browser tests ask, for both browsers: what a finder finds, its text, HTML,
// attributes, value and state, and how many elements it finds.
import { describe, findAll, parse } from './find.mjs';

const quote = (s) => JSON.stringify(s);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
export const short = (e) => clip(e.outerHTML, 160);

// one gives the element f finds, which must be the only one.
export function one(document, f) {
  const found = findAll(document, f);
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`nothing matches ${describe(f)}\n  the document's body: ${clip(document.body.innerHTML, 2000)}`);
  const listed = found.slice(0, 5).map((e) => `\n  ${short(e)}`).join('');
  throw new Error(`${found.length} elements match ${describe(f)}:${listed}${found.length > 5 ? '\n  ...' : ''}`);
}

const differs = (what, f, actual, expected, e) => new Error(`${what} of ${describe(f)} is ${quote(actual)}, not ${quote(expected)}\n  it is ${short(e)}`);

// documentRequest carries out a request that reads or checks the document, or gives undefined for any other.
export function documentRequest(document, fields) {
  const found = () => parse(fields, 1);
  switch (fields[0]) {
    case 'text':
      return one(document, found()[0]).textContent;
    case 'html':
      return one(document, found()[0]).outerHTML;
    case 'attribute': {
      const [f, k] = found();
      const e = one(document, f);
      const v = e.getAttribute(fields[k]);
      if (v === null) throw new Error(`${describe(f)} has no attribute ${fields[k]}\n  it is ${short(e)}`);
      return v;
    }
    case 'has-attribute': {
      const [f, k] = found();
      return one(document, f).hasAttribute(fields[k]) ? 'true' : 'false';
    }
    case 'value':
      return String(one(document, found()[0]).value ?? '');
    case 'checked':
      return one(document, found()[0]).checked ? 'true' : 'false';
    case 'count':
      return String(findAll(document, found()[0]).length);
    case 'expect-text': {
      const [f, k] = found();
      const e = one(document, f);
      if (e.textContent !== fields[k]) throw differs('the text', f, e.textContent, fields[k], e);
      return '';
    }
    case 'expect-html': {
      const [f, k] = found();
      const e = one(document, f);
      if (e.outerHTML !== fields[k]) throw new Error(`the HTML of ${describe(f)} is\n  ${e.outerHTML}\nnot\n  ${fields[k]}`);
      return '';
    }
    case 'expect-value': {
      const [f, k] = found();
      const e = one(document, f);
      if (String(e.value ?? '') !== fields[k]) throw differs('the value', f, String(e.value ?? ''), fields[k], e);
      return '';
    }
    case 'expect-attribute': {
      const [f, k] = found();
      const e = one(document, f);
      const v = e.getAttribute(fields[k]);
      if (v === null) throw new Error(`${describe(f)} has no attribute ${fields[k]}\n  it is ${short(e)}`);
      if (v !== fields[k + 1]) throw differs(`the attribute ${fields[k]}`, f, v, fields[k + 1], e);
      return '';
    }
    case 'expect-no-attribute': {
      const [f, k] = found();
      const e = one(document, f);
      if (e.hasAttribute(fields[k])) throw new Error(`${describe(f)} has the attribute ${fields[k]}\n  it is ${short(e)}`);
      return '';
    }
    case 'expect-checked': {
      const [f, k] = found();
      const e = one(document, f);
      if (e.checked !== (fields[k] === 'true')) throw new Error(`${describe(f)} is ${e.checked ? '' : 'not '}checked\n  it is ${short(e)}`);
      return '';
    }
    case 'expect-count': {
      const [f, k] = found();
      const all = findAll(document, f);
      const want = Number(fields[k]);
      if (all.length !== want) {
        const listed = all.slice(0, 5).map((e) => `\n  ${short(e)}`).join('');
        throw new Error(`${describe(f)} matches ${all.length} element${all.length === 1 ? '' : 's'}, not ${want}${listed}${all.length > 5 ? '\n  ...' : ''}`);
      }
      return '';
    }
    case 'expect-missing': {
      const [f] = found();
      const all = findAll(document, f);
      if (all.length > 0) throw new Error(`${describe(f)} matches ${short(all[0])}${all.length > 1 ? ` and ${all.length - 1} more` : ''}`);
      return '';
    }
    default:
      return undefined;
  }
}
