// Keys as browser tests name them, for both browsers: a key's name or one character, and the modifiers held with it.
export const keyNames = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp',
  'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock',
  'ContextMenu', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
export const modifiers = { Shift: 'shiftKey', Control: 'ctrlKey', Alt: 'altKey', Meta: 'metaKey' };
const punctuation = { '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote' };

export const codeOf = (key) => {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  if (keyNames.has(key)) return key;
  return punctuation[key] || '';
};

// parseKey reads a key as browser-press! takes it: a key's name or one character, after any of Shift, Control, Alt and
// Meta, each followed by +, as in "Shift+Enter".
export function parseKey(spec) {
  const m = /^((?:(?:Shift|Control|Alt|Meta)\+)*)(.+)$/.exec(spec);
  const held = {};
  if (!m) throw new Error(`${JSON.stringify(spec)} is not a key`);
  for (const name of m[1].split('+').filter(Boolean)) held[modifiers[name]] = true;
  let key = m[2] === 'Space' ? ' ' : m[2];
  if (!keyNames.has(key) && [...key].length !== 1) throw new Error(`${JSON.stringify(spec)} is not a key: a key is a name such as Enter, or one character`);
  if (held.shiftKey && /^[a-z]$/.test(key)) key = key.toUpperCase();
  return { key, held };
}
