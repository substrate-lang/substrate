// The host module "files" (files.sub).
import { errors } from '../errors.mjs';
import { readerSource } from '../streams.mjs';

const utf8 = new TextEncoder();

const SOURCE = 14;
const FILE = 1;
const PICKED = 2;
const FAILED = 3;

export function files() {
  return (caller) => {
    let next = 1;
    let ended = false;
    return {
      source: SOURCE,
      end() {
        ended = true;
      },
      pick(multiple, ap, al, tag, err) {
        const id = next++;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = multiple !== 0;
        input.accept = caller.string(ap, al);
        input.style.display = 'none';
        input.onchange = () => {
          input.remove();
          if (ended) return;
          for (const f of input.files) {
            const stream = caller.streams.add(tag, readerSource(() => f.stream().getReader(), () => {}));
            caller.event(FILE, id, tag, stream, utf8.encode(f.name));
          }
          caller.event(PICKED, id, tag, input.files.length);
        };
        input.oncancel = () => {
          input.remove();
          if (!ended) caller.event(FAILED, id, tag, errors.aborted, utf8.encode('cancelled'));
        };
        document.body.append(input);
        try {
          input.showPicker();
        } catch (e) {
          input.remove();
          caller.fail(err, e.message);
          return 0;
        }
        return id;
      },
      save(np, nl, ptr, len) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([caller.memory().slice(caller.u(ptr), caller.u(ptr) + len)]));
        a.download = caller.string(np, nl);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      },
    };
  };
}
