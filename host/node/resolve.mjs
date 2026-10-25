// Names checked again as the addresses they resolve to, for net.mjs, fetch.mjs and websocket.mjs on Node.
import dns from 'node:dns';
import { addressDenials, deniesAddress, notGranted } from '../grants.mjs';

// lookupWithin is a dns.lookup that fails when a name resolves to a denied address, telling onDenied why.
export const lookupWithin = (grants, call, port, onDenied = () => {}) => (hostname, options, callback) => {
  dns.lookup(hostname, options, (e, address, family) => {
    if (e) return callback(e, address, family);
    const found = Array.isArray(address) ? address : [{ address }];
    const denied = found.find((a) => deniesAddress(grants.net, a.address, port));
    if (!denied) return callback(null, address, family);
    const shown = denied.address.includes(':') ? `[${denied.address}]` : denied.address;
    const reason = `${call}: ${hostname}:${port} resolves to ${shown}:${port}, which is not granted (--allow-net)`;
    onDenied(reason);
    return callback(notGranted(reason));
  });
};

let Agent = null;

// agent gives an Agent of the undici in Node's fetch, taken from the global dispatcher the first fetch makes.
const agent = (lookup) => {
  if (!Agent) {
    fetch('data:,').catch(() => {});
    Agent = globalThis[Symbol.for('undici.globalDispatcher.1')].constructor;
  }
  return new Agent({ connect: { lookup } });
};

// dispatchers gives fetch an Agent for each port, and guards an Agent for each WebSocket; neither gives one when the
// deny list names no address.
export function dispatchers(grants) {
  if (!addressDenials(grants.net)) return () => undefined;
  const made = new Map();
  return (port) => {
    if (!made.has(port)) made.set(port, agent(lookupWithin(grants, 'fetch', port)));
    return made.get(port);
  };
}

export const guards = (grants) => (addressDenials(grants.net)
  ? (port, onDenied) => agent(lookupWithin(grants, 'websocket.connect', port, onDenied))
  : undefined);
