// The host module "fetch" (fetch.sub).
import { errors, errorOf, reasonOf } from '../errors.mjs';
import { readerSource } from '../streams.mjs';
import { entries, joined } from '../entries.mjs';

const utf8 = new TextEncoder();

const SOURCE = 6;
const HEAD = 1;
const FAILED = 2;

const base = globalThis.location ? globalThis.location.href : undefined;

// fetch fails with a TypeError when the network fails, and on Node the error's cause has the code.
const headError = (e) => (e.name === 'TypeError' && !(e.cause instanceof Error) ? errors.unreachable : errorOf(e));
const bodyError = (e) => (e.name === 'TypeError' ? errors.aborted : errorOf(e));

export function fetchModule() {
  return (caller) => ({
    source: SOURCE,
    start(mp, ml, up, ul, hp, hl, bp, bl, tag) {
      const method = caller.string(mp, ml);
      const url = caller.string(up, ul);
      const list = entries(caller.string(hp, hl));
      const headers = [];
      for (let i = 0; i + 1 < list.length; i += 2) headers.push([list[i], list[i + 1]]);
      const body = bl > 0 ? caller.memory().slice(caller.u(bp), caller.u(bp) + bl) : null;
      const controller = new AbortController();
      let response = null;
      let settle;
      const ready = new Promise((resolve) => {
        settle = resolve;
      });
      const source = readerSource(async () => {
        await ready;
        return response && response.body ? response.body.getReader() : null;
      }, () => controller.abort());
      source.errorOf = bodyError;
      const id = caller.streams.add(tag, source);
      fetch(url, { method, headers, body, signal: controller.signal })
        .then((r) => {
          response = r;
          settle();
          if (!caller.streams.open(id)) return;
          caller.event(HEAD, id, tag, r.status, utf8.encode(joined([...r.headers].flat())));
        }, (e) => {
          settle();
          if (!caller.streams.drop(id)) return;
          caller.event(FAILED, id, tag, URL.canParse(url, base) ? headError(e) : errors.invalid,
            utf8.encode(reasonOf(e)));
        });
      return id;
    },
  });
}
