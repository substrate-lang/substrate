// The host module "fetch" (fetch.sub).
import { errors, errorOf, reasonOf } from '../errors.mjs';
import { readerSource } from '../streams.mjs';
import { entries, joined } from '../entries.mjs';
import { mayUrl, notGranted, portOfUrl, unlimited } from '../grants.mjs';

const utf8 = new TextEncoder();

const SOURCE = 6;
const HEAD = 1;
const FAILED = 2;

const base = globalThis.location ? globalThis.location.href : undefined;

// fetch fails with a TypeError when the network fails, and on Node the error's cause has the code.
const headError = (e) => (e.name === 'TypeError' && !(e.cause instanceof Error) ? errors.unreachable : errorOf(e));
const bodyError = (e) => (e.name === 'TypeError' ? errors.aborted : errorOf(e));

const moved = new Set([301, 302, 303, 307, 308]);
const bodyHeaders = new Set([
  'content-encoding', 'content-language', 'content-location', 'content-type', 'content-length',
]);
const credentials = new Set(['authorization', 'cookie', 'proxy-authorization']);

const unwrapNotGranted = (e) => {
  throw e.cause instanceof Error && e.cause.name === 'NotGrantedError' ? e.cause : e;
};

// fetchChecked fetches a URL that the grants reach. With redirects, it follows the redirects itself, as the fetch
// standard says to, and checks each; without, the platform follows them.
async function fetchChecked(net, url, init, redirects, dispatcherFor) {
  let at = url;
  let { method, headers, body } = init;
  for (let hops = 0; ; hops++) {
    if (!mayUrl(net, at)) throw notGranted(`fetch: ${at.host} is not granted (--allow-net)`);
    if (!redirects) return fetch(at, init);
    const dispatcher = dispatcherFor(portOfUrl(at));
    const r = await fetch(at, { method, headers, body, signal: init.signal, redirect: 'manual', dispatcher })
      .catch(unwrapNotGranted);
    const location = r.headers.get('location');
    if (!moved.has(r.status) || location === null) return r;
    if (hops === 20) throw new Error('fetch: too many redirects');
    const next = new URL(location, at);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new Error(`fetch: a redirect to ${next.protocol}`);
    }
    if ((r.status === 303 && method !== 'GET' && method !== 'HEAD') || (r.status <= 302 && method === 'POST')) {
      method = 'GET';
      body = null;
      headers = headers.filter(([name]) => !bodyHeaders.has(name.toLowerCase()));
    }
    if (next.origin !== at.origin) headers = headers.filter(([name]) => !credentials.has(name.toLowerCase()));
    if (r.body) await r.body.cancel();
    at = next;
  }
}

// grants is undefined for a page, which may fetch anything; on Node, redirects is true and dispatcherFor gives a
// port's dispatcher (node/resolve.mjs).
export function fetchModule(grants, redirects = false, dispatcherFor = () => undefined) {
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
      let reader = null;
      let settle;
      const ready = new Promise((resolve) => {
        settle = resolve;
      });
      const source = readerSource(async () => {
        await ready;
        reader = response && response.body ? response.body.getReader() : null;
        return reader;
      }, () => {
        if (reader) reader.cancel().catch(() => {});
        else if (response && response.body) response.body.cancel().catch(() => {});
        else controller.abort();
      });
      source.errorOf = bodyError;
      const id = caller.streams.add(tag, source);
      const init = { method, headers, body, signal: controller.signal };
      const target = URL.canParse(url, base) ? new URL(url, base) : null;
      const request = grants && !unlimited(grants.net) && target && /^https?:$/.test(target.protocol)
        ? fetchChecked(grants.net, target, init, redirects, dispatcherFor)
        : fetch(url, init);
      request
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
