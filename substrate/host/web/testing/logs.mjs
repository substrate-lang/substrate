// The text that browser tests read for a page's drawings and sounds, in both browsers. A 2D drawing is one line per
// call or setting, and each sound gives a line when it starts, stops or ends.
import { describe, parse } from './find.mjs';
import { one, short } from './requests.mjs';

export const number = (x) => String(Number(Number(x).toFixed(3)));
export const quoted = (s) => JSON.stringify(String(s));

const settings = {
  fillStyle: 'fill-style', strokeStyle: 'stroke-style', lineWidth: 'line-width', font: 'font', textAlign: 'text-align',
  textBaseline: 'text-baseline', globalAlpha: 'global-alpha',
};
const numeric = new Set(['lineWidth', 'globalAlpha']);
const calls = {
  clearRect: ['clear-rect', 4], fillRect: ['fill-rect', 4], strokeRect: ['stroke-rect', 4], beginPath: ['begin-path', 0],
  moveTo: ['move-to', 2], lineTo: ['line-to', 2], arc: ['arc', 5], closePath: ['close-path', 0], fill: ['fill', 0],
  stroke: ['stroke', 0], save: ['save', 0], restore: ['restore', 0], translate: ['translate', 2], rotate: ['rotate', 1],
  scale: ['scale', 2],
};

// drawn gives the line for a 2D context's call or setting, or null for one that drawings leave out. nameOf names drawn
// images.
export function drawn(name, args, nameOf) {
  if (settings[name]) return `${settings[name]} ${numeric.has(name) ? number(args[0]) : quoted(args[0])}`;
  if (name === 'fillText') return `fill-text ${quoted(args[0])} ${number(args[1])} ${number(args[2])}`;
  if (name === 'drawImage') return ['draw-image', quoted(nameOf(args[0])), ...args.slice(1).map(number)].join(' ');
  const c = calls[name];
  return c ? [c[0], ...args.slice(0, c[1]).map(number)].join(' ') : null;
}

export function heard(s) {
  switch (s.kind) {
    case 'start':
      return `start ${quoted(s.name)} volume ${number(s.volume)}${s.loop ? ' looping' : ''}`;
    case 'stop':
      return `stop ${quoted(s.name)}`;
    case 'end':
      return `end ${quoted(s.name)}`;
    default:
      return `tone ${s.type} ${number(s.first)} ${number(s.last)} ${number(s.ms)} ms`;
  }
}

export function canvasOf(document, f) {
  const e = one(document, f);
  if (e.localName !== 'canvas') throw new Error(`${describe(f)} is not a canvas\n  it is ${short(e)}`);
  return e;
}

const includes = (drawing, lines) => `\n${drawing}\n`.includes(`\n${lines}\n`);
const indented = (s) => s.replace(/\n/g, '\n  ');

// drawingRequest answers a request about a canvas's last drawing, which drawingOf gives for a finder. It gives
// undefined for any other request.
export async function drawingRequest(fields, drawingOf) {
  switch (fields[0]) {
    case 'drawing':
      return drawingOf(parse(fields, 1)[0]);
    case 'drawn': {
      const [f, k] = parse(fields, 1);
      return includes(await drawingOf(f), fields[k]) ? 'true' : 'false';
    }
    case 'expect-drawn': {
      const [f, k] = parse(fields, 1);
      const drawing = await drawingOf(f);
      if (!includes(drawing, fields[k])) {
        throw new Error(`the last drawing of ${describe(f)} does not include\n  ${indented(fields[k])}\nit is\n  ${indented(drawing)}`);
      }
      return '';
    }
    default:
      return undefined;
  }
}
