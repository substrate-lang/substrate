// Lists cross the boundary as entries, each ended by a zero byte.
export const entries = (text) => (text === '' ? [] : text.replace(/\0$/, '').split('\0'));
export const joined = (list) => list.map((e) => `${e}\0`).join('');
