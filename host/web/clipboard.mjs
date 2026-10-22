// The host module "clipboard": text, read and written with the user's leave.
// Kinds: text 1, bytes the text; written 2; failed 3, value the error code.
import { errorOf } from '../errors.mjs';

const utf8 = new TextEncoder();

const SOURCE = 13;
const TEXT = 1;
const WRITTEN = 2;
const FAILED = 3;

export function clipboard() {
  return (caller) => {
    let next = 1;
    let ended = false;
    const attempt = (tag, ask, answer) => {
      if (!navigator.clipboard) {
        caller.error('clipboard: none');
        return 0;
      }
      const id = next++;
      ask().then((result) => {
        if (!ended) answer(id, result);
      }, (e) => {
        if (!ended) caller.event(FAILED, id, tag, errorOf(e), utf8.encode(e.message));
      });
      return id;
    };
    return {
      source: SOURCE,
      end() {
        ended = true;
      },
      read: (tag) => attempt(tag, () => navigator.clipboard.readText(), (id, text) => caller.event(TEXT, id, tag, 0, utf8.encode(text))),
      write(ptr, len, tag) {
        const text = caller.string(ptr, len);
        return attempt(tag, () => navigator.clipboard.writeText(text), (id) => caller.event(WRITTEN, id, tag, 0));
      },
    };
  };
}
