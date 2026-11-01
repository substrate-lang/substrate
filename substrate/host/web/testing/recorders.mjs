// What a Chromium page keeps for browser tests, as the simulated browser keeps it: each canvas's last 2D drawing, the
// sounds played, the blobs and bytes that images and sounds are made from, which kind of context each canvas has, and
// each WebGPU canvas's last frame. substrate/host/node/chromium.mjs sends
// installRecorders' text to run before the page's scripts, so it may use nothing outside itself.
export function installRecorders(window, clock) {
  const drawings = new WeakMap();
  const kinds = new WeakMap();
  const blobs = new Map();
  const decoded = new WeakMap();
  const sounds = [];

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function made(object) {
    const url = createObjectURL.call(URL, object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };

  // Each call starts a new drawing of the canvas, as the web host's draw patches call it once for each.
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function context(kind, ...rest) {
    const given = getContext.call(this, kind, ...rest);
    if (given !== null && !kinds.has(this)) kinds.set(this, kind);
    if (kind !== '2d' || given === null) return given;
    const calls = [];
    drawings.set(this, calls);
    return new Proxy(given, {
      get(target, name) {
        const v = Reflect.get(target, name);
        if (typeof v !== 'function') return v;
        return (...args) => {
          calls.push([name, args]);
          return v.apply(target, args);
        };
      },
      set(target, name, value) {
        calls.push([name, [value]]);
        return Reflect.set(target, name, value);
      },
    });
  };

  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function decodeAudioData(data, ...rest) {
    const bytes = new Uint8Array(data.slice(0));
    return decode.call(this, data, ...rest).then((buffer) => {
      decoded.set(buffer, bytes);
      return buffer;
    });
  };

  const targets = new WeakMap();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function connected(node, ...rest) {
    if (!targets.has(this)) targets.set(this, node);
    return connect.call(this, node, ...rest);
  };

  // A sound that does not loop ends when its length has passed on the page's clock, as in the simulated browser.
  const playing = new WeakMap();
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function started(...args) {
    const next = targets.get(this);
    const state = { done: false, timer: null };
    playing.set(this, state);
    sounds.push({ kind: 'start', buffer: this.buffer, volume: next && next.gain ? next.gain.value : 1, loop: this.loop });
    if (!this.loop) {
      state.timer = clock.setTimeout(() => {
        state.done = true;
        sounds.push({ kind: 'end', buffer: this.buffer });
      }, (this.buffer.duration * 1000) / this.playbackRate.value);
    }
    return start.apply(this, args);
  };
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function stopped(...args) {
    const state = playing.get(this);
    if (state && !state.done) {
      state.done = true;
      clock.clearTimeout(state.timer);
      sounds.push({ kind: 'stop', buffer: this.buffer });
    }
    return stop.apply(this, args);
  };

  const ramps = new WeakMap();
  const setValueAtTime = AudioParam.prototype.setValueAtTime;
  AudioParam.prototype.setValueAtTime = function set(value, ...rest) {
    ramps.set(this, { ...ramps.get(this), first: value });
    return setValueAtTime.call(this, value, ...rest);
  };
  const linearRamp = AudioParam.prototype.linearRampToValueAtTime;
  AudioParam.prototype.linearRampToValueAtTime = function ramped(value, ...rest) {
    ramps.set(this, { ...ramps.get(this), last: value });
    return linearRamp.call(this, value, ...rest);
  };
  const begun = new WeakMap();
  const scheduledStart = AudioScheduledSourceNode.prototype.start;
  const scheduledStop = AudioScheduledSourceNode.prototype.stop;
  OscillatorNode.prototype.start = function toneStarted(at, ...rest) {
    begun.set(this, at);
    return scheduledStart.call(this, at, ...rest);
  };
  OscillatorNode.prototype.stop = function toneStopped(end, ...rest) {
    const { first = this.frequency.value, last = this.frequency.value } = ramps.get(this.frequency) || {};
    sounds.push({ kind: 'tone', type: this.type, first, last, ms: (end - (begun.get(this) ?? 0)) * 1000 });
    return scheduledStop.call(this, end, ...rest);
  };

  // A WebGPU canvas shows its frame only until the next, and reading it gives nothing once it is shown, so each frame
  // is copied, after the work drawing it is submitted, into a texture kept for the canvas.
  const frames = new WeakMap();
  if (window.GPUCanvasContext) {
    const configured = new WeakMap();
    const configure = GPUCanvasContext.prototype.configure;
    GPUCanvasContext.prototype.configure = function configuring(c) {
      configured.set(this, c);
      return configure.call(this, c);
    };
    const drawing = new Map();
    const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function current() {
      const texture = getCurrentTexture.call(this);
      if (!drawing.has(this)) queueMicrotask(() => drawing.delete(this));
      drawing.set(this, texture);
      return texture;
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function submitted(buffers) {
      const r = submit.call(this, buffers);
      for (const [context, texture] of drawing) {
        const c = configured.get(context);
        if (!c || c.device.queue !== this || !(c.usage & GPUTextureUsage.COPY_SRC)) continue;
        let kept = frames.get(context.canvas);
        if (!kept || kept.texture.width !== texture.width || kept.texture.height !== texture.height) {
          if (kept) kept.texture.destroy();
          kept = { device: c.device, texture: c.device.createTexture({
            size: [texture.width, texture.height], format: texture.format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
          }) };
          frames.set(context.canvas, kept);
        }
        const encoder = c.device.createCommandEncoder();
        encoder.copyTextureToTexture({ texture }, { texture: kept.texture }, [texture.width, texture.height]);
        submit.call(this, [encoder.finish()]);
      }
      return r;
    };
  }

  return { drawings, blobs, decoded, sounds, kinds, getContext, frames };
}
