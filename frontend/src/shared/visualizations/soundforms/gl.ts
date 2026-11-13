import type { CameraSettings, Stops, Vec3 } from "./catalog";

/**
 * Small WebGL 2 helpers for Formy dźwięku: programs with cached uniforms, render targets, the
 * matrices of a camera and the GLSL every scene shares (noise, gradients, the music history).
 */

export const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define PI 3.14159265
#define TAU 6.28318531
`;

/** Value noise from an integer hash, smooth to the second derivative; 0–1. */
export const NOISE = `
float hashCell(ivec3 c) {
  uvec3 q = uvec3(c + 4096);
  uint h = q.x * 0x8da6b343u ^ q.y * 0xd8163841u ^ q.z * 0xcb1ab31fu;
  h ^= h >> 13u;
  h *= 0x5bd1e995u;
  h ^= h >> 15u;
  return float(h & 0xffffffu) / 16777215.0;
}
float hash1(float n) {
  return hashCell(ivec3(int(n), int(n * 0.37) + 17, 911));
}
float noise3(vec3 p) {
  vec3 f = fract(p);
  ivec3 i = ivec3(floor(p));
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hashCell(i), b = hashCell(i + ivec3(1, 0, 0));
  float c = hashCell(i + ivec3(0, 1, 0)), d = hashCell(i + ivec3(1, 1, 0));
  float e = hashCell(i + ivec3(0, 0, 1)), g = hashCell(i + ivec3(1, 0, 1));
  float h = hashCell(i + ivec3(0, 1, 1)), k = hashCell(i + ivec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
`;

/** A gradient through up to eight colour stops, turned round the colour wheel by uHue. */
export const RAMP = `
uniform vec3 uStops[8];
uniform int uStopCount;
uniform float uHue;
vec3 turnHue(vec3 c, float angle) {
  const vec3 grey = vec3(0.57735027);
  float co = cos(angle), si = sin(angle);
  return c * co + cross(grey, c) * si + grey * dot(grey, c) * (1.0 - co);
}
vec3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uStopCount - 1);
  int i = int(floor(x));
  int j = min(i + 1, uStopCount - 1);
  vec3 c = mix(uStops[i], uStops[j], x - float(i));
  return uHue == 0.0 ? c : max(turnHue(c, uHue), 0.0);
}
`;

/**
 * The music's recent past (audio.ts, History): one row a moment, the newest at uHead; red is the
 * spectrum (columns low to high), green the waveform. Ages are in rows, fractional ones blended.
 */
export const HISTORY = (bands: number): string => `
uniform sampler2D uHist;
uniform int uHead;
uniform int uRows;
uniform float uPhase;
vec2 histTexel(int col, int age) {
  int row = uHead - age;
  row += row < 0 ? uRows : 0;
  return texelFetch(uHist, ivec2(col, row), 0).rg;
}
vec2 hist(float col01, float age) {
  float c = clamp(col01, 0.0, 1.0) * ${bands - 1}.0;
  int c0 = int(c);
  int c1 = min(c0 + 1, ${bands - 1});
  float fc = c - float(c0);
  float a = clamp(age - uPhase, 0.0, float(uRows - 2));
  int a0 = int(a);
  float fa = a - float(a0);
  vec2 near = mix(histTexel(c0, a0), histTexel(c1, a0), fc);
  vec2 far = mix(histTexel(c0, a0 + 1), histTexel(c1, a0 + 1), fc);
  return mix(near, far, fa);
}
`;

/** A triangle covering the screen, without attributes; vUv is 0–1. */
export const FULLSCREEN_VERTEX = `${HEADER}
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class Program {
  readonly program: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(private readonly gl: WebGL2RenderingContext, vertex: string, fragment: string) {
    const program = gl.createProgram();
    const shaders: WebGLShader[] = [];
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("WebGL shader allocation failed");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        const log = gl.getShaderInfoLog(shader) ?? "shader";
        gl.deleteShader(shader);
        for (const other of shaders) gl.deleteShader(other);
        gl.deleteProgram(program);
        throw new Error(`Formy dźwięku: shader failed: ${log}`);
      }
      gl.attachShader(program, shader);
      shaders.push(shader);
    }
    gl.linkProgram(program);
    for (const shader of shaders) {
      gl.detachShader(program, shader);
      gl.deleteShader(shader);
    }
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(program) ?? "program";
      gl.deleteProgram(program);
      throw new Error(`Formy dźwięku: program failed: ${log}`);
    }
    this.program = program;
  }

  use(): this {
    this.gl.useProgram(this.program);
    return this;
  }

  private at(name: string): WebGLUniformLocation | null {
    let location = this.locations.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, location);
    }
    return location;
  }

  f(name: string, x: number): this {
    this.gl.uniform1f(this.at(name), x);
    return this;
  }

  f2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.at(name), x, y);
    return this;
  }

  f3(name: string, x: number, y: number, z: number): this {
    this.gl.uniform3f(this.at(name), x, y, z);
    return this;
  }

  f4(name: string, x: number, y: number, z: number, w: number): this {
    this.gl.uniform4f(this.at(name), x, y, z, w);
    return this;
  }

  i(name: string, x: number): this {
    this.gl.uniform1i(this.at(name), x);
    return this;
  }

  m4(name: string, matrix: Float32Array): this {
    this.gl.uniformMatrix4fv(this.at(name), false, matrix);
    return this;
  }

  /** A gradient's stops (RAMP): `uStops`, `uStopCount`, and the hue turned by `hue`. */
  stops(stops: Stops, hue = 0): this {
    const count = Math.max(1, Math.min(8, stops.length));
    const values = new Float32Array(24);
    for (let index = 0; index < count; index += 1) values.set(rgb(stops[index] ?? 0), index * 3);
    this.gl.uniform3fv(this.at("uStops[0]"), values);
    this.gl.uniform1i(this.at("uStopCount"), count);
    this.gl.uniform1f(this.at("uHue"), hue);
    return this;
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}

/** 0xRRGGBB as three 0–1 numbers. */
export function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** A texture to draw into, with a depth buffer if asked. */
export interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  depth: WebGLRenderbuffer | null;
  width: number;
  height: number;
}

export function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  options: { depth?: boolean; hdr?: boolean } = {}
): Target {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (options.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  let depth: WebGLRenderbuffer | null = null;
  if (options.depth) {
    depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  }
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, texture, depth, width, height };
}

export function deleteTarget(gl: WebGL2RenderingContext, target: Target | null): void {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
  if (target.depth) gl.deleteRenderbuffer(target.depth);
}

// ——— matrices (column-major, as WebGL reads them) ———

export function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function lookAt(eye: Vec3, target: Vec3, roll = 0): Float32Array {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;
  // Up is +y, turned about the view axis by `roll`; looking straight down, +z stands in.
  let ux = Math.sin(roll);
  let uy = Math.cos(roll);
  let uz = 0;
  if (Math.abs(zy) > 0.999) {
    ux = 0; uy = 0; uz = -1;
  }
  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1
  ]);
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Rotation about x, then y, then z. */
export function rotation(x: number, y: number, z: number): Float32Array {
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  const rx = new Float32Array([1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]);
  const ry = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
  const rz = new Float32Array([cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return multiply(rz, multiply(ry, rx));
}

/**
 * A field of view for this picture's shape: the scenes are framed for 16:9, and a narrower picture
 * (a phone held upright) sees wider, so what was framed stays mostly in view.
 */
export function fitFov(degrees: number, aspect: number): number {
  const base = (degrees * Math.PI) / 180;
  const designed = 16 / 9;
  if (aspect >= designed) return base;
  const widened = Math.tan(base / 2) * (designed / Math.max(0.3, aspect)) ** 0.55;
  return Math.min(2 * Math.atan(widened), (115 * Math.PI) / 180);
}

export interface View {
  view: Float32Array;
  projection: Float32Array;
  viewProjection: Float32Array;
  eye: Vec3;
}

/** The camera of a scene at `time`: its orbit, a slow drift, and a nudge from the bass. */
export function cameraView(camera: CameraSettings, aspect: number, time: number, bass: number, near = 0.05, far = 200): View {
  const orbit = (camera.orbit ?? 0) * time;
  const sway = camera.sway ?? 0;
  const dx = camera.eye[0] - camera.target[0];
  const dz = camera.eye[2] - camera.target[2];
  const co = Math.cos(orbit), si = Math.sin(orbit);
  const drift = sway * (0.6 + 0.4 * bass);
  const eye: Vec3 = [
    camera.target[0] + dx * co - dz * si + drift * Math.sin(time * 0.21),
    camera.eye[1] + drift * 0.5 * Math.sin(time * 0.17 + 1.3),
    camera.target[2] + dx * si + dz * co + drift * 0.3 * Math.sin(time * 0.13 + 0.7)
  ];
  const target: Vec3 = [
    camera.target[0] + drift * 0.25 * Math.sin(time * 0.19 + 2.1),
    camera.target[1] + drift * 0.2 * Math.sin(time * 0.23),
    camera.target[2]
  ];
  const view = lookAt(eye, target, camera.roll ?? 0);
  const projection = perspective(fitFov(camera.fov, aspect), aspect, near, far);
  return { view, projection, viewProjection: multiply(projection, view), eye };
}
