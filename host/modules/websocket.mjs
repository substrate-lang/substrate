// The host module "websocket" (websocket.sub).
import { errors } from '../errors.mjs';
import { entries } from '../entries.mjs';
import { mayUrl, portOfUrl } from '../grants.mjs';

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

// grants is undefined for a page, which may connect anywhere; on Node, guard gives a socket's dispatcher
// (node/resolve.mjs), and node is set, as only Node's WebSocket can send headers.
export function websocket(grants, guard, node = false) {
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
      connect(up, ul, pp, pl, hp, hl, tag, err) {
        const url = caller.string(up, ul);
        if (grants && URL.canParse(url) && !mayUrl(grants.net, new URL(url))) {
          caller.fail(err, `websocket.connect: ${new URL(url).host} is not granted (--allow-net)`);
          return 0;
        }
        const protocols = entries(caller.string(pp, pl));
        const list = entries(caller.string(hp, hl));
        const headers = [];
        for (let i = 0; i + 1 < list.length; i += 2) headers.push([list[i], list[i + 1]]);
        if (headers.length > 0 && !node) {
          caller.fail(err, 'websocket.connect: a page cannot send headers');
          return 0;
        }
        const s = { ws: null, tag, polling: false, opened: false, denied: null };
        try {
          const denied = (why) => {
            s.denied = why;
          };
          const dispatcher = guard && URL.canParse(url) ? guard(portOfUrl(new URL(url)), denied) : undefined;
          s.ws = node ? new WebSocket(url, { protocols, headers, dispatcher }) : new WebSocket(url, protocols);
        } catch (e) {
          caller.fail(err, e.message);
          return 0;
        }
        const id = next++;
        const { ws } = s;
        sockets.set(id, s);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          s.opened = true;
          caller.event(OPEN, id, tag, 0, utf8.encode(ws.protocol));
        };
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') caller.event(MESSAGE, id, tag, TEXT, utf8.encode(e.data));
          else caller.event(MESSAGE, id, tag, BINARY, new Uint8Array(e.data));
        };
        ws.onerror = () => {
          if (sockets.get(id) !== s) return;
          sockets.delete(id);
          if (s.denied !== null) {
            caller.event(FAILED, id, tag, errors.notGranted, utf8.encode(s.denied));
            return;
          }
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
        if (code !== 1000 && (code < 3000 || code > 4999)) {
          caller.trap(`websocket.close: the code must be 1000 or 3000 to 4999, not ${code}`);
        }
        const s = sockets.get(id);
        if (!s) return;
        sockets.delete(id);
        s.ws.close(code);
        caller.forget(id);
      },
    };
  };
}
