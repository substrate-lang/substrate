// The host module "websocket": connections whose messages arrive as events.
const utf8 = new TextEncoder();

const SOURCE = 7;
const OPEN = 1;
const MESSAGE = 2;
const CLOSED = 3;
const FAILED = 4;
const DRAINED = 5;

const full = 1 << 20;

export function websocket() {
  return (caller) => {
    const sockets = new Map();
    let next = 1;
    const drainLater = (id, s) => {
      const check = () => {
        if (sockets.get(id) !== s) return;
        if (s.ws.bufferedAmount <= full) caller.event(DRAINED, id, 0);
        else setTimeout(check, 10);
      };
      setTimeout(check, 10);
    };
    return {
      source: SOURCE,
      connect(ptr, len) {
        const url = caller.string(ptr, len);
        let ws;
        try {
          ws = new WebSocket(url);
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
        const id = next++;
        const s = { ws };
        sockets.set(id, s);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => caller.event(OPEN, id, 0);
        ws.onmessage = (e) => caller.event(MESSAGE, id, 0, typeof e.data === 'string' ? utf8.encode(e.data) : new Uint8Array(e.data));
        ws.onerror = () => caller.event(FAILED, id, 0, utf8.encode(`cannot connect to ${url}`));
        ws.onclose = (e) => {
          if (sockets.get(id) !== s) return;
          sockets.delete(id);
          caller.event(CLOSED, id, e.code);
        };
        return id;
      },
      send(id, ptr, len) {
        const s = sockets.get(id);
        if (!s) return -1;
        s.ws.send(caller.memory().slice(caller.u(ptr), caller.u(ptr) + len));
        if (s.ws.bufferedAmount <= full) return 0;
        drainLater(id, s);
        return 1;
      },
      close(id, code) {
        const s = sockets.get(id);
        if (!s) return;
        sockets.delete(id);
        s.ws.close(code || 1000);
      },
    };
  };
}
