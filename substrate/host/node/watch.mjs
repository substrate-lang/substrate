// The host module "watch" (watch.sub) on Node: fs.watch, its changes put as Deno's watchFs puts them.
import fs from 'node:fs';
import path from 'node:path';
import { errorOf } from '../errors.mjs';
import { entries, joined } from '../entries.mjs';
import { under } from '../grants.mjs';
import { literalPath, plainMessage } from './fs.mjs';

const utf8 = new TextEncoder();

const SOURCE = 15;
const CHANGED = 1;
const FAILED = 2;
const CREATE = 1;
const MODIFY = 2;
const REMOVE = 3;

export function watchModule(grants) {
  const watches = new Map();
  let next = 1;
  const close = (w) => {
    for (const watcher of w.watchers) watcher.close();
  };
  return (caller) => ({
    source: SOURCE,
    end() {
      for (const w of watches.values()) close(w);
      watches.clear();
    },
    start(pp, pl, recursive, ip, il, tag, err) {
      const w = { watchers: [] };
      let at = '';
      try {
        const ignore = entries(caller.string(ip, il)).map((p) => {
          at = p;
          return literalPath(grants, 'read', p);
        });
        const id = next;
        for (const p of entries(caller.string(pp, pl))) {
          at = p;
          const abs = literalPath(grants, 'read', p);
          const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
          const watcher = fs.watch(abs, { recursive: recursive !== 0 && dir === abs }, (type, name) => {
            if (watches.get(id) !== w) return;
            const changed = name === null ? abs : path.join(dir, name.toString());
            if (ignore.some((root) => under(changed, root))) return;
            const kind = type === 'change' ? MODIFY : fs.existsSync(changed) ? CREATE : REMOVE;
            caller.event(CHANGED, id, tag, kind, utf8.encode(joined([changed])));
          });
          watcher.on('error', (e) => {
            if (watches.get(id) !== w) return;
            watches.delete(id);
            close(w);
            caller.event(FAILED, id, tag, errorOf(e), utf8.encode(`watch: ${plainMessage(e)}`));
          });
          w.watchers.push(watcher);
        }
        next++;
        watches.set(id, w);
        return id;
      } catch (e) {
        close(w);
        caller.fail(err, `watch.start: ${at}: ${plainMessage(e)}`);
        return 0;
      }
    },
    stop(id) {
      const w = watches.get(id);
      if (!w) return;
      watches.delete(id);
      close(w);
      caller.forget(id);
    },
  });
}
