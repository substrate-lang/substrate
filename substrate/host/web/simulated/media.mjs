// The simulated browser's Web Audio and WebGPU, with as much of each as the web host's audio and gpu modules use.
// Sounds are recorded as the lines browser-sounds gives. The GPU draws nothing, and reading it back gives zeros.
import { Event, EventTarget } from './document.mjs';
import { sizeOf } from './images.mjs';
import { heard } from '../testing/logs.mjs';

function wavSeconds(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at) => String.fromCharCode(...b.subarray(at, at + 4));
  if (b.length < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= b.length; at += 8 + view.getUint32(at + 4, true) + (view.getUint32(at + 4, true) & 1)) {
    const size = view.getUint32(at + 4, true);
    if (ascii(at) === 'fmt ' && size >= 16) byteRate = view.getUint32(at + 16, true);
    if (ascii(at) === 'data' && byteRate > 0) return size / byteRate;
  }
  return null;
}

// browser gives the document, the clock and later, plus nameOf to name a file by its bytes and sound to record a line.
export function makeAudio(browser) {
  const param = (value) => ({
    value,
    setValueAtTime(v) {
      this.value = v;
      this.first = v;
    },
    linearRampToValueAtTime(v) {
      this.last = v;
    },
  });
  class Source {
    constructor() {
      this.buffer = null;
      this.loop = false;
      this.playbackRate = param(1);
      this.onended = null;
      this.next = null;
      this.done = false;
    }

    connect(node) {
      this.next = node;
      return node;
    }

    start() {
      const volume = this.next && this.next.gain ? this.next.gain.value : 1;
      browser.sound(heard({ kind: 'start', name: this.buffer.name, volume, loop: this.loop }));
      if (!this.loop) this.timer = browser.clock().setTimeout(() => this.ended(true), (this.buffer.duration * 1000) / this.playbackRate.value);
    }

    stop() {
      if (this.done) return;
      browser.sound(heard({ kind: 'stop', name: this.buffer.name }));
      browser.clock().clearTimeout(this.timer);
      this.ended(false);
    }

    ended(naturally) {
      if (this.done) return;
      this.done = true;
      if (naturally) browser.sound(heard({ kind: 'end', name: this.buffer.name }));
      browser.later(() => {
        if (this.onended) this.onended();
      });
    }
  }
  class AudioContext extends EventTarget {
    constructor() {
      super();
      this.state = browser.document().activated > -Infinity ? 'running' : 'suspended';
      this.destination = {};
    }

    get currentTime() {
      return browser.clock().now() / 1000;
    }

    resume() {
      if (this.state !== 'running' && browser.document().activated > -Infinity) {
        this.state = 'running';
        browser.later(() => this.dispatchEvent(new Event('statechange')));
      }
      return Promise.resolve();
    }

    createBufferSource() {
      return new Source();
    }

    createGain() {
      return { gain: param(1), connect: (node) => node };
    }

    createOscillator() {
      const o = {
        type: 'sine',
        frequency: param(440),
        connect: (node) => node,
        start(at) {
          o.at = at;
        },
        stop(end) {
          const { first = o.frequency.value, last = o.frequency.value } = o.frequency;
          browser.sound(heard({ kind: 'tone', type: o.type, first, last, ms: (end - (o.at ?? 0)) * 1000 }));
        },
      };
      return o;
    }
  }
  class OfflineAudioContext {
    decodeAudioData(buffer) {
      const bytes = new Uint8Array(buffer);
      const seconds = wavSeconds(bytes);
      if (seconds === null) return Promise.reject(Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' }));
      return Promise.resolve({ duration: seconds, name: browser.nameOf(bytes), numberOfChannels: 1, sampleRate: 44100 });
    }
  }
  return { AudioContext, OfflineAudioContext };
}

const usages = (names) => Object.fromEntries(names.map((n, k) => [n, 1 << k]));

export function makeWebGpu() {
  const view = () => ({});
  const texture = (d) => ({
    width: d && d.size ? d.size[0] : 1, height: d && d.size ? d.size[1] : 1, format: d ? d.format : 'bgra8unorm',
    createView: view, destroy() {},
  });
  const pass = () => {
    const p = {};
    for (const name of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'draw', 'drawIndexed',
      'drawIndirect', 'dispatchWorkgroups', 'setViewport', 'setScissorRect', 'setBlendConstant', 'end']) p[name] = () => {};
    return p;
  };
  const device = Object.assign(new EventTarget(), {
    lost: new Promise(() => {}),
    features: new Set(),
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728 },
    queue: { submit() {}, writeBuffer() {}, writeTexture() {}, onSubmittedWorkDone: () => Promise.resolve() },
    createBuffer: (d) => ({
      size: d.size, usage: d.usage, mapAsync: () => Promise.resolve(), getMappedRange: (offset = 0, size) => new ArrayBuffer(size ?? d.size - offset),
      unmap() {}, destroy() {},
    }),
    createTexture: texture,
    createShaderModule: () => ({ getCompilationInfo: () => Promise.resolve({ messages: [] }) }),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createRenderPipelineAsync: () => Promise.resolve({ getBindGroupLayout: () => ({}) }),
    createComputePipelineAsync: () => Promise.resolve({ getBindGroupLayout: () => ({}) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    createSampler: () => ({}),
    createCommandEncoder: () => ({
      beginRenderPass: pass, beginComputePass: pass, copyTextureToBuffer() {}, copyBufferToBuffer() {}, copyBufferToTexture() {},
      copyTextureToTexture() {}, finish: () => ({}),
    }),
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
  });
  const adapter = {
    info: { vendor: 'substrate', architecture: 'simulated', device: '', description: 'the simulated browser, which draws nothing' },
    features: new Set(),
    limits: device.limits,
    requestDevice: () => Promise.resolve(device),
  };
  return {
    gpu: { requestAdapter: () => Promise.resolve(adapter), getPreferredCanvasFormat: () => 'bgra8unorm' },
    context: (canvas) => ({
      canvas, configure() {}, unconfigure() {}, getCurrentTexture: () => texture({ size: [canvas.width, canvas.height], format: 'bgra8unorm' }),
    }),
    globals: {
      GPUBufferUsage: usages(['MAP_READ', 'MAP_WRITE', 'COPY_SRC', 'COPY_DST', 'INDEX', 'VERTEX', 'UNIFORM', 'STORAGE', 'INDIRECT', 'QUERY_RESOLVE']),
      GPUTextureUsage: usages(['COPY_SRC', 'COPY_DST', 'TEXTURE_BINDING', 'STORAGE_BINDING', 'RENDER_ATTACHMENT']),
      GPUMapMode: usages(['READ', 'WRITE']),
      GPUShaderStage: usages(['VERTEX', 'FRAGMENT', 'COMPUTE']),
      async createImageBitmap(blob) {
        const size = sizeOf(new Uint8Array(await blob.arrayBuffer()));
        if (!size) throw new Error('The source image could not be decoded.');
        return { width: size[0], height: size[1], close() {} };
      },
    },
  };
}
