// What a program may do beyond computing: read and write files, reach hosts, read the environment and run
// programs. The grants match Deno's permissions wherever the two overlap, except that the host never prompts, a page
// cannot check where fetch is redirected or where names resolve, and a child may keep the dynamic loader's variables
// the host started with.
const kinds = ['read', 'write', 'net', 'env', 'run'];
export const flags = {
  read: '--allow-read', write: '--allow-write', net: '--allow-net', env: '--allow-env', run: '--allow-run',
};

const kind = () => ({ all: false, items: [], deny: { all: false, items: [] } });

export const noGrants = () => ({ read: kind(), write: kind(), net: kind(), env: kind(), run: kind() });

export function allGrants() {
  const g = noGrants();
  for (const k of kinds) g[k].all = true;
  return g;
}

export function notGranted(message) {
  const e = new Error(message);
  e.name = 'NotGrantedError';
  return e;
}

export const pathDenied = (k, flag = flags[k]) => notGranted(
  `${k === 'read' ? 'reading' : 'writing'} is not granted (${flag})`,
);

const urlHost = (bare) => {
  if (/[@/?#\\%\s]/.test(bare)) return bare.toLowerCase();
  try {
    return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    return bare.toLowerCase();
  }
};

// canonicalHost writes a host as the URL standard does, with IPv4 in dotted decimal, IPv6 compressed and without its
// %zone, and names in lowercase punycode, and without a final dot; an IPv6 address that maps an IPv4 one becomes that
// IPv4 address. A host with a character the standard would cut it at, or decode, is left as it is, matching no grant.
export function canonicalHost(host) {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  const zone = bare.includes(':') ? bare.indexOf('%') : -1;
  const h = urlHost(zone < 0 ? bare : bare.slice(0, zone)).replace(/\.$/, '');
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!mapped) return h;
  const [a, b] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

// bytesOf gives the bytes of an address as canonicalHost writes it, or null for a name.
function bytesOf(host) {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return v4.slice(1).every((n) => Number(n) <= 255) ? v4.slice(1).map(Number) : null;
  if (!/^[0-9a-f:]+$/.test(host)) return null;
  const [head, tail] = host.split('::');
  const groups = (s) => (s ? s.split(':') : []);
  const missing = 8 - groups(head).length - groups(tail).length;
  const all = tail === undefined ? groups(head) : [...groups(head), ...Array(missing).fill('0'), ...groups(tail)];
  return all.length === 8 ? all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]) : null;
}

const inSubnet = (item, host) => {
  const b = bytesOf(host);
  if (b === null || b.length !== item.bytes.length) return false;
  for (let bit = 0; bit < item.bits; bit++) {
    const mask = 128 >> (bit % 8);
    if ((b[bit >> 3] & mask) !== (item.bytes[bit >> 3] & mask)) return false;
  }
  return true;
};

const badAddress = (host) => host.includes(':') && !URL.canParse(`http://[${host}]/`);

const portOf = (text, port) => {
  if (port === null) return null;
  if (!(/^\d+$/.test(port) && Number(port) <= 65535)) throw new Error(`${text} is not a host or host:port`);
  return Number(port);
};

// A host is a name or an address, in brackets for IPv6, or *.name for its subdomains, or a subnet, ADDRESS/BITS;
// each with an optional port.
export function hostOf(text) {
  const subnet = /^\[?([^\]/]+)\]?\/(\d{1,3})(?::(.*))?$/.exec(text);
  if (subnet) {
    const host = canonicalHost(subnet[1]);
    const bytes = bytesOf(host);
    const bits = Number(subnet[2]);
    if (bytes === null || badAddress(host) || bits > bytes.length * 8) throw new Error(`${text} is not a subnet`);
    return { host, port: portOf(text, subnet[3] === undefined ? null : subnet[3]), bits, bytes };
  }
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
  const canonical = canonicalHost(host);
  if (canonical === '' || /[@/?#\\%\s]/.test(canonical) || badAddress(canonical)) {
    throw new Error(`${text} is not a host or host:port`);
  }
  return { host: canonical, port: portOf(text, port) };
}

// resolve gives each path and program as a file, except a program denied by a name, which has no slash.
const itemOf = (k, text, resolve, deny) => {
  if (k === 'net') return hostOf(text);
  if (k === 'env' || (k === 'run' && deny && !text.includes('/'))) return text;
  return resolve(text, k);
};

const fakeable = new Set(['clock', 'timer', 'websocket', 'fetch']);

export function pairsFrom(list) {
  if (list.length % 2 !== 0) throw new Error(`the grant ${list[list.length - 1]} has no item`);
  const pairs = [];
  for (let i = 0; i < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
  return pairs;
}

const grantKind = (name) => {
  const deny = name.startsWith('deny-');
  const k = deny ? name.slice(5) : name;
  return kinds.includes(k) ? { k, deny } : null;
};

// requestOf reads kind and item pairs (grants.sub) into grants, inherited kinds, fakes and TLS files.
export function requestOf(pairs, resolve) {
  const g = noGrants();
  const request = { grants: g, inherit: new Set(), fakes: new Map(), tls: null };
  for (const [kind, item] of pairs) {
    if (item === '') throw new Error(`${kind} has an empty item`);
    const granted = grantKind(kind);
    const all = kind === 'all' ? grantKind(item) : null;
    if (granted) {
      const into = granted.deny ? g[granted.k].deny : g[granted.k];
      const resolved = itemOf(granted.k, item, resolve, granted.deny);
      if (resolved !== null) {
        into.items.push(resolved);
        if (into === g.run) g.write.deny.items.push(resolved);
      }
    } else if (all) (all.deny ? g[all.k].deny : g[all.k]).all = true;
    else if (kind === 'inherit' && kinds.includes(item)) request.inherit.add(item);
    else if (kind === 'fake' && fakeable.has(item)) {
      if (!request.fakes.has(item)) request.fakes.set(item, null);
    } else if (kind === 'fetch') request.fakes.set('fetch', item);
    else if (kind === 'tls-cert' || kind === 'tls-key') (request.tls ||= {})[kind.slice(4)] = item;
    else throw new Error(`${kind} ${item} is not a grant`);
  }
  if (request.tls && !(request.tls.cert && request.tls.key)) throw new Error('--tls-cert and --tls-key go together');
  return request;
}

export const joinedGrants = (a, b) => Object.fromEntries(kinds.map((k) => [k, {
  all: a[k].all || b[k].all,
  items: [...a[k].items, ...b[k].items],
  deny: { all: a[k].deny.all || b[k].deny.all, items: [...a[k].deny.items, ...b[k].deny.items] },
}]));

export const askedOf = (request, parent) => joinedGrants(request.grants,
  Object.fromEntries(kinds.map((k) => [k, request.inherit.has(k) ? parent[k] : kind()])));

export const under = (p, root) => root === '/' || p === root
  || (p.startsWith(root) && p.charCodeAt(root.length) === 47);
const named = (item, name) => item === name || (item.endsWith('*') && name.startsWith(item.slice(0, -1)));
const wildcard = (item, host) => item.startsWith('*.') && (host === item.slice(2) || host.endsWith(item.slice(1)));
const reaches = (item, host, port) => (item.port === null || item.port === port) && (item.bits === undefined
  ? item.host === host || wildcard(item.host, host)
  : inSubnet(item, host));
const among = (list, test) => list.all || list.items.some(test);
const may = (grant, test) => among(grant, test) && !among(grant.deny, test);

const inside = (list, p) => {
  if (list.all) return true;
  for (const root of list.items) if (under(p, root)) return true;
  return false;
};

// mayPath takes a path absolute and without . or .. parts; its links are not followed.
export const mayPath = (grant, p) => inside(grant, p) && !inside(grant.deny, p);
// mayTree takes a path as mayPath does, for a call on everything under it, which a denied path inside also stops.
export const mayTree = (grant, p) => mayPath(grant, p) && !grant.deny.items.some((root) => under(root, p));
export const mayEnv = (grant, name) => may(grant, (item) => named(item, name));

const stemOf = (p) => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};
const asciiLower = (s) => s.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
// A denied name covers a file whose stem is the name with its ASCII letters in any case, or starts with the name and a
// dot.
const covered = (name, p) => {
  const stem = asciiLower(stemOf(p));
  const n = asciiLower(name);
  return stem.startsWith(n) && (stem.length === n.length || stem[n.length] === '.');
};
const runs = (item, file, program) => {
  if (file === null) return item.includes('/') ? covered(program, item) : item === program;
  return item.includes('/') ? under(file, item) : covered(item, file);
};
// mayRun takes the file a program runs, as the host found it, or null when there is none, and the program as named.
export const mayRun = (grant, file, program) => (grant.all || (file !== null && grant.items.includes(file)))
  && !among(grant.deny, (item) => runs(item, file, program));
export const mayHost = (grant, host, port) => {
  const h = canonicalHost(host);
  return may(grant, (item) => reaches(item, h, port));
};
const ports = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };
export const portOfUrl = (url) => (url.port === '' ? ports[url.protocol] || 0 : Number(url.port));
export const mayUrl = (grant, url) => mayHost(grant, url.hostname, portOfUrl(url));
export const unlimited = (grant) => grant.all && !grant.deny.all && grant.deny.items.length === 0;
export const allowsAll = (g) => kinds.every((k) => unlimited(g[k]));

// The dynamic loader's variables, which only all of --allow-run lets a program change for a child (node/process.mjs).
export const isLoaderVariable = (name) => /^\s*(LD_|DYLD_)/i.test(name);

// addressDenials tells whether a deny list names addresses or subnets, and deniesAddress whether it denies an address
// (node/resolve.mjs).
const isAddress = (item) => item.bits !== undefined || bytesOf(item.host) !== null;
export const addressDenials = (grant) => grant.deny.items.some(isAddress);
export const deniesAddress = (grant, address, port) => {
  const a = canonicalHost(address);
  return grant.deny.items.some((item) => isAddress(item) && reaches(item, a, port));
};

const covers = (k, outer, inner) => {
  if (k === 'read' || k === 'write') return under(inner, outer);
  if (k === 'run') return outer === inner;
  if (k === 'env') return named(outer, inner);
  if (inner.bits === undefined) return reaches(outer, inner.host, inner.port);
  return outer.bits !== undefined && outer.bits <= inner.bits && reaches(outer, inner.host, inner.port);
};

// within gives a worker's grants: those asked for, which must lie inside its parent's, with the parent's denials.
export function within(asked, parent) {
  const out = noGrants();
  for (const k of kinds) {
    const a = asked[k];
    const p = parent[k];
    const beyond = a.all ? !p.all : a.items.find((item) => !among(p, (outer) => covers(k, outer, item)));
    if (beyond) {
      const subnet = beyond.bits === undefined ? '' : `/${beyond.bits}`;
      const item = k === 'net' ? `${beyond.host}${subnet}${beyond.port === null ? '' : `:${beyond.port}`}` : beyond;
      throw new Error(`${flags[k]}${beyond === true ? '' : `=${item}`} reaches beyond the parent's grants`);
    }
    const deny = { all: a.deny.all || p.deny.all, items: [...a.deny.items, ...p.deny.items] };
    out[k] = { all: a.all, items: [...a.items], deny };
  }
  return out;
}
