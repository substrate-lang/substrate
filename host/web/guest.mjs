// The host module "guest" in a browser: the worker is a Web Worker, and the program's files are the page's.
import { resolvePath } from './subhost-web.mjs';
import { guestModule } from '../guest.mjs';
import { isUnder } from '../guest-side.mjs';

const text = new TextDecoder();

export function guests() {
  return guestModule((spec, app) => {
    const files = app.files;
    const dir = resolvePath(app.cwd, spec.program);
    const list = files.get(`${dir}/program`);
    if (!list) throw new Error(`guest.start: no program found in ${spec.program}`);
    const names = text.decode(list).split('\n').filter((n) => n !== '');
    const wasm = new Map();
    for (const name of names) {
      const bytes = files.get(`${dir}/${name}.wasm`);
      if (!bytes) throw new Error(`guest.start: the program in ${spec.program} is missing ${name}.wasm`);
      wasm.set(name, bytes);
    }
    const readable = spec.read.map((d) => resolvePath(app.cwd, d));
    const granted = new Map();
    for (const [path, bytes] of files) if (readable.some((d) => isUnder(d, path))) granted.set(path, bytes);
    const worker = new Worker(new URL('./guest-worker.mjs', import.meta.url), { type: 'module' });
    worker.postMessage({
      type: 'start',
      names,
      wasm,
      files: granted,
      args: spec.args,
      cwd: app.cwd,
      writable: spec.write.map((d) => resolvePath(app.cwd, d)),
      modules: spec.modules,
      memory: spec.memory,
    });
    return {
      post: (m, transfer) => worker.postMessage(m, transfer),
      terminate: () => worker.terminate(),
      onMessage: (f) => {
        worker.onmessage = (e) => f(e.data);
      },
      onError: (f) => {
        worker.onerror = (e) => {
          e.preventDefault();
          f(`error: ${e.message || 'the worker failed'}`);
        };
      },
    };
  });
}
