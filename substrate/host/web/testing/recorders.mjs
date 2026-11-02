// What a Chromium page keeps for browser tests, as the simulated browser keeps it: each canvas's last 2D drawing, the
// sounds played, the blobs and bytes that images and sounds are made from, which kind of context each canvas has, each
// WebGPU canvas's last frame, and the work the page is waiting on. substrate/host/node/chromium.mjs sends
// installRecorders' text to run before the page's scripts, so it may use nothing outside itself.
export function installRecorders(window, clock, site) {
  const drawings = new WeakMap();
  const kinds = new WeakMap();
  const blobs = new Map();
  const decoded = new WeakMap();
  const sounds = [];

  // The work the page is waiting on, by kind, as the simulated browser counts it: fetches of the site's files, images,
  // sounds, audio starting, storage, the clipboard and the GPU.
  const waiting = new Map();
  const idlers = [];
  const wait = (kind) => waiting.set(kind, (waiting.get(kind) || 0) + 1);
  const done = (kind) => {
    if (waiting.get(kind) > 1) waiting.set(kind, waiting.get(kind) - 1);
    else waiting.delete(kind);
    if (waiting.size === 0) for (const resolve of idlers.splice(0)) resolve();
  };
  const idle = () => new Promise((resolve) => (waiting.size === 0 ? resolve() : idlers.push(resolve)));
  const tracked = (kind, start) => {
    wait(kind);
    let p;
    try {
      p = start();
    } catch (e) {
      done(kind);
      throw e;
    }
    return Promise.resolve(p).finally(() => done(kind));
  };
  const counted = (proto, name, kind) => {
    const f = proto && proto[name];
    if (typeof f !== 'function') return;
    proto[name] = function counting(...args) {
      return tracked(kind, () => f.apply(this, args));
    };
  };
  const until = (target, kind, events) => {
    wait(kind);
    const finished = () => {
      for (const e of events) target.removeEventListener(e, finished);
      done(kind);
    };
    for (const e of events) target.addEventListener(e, finished);
  };

  if (location.origin === site) {
    const fetched = new WeakSet();
    const fetch = window.fetch;
    window.fetch = function fetching(...args) {
      return tracked('a fetch', () => fetch.apply(this, args).then((r) => {
        fetched.add(r);
        return r;
      }));
    };
    for (const name of ['arrayBuffer', 'blob', 'bytes', 'json', 'text']) {
      const read = Response.prototype[name];
      if (typeof read !== 'function') continue;
      Response.prototype[name] = function reading(...args) {
        return fetched.has(this) ? tracked('a fetch', () => read.apply(this, args)) : read.apply(this, args);
      };
    }
  }

  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  const loading = new WeakSet();
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...src,
    set(value) {
      src.set.call(this, value);
      if (this.complete || loading.has(this)) return;
      loading.add(this);
      wait('an image');
      const loaded = () => {
        this.removeEventListener('load', loaded);
        this.removeEventListener('error', loaded);
        loading.delete(this);
        done('an image');
      };
      this.addEventListener('load', loaded);
      this.addEventListener('error', loaded);
    },
  });
  const bitmap = window.createImageBitmap;
  window.createImageBitmap = function createImageBitmap(...args) {
    return tracked('an image', () => bitmap.apply(this, args));
  };

  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function opening(...args) {
    const r = open.apply(this, args);
    until(r, 'storage', ['success', 'error']);
    return r;
  };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function transacting(...args) {
    const t = transaction.apply(this, args);
    until(t, 'storage', ['complete', 'abort']);
    return t;
  };
  if (window.Clipboard) for (const name of ['readText', 'writeText']) counted(Clipboard.prototype, name, 'the clipboard');

  const resume = AudioContext.prototype.resume;
  AudioContext.prototype.resume = function resuming(...args) {
    if (!navigator.userActivation.isActive) return resume.apply(this, args);
    return tracked('audio starting', () => resume.apply(this, args));
  };

  if (window.GPU) {
    counted(GPU.prototype, 'requestAdapter', 'the GPU');
    counted(GPUAdapter.prototype, 'requestDevice', 'the GPU');
    counted(GPUDevice.prototype, 'popErrorScope', 'the GPU');
    counted(GPUDevice.prototype, 'createRenderPipelineAsync', 'the GPU');
    counted(GPUDevice.prototype, 'createComputePipelineAsync', 'the GPU');
    counted(GPUShaderModule.prototype, 'getCompilationInfo', 'the GPU');
    counted(GPUBuffer.prototype, 'mapAsync', 'the GPU');
    counted(GPUQueue.prototype, 'onSubmittedWorkDone', 'the GPU');
  }

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
    return tracked('a sound', () => decode.call(this, data, ...rest)).then((buffer) => {
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

  return { drawings, blobs, decoded, sounds, kinds, getContext, frames, waiting, idle };
}
