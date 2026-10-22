// The host module "stream": the byte streams other modules make, read and written as events.
// Kinds: read 1, value the bytes read, 0 at the end; drained 2; failed 3, value the error code; finished 4,
// once everything written before finish has been.
// A source: pull() gives a promise of the next bytes, null at the end; write(bytes) is false when full;
// finish(); close(); and it is told drained(), finished() and failed(e).
import { errorOf } from './errors.mjs';

const utf8 = new TextEncoder();

export const STREAM = 8;
const READ = 1;
const DRAINED = 2;
const FAILED = 3;
const FINISHED = 4;

export function createStreams(host) {
  const open = new Map();
  let next = 1;

  function fail(id, s, e) {
    if (open.get(id) !== s) return;
    open.delete(id);
    s.closed = true;
    host.raise(FAILED, id, s.tag, errorOf(e), utf8.encode(e.message));
  }

  function add(tag, source) {
    const id = next++;
    const s = { tag, source, chunk: null, at: 0, done: false, reading: false, closed: false };
    open.set(id, s);
    source.drained = () => {
      if (open.get(id) === s) host.raise(DRAINED, id, s.tag, 0);
    };
    source.finished = () => {
      if (open.get(id) === s) host.raise(FINISHED, id, s.tag, 0);
    };
    source.failed = (e) => fail(id, s, e);
    return id;
  }

  function tag(id, t) {
    const s = open.get(id);
    if (s) s.tag = t;
  }

  function drop(id) {
    const s = open.get(id);
    if (!s) return;
    open.delete(id);
    s.closed = true;
    host.forget(id);
  }

  function close(id) {
    const s = open.get(id);
    if (!s) return;
    drop(id);
    s.source.close();
  }

  async function fill(id, s, memory, at, cap) {
    try {
      if (!s.done && (!s.chunk || s.at >= s.chunk.length)) {
        const chunk = await s.source.pull();
        if (s.closed) return;
        if (chunk === null) s.done = true;
        else {
          s.chunk = chunk;
          s.at = 0;
        }
      }
      let n = 0;
      if (s.chunk && s.at < s.chunk.length) {
        n = Math.min(cap, s.chunk.length - s.at);
        memory().set(s.chunk.subarray(s.at, s.at + n), at);
        s.at += n;
      }
      s.reading = false;
      host.raise(READ, id, s.tag, n);
    } catch (e) {
      if (!s.closed) fail(id, s, e);
    }
  }

  return {
    add,
    tag,
    drop,
    close,
    end() {
      for (const id of [...open.keys()]) close(id);
    },
    imports(caller) {
      return {
        read(id, buf, cap) {
          const s = open.get(id);
          if (!s) return -1;
          if (s.reading) host.trap(`stream.read: a read is already posted for stream ${id}`);
          s.reading = true;
          fill(id, s, caller.memory, caller.u(buf), cap);
          return 0;
        },
        write(id, ptr, len) {
          const s = open.get(id);
          if (!s || !s.source.write) return -1;
          return s.source.write(caller.memory().slice(caller.u(ptr), caller.u(ptr) + len)) ? 0 : 1;
        },
        finish(id) {
          const s = open.get(id);
          if (s && s.source.finish) s.source.finish();
        },
        close(id) {
          close(id);
        },
        tag(id, t) {
          tag(id, t);
        },
      };
    },
  };
}

// A source over a web stream's reader, got once ready; null when there is none.
export function readerSource(getReader, cancel) {
  let reader = null;
  let none = false;
  return {
    async pull() {
      if (none) return null;
      if (!reader) reader = await getReader();
      if (!reader) {
        none = true;
        return null;
      }
      const { value, done } = await reader.read();
      return done ? null : value;
    },
    close: cancel,
  };
}

// A source over a Node stream, read only while a read is posted.
export function nodeSource(stream) {
  const chunks = [];
  let waiting = null;
  let ended = false;
  let error = null;
  const wake = (f) => {
    if (!waiting) return false;
    const w = waiting;
    waiting = null;
    f(w);
    return true;
  };
  const source = {
    pull() {
      if (chunks.length > 0) return Promise.resolve(chunks.shift());
      if (error) return Promise.reject(error);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        stream.resume();
      });
    },
    write: stream.writable ? (bytes) => stream.write(bytes) : undefined,
    finish: stream.writable ? () => stream.end() : undefined,
    close: () => stream.destroy(),
  };
  if (stream.readable) {
    stream.pause();
    stream.on('data', (chunk) => {
      stream.pause();
      if (!wake((w) => w.resolve(chunk))) chunks.push(chunk);
    });
    stream.on('end', () => {
      ended = true;
      wake((w) => w.resolve(null));
    });
  }
  stream.on('error', (e) => {
    error = e;
    if (!wake((w) => w.reject(e)) && source.failed) source.failed(e);
  });
  stream.on('drain', () => {
    if (source.drained) source.drained();
  });
  stream.on('finish', () => {
    if (source.finished) source.finished();
  });
  return source;
}
