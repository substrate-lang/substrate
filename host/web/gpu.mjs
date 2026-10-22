// The host module "gpu": WebGPU, as batches of commands from the program, and events back.
import { resolvePath } from './subhost-web.mjs';
import { errors } from '../errors.mjs';

const utf8 = new TextEncoder();
const text = new TextDecoder();

const formats = {
  1: 'rgba8unorm', 2: 'bgra8unorm', 3: 'r8unorm', 4: 'rg8unorm', 5: 'rgba16float', 6: 'r32float', 7: 'rgba32float',
  8: 'depth24plus', 9: 'depth32float',
};
const pixelBytes = {
  rgba8unorm: 4, bgra8unorm: 4, r8unorm: 1, rg8unorm: 2, rgba16float: 8, r32float: 4, rgba32float: 16, depth32float: 4,
};
const vertexFormats = {
  1: 'float32', 2: 'float32x2', 3: 'float32x3', 4: 'float32x4', 5: 'uint32', 6: 'uint32x2', 7: 'uint32x4', 8: 'sint32',
  9: 'unorm8x4', 10: 'snorm8x4', 11: 'float16x2', 12: 'float16x4', 13: 'uint8x4', 14: 'unorm16x2', 15: 'unorm16x4',
};
const topologies = { 1: 'triangle-list', 2: 'triangle-strip', 3: 'line-list', 4: 'line-strip', 5: 'point-list' };
const cullModes = { 0: 'none', 1: 'back', 2: 'front' };
const frontFaces = { 0: 'ccw', 1: 'cw' };
const blends = {
  1: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  2: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  3: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
};
const comparisons = { 1: 'less', 2: 'less-equal', 3: 'greater', 4: 'greater-equal', 5: 'equal', 6: 'always', 7: 'never' };
const addressModes = { 0: 'clamp-to-edge', 1: 'repeat', 2: 'mirror-repeat' };
const kindNames = { 1: 'surface', 2: 'shader', 3: 'pipeline', 4: 'buffer', 5: 'texture', 6: 'sampler', 7: 'layout', 8: 'bind group' };

const SOURCE = 2;
const ERROR = 1;
const LOADED = 2;
const PIXELS = 3;
const BYTES = 4;

function unavailable(reason) {
  const module = (caller) => ({
    source: SOURCE,
    apply() { caller.trap(`gpu: WebGPU is not available: ${reason}`); },
    loading() { return 0; },
  });
  module.available = false;
  module.adapter = {};
  module.read = () => Promise.reject(new Error(reason));
  module.readSurface = module.read;
  module.timing = { measure: false, frames: 0, ms: 0 };
  return module;
}

export async function gpu(options = {}) {
  if (!navigator.gpu) return unavailable('this browser has no WebGPU');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return unavailable('the browser found no GPU to use');
  let device;
  try {
    device = await adapter.requestDevice();
  } catch (e) {
    return unavailable(e.message);
  }
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  const theDom = options.dom || null;

  const surfaces = new Map();
  const shaders = new Map();
  const pipelines = new Map();
  const buffers = new Map();
  const textures = new Map();
  const samplers = new Map();
  const layouts = new Map();
  const layered = new Map();
  const bindGroups = new Map();
  const tables = { 1: surfaces, 2: shaders, 3: pipelines, 4: buffers, 5: textures, 6: samplers, 7: layouts, 8: bindGroups };
  let loading = 0;

  let app = null;
  let caller = null;
  function event(kind, id, data) {
    if (caller) caller.event(kind, id, 0, kind === ERROR ? errors.invalid : 0, data);
  }
  const error = (id, message) => event(ERROR, id, utf8.encode(message));

  device.addEventListener('uncapturederror', (e) => error(0, e.error.message));
  device.lost.then((info) => error(0, `the device was lost (${info.reason}): ${info.message}`));

  function get(kind, id) {
    const r = tables[kind].get(id);
    if (r === undefined) caller.trap(`gpu: there is no ${kindNames[kind]} ${id}`);
    return r;
  }
  function formatOf(code) {
    if (code === 0) return canvasFormat;
    const f = formats[code];
    if (!f) caller.trap(`gpu: there is no texture format ${code}`);
    return f;
  }
  const choose = (table, code, what) => {
    const v = table[code];
    if (v === undefined) caller.trap(`gpu: there is no ${what} ${code}`);
    return v;
  };

  function run(memory, w, f, string) {
    const encoder = device.createCommandEncoder();
    let pass = null;
    let computing = false;
    const reads = [];
    const drawn = new Map();
    const inPass = (what, compute) => {
      if (!pass) caller.trap(`gpu: ${what} outside a pass`);
      if (compute !== undefined && compute !== computing) caller.trap(`gpu: ${what} in the wrong kind of pass`);
    };
    let i = 0;
    while (i < w.length) {
      const op = w[i];
      switch (op) {
        case 1: {
          const id = w[i + 1];
          const node = theDom && theDom.nodeOf ? theDom.nodeOf(w[i + 2]) : null;
          if (!node) caller.trap(`gpu: surface ${id}: the page gave this module no dom, or node ${w[i + 2]} is not on the page`);
          if (!(node instanceof HTMLCanvasElement)) caller.trap(`gpu: surface ${id}: node ${w[i + 2]} is not a canvas`);
          if (options.offscreen) {
            const texture = device.createTexture({
              label: `surface ${id}`, size: [node.width, node.height, 1], format: canvasFormat,
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            });
            surfaces.set(id, { canvas: node, texture });
            i += 3;
            break;
          }
          const context = node.getContext('webgpu');
          if (!context) caller.trap(`gpu: surface ${id}: the canvas cannot be used by WebGPU (it may already be used by a 2D context)`);
          context.configure({ device, format: canvasFormat, alphaMode: 'premultiplied', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
          surfaces.set(id, { canvas: node, context });
          i += 3;
          break;
        }
        case 2: {
          const id = w[i + 1];
          device.pushErrorScope('validation');
          const module = device.createShaderModule({ label: `shader ${id}`, code: string(i + 2) });
          shaders.set(id, module);
          device.popErrorScope().then(async (e) => {
            if (!e) return;
            const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
            error(id, errors.length === 0 ? e.message : `shader ${id} does not compile:\n` +
              errors.map((m) => `  line ${m.lineNum}, column ${m.linePos}: ${m.message}`).join('\n'));
          });
          i += 4;
          break;
        }
        case 3: {
          const id = w[i + 1];
          const module = get(2, w[i + 2]);
          const vertexEntry = string(i + 3);
          const fragmentEntry = string(i + 5);
          const topology = choose(topologies, w[i + 7], 'topology');
          const cullMode = choose(cullModes, w[i + 8], 'cull mode');
          const frontFace = choose(frontFaces, w[i + 9], 'front face');
          const blend = w[i + 10] === 0 ? undefined : choose(blends, w[i + 10], 'blend');
          const depthFormat = w[i + 11] === 0 ? null : formatOf(w[i + 11]);
          const depthCompare = w[i + 12] === 0 ? 'always' : choose(comparisons, w[i + 12], 'comparison');
          const depthWrite = w[i + 13] !== 0;
          i += 14;
          const layoutCount = w[i++];
          const groupLayouts = [];
          for (let k = 0; k < layoutCount; k++) groupLayouts.push(get(7, w[i++]));
          const targetCount = w[i++];
          const targets = [];
          for (let k = 0; k < targetCount; k++) targets.push({ format: formatOf(w[i++]), blend });
          const bufferCount = w[i++];
          const vertexBuffers = [];
          for (let k = 0; k < bufferCount; k++) {
            const arrayStride = w[i++];
            const stepMode = w[i++] === 0 ? 'vertex' : 'instance';
            const attributeCount = w[i++];
            const attributes = [];
            for (let a = 0; a < attributeCount; a++) {
              attributes.push({ shaderLocation: w[i], offset: w[i + 1], format: choose(vertexFormats, w[i + 2], 'vertex format') });
              i += 3;
            }
            vertexBuffers.push({ arrayStride, stepMode, attributes });
          }
          const description = {
            label: `pipeline ${id}`,
            layout: layoutCount === 0 ? 'auto' : device.createPipelineLayout({ bindGroupLayouts: groupLayouts }),
            vertex: { module, entryPoint: vertexEntry, buffers: vertexBuffers },
            primitive: { topology, cullMode, frontFace },
          };
          if (topology === 'triangle-strip' || topology === 'line-strip') description.primitive.stripIndexFormat = 'uint32';
          if (fragmentEntry.length > 0) description.fragment = { module, entryPoint: fragmentEntry, targets };
          if (depthFormat) description.depthStencil = { format: depthFormat, depthWriteEnabled: depthWrite, depthCompare };
          pipelines.set(id, { pipeline: checked(`pipeline ${id}`, id, () => device.createRenderPipeline(description)), compute: false });
          break;
        }
        case 4: {
          const id = w[i + 1];
          const module = get(2, w[i + 2]);
          const entryPoint = string(i + 3);
          i += 5;
          const layoutCount = w[i++];
          const groupLayouts = [];
          for (let k = 0; k < layoutCount; k++) groupLayouts.push(get(7, w[i++]));
          const pipeline = checked(`pipeline ${id}`, id, () => device.createComputePipeline({
            label: `pipeline ${id}`,
            layout: layoutCount === 0 ? 'auto' : device.createPipelineLayout({ bindGroupLayouts: groupLayouts }),
            compute: { module, entryPoint },
          }));
          pipelines.set(id, { pipeline, compute: true });
          break;
        }
        case 5: {
          const id = w[i + 1];
          const size = (w[i + 2] + 3) & ~3;
          const bits = w[i + 3];
          let usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
          if (bits & 1) usage |= GPUBufferUsage.VERTEX;
          if (bits & 2) usage |= GPUBufferUsage.INDEX;
          if (bits & 4) usage |= GPUBufferUsage.UNIFORM;
          if (bits & 8) usage |= GPUBufferUsage.STORAGE;
          if (bits & 16) usage |= GPUBufferUsage.INDIRECT;
          buffers.set(id, device.createBuffer({ label: `buffer ${id}`, size, usage }));
          i += 4;
          break;
        }
        case 6: {
          const id = w[i + 1];
          const [width, height, layers, mips] = [w[i + 2], w[i + 3], w[i + 4], w[i + 5]];
          const format = formatOf(w[i + 6]);
          const bits = w[i + 7];
          let usage = GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
          if (bits & 1) usage |= GPUTextureUsage.TEXTURE_BINDING;
          if (bits & 2) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
          if (bits & 4) usage |= GPUTextureUsage.STORAGE_BINDING;
          if (format.startsWith('depth')) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
          const texture = device.createTexture({ label: `texture ${id}`, size: [width, height, layers], format, usage, mipLevelCount: mips });
          textures.set(id, { texture, format, width, height, layers });
          i += 8;
          break;
        }
        case 7: {
          const id = w[i + 1];
          const name = string(i + 2);
          const placeholder = device.createTexture({
            size: [1, 1, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
          });
          textures.set(id, { texture: placeholder, format: 'rgba8unorm', width: 1, height: 1, layers: 1 });
          loadTexture(id, name);
          i += 4;
          break;
        }
        case 8: {
          const id = w[i + 1];
          const filter = w[i + 2] === 0 ? 'nearest' : 'linear';
          const address = choose(addressModes, w[i + 3], 'address mode');
          const description = {
            magFilter: filter, minFilter: filter, mipmapFilter: filter,
            addressModeU: address, addressModeV: address, addressModeW: address,
          };
          if (w[i + 4] !== 0) description.compare = choose(comparisons, w[i + 4], 'comparison');
          description.label = `sampler ${id}`;
          samplers.set(id, device.createSampler(description));
          i += 5;
          break;
        }
        case 9: {
          const id = w[i + 1];
          const count = w[i + 2];
          i += 3;
          const entries = [];
          for (let k = 0; k < count; k++) {
            const binding = w[i];
            const visibility = (w[i + 1] & 1 ? GPUShaderStage.VERTEX : 0) | (w[i + 1] & 2 ? GPUShaderStage.FRAGMENT : 0) |
              (w[i + 1] & 4 ? GPUShaderStage.COMPUTE : 0);
            const kind = w[i + 2];
            const entry = { binding, visibility };
            switch (kind) {
              case 1: entry.buffer = { type: 'uniform' }; break;
              case 2: entry.buffer = { type: 'storage' }; break;
              case 3: entry.buffer = { type: 'read-only-storage' }; break;
              case 4: entry.buffer = { type: 'uniform', hasDynamicOffset: true }; break;
              case 5: entry.buffer = { type: 'storage', hasDynamicOffset: true }; break;
              case 6: entry.buffer = { type: 'read-only-storage', hasDynamicOffset: true }; break;
              case 7: entry.sampler = { type: 'filtering' }; break;
              case 8: entry.sampler = { type: 'comparison' }; break;
              case 9: entry.texture = { sampleType: 'float' }; break;
              case 10: entry.texture = { sampleType: 'depth' }; break;
              case 11: entry.storageTexture = { access: 'write-only', format: 'rgba8unorm' }; break;
              case 12: entry.texture = { sampleType: 'float', viewDimension: '2d-array' }; break;
              case 13: entry.texture = { sampleType: 'depth', viewDimension: '2d-array' }; break;
              default: caller.trap(`gpu: there is no layout entry kind ${kind}`);
            }
            entries.push(entry);
            i += 3;
          }
          layouts.set(id, checked(`layout ${id}`, id, () => device.createBindGroupLayout({ label: `layout ${id}`, entries })));
          layered.set(id, new Set(entries.filter((e) => e.texture && e.texture.viewDimension === '2d-array').map((e) => e.binding)));
          break;
        }
        case 10: {
          const id = w[i + 1];
          const layoutId = w[i + 2];
          const layout = layoutId !== 0 ? get(7, layoutId) : get(3, w[i + 3]).pipeline.getBindGroupLayout(w[i + 4]);
          const count = w[i + 5];
          i += 6;
          const entries = [];
          for (let k = 0; k < count; k++) {
            const kind = w[i + 1];
            if (kind !== 1 && kind !== 2 && kind !== 3) caller.trap(`gpu: there is no bind group entry kind ${kind}`);
            entries.push({ binding: w[i], kind, id: w[i + 2], offset: w[i + 3], size: w[i + 4] });
            i += 5;
          }
          const description = { id, layout, entries, layers: layoutId !== 0 ? layered.get(layoutId) : new Set() };
          description.group = makeBindGroup(description);
          bindGroups.set(id, description);
          break;
        }
        case 11: {
          const kind = w[i + 1];
          const id = w[i + 2];
          const table = tables[kind];
          if (!table) caller.trap(`gpu: there is no resource kind ${kind}`);
          const r = table.get(id);
          if (r !== undefined) {
            if (kind === 1) { if (r.context) r.context.unconfigure(); else r.texture.destroy(); }
            else if (kind === 4) r.destroy();
            else if (kind === 5) r.texture.destroy();
            table.delete(id);
          }
          i += 3;
          break;
        }
        case 12:
          device.queue.writeBuffer(get(4, w[i + 1]), w[i + 2], memory.buffer, memory.byteOffset + w[i + 3], w[i + 4]);
          i += 5;
          break;
        case 13: {
          const t = get(5, w[i + 1]);
          const [mip, layer, x, y, width, height, ptr, len] = [w[i + 2], w[i + 3], w[i + 4], w[i + 5], w[i + 6], w[i + 7], w[i + 8], w[i + 9]];
          device.queue.writeTexture(
            { texture: t.texture, mipLevel: mip, origin: [x, y, layer] },
            memory.buffer, { offset: memory.byteOffset + ptr, bytesPerRow: len / height, rowsPerImage: height },
            [width, height, 1]);
          i += 10;
          break;
        }
        case 14: {
          const id = w[i + 1];
          const read = readTexture(encoder, id, w[i + 2], w[i + 3], w[i + 4], w[i + 5], w[i + 6], w[i + 7]);
          reads.push(() => read().then((bytes) => event(PIXELS, id, bytes), (e) => error(id, e.message)));
          i += 8;
          break;
        }
        case 15: {
          const id = w[i + 1];
          const len = w[i + 3];
          const staging = device.createBuffer({ size: (len + 3) & ~3, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          encoder.copyBufferToBuffer(get(4, id), w[i + 2], staging, 0, (len + 3) & ~3);
          reads.push(() => readStaging(staging, len).then((bytes) => event(BYTES, id, bytes), (e) => error(id, e.message)));
          i += 4;
          break;
        }
        case 16: {
          if (pass) caller.trap('gpu: render-pass inside a pass');
          const count = w[i + 1];
          i += 2;
          const colorAttachments = [];
          for (let k = 0; k < count; k++) {
            const kind = w[i];
            const id = w[i + 1];
            let view;
            if (kind === 1) {
              const surface = get(1, id);
              const texture = surface.context ? surface.context.getCurrentTexture() : surface.texture;
              drawn.set(id, texture);
              view = texture.createView();
            } else if (kind === 2) {
              view = get(5, id).texture.createView({ baseMipLevel: w[i + 2], mipLevelCount: 1, baseArrayLayer: w[i + 3], arrayLayerCount: 1, dimension: '2d' });
            } else {
              caller.trap(`gpu: there is no target kind ${kind}`);
            }
            colorAttachments.push({
              view, loadOp: w[i + 4] === 0 ? 'load' : 'clear', storeOp: 'store',
              clearValue: { r: f[i + 5], g: f[i + 6], b: f[i + 7], a: f[i + 8] },
            });
            i += 9;
          }
          const description = { colorAttachments };
          if (w[i] !== 0) {
            const depth = get(5, w[i]);
            description.depthStencilAttachment = {
              view: depth.texture.createView({ baseMipLevel: w[i + 1], mipLevelCount: 1, baseArrayLayer: w[i + 2], arrayLayerCount: 1, dimension: '2d' }),
              depthLoadOp: w[i + 3] === 0 ? 'load' : 'clear',
              depthClearValue: f[i + 4],
              depthStoreOp: 'store',
            };
          }
          i += 5;
          pass = encoder.beginRenderPass(description);
          computing = false;
          break;
        }
        case 17:
          if (pass) caller.trap('gpu: compute-pass inside a pass');
          pass = encoder.beginComputePass();
          computing = true;
          i += 1;
          break;
        case 18:
          inPass('end-pass');
          pass.end();
          pass = null;
          i += 1;
          break;
        case 19: {
          inPass('pipeline');
          const p = get(3, w[i + 1]);
          if (p.compute !== computing) caller.trap(`gpu: pipeline ${w[i + 1]} is not for this kind of pass`);
          pass.setPipeline(p.pipeline);
          i += 2;
          break;
        }
        case 20: {
          inPass('bind-group');
          const group = w[i + 1];
          const bindGroup = get(8, w[i + 2]).group;
          const count = w[i + 3];
          i += 4;
          if (count === 0) {
            pass.setBindGroup(group, bindGroup);
          } else {
            const offsets = [];
            for (let k = 0; k < count; k++) offsets.push(w[i++]);
            pass.setBindGroup(group, bindGroup, offsets);
          }
          break;
        }
        case 21:
          inPass('vertex-buffer', false);
          pass.setVertexBuffer(w[i + 1], get(4, w[i + 2]), w[i + 3]);
          i += 4;
          break;
        case 22:
          inPass('index-buffer', false);
          pass.setIndexBuffer(get(4, w[i + 1]), w[i + 2] === 0 ? 'uint16' : 'uint32', w[i + 3]);
          i += 4;
          break;
        case 23:
          inPass('draw', false);
          pass.draw(w[i + 1], w[i + 2], w[i + 3], w[i + 4]);
          i += 5;
          break;
        case 24:
          inPass('draw-indexed', false);
          pass.drawIndexed(w[i + 1], w[i + 2], w[i + 3], w[i + 4], w[i + 5]);
          i += 6;
          break;
        case 25:
          inPass('dispatch', true);
          pass.dispatchWorkgroups(w[i + 1], w[i + 2], w[i + 3]);
          i += 4;
          break;
        case 26:
          inPass('viewport', false);
          pass.setViewport(f[i + 1], f[i + 2], f[i + 3], f[i + 4], 0, 1);
          i += 5;
          break;
        case 27:
          inPass('scissor', false);
          pass.setScissorRect(w[i + 1], w[i + 2], w[i + 3], w[i + 4]);
          i += 5;
          break;
        default:
          caller.trap(`gpu: there is no command ${op}`);
      }
    }
    if (pass) {
      pass.end();
      caller.trap('gpu: a pass was not ended');
    }
    for (const want of surfaceReads.splice(0)) {
      const texture = drawn.get(want.id);
      if (!texture) {
        surfaceReads.push(want);
        continue;
      }
      const read = readCanvasTexture(encoder, texture, want.x, want.y, want.width, want.height);
      reads.push(() => read().then(want.resolve, want.reject));
    }
    device.queue.submit([encoder.finish()]);
    if (timing.measure) {
      const started = performance.now();
      device.queue.onSubmittedWorkDone().then(() => {
        timing.ms += performance.now() - started;
        timing.frames++;
      });
    }
    for (const read of reads) read();
  }

  function checked(what, id, make) {
    device.pushErrorScope('validation');
    const resource = make();
    device.popErrorScope().then((e) => { if (e) error(id, `${what} is invalid: ${e.message}`); });
    return resource;
  }

  const surfaceReads = [];
  const timing = { measure: false, frames: 0, ms: 0 };

  function readCanvasTexture(encoder, texture, x, y, width, height) {
    const bytesPerRow = (width * 4 + 255) & ~255;
    const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture, origin: [x, y, 0] }, { buffer: staging, bytesPerRow, rowsPerImage: height }, [width, height, 1]);
    return () => readStaging(staging, bytesPerRow * height).then((padded) => {
      const bytes = new Uint8Array(width * 4 * height);
      for (let row = 0; row < height; row++) {
        bytes.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
      }
      if (canvasFormat === 'bgra8unorm') {
        for (let i = 0; i < bytes.length; i += 4) {
          const b = bytes[i];
          bytes[i] = bytes[i + 2];
          bytes[i + 2] = b;
        }
      }
      return bytes;
    });
  }

  async function loadTexture(id, name) {
    loading++;
    try {
      const bytes = app && app.files.get(resolvePath(app.cwd, name));
      const blob = bytes ? new Blob([bytes]) : await fetch(name).then((r) => {
        if (!r.ok) throw new Error(`the server answered ${r.status}`);
        return r.blob();
      });
      const bitmap = await createImageBitmap(blob);
      const reader = document.createElement('canvas');
      reader.width = bitmap.width;
      reader.height = bitmap.height;
      const context = reader.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      for (let k = 0; k < pixels.length; k += 4) {
        const a = pixels[k + 3];
        if (a !== 255) {
          pixels[k] = (pixels[k] * a + 127) / 255;
          pixels[k + 1] = (pixels[k + 1] * a + 127) / 255;
          pixels[k + 2] = (pixels[k + 2] * a + 127) / 255;
        }
      }
      const t = textures.get(id);
      if (!t) return;
      const texture = device.createTexture({
        label: `texture ${id}`, size: [bitmap.width, bitmap.height, 1], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      device.queue.writeTexture({ texture }, pixels, { bytesPerRow: bitmap.width * 4 }, [bitmap.width, bitmap.height]);
      textures.set(id, { texture, format: 'rgba8unorm', width: bitmap.width, height: bitmap.height, layers: 1 });
      for (const description of bindGroups.values()) {
        if (description.entries.some((e) => e.kind === 3 && e.id === id)) description.group = makeBindGroup(description);
      }
      t.texture.destroy();
      event(LOADED, id, new Uint8Array(0));
    } catch (e) {
      error(id, `cannot load the texture ${name}: ${e.message}`);
    } finally {
      loading--;
    }
  }

  function makeBindGroup({ id, layout, entries, layers }) {
    return checked(`bind group ${id}`, id, () => device.createBindGroup({
      label: `bind group ${id}`,
      layout,
      entries: entries.map((e) => {
        let resource;
        if (e.kind === 1) {
          resource = { buffer: get(4, e.id), offset: e.offset };
          if (e.size !== 0) resource.size = e.size;
        } else if (e.kind === 2) {
          resource = get(6, e.id);
        } else if (layers.has(e.binding)) {
          resource = get(5, e.id).texture.createView({ dimension: '2d-array' });
        } else {
          resource = get(5, e.id).texture.createView({ dimension: '2d', baseArrayLayer: 0, arrayLayerCount: 1 });
        }
        return { binding: e.binding, resource };
      }),
    }));
  }

  function readTexture(encoder, id, mip, layer, x, y, width, height) {
    const t = get(5, id);
    const bpp = pixelBytes[t.format];
    if (!bpp) caller.trap(`gpu: a ${t.format} texture cannot be read`);
    const bytesPerRow = (width * bpp + 255) & ~255;
    const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer(
      { texture: t.texture, mipLevel: mip, origin: [x, y, layer] }, { buffer: staging, bytesPerRow, rowsPerImage: height },
      [width, height, 1]);
    return () => readStaging(staging, bytesPerRow * height).then((padded) => {
      const bytes = new Uint8Array(width * bpp * height);
      for (let row = 0; row < height; row++) {
        bytes.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + width * bpp), row * width * bpp);
      }
      return bytes;
    });
  }

  async function readStaging(staging, len) {
    await staging.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(staging.getMappedRange().slice(0, len));
    staging.unmap();
    staging.destroy();
    return bytes;
  }

  const module = (theCaller, theApp) => {
    caller = theCaller;
    app = theApp;
    return {
      source: SOURCE,
      apply(ptr, len) {
        const memory = caller.memory();
        const w = ptr % 4 === 0
          ? new Uint32Array(memory.buffer, memory.byteOffset + ptr, len >>> 2)
          : new Uint32Array(memory.slice(ptr, ptr + len).buffer);
        const f = new Float32Array(w.buffer, w.byteOffset, w.length);
        const string = (at) => text.decode(memory.subarray(w[at], w[at] + w[at + 1]));
        run(memory, w, f, string);
      },
      loading() {
        return loading;
      },
    };
  };
  module.available = true;
  module.adapter = adapter.info || {};
  module.read = (id, x, y, width, height, mip = 0, layer = 0) => {
    const encoder = device.createCommandEncoder();
    const read = readTexture(encoder, id, mip, layer, x, y, width, height);
    device.queue.submit([encoder.finish()]);
    return read();
  };
  module.readSurface = (id, x, y, width, height) =>
    new Promise((resolve, reject) => surfaceReads.push({ id, x, y, width, height, resolve, reject }));
  module.timing = timing;
  return module;
}
