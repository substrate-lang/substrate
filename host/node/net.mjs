// The host module "net": TCP listeners, and connections, which are streams.
// Kinds: listening 1, value the port; accept 2, value the new connection's stream; connected 3; failed 4,
// value the error code. A listener's host is the address to bind, "" for 127.0.0.1; secure asks for TLS; most is
// how many of its connections may be open at once, 0 for any, a connection beyond that being closed at once. A
// connection's two sides end apart: the peer's end is a read of 0, and this side's is finish.
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
      listen(port, hp, hl, secure, most, tag, err) {
        let server;
        try {
          const host = caller.string(hp, hl);
          if (secure && !granted.tls) throw new Error('net.listen: no certificate was granted for tls');
          server = secure
            ? tls.createServer({ ...granted.tls, allowHalfOpen: true })
            : net.createServer({ allowHalfOpen: true });
          if (most > 0) server.maxConnections = most;
          server.listen(port, host || '127.0.0.1');
        } catch (e) {
          caller.fail(err, e.message);
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
      connect(port, hp, hl, secure, tag, err) {
        let socket;
        try {
          const host = caller.string(hp, hl);
          socket = secure
            ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ca, allowHalfOpen: true })
            : net.connect({ host, port, allowHalfOpen: true });
        } catch (e) {
          caller.fail(err, e.message);
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
