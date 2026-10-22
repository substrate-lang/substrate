// The host module "audio": sound files and synthesized tones.
import { resolvePath } from './subhost-web.mjs';
import { errors } from '../subhost-core.mjs';

const utf8 = new TextEncoder();

const SOURCE = 4;
const LOADED = 1;
const FAILED = 2;

export function audio() {
  let context = null;
  let played = 0;
  let started = 0;

  const sounds = new Map();
  let loading = 0;
  let decoder = null;

  const voices = new Map();
  const waiting = new Map();
  let nextVoice = 1;

  function start(voice, buffer, volume, rate, loop) {
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = rate;
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    source.onended = () => voices.delete(voice);
    source.start();
    voices.set(voice, source);
    started++;
  }

  function startWaiting() {
    if (!context || context.state !== 'running') return;
    for (const [voice, { id, volume, rate }] of [...waiting]) {
      const buffer = sounds.get(id);
      if (!buffer) continue;
      waiting.delete(voice);
      start(voice, buffer, volume, rate, true);
    }
  }

  const unlock = () => {
    if (!context) {
      context = new AudioContext();
      context.addEventListener('statechange', startWaiting);
    }
    if (context.state === 'suspended') context.resume();
    startWaiting();
  };
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);

  const shapes = ['square', 'sawtooth', 'triangle', 'sine'];

  const module = (caller, app) => ({
    source: SOURCE,
    load(id, ptr, length) {
      const name = caller.string(ptr, length);
      const bytes = app.files.get(resolvePath(app.cwd, name));
      if (!decoder) decoder = new OfflineAudioContext(1, 1, 44100);
      loading++;
      const data = bytes
        ? Promise.resolve(bytes.slice().buffer)
        : fetch(name).then((response) => {
          if (!response.ok) throw new Error(`the server answered ${response.status}`);
          return response.arrayBuffer();
        });
      data.then((buffer) => decoder.decodeAudioData(buffer)).then(
        (decoded) => {
          sounds.set(id, decoded);
          loading--;
          startWaiting();
          caller.event(LOADED, id, 0, 0);
        },
        (e) => {
          console.error(`audio: cannot load the sound ${name}: ${e.message}`);
          loading--;
          startWaiting();
          caller.event(FAILED, id, 0, e.name === 'EncodingError' ? errors.invalid : errors.missing,
            utf8.encode(`cannot load the sound ${name}: ${e.message}`));
        },
      );
    },
    loading() {
      return loading;
    },
    play(id, volume, rate, loop) {
      played++;
      const buffer = sounds.get(id);
      const voice = nextVoice++;
      if (buffer && context && context.state === 'running') {
        start(voice, buffer, volume, rate, loop !== 0);
        return voice;
      }
      if (loop === 0) return 0;
      waiting.set(voice, { id, volume, rate });
      return voice;
    },
    stop(voice) {
      waiting.delete(voice);
      const source = voices.get(voice);
      if (source) {
        voices.delete(voice);
        source.stop();
      }
    },
    tone(wave, from, to, ms, volume) {
      played++;
      if (!context || context.state !== 'running') return;
      const start = context.currentTime;
      const end = start + ms / 1000;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = shapes[wave] || 'square';
      oscillator.frequency.setValueAtTime(from, start);
      oscillator.frequency.linearRampToValueAtTime(to, end);
      gain.gain.setValueAtTime(volume, start);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end);
    },
  });
  module.running = () => context !== null && context.state === 'running';
  module.played = () => played;
  module.loaded = () => sounds.size;
  module.started = () => started;
  module.playing = () => voices.size;
  return module;
}
