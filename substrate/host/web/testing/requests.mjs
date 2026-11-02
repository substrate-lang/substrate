// Reads and checks the document for browser tests.
import { describe, findAll, parse } from './find.mjs';

const quote = (s) => JSON.stringify(s);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
export const short = (e) => clip(e.outerHTML, 160);

export function one(document, f) {
  const found = findAll(document, f);
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`nothing matches ${describe(f)}\n  the document's body: ${clip(document.body.innerHTML, 2000)}`);
  const listed = found.slice(0, 5).map((e) => `\n  ${short(e)}`).join('');
  throw new Error(`${found.length} elements match ${describe(f)}:${listed}${found.length > 5 ? '\n  ...' : ''}`);
}

// chose chooses an option of the select element that a finder finds, as a user does: the one whose text the request
// gives.
export function chose(document, fields) {
  const [f, k] = parse(fields, 1);
  const e = one(document, f);
  if (e.localName !== 'select') throw new Error(`${describe(f)} is not a select element\n  it is ${short(e)}`);
  if (e.hasAttribute('disabled')) throw new Error(`${describe(f)} is disabled, so no option can be chosen\n  it is ${short(e)}`);
  const option = [...e.querySelectorAll('option')].find((o) => o.textContent.trim() === fields[k]);
  if (!option) throw new Error(`${describe(f)} has no option ${quote(fields[k])}\n  it is ${short(e)}`);
  e.focus();
  e.value = option.value;
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return '';
}

// advancedUntil moves the clock ahead, a frame at a time, until the text of what a finder finds is the text the request
// gives, for at most the milliseconds it gives.
export async function advancedUntil(document, fields, clock, settle) {
  const [f, k] = parse(fields, 1);
  const ms = Number(fields[k + 1]);
  const text = () => {
    const found = findAll(document, f);
    return found.length === 1 ? found[0].textContent : null;
  };
  for (let waited = 0; text() !== fields[k]; waited += 1000 / 60) {
    if (waited >= ms) {
      const t = text();
      throw new Error(`after ${ms} ms, ${t === null ? `not one element matches ${describe(f)}` : `the text of ${describe(f)} is ${quote(t)}, not ${quote(fields[k])}`}`);
    }
    await clock.advance(1000 / 60, settle);
    await settle();
  }
  return '';
}

// ending says how the program ended: with its exit status, and after a trap, with the trap's message.
export const ending = (code, reason) => `the program ended with ${code}${reason ? `: ${reason.split('\n')[0]}` : ''}`;

const differs = (what, f, actual, expected, e) => new Error(`${what} of ${describe(f)} is ${quote(actual)}, not ${quote(expected)}\n  it is ${short(e)}`);

// documentRequest answers a request that reads or checks the document, and gives undefined for any other request.
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
