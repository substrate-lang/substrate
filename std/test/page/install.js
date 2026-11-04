// Runs in each page that a browser test opens, before the page's own scripts (std/test/page.sub). It installs the
// test's clock, in which time moves only when a test advances it, and timers, animation frames at 60 a second, Date and
// performance all follow it; seeded random bytes; and recorders of what tests read from a page: drawings, sounds, the
// bytes behind images and sounds, and the work the page is waiting on. agent.mjs finds them all on the window.
(() => {
  function makeClock(epoch = 1700000000000) {
    let now = 0;
    let next = 1;
    let frame = 0;
    const timers = new Map();
    const frames = new Map();

    const add = (f, ms, args, every) => {
      const id = next++;
      timers.set(id, { id, due: now + Math.max(0, Number(ms) || 0), f, args, every, order: id });
      return id;
    };
    const earliest = () => {
      let first = null;
      for (const t of timers.values()) if (first === null || t.due < first.due || (t.due === first.due && t.order < first.order)) first = t;
      return first;
    };
    const fire = (t) => {
      if (t.every === null) timers.delete(t.id);
      else {
        t.due += t.every;
        t.order = next++;
      }
      t.f(...t.args);
    };
    const nextFrame = () => ((Math.floor((now * 60) / 1000 + 1e-9) + 1) * 1000) / 60;

    return {
      epoch,
      now: () => now,
      setTimeout: (f, ms, ...args) => add(f, ms, args, null),
      setInterval: (f, ms, ...args) => add(f, ms, args, Math.max(1, Number(ms) || 0)),
      clearTimeout: (id) => timers.delete(id),
      clearInterval: (id) => timers.delete(id),
      requestAnimationFrame(f) {
        const id = next++;
        frames.set(id, f);
        return id;
      },
      cancelAnimationFrame: (id) => frames.delete(id),
      dueNow() {
        const t = earliest();
        if (t === null || t.due > now) return false;
        fire(t);
        return true;
      },
      // advance moves the clock ms ahead, running the timers and frames due on the way in time order and settling the
      // program after each.
      async advance(ms, settle) {
        const end = now + Math.max(0, ms);
        for (;;) {
          const t = earliest();
          const f = frames.size > 0 ? nextFrame() : Infinity;
          const at = Math.min(t === null ? Infinity : t.due, f);
          if (at > end) break;
          now = at;
          if (t !== null && t.due <= f) fire(t);
          else {
            frame++;
            const due = [...frames.values()];
            frames.clear();
            for (const callback of due) callback(now);
          }
          await settle();
        }
        now = end;
      },
      frames: () => frame,
    };
  }

  function installClock(g, clock) {
    const RealDate = Date;
    class SimulatedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(clock.epoch + Math.floor(clock.now()));
        else super(...args);
      }

      static now() {
        return clock.epoch + Math.floor(clock.now());
      }
    }
    Object.assign(g, {
      Date: SimulatedDate,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      requestAnimationFrame: clock.requestAnimationFrame,
      cancelAnimationFrame: clock.cancelAnimationFrame,
    });
    Object.defineProperty(g.Performance.prototype, 'now', { value: () => clock.now(), configurable: true, writable: true });
    Object.defineProperty(g.Performance.prototype, 'timeOrigin', { get: () => clock.epoch, configurable: true });
  }

  function seeded(seed) {
    let state = (seed >>> 0) || 1;
    return (bytes) => {
      for (let i = 0; i < bytes.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[i] = state & 0xff;
      }
    };
  }

  function installRecorders(window, clock, site) {
    const drawings = new WeakMap();
    const kinds = new WeakMap();
    const blobs = new Map();
    const decoded = new WeakMap();
    const sounds = [];

    // Counts the work the page is waiting on, by kind.
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

    // Fetches from the network, and reading their bodies, which settling waits for only while they make progress.
    const network = { count: 0, done: 0, pending: () => network.count, progress: () => network.done };
    const softly = (start) => {
      network.count++;
      let p;
      try {
        p = start();
      } catch (e) {
        network.count--;
        throw e;
      }
      return Promise.resolve(p).finally(() => {
        network.count--;
        network.done++;
      });
    };
    const local = new WeakMap();
    const fetch = window.fetch;
    window.fetch = function fetching(input, ...rest) {
      const given = input instanceof Request ? input.url : String(input);
      const mine = URL.canParse(given, location.href) && new URL(given, location.href).origin === site;
      const answered = (r) => {
        if (r.body) local.set(r.body, mine);
        return r;
      };
      return mine ? tracked('a fetch', () => fetch.call(this, input, ...rest).then(answered))
        : softly(() => fetch.call(this, input, ...rest).then(answered));
    };
    const whileReading = (body, start) => {
      if (!body || !local.has(body)) return start();
      return local.get(body) ? tracked('a fetch', start) : softly(start);
    };
    for (const name of ['arrayBuffer', 'blob', 'bytes', 'json', 'text']) {
      const read = Response.prototype[name];
      if (typeof read !== 'function') continue;
      Response.prototype[name] = function reading(...args) {
        return whileReading(this.body, () => read.apply(this, args));
      };
    }
    const bodyOf = new WeakMap();
    const getReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function reader(...args) {
      const r = getReader.apply(this, args);
      bodyOf.set(r, this);
      return r;
    };
    const read = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function reading(...args) {
      return whileReading(bodyOf.get(this), () => read.apply(this, args));
    };

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
      const requestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = function requesting(...args) {
        return tracked('the GPU', () => requestDevice.apply(this, args).then((device) => {
          device.lost.then((info) => {
            if (info.reason !== 'destroyed') console.error(`gpu: the device was lost: ${info.message}`);
          });
          return device;
        }));
      };
      counted(GPUDevice.prototype, 'popErrorScope', 'the GPU');
      counted(GPUDevice.prototype, 'createRenderPipelineAsync', 'the GPU');
      counted(GPUDevice.prototype, 'createComputePipelineAsync', 'the GPU');
      counted(GPUShaderModule.prototype, 'getCompilationInfo', 'the GPU');
      counted(GPUBuffer.prototype, 'mapAsync', 'the GPU');
      counted(GPUQueue.prototype, 'onSubmittedWorkDone', 'the GPU');
    }

    // The last frame drawn on each WebGPU canvas, copied as the page submits the work that draws it, since a frame that
    // has been shown cannot be read back.
    const frames = new WeakMap();
    if (window.GPUCanvasContext) {
      const devices = new WeakMap();
      const live = new Map();
      const configure = GPUCanvasContext.prototype.configure;
      GPUCanvasContext.prototype.configure = function configured(c) {
        devices.set(this, c.device);
        return configure.call(this, { ...c, usage: (c.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC });
      };
      const current = GPUCanvasContext.prototype.getCurrentTexture;
      GPUCanvasContext.prototype.getCurrentTexture = function currentTexture() {
        const texture = current.call(this);
        if (live.size === 0) queueMicrotask(() => live.clear());
        live.set(this, texture);
        return texture;
      };
      const submit = GPUQueue.prototype.submit;
      GPUQueue.prototype.submit = function submitted(buffers) {
        const r = submit.call(this, buffers);
        for (const [context, texture] of live) {
          const device = devices.get(context);
          if (!device || device.queue !== this) continue;
          let kept = frames.get(context.canvas);
          if (!kept || kept.texture.width !== texture.width || kept.texture.height !== texture.height) {
            kept = { device, texture: device.createTexture({ size: [texture.width, texture.height], format: texture.format,
              usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC }) };
            frames.set(context.canvas, kept);
          }
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToTexture({ texture }, { texture: kept.texture }, [texture.width, texture.height]);
          submit.call(this, [encoder.finish()]);
        }
        return r;
      };
    }

    // The navigation that is taking the page to another page, if any (page.sub waits for that page).
    let going = null;
    if (window.navigation) {
      window.navigation.addEventListener('navigate', (e) => {
        if (!e.destination.sameDocument && !e.downloadRequest) going = e;
      });
    }
    const leaving = () => going !== null && !going.defaultPrevented;

    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = function made(object) {
      const url = createObjectURL.call(URL, object);
      if (object instanceof Blob) blobs.set(url, object);
      return url;
    };

    // Each getContext call starts a new drawing, since the web host calls it once per drawing.
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

    // A sound that does not loop ends when its length has passed on the page's clock.
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

    return { drawings, frames, blobs, decoded, sounds, kinds, getContext, waiting, idle, network, leaving };
  }

  const clock = makeClock();
  const real = { now: Date.now.bind(Date), setTimeout: setTimeout.bind(window) };
  installClock(window, clock);
  Object.defineProperty(Event.prototype, 'timeStamp', { get: () => clock.now(), configurable: true });
  const fill = seeded(1);
  Crypto.prototype.getRandomValues = function getRandomValues(a) {
    fill(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return a;
  };
  Object.defineProperty(window, Symbol.for('substrate.testing'), {
    value: { clock, real, ...installRecorders(window, clock, 'http://localhost') },
  });
})();
