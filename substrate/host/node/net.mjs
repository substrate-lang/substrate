// The host module "net" (net.sub). A TLS server takes its certificate again whenever the certificate's files change.
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { errorOf, reasonOf } from '../errors.mjs';
import { nodeSource } from '../streams.mjs';
import { addressDenials, mayHost, notGranted } from '../grants.mjs';
import { lookupWithin } from './resolve.mjs';

const utf8 = new TextEncoder();

const SOURCE = 9;
const LISTENING = 1;
const ACCEPT = 2;
const CONNECTED = 3;
const FAILED = 4;

function renewed(server, certificate) {
  const [certFile, keyFile] = certificate.files;
  const reload = () => {
    try {
      server.setSecureContext({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) });
    } catch {
      // a pair caught halfway through being replaced waits for the next change
    }
  };
  for (const file of certificate.files) fs.watchFile(file, { interval: 1000, persistent: false }, reload);
  server.once('close', () => {
    for (const file of certificate.files) fs.unwatchFile(file, reload);
  });
}

export function netModule(grants, certificate) {
  const listeners = new Map();
  const ca = certificate ? [...tls.rootCertificates, certificate.cert] : undefined;
  const reach = (call, host, port) => {
    const shown = host.includes(':') ? `[${host}]` : host;
    if (!mayHost(grants.net, host, port)) throw notGranted(`${call}: ${shown}:${port} is not granted (--allow-net)`);
  };
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
        let id = 0;
        try {
          const host = caller.string(hp, hl) || '127.0.0.1';
          reach('net.listen', host, port);
          if (secure && !certificate) {
            throw new Error('net.listen: TLS needs the host started with --tls-cert and --tls-key');
          }
          server = secure
            ? tls.createServer({ ...certificate, allowHalfOpen: true })
            : net.createServer({ allowHalfOpen: true });
          if (most > 0) server.maxConnections = most;
          if (secure && certificate.files) renewed(server, certificate);
          if (addressDenials(grants.net) && !net.isIP(host)) {
            lookupWithin(grants, 'net.listen', port)(host, {}, (e, address) => {
              if (listeners.get(id) !== server) return;
              if (e) server.emit('error', e);
              else server.listen(port, address);
            });
          } else server.listen(port, host);
        } catch (e) {
          caller.fail(err, e.message, errorOf(e));
          return 0;
        }
        id = next++;
        listeners.set(id, server);
        server.on('listening', () => {
          if (listeners.get(id) === server) caller.event(LISTENING, id, tag, server.address().port);
        });
        server.on(server instanceof tls.Server ? 'secureConnection' : 'connection', (socket) => {
          socket.setNoDelay(true);
          const peer = utf8.encode(socket.remoteAddress || '');
          caller.event(ACCEPT, id, tag, caller.streams.add(tag, nodeSource(socket)), peer);
        });
        server.on('error', (e) => {
          if (listeners.get(id) !== server) return;
          listeners.delete(id);
          caller.event(FAILED, id, tag, errorOf(e), utf8.encode(reasonOf(e)));
        });
        return id;
      },
      connect(port, hp, hl, secure, tag, err) {
        let socket;
        try {
          const host = caller.string(hp, hl);
          reach('net.connect', host, port);
          const lookup = addressDenials(grants.net) ? lookupWithin(grants, 'net.connect', port) : undefined;
          const servername = net.isIP(host) ? undefined : host;
          socket = secure
            ? tls.connect({ host, port, servername, ca, allowHalfOpen: true, lookup })
            : net.connect({ host, port, allowHalfOpen: true, lookup });
        } catch (e) {
          caller.fail(err, e.message, errorOf(e));
          return 0;
        }
        let connected = false;
        let id = 0;
        socket.setNoDelay(true);
        socket.on('error', (e) => {
          if (connected || !caller.streams.drop(id)) return;
          caller.event(FAILED, id, tag, errorOf(e), utf8.encode(reasonOf(e)));
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
