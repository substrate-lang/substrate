// What a program may do beyond computing: read and write files, reach hosts, read the environment and run
// programs. The flags are Deno's: -A, -R, -W, -N, -E and --allow-run, the lists scoped, with --deny-* over them.
const kinds = ['read', 'write', 'net', 'env'];
const short = { read: '-R', write: '-W', net: '-N', env: '-E' };
export const flags = { read: '--allow-read', write: '--allow-write', net: '--allow-net', env: '--allow-env' };

const kind = () => ({ all: false, items: [], deny: { all: false, items: [] } });

export const noGrants = () => ({ read: kind(), write: kind(), net: kind(), env: kind(), run: false });

export function allGrants() {
  const g = noGrants();
  for (const k of kinds) g[k].all = true;
  g.run = true;
  return g;
}

export function notGranted(message) {
  const e = new Error(message);
  e.name = 'NotGrantedError';
  return e;
}

export const pathDenied = (k) => notGranted(`${k === 'read' ? 'reading' : 'writing'} is not granted (${flags[k]})`);

// The items of a list have commas between them, and ",," is a comma within one.
export function listOf(text) {
  const list = [];
  let item = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ',') item += text[i];
    else if (text[i + 1] === ',') {
      item += ',';
      i++;
    } else {
      list.push(item);
      item = '';
    }
  }
  list.push(item);
  return list;
}

const urlHost = (bare) => {
  if (/[@/?#\\%\s]/.test(bare)) return bare.toLowerCase();
  try {
    return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    return bare.toLowerCase();
  }
};

// canonicalHost writes a host as the URL standard does, with IPv4 in dotted decimal, IPv6 compressed and names in
// lowercase punycode, and without a final dot; an IPv6 address that maps an IPv4 one becomes that IPv4 address. A
// host with a character the standard would cut it at, or decode, is left as it is, matching no grant.
export function canonicalHost(host) {
  const h = urlHost(host.replace(/^\[(.*)\]$/, '$1')).replace(/\.$/, '');
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!mapped) return h;
  const [a, b] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

// A host is a name or an address, in brackets for IPv6, or *.name for its subdomains, with an optional port.
export function hostOf(text) {
  let host = text;
  let port = null;
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] === undefined ? null : bracketed[2];
  } else if (text.indexOf(':') > 0 && text.indexOf(':') === text.lastIndexOf(':')) {
    host = text.slice(0, text.indexOf(':'));
    port = text.slice(text.indexOf(':') + 1);
  }
  if (host === '' || (port !== null && !(/^\d+$/.test(port) && Number(port) <= 65535))) {
    throw new Error(`${text} is not a host or host:port`);
  }
  return { host: canonicalHost(host), port: port === null ? null : Number(port) };
}

const itemOf = (k, text, resolve) => {
  if (k === 'read' || k === 'write') return resolve(text);
  return k === 'net' ? hostOf(text) : text;
};

// grantFlag adds a grant flag to g and returns true, or returns false for a flag that is not one.
export function grantFlag(g, flag, resolve) {
  const equals = flag.indexOf('=');
  const name = equals < 0 ? flag : flag.slice(0, equals);
  const value = equals < 0 ? null : flag.slice(equals + 1);
  if (name === '-A' || name === '--allow-all' || name === '--allow-run') {
    const why = name === '--allow-run' ? ', since a child program is not sandboxed' : '';
    if (value !== null) throw new Error(`${name} takes no list${why}`);
    if (name !== '--allow-run') for (const k of kinds) g[k].all = true;
    g.run = true;
    return true;
  }
  for (const k of kinds) {
    const into = name === short[k] || name === flags[k] ? g[k] : name === `--deny-${k}` ? g[k].deny : null;
    if (into === null) continue;
    if (value === null) into.all = true;
    else {
      const list = listOf(value);
      if (list.includes('')) throw new Error(`${flag} has an empty item`);
      into.items.push(...list.map((text) => itemOf(k, text, resolve)));
    }
    return true;
  }
  return false;
}

// grantsOf gives the grants a list of flags makes, every one of which must be a grant flag.
export function grantsOf(list, resolve) {
  const g = noGrants();
  for (const flag of list) if (!grantFlag(g, flag, resolve)) throw new Error(`${flag} is not a grant`);
  return g;
}

const under = (p, root) => root === '/' || p === root || (p.startsWith(root) && p.charCodeAt(root.length) === 47);
const named = (item, name) => item === name || (item.endsWith('*') && name.startsWith(item.slice(0, -1)));
const reaches = (item, host, port) => (item.port === null || item.port === port)
  && (item.host === host || (item.host.startsWith('*.') && host.endsWith(item.host.slice(1))));
const among = (list, test) => list.all || list.items.some(test);
const may = (grant, test) => among(grant, test) && !among(grant.deny, test);

const inside = (list, p) => {
  if (list.all) return true;
  for (const root of list.items) if (under(p, root)) return true;
  return false;
};

// mayPath takes a path as the host resolved it: absolute, with its symbolic links followed.
export const mayPath = (grant, p) => inside(grant, p) && !inside(grant.deny, p);
export const mayEnv = (grant, name) => may(grant, (item) => named(item, name));
export const mayHost = (grant, host, port) => {
  const h = canonicalHost(host);
  return may(grant, (item) => reaches(item, h, port));
};
const ports = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };
export const mayUrl = (grant, url) => {
  const port = url.port === '' ? ports[url.protocol] || 0 : Number(url.port);
  return mayHost(grant, url.hostname, port);
};
export const unlimited = (grant) => grant.all && !grant.deny.all && grant.deny.items.length === 0;

const covers = (k, outer, inner) => {
  if (k === 'read' || k === 'write') return under(inner, outer);
  return k === 'env' ? named(outer, inner) : reaches(outer, inner.host, inner.port);
};

// within gives a worker's grants: those asked for, which must lie inside its parent's, with the parent's denials.
export function within(asked, parent) {
  const out = noGrants();
  for (const k of kinds) {
    const a = asked[k];
    const p = parent[k];
    const beyond = a.all ? !p.all : a.items.find((item) => !among(p, (outer) => covers(k, outer, item)));
    if (beyond) {
      const item = k === 'net' ? `${beyond.host}${beyond.port === null ? '' : `:${beyond.port}`}` : beyond;
      throw new Error(`${flags[k]}${beyond === true ? '' : `=${item}`} reaches beyond the parent's grants`);
    }
    const deny = { all: a.deny.all || p.deny.all, items: [...a.deny.items, ...p.deny.items] };
    out[k] = { all: a.all, items: [...a.items], deny };
  }
  if (asked.run && !parent.run) throw new Error('--allow-run reaches beyond the parent\'s grants');
  out.run = asked.run;
  return out;
}
