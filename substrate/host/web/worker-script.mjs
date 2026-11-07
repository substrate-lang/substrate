// Runs a worker in a Web Worker. The worker can use its side of the worker module and the page's modules that a
// worker may have, within its grants, with the fakes it was given in place of the modules they fake. Its files are a
// read-only copy of the page's files.
import { run } from './subhost-web.mjs';
import { fsModule } from '../fs.mjs';
import { pageFiles, resolvePath } from './fs.mjs';
import { workerSide } from '../worker-side.mjs';

const loaders = {
  clock: () => import('../modules/clock.mjs').then((m) => m.clock()),
  random: () => import('../modules/random.mjs').then((m) => m.random()),
  timer: () => import('../modules/timer.mjs').then((m) => m.timer()),
  fetch: (grants) => import('../modules/fetch.mjs').then((m) => m.fetchModule(grants)),
  websocket: (grants) => import('../modules/websocket.mjs').then((m) => m.websocket(grants)),
};

function readOnly(files) {
  const refused = () => {
    throw new Error('Read-only file system');
  };
  return {
    ...files,
    write: refused,
    makeDir: refused,
    remove: refused,
    rename: refused,
    symlink: refused,
    copy: refused,
    chmod: refused,
    makeTemp: refused,
    openFile: (p, how) => (how.write || how.append || how.truncate || how.create || how.createNew
      ? refused() : files.openFile(p, how)),
  };
}

async function fakesOf(m) {
  if (m.fakes.length === 0) return new Map();
  const { fakeModules } = await import('../modules/fake.mjs');
  const read = (dir, path) => {
    const bytes = m.files.get(resolvePath(m.cwd, `${dir}/${path}`));
    if (!bytes) throw new Error('No such file or directory');
    return bytes;
  };
  return fakeModules({ grants: m.grants, fakes: new Map(m.fakes) }, read);
}

const side = workerSide((m, transfer) => self.postMessage(m, transfer));

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'start') {
    if (m.heard) side.limitOutput();
    const wasm = new Map(m.modules);
    const modules = { worker: side.worker, fs: fsModule(readOnly(pageFiles(m.files, m.cwd, m.grants))) };
    const absent = new Set();
    const fakes = await fakesOf(m);
    for (const name of m.names) {
      if (name in modules) continue;
      if (fakes.has(name)) modules[name] = fakes.get(name);
      else if (loaders[name]) modules[name] = await loaders[name](m.grants);
      else absent.add(name);
    }
    const app = run({
      args: m.args ?? [m.argument],
      compiled: m.compiled,
      files: m.files,
      cwd: m.cwd,
      output: side.write,
      memoryPages: m.pages,
      modules,
      absent,
      grants: m.grants,
      entry: m.entry,
      onEnd: side.ended,
      delivered: side.delivered,
      active: side.active,
    }, [...wasm.keys()], wasm);
    if (app.entry && typeof app.worker !== 'function' && !app.ended) {
      side.ended(2, `worker.start: no function ${m.entry[1]} in ${m.entry[0]}`);
      return;
    }
    side.started(app.host, app.started);
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
};
