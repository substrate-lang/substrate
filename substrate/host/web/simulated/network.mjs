// The simulated browser's network: fetch gets the site's own files and the answers a test gave, and fails for any
// other URL; a WebSocket connects to a server that echoes what it is sent.
import { Event, EventTarget } from './document.mjs';

const types = {
  txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
};

export const typeOf = (path) => types[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';

const bodiless = new Set([101, 103, 204, 205, 304]);

// site maps a path to its bytes, answers a URL to its status and body, and track runs the work as the page's.
export function makeFetch(site, answers, where, track) {
  return (input, init = {}) => track(async () => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, where().href);
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
      const echo = typeof data === 'string' ? data : new Uint8Array(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.slice(0)).buffer;
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
