/**
 * Not part of voltviz: WebGL 2 for voltviz's raw WebGPU visualizations (Pulsar, Oscilloscope,
 * Daybreak, Blob Tracker) where the browser has no WebGPU — Firefox, older Safari.
 *
 * Each of them sets up its WebGPU pipelines, buffers, textures and passes itself and writes its
 * shaders in WGSL. This file stands in for the part of the WebGPU API they use, on WebGL 2, so
 * their own code runs unchanged: the same uniforms, the same passes in the same order, the same
 * render targets and formats. Only the shaders are not WGSL: each visualization has its WGSL
 * translated to GLSL ES 3.00 in `impl/gl/<Name>.ts`, function by function, and a shader module is
 * found there by its WebGPU label.
 *
 * - A GLSL module is the WGSL module's declarations and functions; `#define VERTEX` / `FRAGMENT`
 *   and `ENTRY_<entry point>` pick the stage and its `main`. `bindings` names, by binding number,
 *   the GLSL name of each resource of group 0: a uniform block (bound at the binding's number), a
 *   sampler2D (on the texture unit of the binding's number), "" for a sampler (it applies to the
 *   group's textures), or a storage buffer read as instance attributes, or written by a compute
 *   shader.
 * - Rows: WebGPU's framebuffer and texture rows run from the top. Every vertex shader here flips y,
 *   so each texture holds its rows in the same order as under WebGPU and a fragment's
 *   gl_FragCoord is WebGPU's @builtin(position); the canvas gets the last pass through a flipped
 *   blit.
 * - A compute pass (Blob Tracker's brightness grid) is a fragment pass: output element e of the
 *   storage buffer is pixel e of an R32UI target, read back asynchronously (a pixel buffer and a
 *   fence) when the visualization maps the buffer, as mapAsync does.
 * - Light is drawn in 16-bit float targets, as under WebGPU; that needs EXT_color_buffer_float
 *   (or _half_float), which every WebGL 2 browser of the last years has. Without it, or without
 *   WebGL 2, creating the GPU throws (an error naming WebGL: the player skips the visualization for
 *   the visit).
 */

/** A storage buffer that a vertex shader reads as per-instance attributes (name → byte offset). */
export interface InstanceBinding { instance: { stride: number; attributes: Record<string, number> } }
/** A storage buffer a compute shader writes, one u32 per invocation, workgroups of this size. */
export interface ComputeOutput { output: { workgroup: [number, number] } }
export interface GlslModule {
  bindings: (string | InstanceBinding | ComputeOutput)[];
  code: string;
}
export type GlslModules = Record<string, GlslModule>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const HEADER = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\n";
const FULLSCREEN = `${HEADER}void main() {\n  vec2 p[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));\n  gl_Position = vec4(p[gl_VertexID], 0.0, 1.0);\n}\n`;

interface Format { internal: number; format: number; type: number; integer?: boolean }

/** WebGPU's texture formats used by the visualizations, in WebGL 2's terms. */
function formats(gl: WebGL2RenderingContext): Record<string, Format> {
  return {
    r16float: { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT },
    rg16float: { internal: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT },
    rgba16float: { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT },
    rgba8unorm: { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
    bgra8unorm: { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
    r32uint: { internal: gl.R32UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_INT, integer: true }
  };
}

class GlTexture {
  readonly gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly levels: number;
  readonly format: Format;
  private readonly fbos = new Map<number, WebGLFramebuffer>();
  private base = -1;
  private max = -1;
  destroyed = false;

  constructor(gl: WebGL2RenderingContext, width: number, height: number, format: Format, levels = 1) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.levels = levels;
    this.format = format;
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, levels, format.internal, width, height);
    // Sampled through a sampler object, or read with texelFetch; on its own it filters nothing.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  size(level: number): [number, number] {
    return [Math.max(1, this.width >> level), Math.max(1, this.height >> level)];
  }

  /** The framebuffer drawing into one level. */
  framebuffer(level: number): WebGLFramebuffer {
    let fbo = this.fbos.get(level);
    if (!fbo) {
      const gl = this.gl;
      fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, level);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`WebGL: framebuffer incomplete (0x${status.toString(16)})`);
      this.fbos.set(level, fbo);
    }
    return fbo;
  }

  /** Bound for sampling with only these levels visible, as a WebGPU view of them. */
  bind(unit: number, base: number, count: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const max = base + count - 1;
    if (base !== this.base) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, (this.base = base));
    if (max !== this.max) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, (this.max = max));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const fbo of this.fbos.values()) this.gl.deleteFramebuffer(fbo);
    this.fbos.clear();
    this.gl.deleteTexture(this.texture);
  }
}

/** A GPUTextureView: one texture and a range of its levels. */
class View {
  constructor(readonly texture: GpuTexture, readonly base: number, readonly count: number) {}
}

/** A GPUTexture; the canvas's is replaced when the canvas changes size. */
class GpuTexture {
  constructor(private readonly make: () => GlTexture, private current: GlTexture | null = null) {}
  get gl(): GlTexture {
    this.current ??= this.make();
    return this.current;
  }
  set gl(next: GlTexture) {
    this.current = next;
  }
  get levels(): number {
    return this.gl.levels;
  }
  createView(descriptor: { baseMipLevel?: number; mipLevelCount?: number } = {}): View {
    const base = descriptor.baseMipLevel ?? 0;
    return new View(this, base, descriptor.mipLevelCount ?? this.levels - base);
  }
  destroy(): void {
    this.current?.destroy();
  }
}

const BUFFER_USAGE = { MAP_READ: 0x1, UNIFORM: 0x40, STORAGE: 0x80 };

class GpuBuffer {
  readonly gl: WebGL2RenderingContext;
  readonly buffer: WebGLBuffer;
  readonly size: number;
  readonly usage: number;
  /** Written by a compute pass: 4 u32 a pixel (RGBA_INTEGER reads), of which the first counts. */
  packed = false;
  /** Bytes the GL buffer holds. */
  bytes: number;
  private mapped: ArrayBuffer | null = null;
  mapState: "unmapped" | "pending" | "mapped" = "unmapped";

  constructor(gl: WebGL2RenderingContext, size: number, usage: number) {
    this.gl = gl;
    this.size = size;
    this.usage = usage;
    this.bytes = size;
    this.buffer = gl.createBuffer()!;
    const target = this.target();
    gl.bindBuffer(target, this.buffer);
    gl.bufferData(target, size, usage & BUFFER_USAGE.MAP_READ ? gl.STREAM_READ : gl.DYNAMIC_DRAW);
    gl.bindBuffer(target, null);
  }

  target(): number {
    return this.usage & BUFFER_USAGE.UNIFORM ? this.gl.UNIFORM_BUFFER : this.gl.COPY_WRITE_BUFFER;
  }

  /** Holds a compute shader's output: each element a whole RGBA_INTEGER pixel (16 bytes). */
  pack(bytes = this.size * 4): void {
    if (this.packed && this.bytes >= bytes) return;
    const gl = this.gl;
    this.packed = true;
    this.bytes = Math.max(bytes, this.size * 4);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.buffer);
    gl.bufferData(gl.COPY_WRITE_BUFFER, this.bytes, this.usage & BUFFER_USAGE.MAP_READ ? gl.STREAM_READ : gl.STREAM_COPY);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
  }

  mapAsync(_mode: number, offset = 0, size = this.size - offset): Promise<void> {
    const gl = this.gl;
    this.mapState = "pending";
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return new Promise<void>((resolve, reject) => {
      const poll = (): void => {
        if (!sync || gl.isContextLost()) {
          this.mapState = "unmapped";
          reject(new Error("WebGL: context lost"));
          return;
        }
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) {
          window.setTimeout(poll, 1);
          return;
        }
        gl.deleteSync(sync);
        if (status === gl.WAIT_FAILED) {
          this.mapState = "unmapped";
          reject(new Error("WebGL: readback failed"));
          return;
        }
        const out = new ArrayBuffer(size);
        gl.bindBuffer(gl.COPY_READ_BUFFER, this.buffer);
        if (this.packed) {
          const pixels = new Uint32Array(size);
          gl.getBufferSubData(gl.COPY_READ_BUFFER, offset * 4, pixels);
          const values = new Uint32Array(out);
          for (let index = 0; index < values.length; index += 1) values[index] = pixels[index * 4]!;
        } else {
          gl.getBufferSubData(gl.COPY_READ_BUFFER, offset, new Uint8Array(out));
        }
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);
        this.mapped = out;
        this.mapState = "mapped";
        resolve();
      };
      window.setTimeout(poll, 0);
    });
  }

  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    if (!this.mapped) throw new Error("WebGL: buffer not mapped");
    return this.mapped.slice(0, size ?? this.mapped.byteLength - offset);
  }

  unmap(): void {
    this.mapped = null;
    this.mapState = "unmapped";
  }

  destroy(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}

class GpuSampler {
  constructor(readonly sampler: WebGLSampler) {}
}

interface ProgramBinding {
  kind: "block" | "texture" | "sampler" | "instance" | "output";
  instance?: { stride: number; attributes: { location: number; offset: number }[] };
  workgroup?: [number, number];
}

class Pipeline {
  constructor(
    readonly program: WebGLProgram,
    readonly bindings: (ProgramBinding | null)[],
    readonly vao: WebGLVertexArrayObject,
    readonly blend: Any,
    readonly compute: boolean
  ) {}
  getBindGroupLayout(index: number): { pipeline: Pipeline; index: number } {
    return { pipeline: this, index };
  }
}

class BindGroup {
  constructor(readonly entries: Map<number, Any>) {}
}

type Command = () => void;

export interface Webgl2Gpu {
  requestAdapter(): Promise<{ requestDevice(): Promise<Any> }>;
  getPreferredCanvasFormat(): string;
  /** The canvas's context, as canvas.getContext('webgpu') gives it. */
  canvasContext(canvas: HTMLCanvasElement): Any;
}

/**
 * WebGPU for one canvas, on its WebGL 2 context, with the visualization's GLSL modules (loaded
 * only here, so a browser with WebGPU never fetches them).
 */
export async function webgl2Gpu(canvas: HTMLCanvasElement, load: () => Promise<{ default: GlslModules }>): Promise<Webgl2Gpu> {
  const gl = canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
    preserveDrawingBuffer: false, powerPreference: "high-performance"
  });
  if (!gl) throw new Error("WebGL 2 is not available");
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) {
    throw new Error("WebGL 2 without float render targets (EXT_color_buffer_float)");
  }
  const modules = (await load()).default;
  const FORMATS = formats(gl);
  const empty = gl.createVertexArray()!;

  let lostResolve: (info: { reason: string; message: string }) => void = () => undefined;
  const lost = new Promise<{ reason: string; message: string }>((resolve) => { lostResolve = resolve; });
  canvas.addEventListener("webglcontextlost", () => lostResolve({ reason: "WebGL context lost", message: "" }), { once: true });

  const compile = (type: number, source: string, label: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(shader) ?? "";
      gl.deleteShader(shader);
      throw new Error(`WebGL: ${label} does not compile: ${log}`);
    }
    return shader;
  };

  const link = (vertex: string, fragment: string, label: string, module: GlslModule, compute: boolean): { program: WebGLProgram; bindings: (ProgramBinding | null)[] } => {
    const program = gl.createProgram()!;
    const vs = compile(gl.VERTEX_SHADER, vertex, `${label} (vertex)`);
    const fs = compile(gl.FRAGMENT_SHADER, fragment, `${label} (fragment)`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`WebGL: ${label} does not link: ${gl.getProgramInfoLog(program) ?? ""}`);
    }
    gl.useProgram(program);
    const bindings = module.bindings.map((binding, index): ProgramBinding | null => {
      if (typeof binding !== "string") {
        if ("output" in binding) return { kind: "output", workgroup: binding.output.workgroup };
        return {
          kind: "instance",
          instance: {
            stride: binding.instance.stride,
            attributes: Object.entries(binding.instance.attributes).map(([name, offset]) => ({ location: gl.getAttribLocation(program, name), offset }))
          }
        };
      }
      if (binding === "") return { kind: "sampler" };
      const block = gl.getUniformBlockIndex(program, binding);
      if (block !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(program, block, index);
        return { kind: "block" };
      }
      const location = gl.getUniformLocation(program, binding);
      if (location) {
        gl.uniform1i(location, index);
        return { kind: "texture" };
      }
      // Declared but not used by this entry point: nothing to bind.
      return null;
    });
    void compute;
    return { program, bindings };
  };

  const moduleOf = (stage: { module: { glsl: GlslModule; label: string } }): GlslModule => stage.module.glsl;

  const canvasTexture = new GpuTexture(() => new GlTexture(gl, Math.max(1, canvas.width), Math.max(1, canvas.height), FORMATS.rgba8unorm!));
  /** The canvas texture of the frame, drawn in this submission: shown when it ends. */
  let presented = false;
  const outputs = new Map<string, GlTexture>();
  let destroyed = false;

  const device = {
    lost,
    queue: {
      writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView | ArrayBuffer, dataOffset = 0, size?: number): void {
        const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const target = buffer.target();
        gl.bindBuffer(target, buffer.buffer);
        const elements = view as unknown as { length: number };
        gl.bufferSubData(target, offset, view, dataOffset, size ?? elements.length - dataOffset);
        gl.bindBuffer(target, null);
      },
      writeTexture(destination: { texture: GpuTexture; origin?: { x?: number; y?: number }; mipLevel?: number }, data: ArrayBufferView, layout: { bytesPerRow?: number }, size: [number, number] | { width: number; height: number }): void {
        const [width, height] = Array.isArray(size) ? size : [size.width, size.height];
        const texture = destination.texture.gl;
        gl.bindTexture(gl.TEXTURE_2D, texture.texture);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout.bytesPerRow ? layout.bytesPerRow / 4 : 0);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        gl.texSubImage2D(gl.TEXTURE_2D, destination.mipLevel ?? 0, destination.origin?.x ?? 0, destination.origin?.y ?? 0, width, height, texture.format.format, texture.format.type, bytes);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      },
      copyExternalImageToTexture(source: { source: TexImageSource }, destination: { texture: GpuTexture; premultipliedAlpha?: boolean }, size: [number, number]): void {
        const texture = destination.texture.gl;
        gl.bindTexture(gl.TEXTURE_2D, texture.texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, Boolean(destination.premultipliedAlpha));
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size[0], size[1], texture.format.format, texture.format.type, source.source);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      },
      submit(buffers: Command[][]): void {
        if (destroyed || gl.isContextLost()) return;
        presented = false;
        for (const commands of buffers) for (const command of commands) command();
        if (presented) {
          // The last pass drew into the canvas texture, rows from the top: onto the canvas, flipped.
          const texture = canvasTexture.gl;
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, texture.framebuffer(0));
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
          gl.blitFramebuffer(0, 0, texture.width, texture.height, 0, texture.height, texture.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
      }
    },
    pushErrorScope(): void { /* errors surface when a shader compiles or links */ },
    popErrorScope(): Promise<null> {
      return Promise.resolve(null);
    },
    createShaderModule(descriptor: { label?: string }): Any {
      const glsl = modules[descriptor.label ?? ""];
      if (!glsl) throw new Error(`WebGL: no GLSL for ${descriptor.label}`);
      return { label: descriptor.label, glsl, getCompilationInfo: () => Promise.resolve({ messages: [] }) };
    },
    async createRenderPipelineAsync(descriptor: Any): Promise<Pipeline> {
      const vertex = moduleOf(descriptor.vertex);
      const fragment = moduleOf(descriptor.fragment);
      const label = `${descriptor.fragment.module.label}:${descriptor.fragment.entryPoint}`;
      const { program, bindings } = link(
        `${HEADER}#define VERTEX\n#define ENTRY_${descriptor.vertex.entryPoint}\n${vertex.code}`,
        `${HEADER}#define FRAGMENT\n#define ENTRY_${descriptor.fragment.entryPoint}\n${fragment.code}`,
        label, fragment, false
      );
      const vao = bindings.some((binding) => binding?.kind === "instance") ? gl.createVertexArray()! : empty;
      return new Pipeline(program, bindings, vao, descriptor.fragment.targets?.[0]?.blend ?? null, false);
    },
    async createComputePipelineAsync(descriptor: Any): Promise<Pipeline> {
      const module = moduleOf(descriptor.compute);
      const label = `${descriptor.compute.module.label}:${descriptor.compute.entryPoint}`;
      const { program, bindings } = link(FULLSCREEN, `${HEADER}#define COMPUTE\n#define ENTRY_${descriptor.compute.entryPoint}\n${module.code}`, label, module, true);
      return new Pipeline(program, bindings, empty, null, true);
    },
    createBuffer(descriptor: { size: number; usage: number }): GpuBuffer {
      return new GpuBuffer(gl, descriptor.size, descriptor.usage);
    },
    createTexture(descriptor: { size: [number, number] | { width: number; height: number }; format: string; mipLevelCount?: number }): GpuTexture {
      const [width, height] = Array.isArray(descriptor.size) ? descriptor.size : [descriptor.size.width, descriptor.size.height];
      const format = FORMATS[descriptor.format];
      if (!format) throw new Error(`WebGL: no texture format ${descriptor.format}`);
      const texture = new GlTexture(gl, width, height, format, descriptor.mipLevelCount ?? 1);
      return new GpuTexture(() => texture, texture);
    },
    createSampler(descriptor: Any = {}): GpuSampler {
      const sampler = gl.createSampler()!;
      const linear = (value: string | undefined): boolean => value === "linear";
      const min = linear(descriptor.minFilter);
      const mip = descriptor.mipmapFilter;
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, linear(descriptor.magFilter) ? gl.LINEAR : gl.NEAREST);
      // WebGPU samples a view's levels by mipmapFilter (nearest when not given).
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, mip === "linear"
        ? (min ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR)
        : (min ? gl.LINEAR_MIPMAP_NEAREST : gl.NEAREST_MIPMAP_NEAREST));
      const wrap = (mode: string | undefined): number => (mode === "repeat" ? gl.REPEAT : mode === "mirror-repeat" ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, wrap(descriptor.addressModeU));
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, wrap(descriptor.addressModeV));
      return new GpuSampler(sampler);
    },
    createBindGroup(descriptor: { entries: { binding: number; resource: Any }[] }): BindGroup {
      return new BindGroup(new Map(descriptor.entries.map((entry) => [entry.binding, entry.resource])));
    },
    createCommandEncoder(): Any {
      const commands: Command[] = [];
      /** The bindings of a group for a pipeline: buffers, textures and the group's sampler. */
      const apply = (pipeline: Pipeline, group: BindGroup | null): void => {
        if (!group) return;
        let sampler: WebGLSampler | null = null;
        const units: number[] = [];
        for (const [binding, resource] of group.entries) {
          const slot = pipeline.bindings[binding];
          if (resource instanceof GpuSampler) {
            sampler = resource.sampler;
            continue;
          }
          if (!slot) continue;
          if (resource instanceof View) {
            resource.texture.gl.bind(binding, resource.base, resource.count);
            units.push(binding);
          } else if (resource?.buffer instanceof GpuBuffer) {
            const buffer = resource.buffer as GpuBuffer;
            if (slot.kind === "block") gl.bindBufferBase(gl.UNIFORM_BUFFER, binding, buffer.buffer);
            else if (slot.kind === "instance") {
              gl.bindVertexArray(pipeline.vao);
              gl.bindBuffer(gl.ARRAY_BUFFER, buffer.buffer);
              for (const attribute of slot.instance!.attributes) {
                if (attribute.location < 0) continue;
                gl.enableVertexAttribArray(attribute.location);
                gl.vertexAttribPointer(attribute.location, 4, gl.FLOAT, false, slot.instance!.stride, attribute.offset);
                gl.vertexAttribDivisor(attribute.location, 1);
              }
              gl.bindBuffer(gl.ARRAY_BUFFER, null);
            }
          }
        }
        for (const unit of units) gl.bindSampler(unit, sampler);
      };
      const blendFactor = (factor: string | undefined): number => ({
        zero: gl.ZERO, one: gl.ONE, src: gl.SRC_COLOR, "one-minus-src": gl.ONE_MINUS_SRC_COLOR,
        "src-alpha": gl.SRC_ALPHA, "one-minus-src-alpha": gl.ONE_MINUS_SRC_ALPHA, dst: gl.DST_COLOR,
        "one-minus-dst": gl.ONE_MINUS_DST_COLOR, "dst-alpha": gl.DST_ALPHA, "one-minus-dst-alpha": gl.ONE_MINUS_DST_ALPHA
      } as Record<string, number>)[factor ?? "one"] ?? gl.ONE;
      const blendOp = (operation: string | undefined): number => ({
        add: gl.FUNC_ADD, subtract: gl.FUNC_SUBTRACT, "reverse-subtract": gl.FUNC_REVERSE_SUBTRACT, min: gl.MIN, max: gl.MAX
      } as Record<string, number>)[operation ?? "add"] ?? gl.FUNC_ADD;
      return {
        beginRenderPass(descriptor: Any): Any {
          const attachment = descriptor.colorAttachments[0];
          const view = attachment.view as View;
          let pipeline: Pipeline | null = null;
          let group: BindGroup | null = null;
          commands.push(() => {
            const texture = view.texture.gl;
            if (view.texture === canvasTexture) presented = true;
            gl.bindFramebuffer(gl.FRAMEBUFFER, texture.framebuffer(view.base));
            const [width, height] = texture.size(view.base);
            gl.viewport(0, 0, width, height);
            if (attachment.loadOp === "clear") {
              const value = attachment.clearValue ?? [0, 0, 0, 0];
              const rgba = Array.isArray(value) ? value : [value.r, value.g, value.b, value.a];
              if (texture.format.integer) gl.clearBufferuiv(gl.COLOR, 0, rgba.map((x: number) => Math.max(0, Math.round(x))));
              else gl.clearBufferfv(gl.COLOR, 0, rgba);
            }
          });
          return {
            setPipeline(next: Pipeline): void {
              commands.push(() => { pipeline = next; });
            },
            setBindGroup(_index: number, next: BindGroup): void {
              commands.push(() => { group = next; });
            },
            draw(vertices: number, instances = 1): void {
              commands.push(() => {
                if (!pipeline) return;
                gl.useProgram(pipeline.program);
                apply(pipeline, group);
                gl.bindVertexArray(pipeline.vao);
                const blend = pipeline.blend;
                if (blend) {
                  gl.enable(gl.BLEND);
                  gl.blendEquationSeparate(blendOp(blend.color?.operation), blendOp(blend.alpha?.operation));
                  gl.blendFuncSeparate(blendFactor(blend.color?.srcFactor), blendFactor(blend.color?.dstFactor), blendFactor(blend.alpha?.srcFactor), blendFactor(blend.alpha?.dstFactor));
                } else gl.disable(gl.BLEND);
                if (instances > 1 || pipeline.vao !== empty) gl.drawArraysInstanced(gl.TRIANGLES, 0, vertices, instances);
                else gl.drawArrays(gl.TRIANGLES, 0, vertices);
                gl.bindVertexArray(null);
              });
            },
            end(): void { /* the commands are recorded */ }
          };
        },
        beginComputePass(): Any {
          let pipeline: Pipeline | null = null;
          let group: BindGroup | null = null;
          return {
            setPipeline(next: Pipeline): void {
              commands.push(() => { pipeline = next; });
            },
            setBindGroup(_index: number, next: BindGroup): void {
              commands.push(() => { group = next; });
            },
            dispatchWorkgroups(x: number, y = 1): void {
              commands.push(() => {
                if (!pipeline || !group) return;
                const binding = pipeline.bindings.findIndex((slot) => slot?.kind === "output");
                const output = group.entries.get(binding)?.buffer as GpuBuffer | undefined;
                const workgroup = pipeline.bindings[binding]?.workgroup ?? [1, 1];
                if (!output) return;
                // Element e of the output is pixel e of a target as wide as the dispatch.
                const width = x * workgroup[0];
                const height = y * workgroup[1];
                const key = `${width}x${height}`;
                let target = outputs.get(key);
                if (!target) {
                  for (const old of outputs.values()) old.destroy();
                  outputs.clear();
                  target = new GlTexture(gl, width, height, FORMATS.r32uint!);
                  outputs.set(key, target);
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer(0));
                gl.viewport(0, 0, width, height);
                gl.clearBufferuiv(gl.COLOR, 0, [0, 0, 0, 0]);
                gl.useProgram(pipeline.program);
                apply(pipeline, group);
                const widthLocation = gl.getUniformLocation(pipeline.program, "outputWidth");
                if (widthLocation) gl.uniform1ui(widthLocation, width);
                gl.disable(gl.BLEND);
                gl.bindVertexArray(empty);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.bindVertexArray(null);
                // Into the buffer, without waiting: mapAsync waits for the GPU.
                const rows = Math.min(height, Math.ceil(output.size / 4 / width));
                output.pack(width * rows * 16);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, output.buffer);
                gl.readPixels(0, 0, width, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
              });
            },
            end(): void { /* the commands are recorded */ }
          };
        },
        copyBufferToBuffer(source: GpuBuffer, sourceOffset: number, destination: GpuBuffer, destinationOffset: number, size: number): void {
          commands.push(() => {
            const scale = source.packed ? 4 : 1;
            if (source.packed) destination.pack(destinationOffset * 4 + size * 4);
            gl.bindBuffer(gl.COPY_READ_BUFFER, source.buffer);
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, destination.buffer);
            gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, sourceOffset * scale, destinationOffset * scale, size * scale);
            gl.bindBuffer(gl.COPY_READ_BUFFER, null);
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
          });
        },
        finish(): Command[] {
          return commands;
        }
      };
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const target of outputs.values()) target.destroy();
      canvasTexture.destroy();
      // Frees everything the context holds at once.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  };

  const context = {
    configure(): void { /* the WebGL context is the canvas's */ },
    unconfigure(): void { /* nothing to undo */ },
    getCurrentTexture(): GpuTexture {
      const current = canvasTexture.gl;
      if (current.width !== Math.max(1, canvas.width) || current.height !== Math.max(1, canvas.height)) {
        current.destroy();
        canvasTexture.gl = new GlTexture(gl, Math.max(1, canvas.width), Math.max(1, canvas.height), FORMATS.rgba8unorm!);
      }
      return canvasTexture;
    }
  };

  return {
    requestAdapter: () => Promise.resolve({ requestDevice: () => Promise.resolve(device) }),
    getPreferredCanvasFormat: () => "rgba8unorm",
    canvasContext: () => context
  };
}
