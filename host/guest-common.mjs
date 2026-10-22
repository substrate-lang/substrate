// What the guest module's browser and Node sides share: specs, directory checks, and a guest's output batches.
const utf8 = new TextEncoder();

export function parseSpec(spec) {
  const result = { program: null, args: [], read: [], write: [], time: 0, memory: 0 };
  const positiveInteger = (word, value) => {
    if (!/^[0-9]+$/.test(value) || Number(value) === 0) {
      throw new Error(`guest.start: "${word}" needs a positive whole number, not "${value}"`);
    }
    return Number(value);
  };
  for (const line of spec.split('\n')) {
    if (line.trim() === '') continue;
    const space = line.indexOf(' ');
    const word = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (word === 'program') result.program = value;
    else if (word === 'arg') result.args.push(value);
    else if (word === 'read') result.read.push(value);
    else if (word === 'write') result.write.push(value);
    else if (word === 'time') result.time = positiveInteger(word, value);
    else if (word === 'memory') result.memory = positiveInteger(word, value);
    else throw new Error(`guest.start: unknown setting "${word}" in the spec`);
  }
  if (result.program === null) throw new Error('guest.start: the spec has no "program" line');
  return result;
}

export const isUnder = (dir, path) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`);

export function batcher(post) {
  const pieces = [];
  let pendingBytes = 0;
  let droppedBytes = 0;
  let lastSend = 0;
  const maxPending = 1 << 20;

  function flush() {
    lastSend = performance.now();
    if (droppedBytes > 0) {
      pieces.push([2, utf8.encode(`\n... ${droppedBytes} bytes of output dropped\n`)]);
      droppedBytes = 0;
    }
    for (let i = 0; i < pieces.length; ) {
      const fd = pieces[i][0];
      let j = i;
      let length = 0;
      for (; j < pieces.length && pieces[j][0] === fd; j++) length += pieces[j][1].length;
      const bytes = new Uint8Array(length);
      for (let at = 0; i < j; i++) {
        bytes.set(pieces[i][1], at);
        at += pieces[i][1].length;
      }
      post(fd, bytes);
    }
    pieces.length = 0;
    pendingBytes = 0;
  }

  function output(fd, bytes) {
    if (pendingBytes + bytes.length > maxPending) droppedBytes += bytes.length;
    else {
      pieces.push([fd, bytes.slice()]);
      pendingBytes += bytes.length;
    }
    if (performance.now() - lastSend >= 30) flush();
  }

  return { output, flush };
}
