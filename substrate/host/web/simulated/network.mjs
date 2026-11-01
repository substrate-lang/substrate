// The simulated browser's network: fetch gets the answers a test gave, the network as far as network gives, or else the
// site's own files, and fails for any other URL; a WebSocket connects to a server that echoes what it is sent.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { Event, EventTarget } from './document.mjs';

const types = {
  txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
};

export const typeOf = (path) => types[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';

const bodiless = new Set([101, 103, 204, 205, 304]);

const decoders = { gzip: () => zlib.createGunzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress() };

// nodeFetch fetches over Node's HTTP for the simulated browser's pages, whose timers and performance are the page's and
// so useless to Node's own fetch. It decodes compressed bodies, as a browser does.
export function nodeFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = {};
    for (const [k, v] of Array.isArray(init.headers) ? init.headers : Object.entries(init.headers || {})) headers[k] = v;
    const options = { method: init.method || 'GET', headers, signal: init.signal };
    const request = (target.protocol === 'https:' ? https : http).request(target, options, (response) => {
      const decoder = decoders[String(response.headers['content-encoding'] || '').toLowerCase()];
      const body = decoder ? response.pipe(decoder()) : response;
      const list = [];
      for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) list.push([response.rawHeaders[i], response.rawHeaders[i + 1]]);
      const none = options.method === 'HEAD' || bodiless.has(response.statusCode);
      resolve(new Response(none ? null : Readable.toWeb(body), { status: response.statusCode, statusText: response.statusMessage, headers: list }));
    });
    request.on('error', (e) => reject(new TypeError('Failed to fetch', { cause: e })));
    request.end(init.body ? Buffer.from(init.body) : undefined);
  });
}

// site maps a path to its bytes, answers a URL to its status and body, track runs the work as the program's, and
// network gives the real fetch for a URL the browser may reach, or null. What the network does takes its own time,
// so it is not the program's work for settling.
export function makeFetch(site, answers, where, track, network = () => null) {
  const local = (url, init) => track(async () => {
    if (url.origin === where().origin) {
      const bytes = site.get(decodeURIComponent(url.pathname));
      if (bytes) {
        const body = init.method === 'HEAD' ? null : bytes.slice();
        return new Response(body, { status: 200, headers: { 'content-type': typeOf(url.pathname), 'content-length': String(bytes.length) } });
      }
      return new Response('not found', { status: 404, statusText: 'Not Found', headers: { 'content-type': types.txt } });
    }
    const answer = answers.get(url.href);
    if (answer) {
      return new Response(bodiless.has(answer.status) ? null : answer.body, { status: answer.status, headers: { 'content-type': typeOf(url.pathname) } });
    }
    throw new TypeError('Failed to fetch');
  });
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, where().href);
    const real = !answers.has(url.href) && network(url);
    return real ? real(url.href, init) : local(url, init);
  };
}

export function makeWebSocket(later, where) {
  return class WebSocket extends EventTarget {
    static CONNECTING = 0;

    static OPEN = 1;

    static CLOSING = 2;

    static CLOSED = 3;

    constructor(url, protocols = []) {
      super();
      const u = new URL(url, where().href);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error(`SyntaxError: ${u.href} is not a WebSocket URL`);
      this.url = u.href;
      this.readyState = 0;
      this.protocol = '';
      this.extensions = '';
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      const offered = Array.isArray(protocols) ? protocols : [protocols];
      later(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.protocol = offered[0] || '';
        this.dispatchEvent(new Event('open'));
      });
    }

    send(data) {
      if (this.readyState !== 1) throw new Error('InvalidStateError: the WebSocket is not open');
      const bytes = ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.slice(0);
      const echo = typeof data === 'string' ? data : bytes;
      later(() => {
        if (this.readyState === 1) this.dispatchEvent(new Event('message', { data: echo }));
      });
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      later(() => {
        this.readyState = 3;
        this.dispatchEvent(new Event('close', { code, reason, wasClean: true }));
      });
    }
  };
}
