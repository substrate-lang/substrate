// Lifecycle: experimental.
//
// The host module "audio": lets a program play sounds. There are two
// kinds: sound files, and short tones that are made up on the spot, the
// kind a retro game uses for a jump or a coin.
//
// Usage, in the page:
//
//   import { audio } from './audio.mjs';
//   boot({ ..., modules: { audio: audio() } })
//
// What a program can call (a pointer is an address in its memory):
//
//   load (id, path, length)
//       Starts loading a sound file, and gives it the number `id`, which
//       the program chooses. The path names one of the program's files
//       (its assets are among them: see next/web/site.sh), or else is
//       taken as a URL. Any format that the browser can decode will do,
//       such as WAV, MP3 or Ogg.
//   loading () -> i32
//       How many sound files are still being loaded.
//   play (id, volume, rate, loop) -> voice
//       Plays sound `id`. `volume` is from 0 to 1. `rate` is the speed:
//       1 is the sound as recorded, 2 is twice as fast and an octave
//       higher. If `loop` is 1 the sound repeats until it is stopped.
//       Returns a number that stands for this playing of the sound, for
//       `stop`, or 0 if nothing is played (see below).
//   stop (voice)
//       Stops a sound that `play` started.
//   tone (wave, from, to, ms, volume)
//       Plays one tone. `wave` is the shape of the sound wave, which gives
//       the sound its character: 0 = square (the classic game beep),
//       1 = sawtooth (harsher), 2 = triangle (softer), 3 = sine (pure).
//       The pitch slides from `from` to `to`, in hertz, over `ms`
//       milliseconds, and the tone fades out over the same time. `volume`
//       is from 0 to 1.
//
// next/web/game/sound.sub is the program's side of this.
//
// A browser does not let a page make any sound until the user has
// pressed a key or clicked. This module listens for the first key press
// or click itself, so a program does not have to care. Until then:
//   - a tone, or a sound that plays once, is silently dropped;
//   - a sound that loops (music, usually) is remembered, and starts as
//     soon as it can.
// The same goes for a sound that is asked for before its file has
// arrived.
//
// audio() returns the module, with extra properties for tests:
//   running()   true once the browser allows the page to make sound
//   played()    how many tones and sounds the program has asked for so
//               far, whether or not they could be heard
//   loaded()    how many sound files have been loaded and decoded
//   started()   how many sounds from files have actually started playing
//   playing()   how many of them are playing now
import { resolvePath } from './subhost-web.mjs';

export function audio() {
  // The browser's audio output. Created on the first key press or click.
  let context = null;
  let played = 0;
  let started = 0;

  // The sound files that have been decoded, by the program's numbers,
  // and how many are still on their way.
  const sounds = new Map();
  let loading = 0;
  // Decoding needs an audio context, but the one for output cannot be
  // made before the user's first key press. A context that renders to
  // memory can, and what it decodes can be played by any other context.
  let decoder = null;

  // The sounds that are playing, by voice number, and the looping sounds
  // that are waiting to start: voice -> { id, volume, rate }.
  const voices = new Map();
  const waiting = new Map();
  let nextVoice = 1;

  function start(voice, buffer, volume, rate, loop) {
    // A source plays the decoded sound; a gain node sets its volume.
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

  // Starts the looping sounds that were waiting, if they now can start.
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
    load(id, ptr, length) {
      const name = caller.string(ptr, length);
      const bytes = app.files.get(resolvePath(app.cwd, name));
      if (!decoder) decoder = new OfflineAudioContext(1, 1, 44100);
      loading++;
      // Decoding takes the bytes away from whoever passes them, so a file
      // of the program's is copied first.
      const data = bytes
        ? Promise.resolve(bytes.slice().buffer)
        : fetch(name).then((response) => {
          if (!response.ok) throw new Error(`the server answered ${response.status}`);
          return response.arrayBuffer();
        });
      data.then((buffer) => decoder.decodeAudioData(buffer)).then(
        (decoded) => sounds.set(id, decoded),
        (e) => console.error(`audio: cannot load the sound ${name}: ${e.message}`),
      ).finally(() => {
        loading--;
        startWaiting();
      });
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
      // An oscillator makes the tone; a gain node sets its volume.
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = shapes[wave] || 'square';
      oscillator.frequency.setValueAtTime(from, start);
      oscillator.frequency.linearRampToValueAtTime(to, end);
      // Fading to silence avoids the click that an abrupt stop makes.
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
