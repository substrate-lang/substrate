// The host module "websocket": connections whose messages arrive as events. A message is text 1 or binary 2: its
// event's value, and how send sends it.
import { errors } from '../errors.mjs';

const utf8 = new TextEncoder();
const text = new TextDecoder();

const SOURCE = 7;
const OPEN = 1;
const MESSAGE = 2;
const CLOSED = 3;
const FAILED = 4;
const DRAINED = 5;
const TEXT = 1;
const BINARY = 2;

const full = 1 << 20;

export function websocket() {
  const sockets = new Map();
  let next = 1;
  return (caller) => {
    const drainLater = (id, s) => {
      if (s.polling) return;
      s.polling = true;
      const check = () => {
        if (sockets.get(id) !== s) return;
        if (s.ws.bufferedAmount > full) {
          setTimeout(check, 10);
          return;
        }
        s.polling = false;
        caller.event(DRAINED, id, s.tag, 0);
      };
      setTimeout(check, 10);
    };
    return {
      source: SOURCE,
      end() {
        for (const s of sockets.values()) s.ws.close(1000);
        sockets.clear();
      },
      connect(ptr, len, tag, err) {
        const url = caller.string(ptr, len);
        let ws;
        try {
          ws = new WebSocket(url);
        } catch (e) {
          caller.fail(err, e.message);
          return 0;
        }
        const id = next++;
        const s = { ws, tag, polling: false, opened: false };
        sockets.set(id, s);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          s.opened = true;
          caller.event(OPEN, id, tag, 0);
        };
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') caller.event(MESSAGE, id, tag, TEXT, utf8.encode(e.data));
          else caller.event(MESSAGE, id, tag, BINARY, new Uint8Array(e.data));
        };
        ws.onerror = () => {
          if (sockets.get(id) !== s) return;
          sockets.delete(id);
          const why = s.opened ? `the connection to ${url} failed` : `cannot connect to ${url}`;
          caller.event(FAILED, id, tag, s.opened ? errors.aborted : errors.unreachable, utf8.encode(why));
        };
        ws.onclose = (e) => {
          if (sockets.get(id) !== s) return;
          sockets.delete(id);
          caller.event(CLOSED, id, tag, e.code);
        };
        return id;
      },
      send(id, ptr, len, kind) {
        const s = sockets.get(id);
        if (!s) return -1;
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
        s.ws.send(kind === TEXT ? text.decode(bytes) : bytes);
        if (s.ws.bufferedAmount <= full) return 0;
        drainLater(id, s);
        return 1;
      },
      close(id, code) {
        const s = sockets.get(id);
        if (!s) return;
        sockets.delete(id);
        s.ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);
        caller.forget(id);
      },
    };
  };
}
