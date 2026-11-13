import { MvAudio, type ShaderAudio } from "./audio";
import type { TextureBank, VideoTexture } from "./textures";
import type { AudioName, DrawMode, Geometry, Pass, Program, TextureSpec, UniformValue } from "./types";

/**
 * The WebGL 2 side of the shader visualizations: one context, programs compiled once and shared,
 * and a Graph per preset playing — its passes drawn into its buffers each frame, as Monkey Hi Hat
 * draws a visualizer's [multipass] (and an effect's) and music_visualizer its buffers.
 */

const EYECANDY = new Map<string, AudioName>([["eyecandyshadertoy", "eyecandyShadertoy"], ["eyecandyfreqdb", "eyecandyFreqDB"],
  ["eyecandywebaudio", "eyecandyWebAudio"]]);

/** The full-screen quad's corners and texture coordinates (Monkey Hi Hat's VertexQuad). */
const QUAD = new Float32Array([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, -1, 1, 0, 0, 1, 1, 1, 0, 1, 1]);

const PRESENT_VERTEX = `#version 300 es
layout(location = 0) in vec3 vertices;
layout(location = 1) in vec2 vertexTexCoords;
out vec2 fragCoord;
void main() {
  fragCoord = vertexTexCoords;
  gl_Position = vec4(vertices, 1.0);
}
`;

/** The picture to the screen, opaque. */
const PRESENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 fragCoord;
uniform sampler2D picture;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(picture, fragCoord).rgb, 1.0);
}
`;

/** Two pictures mixed: the plain crossfade, and an effect fading in over its visualization. */
export const MIX_FRAGMENT = `#version 300 es
precision highp float;
in vec2 fragCoord;
uniform sampler2D oldBuffer;
uniform sampler2D newBuffer;
uniform float fadeLevel;
out vec4 fragColor;
void main() {
  fragColor = mix(texture(oldBuffer, fragCoord), texture(newBuffer, fragCoord), fadeLevel);
}
`;

interface UniformSlot {
  name: string;
  location: WebGLUniformLocation;
  type: number;
  /** The texture unit of a sampler; -1 for anything else. */
  unit: number;
}

export interface CompiledProgram {
  key: string;
  program: WebGLProgram;
  shaders: WebGLShader[];
  state: "pending" | "ready" | "failed";
  error: string;
  uniforms: UniformSlot[];
  refs: number;
}

export interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

const MODES: Record<DrawMode, number> = {
  Points: WebGL2RenderingContext.POINTS,
  Lines: WebGL2RenderingContext.LINES,
  LineStrip: WebGL2RenderingContext.LINE_STRIP,
  LineLoop: WebGL2RenderingContext.LINE_LOOP,
  Triangles: WebGL2RenderingContext.TRIANGLES,
  TriangleStrip: WebGL2RenderingContext.TRIANGLE_STRIP,
  TriangleFan: WebGL2RenderingContext.TRIANGLE_FAN
};

/** How many unused programs stay compiled for a preset that comes back. */
const SPARE_PROGRAMS = 24;

export class Gpu {
  public readonly parallel: KHR_parallel_shader_compile | null;
  /** Float buffers can be drawn into (music_visualizer's are 32-bit floats). */
  public readonly floatColor: boolean;
  private readonly quad: { vao: WebGLVertexArrayObject; buffer: WebGLBuffer };
  private readonly empty: WebGLVertexArrayObject;
  private readonly arrays = new Map<number, { vao: WebGLVertexArrayObject; buffer: WebGLBuffer }>();
  private readonly programs = new Map<string, CompiledProgram>();
  public readonly dummy2D: WebGLTexture;
  public readonly dummyCube: WebGLTexture;
  private present: CompiledProgram | null = null;
  private mix: CompiledProgram | null = null;

  public constructor(public readonly gl: WebGL2RenderingContext) {
    this.parallel = gl.getExtension("KHR_parallel_shader_compile");
    this.floatColor = Boolean(gl.getExtension("EXT_color_buffer_float"));
    gl.getExtension("OES_texture_float_linear");
    const vao = gl.createVertexArray()!;
    const buffer = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    this.quad = { vao, buffer };
    this.empty = gl.createVertexArray()!;
    const black = new Uint8Array([0, 0, 0, 255]);
    this.dummy2D = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummy2D);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, black);
    this.dummyCube = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.dummyCube);
    for (let face = 0; face < 6; face += 1) {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, black);
    }
  }

  /** A program for these stages: the one compiled already, or a new one compiling. */
  public acquire(vertex: string, fragment: string): CompiledProgram {
    const key = `${vertex.length}:${fragment.length}:${hashText(vertex)}:${hashText(fragment)}`;
    let compiled = this.programs.get(key);
    if (!compiled) {
      compiled = this.compile(key, vertex, fragment);
      this.programs.set(key, compiled);
    } else {
      // Most recently used last, for the eviction below.
      this.programs.delete(key);
      this.programs.set(key, compiled);
    }
    compiled.refs += 1;
    return compiled;
  }

  public release(compiled: CompiledProgram): void {
    compiled.refs = Math.max(0, compiled.refs - 1);
    const spare = [...this.programs.values()].filter((program) => program.refs === 0);
    for (const program of spare.slice(0, Math.max(0, spare.length - SPARE_PROGRAMS))) this.deleteProgram(program);
  }

  private compile(key: string, vertex: string, fragment: string): CompiledProgram {
    const gl = this.gl;
    const program = gl.createProgram()!;
    const shaders = [gl.createShader(gl.VERTEX_SHADER)!, gl.createShader(gl.FRAGMENT_SHADER)!];
    gl.shaderSource(shaders[0]!, vertex);
    gl.shaderSource(shaders[1]!, fragment);
    for (const shader of shaders) {
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    // A content vertex stage that does not say where its inputs are gets them where the quad has them.
    gl.bindAttribLocation(program, 0, "vertices");
    gl.bindAttribLocation(program, 1, "vertexTexCoords");
    gl.bindAttribLocation(program, 0, "vertexId");
    gl.linkProgram(program);
    const compiled: CompiledProgram = { key, program, shaders, state: "pending", error: "", uniforms: [], refs: 0 };
    if (!this.parallel) this.finish(compiled);
    return compiled;
  }

  /** Whether the program is done compiling; asks without waiting where the browser can. */
  public poll(compiled: CompiledProgram): boolean {
    if (compiled.state !== "pending") return true;
    const gl = this.gl;
    if (this.parallel && !gl.getProgramParameter(compiled.program, this.parallel.COMPLETION_STATUS_KHR)) return false;
    this.finish(compiled);
    return true;
  }

  private finish(compiled: CompiledProgram): void {
    const gl = this.gl;
    if (!gl.getProgramParameter(compiled.program, gl.LINK_STATUS)) {
      const logs = compiled.shaders.map((shader) => (gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? "" : gl.getShaderInfoLog(shader) ?? ""));
      compiled.state = "failed";
      compiled.error = (logs.filter(Boolean).join("\n") || gl.getProgramInfoLog(compiled.program) || "link failed").slice(0, 2000);
      return;
    }
    const count = gl.getProgramParameter(compiled.program, gl.ACTIVE_UNIFORMS) as number;
    let unit = 0;
    gl.useProgram(compiled.program);
    for (let index = 0; index < count; index += 1) {
      const info = gl.getActiveUniform(compiled.program, index);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, "");
      const location = gl.getUniformLocation(compiled.program, info.name);
      if (!location) continue;
      const sampler = info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_CUBE;
      compiled.uniforms.push({ name, location, type: info.type, unit: sampler ? unit : -1 });
      if (sampler) gl.uniform1i(location, unit++);
    }
    compiled.state = "ready";
    for (const shader of compiled.shaders) {
      gl.detachShader(compiled.program, shader);
      gl.deleteShader(shader);
    }
    compiled.shaders = [];
  }

  private deleteProgram(compiled: CompiledProgram): void {
    for (const shader of compiled.shaders) this.gl.deleteShader(shader);
    this.gl.deleteProgram(compiled.program);
    this.programs.delete(compiled.key);
  }

  /** The vertices 0…count−1 as the `vertexId` attribute (Monkey Hi Hat's VertexIntegerArray). */
  private array(count: number): WebGLVertexArrayObject {
    let entry = this.arrays.get(count);
    if (!entry) {
      const gl = this.gl;
      const vao = gl.createVertexArray()!;
      const buffer = gl.createBuffer()!;
      const ids = new Float32Array(count);
      for (let index = 0; index < count; index += 1) ids[index] = index;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 4, 0);
      gl.bindVertexArray(null);
      entry = { vao, buffer };
      this.arrays.set(count, entry);
    }
    return entry.vao;
  }

  public draw(geometry: Geometry | undefined): void {
    const gl = this.gl;
    if (!geometry || geometry.type === "quad") {
      gl.bindVertexArray(this.quad.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (geometry.type === "array") {
      gl.bindVertexArray(this.array(geometry.count));
      gl.drawArrays(MODES[geometry.mode] ?? gl.POINTS, 0, geometry.count);
    } else {
      gl.bindVertexArray(this.empty);
      gl.drawArraysInstanced(MODES[geometry.mode] ?? gl.TRIANGLES, 0, geometry.vertices, geometry.instances);
    }
    gl.bindVertexArray(null);
  }

  public target(width: number, height: number, format: "rgba8" | "float", wrap: number): Target {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (format === "float" && this.floatColor) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
    else gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height };
  }

  /** `from`'s picture into `to`, scaled. */
  public blit(from: Target, to: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.framebuffer);
    gl.blitFramebuffer(0, 0, from.width, from.height, 0, 0, to.width, to.height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  public deleteTarget(target: Target): void {
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  /** A picture onto the canvas (the default framebuffer), filling it. */
  public show(texture: WebGLTexture, width: number, height: number): void {
    this.present ??= this.acquire(PRESENT_VERTEX, PRESENT_FRAGMENT);
    if (!this.poll(this.present) || this.present.state !== "ready") return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.present.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.draw({ type: "quad" });
  }

  /** The plain mix of two pictures into `to` (or the canvas), `level` of the new one. */
  public mixInto(to: Target | null, older: WebGLTexture, newer: WebGLTexture, level: number, width: number, height: number): boolean {
    this.mix ??= this.acquire(PRESENT_VERTEX, MIX_FRAGMENT);
    if (!this.poll(this.mix) || this.mix.state !== "ready") return false;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, to?.framebuffer ?? null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.mix.program);
    for (const slot of this.mix.uniforms) {
      if (slot.name === "fadeLevel") gl.uniform1f(slot.location, level);
      else if (slot.unit >= 0) {
        gl.activeTexture(gl.TEXTURE0 + slot.unit);
        gl.bindTexture(gl.TEXTURE_2D, slot.name === "oldBuffer" ? older : newer);
      }
    }
    this.draw({ type: "quad" });
    return true;
  }

  private probeTarget: Target | null = null;
  private readonly probePixels = new Uint8Array(32 * 18 * 4);

  /** The brightest channel of a picture shrunk to 32 × 18 (0–255): a black picture reads 0. */
  public brightness(picture: Target): number {
    this.probeTarget ??= this.target(32, 18, "rgba8", this.gl.CLAMP_TO_EDGE);
    this.blit(picture, this.probeTarget);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeTarget.framebuffer);
    gl.readPixels(0, 0, 32, 18, gl.RGBA, gl.UNSIGNED_BYTE, this.probePixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let brightest = 0;
    for (let index = 0; index < this.probePixels.length; index += 4) {
      brightest = Math.max(brightest, this.probePixels[index]!, this.probePixels[index + 1]!, this.probePixels[index + 2]!);
    }
    return brightest;
  }

  /** A crossfade of Volt's Laboratory onto the canvas: Monkey Hi Hat's uniforms for it. */
  public crossfade(compiled: CompiledProgram, older: WebGLTexture, newer: WebGLTexture, level: number,
    state: { seconds: number; frame: number; random: number; random4: readonly number[]; seed: number; randomNumber: number },
    width: number, height: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(compiled.program);
    const values: Record<string, number | readonly number[]> = {
      fadeLevel: Math.min(1, Math.max(0, level)), fadeDuration: CROSSFADE_SECONDS, resolution: [width, height],
      time: state.seconds, frame: state.frame, randomrun: state.random, randomrun4: state.random4,
      randomseed: state.seed, randomnumber: state.randomNumber, fxactive: 0, silent: 0
    };
    for (const slot of compiled.uniforms) {
      if (slot.unit >= 0) {
        gl.activeTexture(gl.TEXTURE0 + slot.unit);
        if (slot.type === gl.SAMPLER_CUBE) gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.dummyCube);
        else gl.bindTexture(gl.TEXTURE_2D, slot.name === "oldBuffer" ? older : slot.name === "newBuffer" ? newer : this.dummy2D);
        continue;
      }
      const value = values[slot.name];
      if (value !== undefined) setValue(gl, slot, value);
    }
    this.draw({ type: "quad" });
  }

  public destroy(): void {
    const gl = this.gl;
    for (const compiled of [...this.programs.values()]) this.deleteProgram(compiled);
    for (const entry of this.arrays.values()) {
      gl.deleteVertexArray(entry.vao);
      gl.deleteBuffer(entry.buffer);
    }
    this.arrays.clear();
    gl.deleteVertexArray(this.quad.vao);
    gl.deleteBuffer(this.quad.buffer);
    gl.deleteVertexArray(this.empty);
    gl.deleteTexture(this.dummy2D);
    gl.deleteTexture(this.dummyCube);
    if (this.probeTarget) this.deleteTarget(this.probeTarget);
    this.probeTarget = null;
  }
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

/** The longer side brought down to `limit` (Monkey Hi Hat's RenderResolutionLimit). */
export function limitSize(width: number, height: number, limit: number): [number, number] {
  const larger = Math.max(width, height);
  if (!limit || larger <= limit) return [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))];
  const scale = limit / larger;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

const resolve = (value: UniformValue, random: () => number): number =>
  Array.isArray(value) ? value[0] + random() * (value[1] - value[0]) : value;

/** What every pass of a frame shares. */
export interface FrameState {
  now: number;
  fxActive: boolean;
  /** Monkey Hi Hat's randomseed: one per visualizer opened. */
  seed: number;
  /** Its randomnumber: one per frame. */
  randomNumber: number;
}

interface Buffer {
  targets: Target[];
  /** Frame mode: the one drawn into this frame. Draw mode: the one drawn last. */
  current: number;
  size: [number, number] | null;
}

/** One preset (or effect) playing: its programs, buffers, textures and clock. */
export class Graph {
  public state: "loading" | "ready" | "failed" = "loading";
  public error = "";
  private readonly compiled: (CompiledProgram | null)[] = [];
  private readonly buffers: Buffer[] = [];
  private readonly textures = new Map<string, { texture: WebGLTexture; cube: boolean }>();
  /** Videos playing for this preset, by the uniform that samples them. */
  private readonly videos = new Map<string, VideoTexture>();
  private readonly uniforms: Record<string, number>;
  private readonly fxValues: Record<string, number>;
  private readonly passValues: Record<string, number>[];
  private readonly randomRun: number;
  private readonly randomRun4: [number, number, number, number];
  private readonly timeOffset: number;
  private mv: MvAudio | null = null;
  private width = 0;
  private height = 0;
  private startedAt = 0;
  private frame = 0;
  private pending = 0;
  private fade: Target | null = null;
  /** An effect: the visualization under it. */
  public primary: Graph | null = null;
  /** The audio textures it reads: those its .conf names, and any its shaders sample. */
  public readonly eyecandy = new Set<AudioName>();
  public readonly stereo: boolean;

  public constructor(
    private readonly gpu: Gpu,
    public readonly program: Program,
    private readonly bank: TextureBank,
    options: { fxName?: string; random?: () => number } = {}
  ) {
    const random = options.random ?? Math.random;
    this.randomRun = random();
    this.randomRun4 = [random(), random(), random(), random()];
    const offset = program.timeOffset ?? 0;
    this.timeOffset = offset ? Math.floor(random() * (Math.abs(offset) + 1)) * Math.sign(offset) : 0;
    this.uniforms = Object.fromEntries(Object.entries(program.uniforms).map(([name, value]) => [name, resolve(value, random)]));
    this.fxValues = {};
    this.passValues = program.passes.map((pass) => Object.fromEntries(Object.entries(pass.uniforms ?? {})
      .map(([name, value]) => [name, resolve(value, random)])));
    for (const entry of program.audio) this.eyecandy.add(entry.name);
    this.stereo = Boolean(program.mvAudio);
    for (const pass of program.passes) {
      if (pass.primary || !pass.vertex || !pass.fragment) {
        this.compiled.push(null);
        continue;
      }
      this.compiled.push(gpu.acquire(pass.vertex, pass.fragment));
    }
    if (program.mvAudio) this.mv = new MvAudio(gpu.gl, program.mvAudio);
    // Textures: each uniform gets one of its files, chosen now. With RandomTextureSync, uniforms
    // listing as many files as the first one with a choice take the same place in their lists.
    const choices = program.textures.find((spec) => !spec.video && spec.files.length > 1)?.files.length ?? 0;
    const syncIndex = program.textureSync && choices ? Math.floor(random() * choices) : undefined;
    for (const spec of program.textures) {
      const index = spec.files.length === choices ? syncIndex : undefined;
      if (spec.video) {
        const video = this.bank.video(this.bank.choose(spec, random, index));
        if (video) {
          this.videos.set(spec.uniform, video);
          this.textures.set(spec.uniform, { texture: video.texture, cube: false });
        }
        continue;
      }
      this.pending += 1;
      void this.bank.texture(spec, this.bank.choose(spec, random, index)).then(
        (texture) => {
          this.textures.set(spec.uniform, { texture, cube: spec.cube });
          this.pending -= 1;
        },
        (error: unknown) => {
          this.state = "failed";
          this.error = `texture ${spec.uniform}: ${error instanceof Error ? error.message : String(error)}`;
        }
      );
    }
  }

  /** An effect's values for its uniforms from the visualization under it ([fx-uniforms:name]). */
  public setFxUniforms(values: Record<string, UniformValue> | undefined, random: () => number = Math.random): void {
    for (const [name, value] of Object.entries(values ?? {})) this.fxValues[name] = resolve(value, random);
  }

  /** Whether everything is compiled and fetched; true once ready, false while it still loads. */
  public poll(): boolean {
    if (this.state !== "loading") return this.state === "ready";
    let done = this.pending === 0;
    for (const compiled of this.compiled) {
      if (!compiled) continue;
      if (!this.gpu.poll(compiled)) done = false;
      else if (compiled.state === "failed") {
        this.state = "failed";
        this.error = compiled.error;
        return false;
      }
    }
    if (this.primary && !this.primary.poll()) {
      if (this.primary.state === "failed") {
        this.state = "failed";
        this.error = `under the effect: ${this.primary.error}`;
      }
      return false;
    }
    if (done) {
      this.state = "ready";
      for (const compiled of this.compiled) {
        for (const slot of compiled?.uniforms ?? []) {
          const name = slot.unit >= 0 ? EYECANDY.get(slot.name.toLowerCase()) : undefined;
          if (name) this.eyecandy.add(name);
        }
      }
    }
    return done;
  }

  /** The picture's size; buffers follow, keeping what they held (feedback survives a resize). */
  public resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const program = this.program;
    const format = program.swap === "draw" ? "float" : "rgba8";
    const wrap = program.swap === "draw" ? this.gpu.gl.CLAMP_TO_EDGE : this.gpu.gl.REPEAT;
    for (let index = 0; index < program.buffers; index += 1) {
      const fixed = program.passes.find((pass) => pass.draw === index && pass.size)?.size ?? null;
      const [w, h] = fixed ?? [width, height];
      const count = program.swap === "draw" || program.previous.includes(index) ? 2 : 1;
      const existing = this.buffers[index];
      const targets = Array.from({ length: count }, (_, at) => {
        const target = this.gpu.target(w, h, format, wrap);
        const old = existing?.targets[at];
        if (old) {
          this.gpu.blit(old, target);
          this.gpu.deleteTarget(old);
        }
        return target;
      });
      this.buffers[index] = { targets, current: existing?.current ?? 0, size: fixed };
    }
    if (this.fade) {
      this.gpu.deleteTarget(this.fade);
      this.fade = null;
    }
  }

  private texture(buffer: number, which: "front" | "back" | "latest"): Target | null {
    const entry = this.buffers[buffer];
    if (!entry) return null;
    if (which === "latest") return entry.targets[entry.current] ?? null;
    if (which === "front") return entry.targets[entry.current] ?? null;
    return entry.targets[1 - entry.current] ?? entry.targets[0] ?? null;
  }

  /** Draws a frame; the picture is in the returned target. */
  public render(state: FrameState, audio: ShaderAudio, primaryOutput: Target | null): Target | null {
    if (this.state !== "ready" || !this.width) return null;
    const gl = this.gpu.gl;
    if (!this.startedAt) this.startedAt = state.now;
    const seconds = (state.now - this.startedAt) / 1000;
    if (this.mv) this.mv.update(audio);
    for (const video of this.videos.values()) video.update();
    const program = this.program;
    const drawMode = program.swap === "draw";
    if (program.blend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
    let output: Target | null = null;
    program.passes.forEach((pass, index) => {
      if (pass.primary) {
        const front = this.texture(pass.draw, "front");
        if (front && primaryOutput) this.gpu.blit(primaryOutput, front);
        return;
      }
      const compiled = this.compiled[index];
      if (!compiled || compiled.state !== "ready") return;
      const buffer = this.buffers[pass.draw];
      if (!buffer) return;
      const target = drawMode ? buffer.targets[1 - buffer.current]! : buffer.targets[buffer.current]!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      const clear = pass.clear ?? [0, 0, 0, 0];
      gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(compiled.program);
      this.setUniforms(compiled, pass, index, target, seconds, state, audio);
      this.gpu.draw(pass.geometry);
      if (drawMode) buffer.current = 1 - buffer.current;
      output = drawMode ? buffer.targets[buffer.current]! : target;
    });
    if (!drawMode) {
      // Buffers read as they were last frame swap their two textures.
      output = this.texture(program.output, "front");
      for (const index of program.previous) {
        const buffer = this.buffers[index];
        if (buffer && buffer.targets.length === 2) buffer.current = 1 - buffer.current;
      }
    }
    this.frame += 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const result = output as Target | null;
    // An effect fades in over the visualization under it, as Monkey Hi Hat's FX crossfade does.
    if (result && primaryOutput && program.crossfade && seconds < FX_FADE_SECONDS) {
      this.fade ??= this.gpu.target(result.width, result.height, "rgba8", gl.CLAMP_TO_EDGE);
      if (this.gpu.mixInto(this.fade, primaryOutput.texture, result.texture, seconds / FX_FADE_SECONDS, this.fade.width, this.fade.height)) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return this.fade;
      }
    }
    return result;
  }

  private setUniforms(compiled: CompiledProgram, pass: Pass, index: number, target: Target, seconds: number,
    state: FrameState, audio: ShaderAudio): void {
    const gl = this.gpu.gl;
    const time = seconds + this.timeOffset;
    const now = new Date(Date.now());
    const values = this.passValues[index]!;
    for (const slot of compiled.uniforms) {
      const name = slot.name;
      if (slot.unit >= 0) {
        this.bindSampler(slot, pass, target, audio);
        continue;
      }
      let value: number | readonly number[] | undefined;
      switch (name) {
        case "resolution": value = [target.width, target.height]; break;
        case "time": value = time; break;
        case "frame": value = this.frame; break;
        case "randomrun": value = this.randomRun; break;
        case "randomrun4": value = this.randomRun4; break;
        case "randomseed": value = state.seed; break;
        case "randomnumber": value = state.randomNumber; break;
        case "date": value = [now.getFullYear(), now.getMonth() + 1, now.getDate(),
          now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000]; break;
        case "clocktime": value = [now.getHours(), now.getMinutes(), now.getSeconds(), now.getUTCHours()]; break;
        case "fxactive": value = state.fxActive ? 1 : 0; break;
        case "silent": value = 0; break;
        case "vertexCount": value = pass.geometry?.type === "array" ? pass.geometry.count : 0; break;
        // music_visualizer's
        case "iRes": value = [this.width, this.height]; break;
        case "iBuffRes": value = [target.width, target.height]; break;
        case "iTime": value = seconds; break;
        case "iFrame": value = this.frame; break;
        case "iMouse": case "iMouseDownPos": value = [0, 0]; break;
        case "iMouseDown": value = 0; break;
        case "iNumGeomIters": value = pass.geometry?.type === "instanced" ? pass.geometry.instances : 1; break;
        default:
          value = values[name] ?? this.fxValues[name] ?? this.uniforms[name] ?? this.program.mvUniforms?.[name]
            ?? this.videoValue(name) ?? pass.defaults?.[name];
      }
      if (value === undefined) continue;
      setValue(gl, slot, value);
    }
  }

  /** `<name>_duration`, `<name>_progress` and `<name>_resolution` of a video sampled as `<name>`. */
  private videoValue(name: string): number | readonly number[] | undefined {
    const match = /^(.*)_(duration|progress|resolution)$/.exec(name);
    const video = match ? this.videos.get(match[1]!) : undefined;
    if (!video || !match) return undefined;
    return match[2] === "duration" ? video.duration : match[2] === "progress" ? video.progress : video.resolution;
  }

  private bindSampler(slot: UniformSlot, pass: Pass, target: Target, audio: ShaderAudio): void {
    const gl = this.gpu.gl;
    const cube = slot.type === gl.SAMPLER_CUBE;
    let texture: WebGLTexture | null = null;
    const input = pass.inputs.find((candidate) => candidate.uniform === slot.name);
    if (input) {
      const source = this.texture(input.buffer, input.latest ? "latest" : input.previous ? "back" : "front");
      // Never the texture this pass draws into.
      if (source && source !== target) texture = source.texture;
    } else {
      const eyecandy = EYECANDY.get(slot.name.toLowerCase());
      if (eyecandy) texture = audio.texture(eyecandy);
      else texture = this.mv?.texture(slot.name) ?? this.textures.get(slot.name)?.texture ?? null;
    }
    gl.activeTexture(gl.TEXTURE0 + slot.unit);
    if (cube) {
      const entry = this.textures.get(slot.name);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, entry?.cube ? entry.texture : this.gpu.dummyCube);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, texture && !this.textures.get(slot.name)?.cube ? texture : this.gpu.dummy2D);
    }
  }

  public destroy(): void {
    for (const compiled of this.compiled) if (compiled) this.gpu.release(compiled);
    this.compiled.length = 0;
    for (const buffer of this.buffers) for (const target of buffer.targets) this.gpu.deleteTarget(target);
    this.buffers.length = 0;
    if (this.fade) this.gpu.deleteTarget(this.fade);
    this.fade = null;
    this.mv?.destroy();
    for (const video of this.videos.values()) video.destroy();
    this.videos.clear();
    this.mv = null;
    this.primary?.destroy();
    this.primary = null;
    this.state = "failed";
  }
}

/** How long an effect fades in over its visualization, and one preset into the next (Monkey Hi Hat's CrossfadeSeconds). */
export const FX_FADE_SECONDS = 2;
export const CROSSFADE_SECONDS = 2;

/** The vertex stage a crossfade is drawn with. */
export const CROSSFADE_VERTEX = PRESENT_VERTEX;

function setValue(gl: WebGL2RenderingContext, slot: UniformSlot, value: number | readonly number[]): void {
  const list = typeof value === "number" ? [value] : value;
  const at = (index: number): number => list[index] ?? list[0] ?? 0;
  switch (slot.type) {
    case gl.FLOAT: gl.uniform1f(slot.location, at(0)); break;
    case gl.FLOAT_VEC2: gl.uniform2f(slot.location, at(0), at(1)); break;
    case gl.FLOAT_VEC3: gl.uniform3f(slot.location, at(0), at(1), at(2)); break;
    case gl.FLOAT_VEC4: gl.uniform4f(slot.location, at(0), at(1), at(2), at(3)); break;
    case gl.INT: case gl.BOOL: gl.uniform1i(slot.location, Math.trunc(at(0))); break;
    case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2i(slot.location, Math.trunc(at(0)), Math.trunc(at(1))); break;
    case gl.UNSIGNED_INT: gl.uniform1ui(slot.location, Math.max(0, Math.trunc(at(0)))); break;
    default: break;
  }
}

/** Whether the textures a program names can all be had (no video, no picture the build lacks). */
export function texturesAvailable(program: Program, bank: TextureBank): boolean {
  return program.textures.every((spec: TextureSpec) => bank.available(spec));
}
