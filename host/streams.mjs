// The host module "stream" (stream.sub): byte streams other modules make from sources. A source that can be read
// has pull(), which gives a promise of the next bytes, or of null at the end. One that can be written has
// write(bytes), which gives false when full, and finish(). Each has close(), and may have errorOf(e) to give its
// failures' codes. The streams set its drained(), finished() and failed(e).
import { errorOf, reasonOf } from './errors.mjs';

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
    host.raise(FAILED, id, s.tag, (s.source.errorOf || errorOf)(e), utf8.encode(reasonOf(e)));
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
    if (!s) return false;
    open.delete(id);
    s.closed = true;
    host.forget(id);
    return true;
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
    open: (id) => open.has(id),
    end() {
      for (const id of [...open.keys()]) close(id);
    },
    imports(caller) {
      return {
        read(id, buf, cap) {
          const s = open.get(id);
          if (!s) return -1;
          if (!s.source.pull) host.trap(`stream.read: stream ${id} cannot be read`);
          if (s.reading) host.trap(`stream.read: a read is already posted for stream ${id}`);
          if (cap === 0) host.trap('stream.read: a read with no room');
          s.reading = true;
          fill(id, s, caller.memory, caller.u(buf), cap);
          return 0;
        },
        write(id, ptr, len) {
          const s = open.get(id);
          if (!s) return -1;
          if (!s.source.write) host.trap(`stream.write: stream ${id} cannot be written`);
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

// readerSource reads the web stream reader that getReader gives; a null reader is an empty stream.
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

// nodeSource reads a Node stream only while a read is posted.
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
    pull: stream.readable ? () => {
      if (chunks.length > 0) return Promise.resolve(chunks.shift());
      if (error) return Promise.reject(error);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        stream.resume();
      });
    } : undefined,
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
