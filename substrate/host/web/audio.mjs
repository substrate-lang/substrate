// Lifecycle: experimental.
//
// The host module "audio": lets a program play short synthesized sounds,
// the kind a retro game uses for a jump or a coin.
//
// Usage, in the page:
//
//   import { audio } from './audio.mjs';
//   boot({ ..., modules: { audio: audio() } })
//
// What a program can call:
//
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
// pressed a key or clicked. Until then, tones are silently dropped. This
// module listens for the first key press or click itself, so a program
// does not have to care.
//
// audio() returns the module, with one extra property for tests:
// `played()` gives how many tones the program has asked for so far,
// whether or not they could be heard.
export function audio() {
  // The browser's audio output. Created on the first key press or click.
  let context = null;
  let played = 0;

  const unlock = () => {
    if (!context) context = new AudioContext();
    if (context.state === 'suspended') context.resume();
  };
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);

  const shapes = ['square', 'sawtooth', 'triangle', 'sine'];

  const module = () => ({
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
  module.played = () => played;
  return module;
}
