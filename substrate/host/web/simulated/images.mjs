// Reads an image's width and height from the header of a PNG, GIF, JPEG, BMP or WebP file, or gives null.
export function sizeOf(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at, n) => String.fromCharCode(...b.subarray(at, at + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return [view.getUint32(16), view.getUint32(20)];
  if (b.length >= 10 && ascii(0, 4) === 'GIF8') return [view.getUint16(6, true), view.getUint16(8, true)];
  if (b.length >= 26 && ascii(0, 2) === 'BM') return [view.getInt32(18, true), Math.abs(view.getInt32(22, true))];
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    if (chunk === 'VP8X') return [(b[24] | (b[25] << 8) | (b[26] << 16)) + 1, (b[27] | (b[28] << 8) | (b[29] << 16)) + 1];
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let at = 2; at + 9 < b.length;) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      const length = view.getUint16(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [view.getUint16(at + 7), view.getUint16(at + 5)];
      }
      at += 2 + length;
    }
  }
  return null;
}
