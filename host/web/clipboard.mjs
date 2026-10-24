// The host module "clipboard" (clipboard.sub).
import { errorOf, reasonOf } from '../errors.mjs';

const utf8 = new TextEncoder();

const SOURCE = 13;
const TEXT = 1;
const WRITTEN = 2;
const FAILED = 3;

export function clipboard() {
  return (caller) => {
    let next = 1;
    let ended = false;
    const attempt = (tag, err, ask, answer) => {
      if (!navigator.clipboard) {
        caller.fail(err, 'clipboard: none');
        return 0;
      }
      const id = next++;
      ask().then((result) => {
        if (!ended) answer(id, result);
      }, (e) => {
        if (!ended) caller.event(FAILED, id, tag, errorOf(e), utf8.encode(reasonOf(e)));
      });
      return id;
    };
    return {
      source: SOURCE,
      end() {
        ended = true;
      },
      read: (tag, err) => attempt(tag, err, () => navigator.clipboard.readText(),
        (id, text) => caller.event(TEXT, id, tag, 0, utf8.encode(text))),
      write(ptr, len, tag, err) {
        const text = caller.string(ptr, len);
        return attempt(tag, err, () => navigator.clipboard.writeText(text), (id) => caller.event(WRITTEN, id, tag, 0));
      },
    };
  };
}
