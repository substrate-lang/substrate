// The host module "fetch": HTTP requests, answered as events.
import { errors } from '../subhost-core.mjs';

const utf8 = new TextEncoder();
const text = new TextDecoder();

const SOURCE = 6;
const HEAD = 1;
const READ = 2;
const FAILED = 3;

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

const errorOf = (e) => {
  if (e.name === 'AbortError') return errors.aborted;
  if (e.code === 'ERR_INVALID_URL' || /URL/.test(e.message)) return errors.invalid;
  return errors.unreachable;
};

export function fetchModule() {
  const requests = new Map();
  let next = 1;
  return (caller) => {
    const fail = (id, state, e) => {
      if (state.closed) return;
      state.closed = true;
      requests.delete(id);
      caller.event(FAILED, id, state.tag, errorOf(e), utf8.encode(e.message));
    };
    async function fill(id, state, at, cap) {
      if (!state.done && (!state.chunk || state.at >= state.chunk.length)) {
        const { value, done } = await state.reader.read();
        if (state.closed) return;
        if (done) state.done = true;
        else {
          state.chunk = value;
          state.at = 0;
        }
      }
      let n = 0;
      if (state.chunk && state.at < state.chunk.length) {
        n = Math.min(cap, state.chunk.length - state.at);
        caller.memory().set(state.chunk.subarray(state.at, state.at + n), at);
        state.at += n;
      }
      if (state.done && (!state.chunk || state.at >= state.chunk.length)) {
        state.closed = true;
        requests.delete(id);
      }
      caller.event(READ, id, state.tag, n);
    }
    return {
      source: SOURCE,
      end() {
        for (const state of requests.values()) {
          state.closed = true;
          state.controller.abort();
        }
        requests.clear();
      },
      start(ptr, len, tag) {
        let request;
        try {
          request = parseRequest(caller.memory().slice(caller.u(ptr), caller.u(ptr) + len));
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
        const id = next++;
        const state = { tag, controller: new AbortController(), reader: null, chunk: null, at: 0, done: false, closed: false };
        requests.set(id, state);
        fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: state.controller.signal })
          .then((response) => {
            if (state.closed) return;
            state.reader = response.body ? response.body.getReader() : null;
            state.done = state.reader === null;
            const headers = [...response.headers].map(([name, value]) => `${name}: ${value}\n`).join('');
            caller.event(HEAD, id, tag, response.status, utf8.encode(headers));
          }, (e) => fail(id, state, e));
        return id;
      },
      read(id, buf, cap) {
        const state = requests.get(id);
        if (!state || (!state.reader && !state.done)) return -1;
        fill(id, state, caller.u(buf), cap).catch((e) => fail(id, state, e));
        return 0;
      },
      abort(id) {
        const state = requests.get(id);
        if (!state) return;
        state.closed = true;
        requests.delete(id);
        state.controller.abort();
        caller.forget(id);
      },
    };
  };
}
