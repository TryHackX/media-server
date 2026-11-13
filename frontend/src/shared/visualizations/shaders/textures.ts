import type { TextureSpec } from "./types";

/**
 * The images a shader samples. Shadertoy's noise textures are noise, so they are made here, with
 * the property its RGBA noise has and shaders rely on (green is red 37 texels left and 17 down,
 * alpha is blue likewise: iq's 3D noise from one 2D lookup). Its photographs (Abstract, Organic,
 * Stars…) are not part of the build unless the owner put Volt's Laboratory's textures/ folder in
 * vendor/ too; without them a coloured noise of the same size stands in — the shaders use them for
 * colour and surface detail. Cube maps get a sky, or the build's own cube map pictures, sliced as
 * Monkey Hi Hat slices them. Videos play from the build's files. A texture the content has no
 * stand-in for and the build lacks (a video, Monkey Hi Hat's own pictures) makes the preset
 * unavailable.
 */

export interface TextureSource {
  /** URLs of the image and video files the build carries, by the name a .conf gives them. */
  images: Readonly<Record<string, string>>;
}

/** A small deterministic generator: the same stand-ins every time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

/** The size a Shadertoy file name gives (`… 256x256.png`), at most 1024. */
function sizeOf(name: string, fallback: number): number {
  const match = /(\d+)x(\d+)/.exec(name);
  return Math.min(1024, Math.max(8, match ? Number(match[1]) : fallback));
}

type Pixels = { width: number; height: number; data: Uint8Array };

/** Shadertoy's RGBA noise: G is R shifted by (37, 17), A is B shifted likewise. */
function rgbaNoise(size: number, seed: number): Pixels {
  const next = random(seed);
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    data[index * 4] = Math.floor(next() * 256);
    data[index * 4 + 2] = Math.floor(next() * 256);
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((((y - 17) % size) + size) % size) * size + ((((x - 37) % size) + size) % size);
      const at = (y * size + x) * 4;
      data[at + 1] = data[from * 4]!;
      data[at + 3] = data[from * 4 + 2]!;
    }
  }
  return { width: size, height: size, data };
}

function grayNoise(size: number, seed: number): Pixels {
  const next = random(seed);
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    const value = Math.floor(next() * 256);
    data[index * 4] = value;
    data[index * 4 + 1] = value;
    data[index * 4 + 2] = value;
    data[index * 4 + 3] = 255;
  }
  return { width: size, height: size, data };
}

/** White noise with its low frequencies taken out: close enough to blue noise for dithering. */
function blueNoise(size: number, seed: number): Pixels {
  const next = random(seed);
  const data = new Uint8Array(size * size * 4);
  const plane = new Float32Array(size * size);
  const blurred = new Float32Array(size * size);
  for (let channel = 0; channel < 4; channel += 1) {
    for (let index = 0; index < plane.length; index += 1) plane[index] = next();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) sum += plane[((y + dy + size) % size) * size + ((x + dx + size) % size)]!;
        }
        blurred[y * size + x] = sum / 9;
      }
    }
    for (let index = 0; index < plane.length; index += 1) {
      const value = 0.5 + (plane[index]! - blurred[index]!) * 1.6;
      data[index * 4 + channel] = Math.max(0, Math.min(255, Math.round(value * 255)));
    }
  }
  return { width: size, height: size, data };
}

/** The 8×8 ordered-dither matrix. */
function bayer(): Pixels {
  const data = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let value = 0;
      for (let bit = 0; bit < 3; bit += 1) {
        const xb = (x >> bit) & 1;
        const yb = (y >> bit) & 1;
        value |= ((xb ^ yb) << (2 * (2 - bit) + 1)) | (yb << (2 * (2 - bit)));
      }
      const byte = Math.round((value / 64) * 255);
      data.set([byte, byte, byte, 255], (y * 8 + x) * 4);
    }
  }
  return { width: 8, height: 8, data };
}

/** Smooth value noise over a lattice, tiling at `size`. */
function fbm(size: number, seed: number, octaves: number, base: number): Float32Array {
  const next = random(seed);
  const out = new Float32Array(size * size);
  let amplitude = 0.5;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const cells = Math.min(size, base << octave);
    const lattice = new Float32Array(cells * cells);
    for (let index = 0; index < lattice.length; index += 1) lattice[index] = next();
    const step = cells / size;
    for (let y = 0; y < size; y += 1) {
      const fy = y * step;
      const y0 = Math.floor(fy) % cells;
      const y1 = (y0 + 1) % cells;
      const ty = fy - Math.floor(fy);
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x += 1) {
        const fx = x * step;
        const x0 = Math.floor(fx) % cells;
        const x1 = (x0 + 1) % cells;
        const tx = fx - Math.floor(fx);
        const sx = tx * tx * (3 - 2 * tx);
        const a = lattice[y0 * cells + x0]!;
        const b = lattice[y0 * cells + x1]!;
        const c = lattice[y1 * cells + x0]!;
        const d = lattice[y1 * cells + x1]!;
        out[y * size + x]! += amplitude * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let index = 0; index < out.length; index += 1) out[index] = out[index]! / total;
  return out;
}

/** A stand-in for one of Shadertoy's photographs: coloured noise, or a starfield for "Stars". */
function photograph(name: string): Pixels {
  const size = Math.min(512, sizeOf(name, 512));
  const seed = seedOf(name);
  const data = new Uint8Array(size * size * 4);
  if (/star/i.test(name)) {
    const next = random(seed);
    for (let index = 0; index < size * size; index += 1) {
      const glow = next() > 0.996 ? 160 + next() * 95 : next() * 12;
      data.set([glow, glow, Math.min(255, glow * 1.1), 255], index * 4);
    }
    return { width: size, height: size, data };
  }
  const shape = fbm(size, seed, 6, 4);
  const detail = fbm(size, seed ^ 0x9e3779b9, 4, 16);
  const next = random(seed ^ 0x51ed270b);
  const hue = next() * Math.PI * 2;
  const tint = [0, 2.094, 4.189].map((offset) => 0.55 + 0.45 * Math.cos(hue + offset));
  for (let index = 0; index < size * size; index += 1) {
    const value = Math.min(1, Math.max(0, shape[index]! * 1.25 - 0.12 + (detail[index]! - 0.5) * 0.35));
    data[index * 4] = Math.round(255 * value * tint[0]!);
    data[index * 4 + 1] = Math.round(255 * value * (0.4 + 0.6 * tint[1]!));
    data[index * 4 + 2] = Math.round(255 * value * tint[2]!);
    data[index * 4 + 3] = 255;
  }
  return { width: size, height: size, data };
}

/** Whether `name` is one of Shadertoy's textures, which a stand-in may replace. */
export function isShadertoyTexture(name: string): boolean {
  return /^shadertoy\s/i.test(name);
}

function procedural(name: string): Pixels {
  const seed = seedOf(name);
  if (/bayer/i.test(name)) return bayer();
  if (/blue noise/i.test(name)) return blueNoise(sizeOf(name, 1024), seed);
  if (/gray noise|grey noise/i.test(name)) return grayNoise(sizeOf(name, 256), seed);
  if (/noise/i.test(name)) return rgbaNoise(sizeOf(name, 256), seed);
  return photograph(name);
}

/** A sky for a cube map: blue above, a warm horizon, dark ground. */
function skyFace(face: number, size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size * 2 - 1;
      const v = (y + 0.5) / size * 2 - 1;
      // The direction this texel stands for (GL's cube map faces: +X, -X, +Y, -Y, +Z, -Z).
      const direction = [[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]][face]!;
      const length = Math.hypot(direction[0]!, direction[1]!, direction[2]!);
      const up = direction[1]! / length;
      const sky = Math.max(0, up);
      const ground = Math.max(0, -up);
      const horizon = Math.exp(-Math.abs(up) * 6);
      const r = 40 + 60 * sky + 180 * horizon - 30 * ground;
      const g = 70 + 90 * sky + 110 * horizon - 50 * ground;
      const b = 140 + 110 * sky + 40 * horizon - 110 * ground;
      data.set([r, g, b, 255].map((value) => Math.max(0, Math.min(255, Math.round(value)))), (y * size + x) * 4);
    }
  }
  return data;
}

/** The textures of one WebGL context, made or fetched once and shared by every preset. */
export class TextureBank {
  private readonly cache = new Map<string, Promise<WebGLTexture>>();
  private readonly made: WebGLTexture[] = [];

  public constructor(private readonly gl: WebGL2RenderingContext, private readonly source: TextureSource) {}

  private usable(spec: TextureSpec, file: string): boolean {
    if (this.source.images[file] !== undefined) return true;
    return !spec.video && (spec.cube || isShadertoyTexture(file));
  }

  /** Whether the preset can have this texture: a file the build has, or a stand-in. */
  public available(spec: TextureSpec): boolean {
    return spec.files.some((file) => this.usable(spec, file));
  }

  /**
   * One of the spec's files, chosen at random among those that can be had — or the one at `index`
   * (Monkey Hi Hat's RandomTextureSync: a ship picture with its own masks), when that can be had.
   */
  public choose(spec: TextureSpec, pick: () => number = Math.random, index?: number): string {
    const synced = index === undefined ? undefined : spec.files[index];
    if (synced !== undefined && this.usable(spec, synced)) return synced;
    const usable = spec.files.filter((file) => this.usable(spec, file));
    return usable[Math.floor(pick() * usable.length)] ?? spec.files[0] ?? "";
  }

  public texture(spec: TextureSpec, file: string): Promise<WebGLTexture> {
    const key = `${spec.cube ? "cube" : "2d"}|${spec.clamp ? "clamp" : "repeat"}|${file}`;
    let pending = this.cache.get(key);
    if (!pending) {
      const url = this.source.images[file];
      pending = spec.cube ? (url ? this.cube(url) : Promise.resolve(this.sky())) : this.image(file, spec.clamp);
      this.cache.set(key, pending);
    }
    return pending;
  }

  /** A video of the build's, playing for one preset: its own element and texture. */
  public video(file: string): VideoTexture | null {
    const url = this.source.images[file];
    return url ? new VideoTexture(this.gl, url) : null;
  }

  /**
   * A cube map from one picture laid out as Monkey Hi Hat reads it — a cross four faces wide and
   * three high: +Y above, -X +Z +X -Z across the middle, -Y below — each face as the picture has it.
   */
  private async cube(url: string): Promise<WebGLTexture> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    const picture = await createImageBitmap(await response.blob());
    const size = Math.floor(picture.width / 4);
    const height = Math.floor(picture.height / 3);
    const gl = this.gl;
    const faces: [number, number, number][] = [
      [gl.TEXTURE_CUBE_MAP_POSITIVE_X, 2, 1], [gl.TEXTURE_CUBE_MAP_NEGATIVE_X, 0, 1],
      [gl.TEXTURE_CUBE_MAP_POSITIVE_Y, 1, 0], [gl.TEXTURE_CUBE_MAP_NEGATIVE_Y, 1, 2],
      [gl.TEXTURE_CUBE_MAP_POSITIVE_Z, 1, 1], [gl.TEXTURE_CUBE_MAP_NEGATIVE_Z, 3, 1]
    ];
    const slices = await Promise.all(faces.map(([, column, row]) => createImageBitmap(picture, column * size, row * height, size, height)));
    picture.close();
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL context lost");
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
    faces.forEach(([target], at) => {
      gl.texImage2D(target, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, slices[at]!);
      slices[at]!.close();
    });
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_CUBE_MAP, wrap, gl.CLAMP_TO_EDGE);
    this.made.push(texture);
    return texture;
  }

  private sky(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL context lost");
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
    const size = 128;
    for (let face = 0; face < 6; face += 1) {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, skyFace(face, size));
    }
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_CUBE_MAP, wrap, gl.CLAMP_TO_EDGE);
    this.made.push(texture);
    return texture;
  }

  private async image(file: string, clamp: boolean): Promise<WebGLTexture> {
    const url = this.source.images[file];
    let upload: (gl: WebGL2RenderingContext) => void;
    if (url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      // Flipped as Monkey Hi Hat flips its images: the first row is the bottom one.
      const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "flipY" });
      upload = (gl) => {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        bitmap.close();
      };
    } else {
      const pixels = procedural(file);
      upload = (gl) => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pixels.width, pixels.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels.data);
    }
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL context lost");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    upload(gl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    this.made.push(texture);
    return texture;
  }

  public destroy(): void {
    for (const texture of this.made) this.gl.deleteTexture(texture);
    this.made.length = 0;
    this.cache.clear();
  }
}

/**
 * A video as a texture, as Monkey Hi Hat plays one ([videos]): looped, muted, flipped like its
 * pictures, a frame uploaded whenever the video has moved on. Its length, position (0-1) and size
 * are what a shader reads as `<name>_duration`, `<name>_progress` and `<name>_resolution`.
 * `destroy()` stops it and lets the browser drop the decoder.
 */
export class VideoTexture {
  public readonly texture: WebGLTexture;
  private readonly element: HTMLVideoElement;
  /** The position of the frame in the texture; -1 before the first. */
  private shownTime = -1;

  public constructor(private readonly gl: WebGL2RenderingContext, url: string) {
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL context lost");
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    this.element = video;
    // A muted video may play without a gesture; refused, its first frame still shows.
    void video.play().catch(() => undefined);
  }

  /** The video's frame into the texture, when it has moved on since the last one. */
  public update(): void {
    const video = this.element;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === this.shownTime) return;
    this.shownTime = video.currentTime;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  public get duration(): number {
    return Number.isFinite(this.element.duration) ? this.element.duration : 0;
  }

  public get progress(): number {
    const duration = this.duration;
    return duration > 0 ? (this.element.currentTime % duration) / duration : 0;
  }

  public get resolution(): [number, number] {
    return [this.element.videoWidth, this.element.videoHeight];
  }

  public destroy(): void {
    const video = this.element;
    video.pause();
    video.removeAttribute("src");
    video.load();
    this.gl.deleteTexture(this.texture);
  }
}
