// Settings as lines of "word value", each given to f, which refuses one it does not know.
export function settings(text, who, f) {
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    const word = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (word !== '' && !f(word, value)) throw new Error(`${who}: unknown setting "${word}"`);
  }
}
