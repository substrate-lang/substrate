// The host module "net": TCP listeners, and connections, which are streams.
// Kinds: listening 1, value the port; accept 2, value the new connection's stream; connected 3; failed 4,
// value the error code. The options are lines: tls; host NAME.
import net from 'node:net';
import tls from 'node:tls';
import { errorOf } from '../errors.mjs';
import { nodeSource } from '../streams.mjs';

const utf8 = new TextEncoder();

const SOURCE = 9;
const LISTENING = 1;
const ACCEPT = 2;
const CONNECTED = 3;
const FAILED = 4;

function parseOptions(text) {
  const options = { tls: false, host: null };
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    const word = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (word === '') continue;
    if (word === 'tls') options.tls = true;
    else if (word === 'host') options.host = value;
    else throw new Error(`net: unknown option "${word}"`);
  }
  return options;
}

export function netModule(granted = {}) {
  const listeners = new Map();
  const ca = granted.tls ? [...tls.rootCertificates, granted.tls.cert] : undefined;
  let next = 1;
  return (caller) => {
    return {
      source: SOURCE,
      end() {
        for (const server of listeners.values()) server.close();
        listeners.clear();
      },
      listen(port, ptr, len, tag) {
        let server;
        try {
          const options = parseOptions(caller.string(ptr, len));
          if (options.tls && !granted.tls) throw new Error('net.listen: no certificate was granted for tls');
          server = options.tls ? tls.createServer(granted.tls) : net.createServer();
          server.listen(port, options.host || '127.0.0.1');
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
        const id = next++;
        listeners.set(id, server);
        server.on('listening', () => {
          if (listeners.get(id) === server) caller.event(LISTENING, id, tag, server.address().port);
        });
        server.on(server instanceof tls.Server ? 'secureConnection' : 'connection', (socket) => {
          socket.setNoDelay(true);
          caller.event(ACCEPT, id, tag, caller.streams.add(tag, nodeSource(socket)));
        });
        server.on('error', (e) => {
          if (listeners.get(id) !== server) return;
          listeners.delete(id);
          caller.event(FAILED, id, tag, errorOf(e), utf8.encode(e.message));
        });
        return id;
      },
      connect(hostPtr, hostLen, port, ptr, len, tag) {
        let socket;
        try {
          const host = caller.string(hostPtr, hostLen);
          const options = parseOptions(caller.string(ptr, len));
          socket = options.tls
            ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ca })
            : net.connect({ host, port });
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
        let connected = false;
        let id = 0;
        socket.setNoDelay(true);
        socket.on('error', (e) => {
          if (connected || !caller.streams.drop(id)) return;
          caller.event(FAILED, id, tag, errorOf(e), utf8.encode(e.message));
        });
        id = caller.streams.add(tag, nodeSource(socket));
        socket.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', () => {
          connected = true;
          caller.event(CONNECTED, id, tag, 0);
        });
        return id;
      },
      close(id) {
        const server = listeners.get(id);
        if (!server) return;
        listeners.delete(id);
        server.close();
        caller.forget(id);
      },
    };
  };
}
