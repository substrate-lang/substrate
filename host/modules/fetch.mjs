// The host module "fetch": HTTP requests, answered as events. The request's id is its response body's stream.
// Kinds: head 1, value the status, bytes the header lines; failed 2, value the error code.
import { errorOf } from '../errors.mjs';
import { readerSource } from '../streams.mjs';

const utf8 = new TextEncoder();
const text = new TextDecoder();

const SOURCE = 6;
const HEAD = 1;
const FAILED = 2;

// A request: a line with the method and the URL, header lines, an empty line, then the body.
export function parseRequest(bytes) {
  let split = -1;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) {
      split = i;
      break;
    }
  }
  const lines = text.decode(split < 0 ? bytes : bytes.subarray(0, split)).split('\n');
  const body = split < 0 ? null : bytes.subarray(split + 2);
  const space = lines[0].indexOf(' ');
  const method = space < 0 ? lines[0] : lines[0].slice(0, space);
  const url = space < 0 ? '' : lines[0].slice(space + 1);
  const headers = [];
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`fetch.start: a header line without a colon: ${line}`);
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { method, url, headers, body: body && body.length > 0 ? body : null };
}

export function fetchModule() {
  return (caller) => ({
    source: SOURCE,
    start(ptr, len, tag) {
      let request;
      try {
        request = parseRequest(caller.memory().slice(caller.u(ptr), caller.u(ptr) + len));
      } catch (e) {
        caller.error(e.message);
        return 0;
      }
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
      fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal })
        .then((r) => {
          response = r;
          settle();
          const headers = [...r.headers].map(([name, value]) => `${name}: ${value}\n`).join('');
          caller.event(HEAD, id, tag, r.status, utf8.encode(headers));
        }, (e) => {
          settle();
          caller.streams.drop(id);
          caller.event(FAILED, id, tag, errorOf(e), utf8.encode(e.message));
        });
      return id;
    },
  });
}
