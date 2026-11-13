/**
 * The WebGL 2 side of the Fable visualizations: programs, float targets, full-screen passes and
 * point clouds. It follows the shapes of shaders/runner.ts (a `Target` is the same texture +
 * framebuffer + size), with what these visualizations need beyond it: half/full float formats
 * chosen per target, several colour attachments, ping-pong pairs, GPU timer queries, and
 * programs compiled in the background where the browser can (KHR_parallel_shader_compile).
 */

export type Format = "rgba8" | "rgba16f" | "rgba32f" | "rg16f" | "r16f";
export type Filter = "linear" | "nearest";
export type Wrap = "clamp" | "repeat" | "mirror";

export interface Target {
  /** The first colour attachment. */
  texture: WebGLTexture;
  /** Every colour attachment, in order. */
  textures: readonly WebGLTexture[];
  framebuffer: WebGLFramebuffer;
  /** With several attachments: a framebuffer onto each alone (see `Kit.program`). */
  singles?: readonly WebGLFramebuffer[];
  width: number;
  height: number;
  format: Format;
}

/** Two targets of one size: read the one, draw into the other, swap. */
export interface Double {
  read: Target;
  write: Target;
  swap(): void;
}

export interface TargetOptions {
  filter?: Filter;
  wrap?: Wrap;
  /** More than one colour attachment (all of `format`). */
  attachments?: number;
}

export type UniformValue = number | boolean | readonly number[] | Float32Array | WebGLTexture | Target | null | undefined;
export type Uniforms = Record<string, UniformValue>;

interface Slot {
  location: WebGLUniformLocation;
  type: number;
  size: number;
  /** The texture unit of a sampler; -1 for anything else. */
  unit: number;
}

export interface Program {
  program: WebGLProgram;
  slots: Map<string, Slot>;
  /** Linked, its uniforms known. False while the driver still compiles it. */
  ready: boolean;
  /** With several outputs: the same stages again, one program per further output (see `Kit.program`). */
  others: Program[];
}

interface Stage {
  shader: WebGLShader;
  source: string;
}

/** The kits alive on each context: what `compiling` asks. */
const kits = new WeakMap<WebGL2RenderingContext, Set<Kit>>();

/**
 * Whether any program on this context is still being compiled. Where the browser compiles in
 * the background (KHR_parallel_shader_compile) a host draws the picture it has until this is
 * false, and a new preset costs no frame; elsewhere it is false at once and the first draw waits.
 * Throws what a program that failed to compile throws.
 */
export function compiling(gl: WebGL2RenderingContext): boolean {
  let busy = false;
  for (const kit of kits.get(gl) ?? []) if (kit.compiling()) busy = true;
  return busy;
}

export interface ProgramOptions {
  /** A vertex stage of its own (point clouds); the full-screen triangle otherwise. */
  vertex?: string;
  /** How many colour outputs the fragment stage writes: fragColor, fragColor1, … */
  outputs?: number;
}

export type Blend = "none" | "add" | "alpha" | "max";

const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** A fragment stage's header: of its outputs (fragColor, fragColor1, …) `only` is the real one; the rest are plain variables. */
function fragmentHeader(outputs: number, only: number): string {
  let text = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nin vec2 vUv;\n";
  for (let index = 0; index < outputs; index += 1) {
    const name = index ? `fragColor${index}` : "fragColor";
    text += index === only ? `layout(location = 0) out vec4 ${name};\n` : `vec4 ${name};\n`;
  }
  return text;
}

const VERTEX_HEADER = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n";

function numbered(source: string): string {
  return source.split("\n").map((line, index) => `${String(index + 1).padStart(4)}: ${line}`).join("\n");
}

export class Kit {
  /** Float colour buffers can be drawn into (RGBA16F and RGBA32F). */
  public readonly floatColor: boolean;
  /** Half-float colour buffers can be drawn into (RGBA16F). */
  public readonly halfFloatColor: boolean;
  /** 32-bit float textures filter linearly. */
  public readonly floatLinear: boolean;
  public readonly gl: WebGL2RenderingContext;
  private readonly timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly parallel: { COMPLETION_STATUS_KHR: number } | null;
  private readonly empty: WebGLVertexArrayObject;
  private readonly programs: Program[] = [];
  /** Programs linked but not looked at yet, with their stages (kept for the error text). */
  private readonly pending = new Map<Program, Stage[]>();
  private readonly targets = new Set<Target>();
  private readonly ownedTextures = new Set<WebGLTexture>();
  private pendingQueries: { query: WebGLQuery; resolve: (ms: number | null) => void }[] = [];
  private activeQuery: WebGLQuery | null = null;

  public constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.parallel = gl.getExtension("KHR_parallel_shader_compile") as Kit["parallel"];
    let alive = kits.get(gl);
    if (!alive) kits.set(gl, alive = new Set());
    alive.add(this);
    this.floatColor = Boolean(gl.getExtension("EXT_color_buffer_float"));
    this.halfFloatColor = this.floatColor || Boolean(gl.getExtension("EXT_color_buffer_half_float"));
    this.floatLinear = Boolean(gl.getExtension("OES_texture_float_linear"));
    // Additive point clouds into float buffers.
    gl.getExtension("EXT_float_blend");
    this.timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2") as Kit["timerExt"];
    this.empty = gl.createVertexArray()!;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** Whether the HDR pipeline can run at all: some float format to draw into. */
  public get hdr(): boolean {
    return this.halfFloatColor;
  }

  /** The best format for positions and other state that half floats are too coarse for. */
  public get stateFormat(): Format {
    return this.floatColor ? "rgba32f" : "rgba16f";
  }

  /**
   * A program from a fragment body (the header — version, precision, `vUv`, `fragColor` — is
   * added here). It is handed to the driver and returned at once; it is looked at (and a
   * failure thrown, with the numbered source and the log) when it is first drawn with, or by
   * `compiling` once the driver is done with it.
   *
   * A body with several outputs becomes one program per output, each writing its own output
   * alone, and a draw into a target of several attachments one pass per attachment. A single
   * program with several outputs would be the plainer thing, but ANGLE on Direct3D compiles
   * such a program for one output when it links and again — on the GPU's own thread, the whole
   * page's picture waiting — the first time it is drawn with into several. Measured: 0.15–0.9 s
   * without a frame each time such a preset began. This way everything is compiled at link time,
   * in the background.
   */
  public program(fragment: string, options: ProgramOptions = {}): Program {
    const vertexSource = options.vertex ? VERTEX_HEADER + options.vertex : FULLSCREEN_VERTEX;
    const outputs = options.outputs ?? 1;
    const compiled = this.link(vertexSource, fragmentHeader(outputs, 0) + fragment);
    for (let only = 1; only < outputs; only += 1) compiled.others.push(this.link(vertexSource, fragmentHeader(outputs, only) + fragment));
    return compiled;
  }

  private link(vertexSource: string, fragmentSource: string): Program {
    const gl = this.gl;
    const program = gl.createProgram()!;
    const sources: [number, string][] = [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]];
    const stages = sources.map(([kind, source]): Stage => {
      const shader = gl.createShader(kind)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      return { shader, source };
    });
    gl.linkProgram(program);
    const compiled: Program = { program, slots: new Map(), ready: false, others: [] };
    this.pending.set(compiled, stages);
    this.programs.push(compiled);
    return compiled;
  }

  /** The link's outcome read (this waits for the driver if it is not done) and the uniforms listed. */
  private finish(compiled: Program): void {
    const stages = this.pending.get(compiled);
    if (!stages) return;
    this.pending.delete(compiled);
    const gl = this.gl;
    const { program } = compiled;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const logs = stages.map(({ shader, source }) => (gl.getShaderParameter(shader, gl.COMPILE_STATUS)
        ? "" : `${gl.getShaderInfoLog(shader) ?? ""}\n${numbered(source)}`)).filter(Boolean).join("\n");
      const message = logs || gl.getProgramInfoLog(program) || "link failed";
      for (const { shader } of stages) gl.deleteShader(shader);
      throw new Error(`Shader failed: ${message}`);
    }
    for (const { shader } of stages) {
      gl.detachShader(program, shader);
      gl.deleteShader(shader);
    }
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    let unit = 0;
    gl.useProgram(program);
    for (let index = 0; index < count; index += 1) {
      const info = gl.getActiveUniform(program, index);
      if (!info) continue;
      const location = gl.getUniformLocation(program, info.name);
      if (!location) continue;
      const sampler = info.type === gl.SAMPLER_2D;
      compiled.slots.set(info.name.replace(/\[0\]$/, ""), { location, type: info.type, size: info.size, unit: sampler ? unit : -1 });
      if (sampler) gl.uniform1i(location, unit++);
    }
    compiled.ready = true;
  }

  /**
   * Whether drawing with the program would not wait for the driver: it is finished, or done
   * compiling (and finished here). Always true without KHR_parallel_shader_compile, where the
   * wait cannot be avoided.
   */
  public usable(compiled: Program): boolean {
    if (!this.parallel) return true;
    for (const each of [compiled, ...compiled.others]) {
      if (each.ready) continue;
      if (!this.gl.getProgramParameter(each.program, this.parallel.COMPLETION_STATUS_KHR)) return false;
      this.finish(each);
    }
    return true;
  }

  /**
   * Whether the driver still compiles one of this kit's programs; those it is done with are
   * finished here (a failure throws). Without KHR_parallel_shader_compile nothing can be asked
   * without waiting, so the answer is no and the first draw does the waiting.
   */
  public compiling(): boolean {
    if (!this.pending.size || !this.parallel) return false;
    let busy = false;
    for (const compiled of [...this.pending.keys()]) {
      if (this.gl.getProgramParameter(compiled.program, this.parallel.COMPLETION_STATUS_KHR)) this.finish(compiled);
      else busy = true;
    }
    return busy;
  }

  private formatOf(format: Format): { internal: number; base: number; type: number } {
    const gl = this.gl;
    switch (format) {
      case "rgba16f": return { internal: gl.RGBA16F, base: gl.RGBA, type: gl.HALF_FLOAT };
      case "rgba32f": return { internal: gl.RGBA32F, base: gl.RGBA, type: gl.FLOAT };
      case "rg16f": return { internal: gl.RG16F, base: gl.RG, type: gl.HALF_FLOAT };
      case "r16f": return { internal: gl.R16F, base: gl.RED, type: gl.HALF_FLOAT };
      default: return { internal: gl.RGBA8, base: gl.RGBA, type: gl.UNSIGNED_BYTE };
    }
  }

  private wrapOf(wrap: Wrap | undefined): number {
    const gl = this.gl;
    return wrap === "repeat" ? gl.REPEAT : wrap === "mirror" ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
  }

  /** A texture to draw into, cleared to zero. */
  public target(width: number, height: number, format: Format, options: TargetOptions = {}): Target {
    const gl = this.gl;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    // Without float buffers a float target is 8 bits: the picture is there, the range is not.
    const actual: Format = format !== "rgba8" && !this.halfFloatColor ? "rgba8"
      : format === "rgba32f" && !this.floatColor ? "rgba16f" : format;
    const spec = this.formatOf(actual);
    const linear = (options.filter ?? "linear") === "linear" && (actual !== "rgba32f" || this.floatLinear);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const textures: WebGLTexture[] = [];
    const attachments = Math.max(1, options.attachments ?? 1);
    for (let index = 0; index < attachments; index += 1) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, spec.internal, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.wrapOf(options.wrap));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, this.wrapOf(options.wrap));
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, texture, 0);
      textures.push(texture);
    }
    gl.drawBuffers(textures.map((_, index) => gl.COLOR_ATTACHMENT0 + index));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Several attachments are drawn into one at a time (see `program`).
    const singles = attachments > 1 ? textures.map((texture) => {
      const single = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, single);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return single;
    }) : [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const target: Target = { texture: textures[0]!, textures, framebuffer, width: w, height: h, format: actual, singles };
    this.targets.add(target);
    return target;
  }

  public double(width: number, height: number, format: Format, options: TargetOptions = {}): Double {
    const pair: Double = {
      read: this.target(width, height, format, options),
      write: this.target(width, height, format, options),
      swap(): void {
        const held = pair.read;
        pair.read = pair.write;
        pair.write = held;
      }
    };
    return pair;
  }

  public deleteTarget(target: Target | null | undefined): void {
    if (!target || !this.targets.delete(target)) return;
    this.gl.deleteFramebuffer(target.framebuffer);
    for (const single of target.singles ?? []) this.gl.deleteFramebuffer(single);
    for (const texture of target.textures) this.gl.deleteTexture(texture);
  }

  public deleteDouble(pair: Double | null | undefined): void {
    if (!pair) return;
    this.deleteTarget(pair.read);
    this.deleteTarget(pair.write);
  }

  /**
   * The target resized (or made), keeping its picture scaled when `keep` is set — feedback
   * and simulations survive a resize, as the shader runner's buffers do.
   */
  public fit(target: Target | null, width: number, height: number, format: Format, options: TargetOptions = {}, keep = false): Target {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (target && target.width === w && target.height === h) return target;
    const next = this.target(w, h, format, options);
    if (target) {
      if (keep && target.textures.length === 1) this.blit(target, next);
      this.deleteTarget(target);
    }
    return next;
  }

  public fitDouble(pair: Double | null, width: number, height: number, format: Format, options: TargetOptions = {}, keep = false): Double {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (pair && pair.read.width === w && pair.read.height === h) return pair;
    const next = this.double(w, h, format, options);
    if (pair) {
      if (keep && pair.read.textures.length === 1) this.blit(pair.read, next.read);
      this.deleteDouble(pair);
    }
    return next;
  }

  /** `from`'s picture into `to`, scaled. */
  public blit(from: Target, to: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.framebuffer);
    const filter = from.format === "rgba32f" && !this.floatLinear ? gl.NEAREST : gl.LINEAR;
    gl.blitFramebuffer(0, 0, from.width, from.height, 0, 0, to.width, to.height, gl.COLOR_BUFFER_BIT, filter);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /** A texture of float data (R16F or RGBA16F/32F), for audio and lookup tables. */
  public dataTexture(width: number, height: number, channels: 1 | 4, data: Float32Array | null, options: { filter?: Filter; wrap?: Wrap; full?: boolean } = {}): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const internal = channels === 1 ? gl.R16F : options.full ? gl.RGBA32F : gl.RGBA16F;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, channels === 1 ? gl.RED : gl.RGBA, gl.FLOAT, data);
    const linear = (options.filter ?? "linear") === "linear" && (!options.full || this.floatLinear);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.wrapOf(options.wrap));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, this.wrapOf(options.wrap));
    this.ownedTextures.add(texture);
    return texture;
  }

  public updateDataTexture(texture: WebGLTexture, width: number, height: number, channels: 1 | 4, data: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, channels === 1 ? gl.RED : gl.RGBA, gl.FLOAT, data);
  }

  /** An 8-bit texture for pictures (a cover, a video frame); filled by the caller. */
  public imageTexture(wrap: Wrap = "mirror"): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.wrapOf(wrap));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, this.wrapOf(wrap));
    this.ownedTextures.add(texture);
    return texture;
  }

  public deleteTexture(texture: WebGLTexture | null | undefined): void {
    if (!texture || !this.ownedTextures.delete(texture)) return;
    this.gl.deleteTexture(texture);
  }

  public blend(mode: Blend): void {
    const gl = this.gl;
    if (mode === "none") {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(mode === "max" ? gl.MAX : gl.FUNC_ADD);
    if (mode === "alpha") gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
  }

  private bind(target: Target | null, width?: number, height?: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, target?.width ?? width ?? gl.drawingBufferWidth, target?.height ?? height ?? gl.drawingBufferHeight);
  }

  private apply(program: Program, uniforms: Uniforms): void {
    const gl = this.gl;
    if (!program.ready) this.finish(program);
    gl.useProgram(program.program);
    for (const [name, slot] of program.slots) {
      const value = uniforms[name];
      if (value === undefined || value === null) continue;
      if (slot.unit >= 0) {
        const texture = value instanceof WebGLTexture ? value : typeof value === "object" && "texture" in value ? value.texture : null;
        if (!texture) continue;
        gl.activeTexture(gl.TEXTURE0 + slot.unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        continue;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        const number = Number(value);
        if (slot.type === gl.INT || slot.type === gl.BOOL) gl.uniform1i(slot.location, Math.trunc(number));
        else if (slot.type === gl.UNSIGNED_INT) gl.uniform1ui(slot.location, Math.max(0, Math.trunc(number)));
        else gl.uniform1f(slot.location, number);
        continue;
      }
      if (value instanceof WebGLTexture || "texture" in value) continue;
      const list = value as readonly number[] | Float32Array;
      switch (slot.type) {
        case gl.FLOAT: gl.uniform1fv(slot.location, list); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(slot.location, list); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(slot.location, list); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(slot.location, list); break;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(slot.location, false, list); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(slot.location, false, list); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(slot.location, false, list); break;
        case gl.INT: gl.uniform1iv(slot.location, list); break;
        case gl.INT_VEC2: gl.uniform2iv(slot.location, list); break;
        default: break;
      }
    }
  }

  /** `issue` once into `target` — or, for a program of several outputs, once into each of its attachments. */
  private passes(program: Program, target: Target | null, uniforms: Uniforms, blend: Blend, issue: () => void): void {
    const gl = this.gl;
    this.blend(blend);
    const singles = target?.singles ?? [];
    if (target && program.others.length && singles.length > 1) {
      const count = Math.min(singles.length, program.others.length + 1);
      for (let index = 0; index < count; index += 1) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, singles[index]!);
        gl.viewport(0, 0, target.width, target.height);
        this.apply(index ? program.others[index - 1]! : program, uniforms);
        gl.bindVertexArray(this.empty);
        issue();
      }
      return;
    }
    this.bind(target);
    this.apply(program, uniforms);
    gl.bindVertexArray(this.empty);
    issue();
  }

  /** A full-screen pass of `program` into `target` (null: the canvas). */
  public draw(program: Program, target: Target | null, uniforms: Uniforms, blend: Blend = "none"): void {
    this.passes(program, target, uniforms, blend, () => this.gl.drawArrays(this.gl.TRIANGLES, 0, 3));
  }

  /**
   * A full-screen pass of one output of a program of several, into a target of one attachment:
   * for framebuffers made by hand (a layer of a 3D texture), which have no `singles`.
   */
  public drawOutput(program: Program, output: number, target: Target, uniforms: Uniforms): void {
    const gl = this.gl;
    this.blend("none");
    this.bind(target);
    this.apply(output ? program.others[output - 1] ?? program : program, uniforms);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** `count` points (the vertex stage reads gl_VertexID) into `target`. */
  public points(program: Program, target: Target | null, count: number, uniforms: Uniforms, blend: Blend = "add"): void {
    this.passes(program, target, uniforms, blend, () => this.gl.drawArrays(this.gl.POINTS, 0, count));
  }

  /** `instances` copies of a `vertices`-vertex strip (the vertex stage reads gl_VertexID and gl_InstanceID). */
  public instances(program: Program, target: Target | null, vertices: number, instances: number, uniforms: Uniforms, blend: Blend = "add"): void {
    this.passes(program, target, uniforms, blend, () => this.gl.drawArraysInstanced(this.gl.TRIANGLE_STRIP, 0, vertices, instances));
  }

  public clear(target: Target | null, r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    this.bind(target);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Whether GPU time can be measured (EXT_disjoint_timer_query_webgl2). */
  public get canTime(): boolean {
    return Boolean(this.timerExt);
  }

  /** Starts measuring GPU time; `timeEnd` ends it. One at a time. */
  public timeBegin(): void {
    if (!this.timerExt || this.activeQuery) return;
    const gl = this.gl;
    this.activeQuery = gl.createQuery();
    if (this.activeQuery) gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, this.activeQuery);
  }

  /** Ends the measurement; the milliseconds arrive a few frames later (null: disjoint or lost). */
  public timeEnd(): Promise<number | null> {
    if (!this.timerExt || !this.activeQuery) return Promise.resolve(null);
    const gl = this.gl;
    gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    const query = this.activeQuery;
    this.activeQuery = null;
    return new Promise((resolve) => {
      this.pendingQueries.push({ query, resolve });
    });
  }

  /** Collects finished measurements; call once a frame. */
  public pollTimers(): void {
    if (!this.timerExt || !this.pendingQueries.length) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT) as boolean;
    this.pendingQueries = this.pendingQueries.filter(({ query, resolve }) => {
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return true;
      const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(query);
      resolve(disjoint ? null : nanoseconds / 1e6);
      return false;
    });
  }

  public destroy(): void {
    const gl = this.gl;
    for (const stages of this.pending.values()) for (const { shader } of stages) gl.deleteShader(shader);
    this.pending.clear();
    for (const { program } of this.programs) gl.deleteProgram(program);
    this.programs.length = 0;
    kits.get(gl)?.delete(this);
    for (const target of [...this.targets]) this.deleteTarget(target);
    for (const texture of [...this.ownedTextures]) this.deleteTexture(texture);
    for (const { query, resolve } of this.pendingQueries) {
      gl.deleteQuery(query);
      resolve(null);
    }
    this.pendingQueries = [];
    gl.deleteVertexArray(this.empty);
  }
}
