// The host module "fetch": HTTP requests, answered as events. The request's id is its response body's stream.
// Kinds: head 1, value the status, bytes the headers as entries, a name then its value, each ended by a zero;
// failed 2, value the error code. start takes the method, the URL, headers as such entries, and the body.
import { errorOf } from '../errors.mjs';
import { readerSource } from '../streams.mjs';
import { entries, joined } from '../entries.mjs';

const utf8 = new TextEncoder();

const SOURCE = 6;
const HEAD = 1;
const FAILED = 2;

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
      const id = caller.streams.add(tag, readerSource(async () => {
        await ready;
        return response && response.body ? response.body.getReader() : null;
      }, () => controller.abort()));
      fetch(url, { method, headers, body, signal: controller.signal })
        .then((r) => {
          response = r;
          settle();
          if (!caller.streams.open(id)) return;
          caller.event(HEAD, id, tag, r.status, utf8.encode(joined([...r.headers].flat())));
        }, (e) => {
          settle();
          if (!caller.streams.drop(id)) return;
          caller.event(FAILED, id, tag, errorOf(e), utf8.encode(e.message));
        });
      return id;
    },
  });
}
