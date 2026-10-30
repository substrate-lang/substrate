// The host module "stdin": the program's standard input, as a stream.
import { nodeSource } from '../streams.mjs';

export function stdin() {
  let id = 0;
  return (caller) => ({
    stream() {
      if (id === 0) id = caller.streams.add(0, nodeSource(process.stdin));
      return id;
    },
  });
}
