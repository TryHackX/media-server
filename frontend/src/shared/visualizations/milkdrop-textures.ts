/**
 * The textures MilkDrop presets name (`sampler_worms`), handed to butterchurn
 * as each preset loads.
 *
 * butterchurn has two textures of its own, clouds2 and an empty one, and gives
 * every preset that asks for anything else clouds2. A build with a texture
 * folder (scripts/milkdrop-textures.mjs) lists its images in
 * `virtual:milkdrop-presets`; without one, the stock MilkDrop textures
 * butterchurn-presets carries as data (imageData, MIT) stand in for the
 * handful it has. Either way a texture is fetched only when a preset asks for it.
 *
 * What MilkDrop does, done here as well:
 *   - names are found case-insensitively, and two letters with an underscore in
 *     front (`fw_`, `fc_`, `pw_`, `pc_`) choose bilinear or point sampling and
 *     wrapping or clamping — not a different texture;
 *   - `rand00`…`rand15` (optionally `rand03_smalltiled`: only textures whose
 *     name starts so) are drawn at random each time the preset loads, one per
 *     slot, and `texsize_randNN` then describes the one drawn.
 *
 * A drawn texture gets a sampler name of its own (the shader is rewritten to
 * it), so a preset blending out keeps the texture it was drawn. Textures stay
 * on the GPU while presets use them; past a budget, the ones neither the
 * current nor the previous preset uses are let go first.
 *
 * Pure logic first (testable without a browser), the WebGL part last.
 */

/** A texture a preset may be given: its MilkDrop name (lower case), where it is, and its size. */
export interface TextureSource {
  key: string;
  url: string;
  width: number;
  height: number;
}

/** What the build lists (scripts/milkdrop-presets.mjs): where the files are, and `[name, file, width, height, pool]` each. */
export interface TexturesInfo {
  base: string;
  list: readonly (readonly [name: string, file: string, width: number, height: number, pool: number])[];
}

/** The textures there are, by name, and the ones a random slot may draw. */
export interface TextureCatalog {
  find(root: string): TextureSource | undefined;
  /** What any random slot draws from. */
  pool: readonly TextureSource[];
  /** What a slot naming a prefix (`rand00_chelsea`) draws from: the pool and the textures kept for prefixed slots. */
  prefixed: readonly TextureSource[];
}

/**
 * butterchurn's template declares these itself, and the patched engine keeps `fft` and `wave`
 * current (BeatDrop's get_fft() and get_wave(), scripts/butterchurn-patches.mjs); they are no
 * texture of the preset's.
 */
const BUILTIN_SAMPLERS: ReadonlySet<string> = new Set([
  "main", "fw_main", "fc_main", "pw_main", "pc_main", "blur1", "blur2", "blur3",
  "noise_lq", "noise_lq_lite", "noise_mq", "noise_hq", "pw_noise_lq", "noisevol_lq", "noisevol_hq",
  "fft", "wave"
]);
/** butterchurn's own textures: a preset asking for them gets them as it always did. */
const BUTTERCHURN_TEXTURES: ReadonlySet<string> = new Set(["clouds2", "empty"]);
/** clouds2 stands in for any texture there is none of; its size is what texsize describes then. */
const CLOUDS2 = { width: 128, height: 128 };

/** MilkDrop's filtering-and-wrapping prefixes (either way round); other two letters are peeled off just the same. */
const MODES: Record<string, { bilinear: boolean; wrap: boolean }> = {
  FW: { bilinear: true, wrap: true }, WF: { bilinear: true, wrap: true },
  FC: { bilinear: true, wrap: false }, CF: { bilinear: true, wrap: false },
  PW: { bilinear: false, wrap: true }, WP: { bilinear: false, wrap: true },
  PC: { bilinear: false, wrap: false }, CP: { bilinear: false, wrap: false }
};

/** A sampler's texture name (lower case) and how it is read, as MilkDrop reads `sampler_<name>`. */
export function samplerRoot(name: string): { root: string; bilinear: boolean; wrap: boolean } {
  if (name.length > 3 && name[2] === "_") {
    const mode = MODES[name.slice(0, 2).toUpperCase()] ?? { bilinear: true, wrap: true };
    return { root: name.slice(3).toLowerCase(), ...mode };
  }
  return { root: name.toLowerCase(), bilinear: true, wrap: true };
}

/** `rand00`…`rand15`, with the name prefix after it (`rand03_smalltiled`), or null. */
export function randomSlot(root: string): { slot: number; prefix: string } | null {
  const match = /^rand(\d\d)(?:_(.*))?$/.exec(root);
  if (!match) return null;
  const slot = Number(match[1]);
  return slot <= 15 ? { slot, prefix: (match[2] ?? "").toLowerCase() } : null;
}

/**
 * The samplers a shader declares itself (`uniform sampler2D sampler_worms;`),
 * as butterchurn finds them — and reads: one declared and never sampled (the
 * translation keeps such declarations) asks for nothing.
 */
export function declaredSamplers(shader: string | undefined): string[] {
  const text = shader ?? "";
  const end = text.indexOf("shader_body");
  return [...(end >= 0 ? text.slice(0, end) : text).matchAll(/uniform\s+sampler2D\s+sampler_(\w+)\s*;/g)]
    .map((match) => match[1]!)
    .filter((name) => (text.match(new RegExp(`\\bsampler_${name}\\b`, "g")) ?? []).length > 1);
}

interface ShaderPreset {
  warp?: string;
  comp?: string;
}

/** What a preset asks for that butterchurn does not have itself: texture names, and whether a random slot is among them. */
export function requestedTextures(preset: object): { roots: string[]; random: boolean } {
  const { warp, comp } = preset as ShaderPreset;
  const roots = new Set<string>();
  let random = false;
  for (const name of [...declaredSamplers(warp), ...declaredSamplers(comp)]) {
    if (BUILTIN_SAMPLERS.has(name)) continue;
    const { root } = samplerRoot(name);
    if (BUTTERCHURN_TEXTURES.has(root)) continue;
    if (randomSlot(root)) random = true;
    else roots.add(root);
  }
  const sprite = spriteOf(preset);
  if (sprite?.texture) roots.add(sprite.texture);
  return { roots: [...roots], random };
}

/** A MilkDrop 3 preset sprite (milkdrop-convert.mjs `parseSprite`; the engine draws it). */
interface PresetSprite {
  texture?: string;
  colorKey?: number;
  sampler?: string;
  width?: number;
  height?: number;
}

const spriteOf = (preset: object): PresetSprite | undefined => (preset as { md?: { sprite?: PresetSprite } }).md?.sprite;

const float = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** `vec4(w, h, 1/w, 1/h)`, as MilkDrop fills `texsize_<name>`. */
export function texsizeValue({ width, height }: { width: number; height: number }): string {
  return `vec4(${float(width)}, ${float(height)}, ${float(1 / width)}, ${float(1 / height)})`;
}

/** One texture to hand butterchurn: under which sampler name, and how it is sampled. */
export interface TextureBinding {
  sampler: string;
  texture: TextureSource;
  bilinear: boolean;
  wrap: boolean;
  /** A sprite's colour key (0xRRGGBB): opaque texels of exactly that colour become transparent black, as D3DX loads them. */
  colorKey?: number;
  /** A GIF sprite: every frame of it, which the engine animates (milkdrop-gif.ts) — no colour key, as MilkDrop 3 loads one. */
  frames?: boolean;
  /**
   * A sprite's still image, sized as D3DX sizes it for MilkDrop 3's texmgr (D3DX_DEFAULT width and
   * height): each side rounded up to a power of two, the image stretched over it (d3dxTextureSize).
   */
  powerOfTwo?: boolean;
}

/**
 * The texture D3DX makes of a sprite image for MilkDrop 3.37's texmgr: its LoadTex asks
 * D3DXCreateTextureFromFileExW for D3DX_DEFAULT width and height, which D3DX rounds up to a power of
 * two (D3DX_DEFAULT_NONPOW2 would keep the size; MilkDrop 3's shader textures ask for that one), no
 * larger than the device takes.
 */
export function d3dxTextureSize(width: number, height: number, limit: number): { width: number; height: number } {
  let largest = 1;
  while (largest * 2 <= limit) largest *= 2;
  const side = (value: number): number => {
    let size = 1;
    while (size < value) size *= 2;
    return Math.min(size, largest);
  };
  return { width: side(Math.max(1, Math.ceil(width))), height: side(Math.max(1, Math.ceil(height))) };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The textures a preset gets, and the preset as butterchurn should load it:
 * unchanged unless it has random slots, which are drawn now — one per slot,
 * for its warp and composite shaders alike — and renamed to what was drawn,
 * their `texsize_randNN` filled in. A name there is no texture of is left to
 * butterchurn, which gives it clouds2.
 */
export function planTextures(
  preset: object,
  catalog: TextureCatalog,
  random: () => number = Math.random
): { preset: object; bindings: TextureBinding[] } {
  const { warp, comp } = preset as ShaderPreset;
  const names = [...new Set([...declaredSamplers(warp), ...declaredSamplers(comp)])];
  const bindings: TextureBinding[] = [];
  const drawn = new Map<number, TextureSource | null>();
  const renamed = new Map<string, string>();
  const draw = (slot: number, prefix: string): TextureSource | null => {
    if (!drawn.has(slot)) {
      const candidates = prefix ? catalog.prefixed.filter((texture) => texture.key.startsWith(prefix)) : catalog.pool;
      drawn.set(slot, candidates.length ? candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]! : null);
    }
    return drawn.get(slot)!;
  };
  for (const name of names) {
    if (BUILTIN_SAMPLERS.has(name)) continue;
    const { root, bilinear, wrap } = samplerRoot(name);
    if (BUTTERCHURN_TEXTURES.has(root)) continue;
    const slot = randomSlot(root);
    if (slot) {
      const texture = draw(slot.slot, slot.prefix);
      if (!texture) continue;
      const sampler = `${name}_pick${catalog.prefixed.indexOf(texture)}`;
      renamed.set(name, sampler);
      bindings.push({ sampler, texture, bilinear, wrap });
      continue;
    }
    const texture = catalog.find(root);
    if (texture) bindings.push({ sampler: name, texture, bilinear, wrap });
  }
  const texsizes = /^vec4\s+texsize_(rand(\d\d)(?:_\w*)?)\s*;$/gim;
  const rewrite = (shader: string | undefined): string | undefined => {
    if (!shader) return shader;
    let text = shader;
    if (renamed.size) {
      const pattern = new RegExp(`\\bsampler_(${[...renamed.keys()].map(escape).join("|")})\\b`, "g");
      text = text.replace(pattern, (_, name: string) => `sampler_${renamed.get(name)!}`);
    }
    return text.replace(texsizes, (line, name: string, slot: string) => {
      const index = Number(slot);
      if (index > 15) return line;
      const texture = drawn.get(index) ?? null;
      return `vec4 texsize_${name} = ${texsizeValue(texture ?? CLOUDS2)};`;
    });
  };
  const nextWarp = rewrite(warp);
  const nextComp = rewrite(comp);
  // The preset's sprite image, under a sampler name of its own, and its size for the engine.
  const sprite = spriteOf(preset);
  const spriteTexture = sprite?.texture ? catalog.find(sprite.texture) : undefined;
  let next: object = preset;
  if (sprite && spriteTexture) {
    const sampler = `md_sprite_${sprite.texture}`;
    // MilkDrop 3 loads a GIF through GDI+, frame by frame, as it is and without the colour key; any
    // other image through D3DX, keyed, at a power-of-two size, with every mip level.
    bindings.push(/\.gif$/i.test(spriteTexture.url)
      ? { sampler, texture: spriteTexture, bilinear: true, wrap: true, frames: true }
      : { sampler, texture: spriteTexture, bilinear: true, wrap: true, colorKey: sprite.colorKey ?? 0, powerOfTwo: true });
    const md = (preset as { md?: object }).md;
    next = { ...preset, md: { ...md, sprite: { ...sprite, sampler, width: spriteTexture.width, height: spriteTexture.height } } };
  }
  if (nextWarp === warp && nextComp === comp) return { preset: next, bindings };
  return { preset: { ...next, warp: nextWarp, comp: nextComp }, bindings };
}

/** The build's textures as a catalog: found by name, every one of them in the random pool unless the build says not. */
export function buildCatalog(info: TexturesInfo | null, fallback: readonly TextureSource[] = []): TextureCatalog {
  const byKey = new Map<string, TextureSource>();
  const pool: TextureSource[] = [];
  const prefixed: TextureSource[] = [];
  // The last field: 1 drawn by any random slot, 2 only by a slot naming its prefix, 0 by name only.
  for (const [name, file, width, height, inPool] of info?.list ?? []) {
    if (typeof name !== "string" || typeof file !== "string" || !(width > 0) || !(height > 0) || byKey.has(name)) continue;
    const texture = { key: name, url: `${info!.base}${file}`, width, height };
    byKey.set(name, texture);
    if (inPool === 1) pool.push(texture);
    if (inPool === 1 || inPool === 2) prefixed.push(texture);
  }
  // butterchurn-presets' textures, for what the build does not have; the pool only when the build has none.
  for (const texture of fallback) if (!byKey.has(texture.key)) byKey.set(texture.key, texture);
  return { find: (root) => byKey.get(root), pool: pool.length ? pool : fallback, prefixed: prefixed.length ? prefixed : fallback };
}

/** The textures butterchurn-presets carries (imageData): MilkDrop's stock ones, `cloudsImage` being clouds.jpg. */
export const IMAGE_DATA_NAMES: ReadonlySet<string> = new Set(["cells", "seaweed", "smalltiled_lizard_scales", "prayerwheel", "lichen", "clouds"]);

export function imageDataTextures(module: unknown): TextureSource[] {
  let value: unknown = module;
  for (let depth = 0; depth < 3 && value && typeof value === "object" && "default" in value; depth += 1) {
    value = (value as { default: unknown }).default;
  }
  if (!value || typeof value !== "object") return [];
  const textures: TextureSource[] = [];
  for (const [name, entry] of Object.entries(value as Record<string, { data?: unknown; width?: unknown; height?: unknown }>)) {
    if (typeof entry?.data !== "string" || typeof entry.width !== "number" || typeof entry.height !== "number") continue;
    textures.push({ key: name === "cloudsImage" ? "clouds" : name.toLowerCase(), url: entry.data, width: entry.width, height: entry.height });
  }
  return textures;
}

/**
 * Which textures may go when the GPU holds more than `budget` bytes of them:
 * the least recently used first, never one the current or the previous
 * preset uses (that one may still be blending out).
 */
export function texturesToRelease<T extends { bytes: number; used: number }>(entries: readonly T[], budget: number, now: number): T[] {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const released: T[] = [];
  for (const entry of [...entries].sort((left, right) => left.used - right.used)) {
    if (total <= budget) break;
    if (entry.used >= now - 1) continue;
    released.push(entry);
    total -= entry.bytes;
  }
  return released;
}

/** What milkdrop.ts needs of butterchurn's visualizer here. */
export interface TextureHost {
  gl?: WebGL2RenderingContext | null;
  loadExtraImages?(images: Record<string, { data: string; width: number; height: number }>): void;
}

/** About 64 MB of textures (mipmaps counted) before older ones are let go. */
const BUDGET = 64 * 1024 * 1024;
/** A GIF sprite's frames together, at most (MilkDrop 3's GIF test sprite: 50 frames, 45 MB); a larger one shows its first frame. */
const GIF_BUDGET = 96 * 1024 * 1024;

/** A GIF sprite's frames, on the first frame's texture: what the engine draws at a given sprite time. */
interface SpriteFrames {
  textures: WebGLTexture[];
  pick(seconds: number): WebGLTexture;
}
/** How long a preset waits for its textures; what arrives later still shows up the frame after. */
const WAIT_MS = 2500;

interface Held {
  key: string;
  texture: Promise<WebGLTexture | null>;
  ready: WebGLTexture | null;
  bytes: number;
  used: number;
  samplers: Set<string>;
}

/**
 * D3DX's colour key, as MilkDrop's texmgr loads a sprite (`0xFF000000 | ck`): every texel of exactly
 * that colour becomes transparent black. The key is ARGB and D3DX compares the alpha too, so only an
 * opaque texel of that colour matches.
 */
export function keyOutPixels(pixels: Uint8ClampedArray, colorKey: number): void {
  const r = (colorKey >> 16) & 0xff;
  const g = (colorKey >> 8) & 0xff;
  const b = colorKey & 0xff;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] === r && pixels[index + 1] === g && pixels[index + 2] === b && pixels[index + 3] === 255) {
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
      pixels[index + 3] = 0;
    }
  }
}

function keyOut(context: CanvasRenderingContext2D, width: number, height: number, colorKey: number): void {
  const data = context.getImageData(0, 0, width, height);
  keyOutPixels(data.data, colorKey);
  context.putImageData(data, 0, 0);
}

const STRETCH_VS = `#version 300 es
void main() {
  gl_Position = vec4(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0, 0.0, 1.0);
}`;
// D3DX's load of a sprite, per destination texel: the colour key on each source texel (keyOutPixels),
// then the stretch to the power-of-two size — linear between the four nearest texels, wrapping at the
// edges as D3DX's filters do unless told to mirror.
const STRETCH_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSource;
uniform ivec2 uSize;
uniform vec2 uScale;
uniform ivec4 uKey;
out vec4 fragColor;
vec4 texel(ivec2 at) {
  at -= uSize * ivec2(floor(vec2(at) / vec2(uSize)));
  vec4 t = texelFetch(uSource, at, 0);
  return uKey.a >= 0 && ivec4(round(t * 255.0)) == uKey ? vec4(0.0) : t;
}
void main() {
  vec2 at = gl_FragCoord.xy * uScale - 0.5;
  vec2 cell = floor(at);
  vec2 f = at - cell;
  ivec2 i = ivec2(cell);
  fragColor = mix(mix(texel(i), texel(i + ivec2(1, 0)), f.x), mix(texel(i + ivec2(0, 1)), texel(i + ivec2(1, 1)), f.x), f.y);
}`;

interface StretchProgram {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  size: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  key: WebGLUniformLocation | null;
  source: WebGLUniformLocation | null;
}
const stretchPrograms = new WeakMap<WebGL2RenderingContext, StretchProgram | null>();

function stretchProgram(gl: WebGL2RenderingContext): StretchProgram | null {
  if (stretchPrograms.has(gl)) return stretchPrograms.get(gl)!;
  const compile = (type: number, text: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vs = compile(gl.VERTEX_SHADER, STRETCH_VS);
  const fs = compile(gl.FRAGMENT_SHADER, STRETCH_FS);
  const program = vs && fs ? gl.createProgram() : null;
  const vao = gl.createVertexArray();
  let made: StretchProgram | null = null;
  if (program && vao && vs && fs) {
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
      made = {
        program, vao,
        size: gl.getUniformLocation(program, "uSize"), scale: gl.getUniformLocation(program, "uScale"),
        key: gl.getUniformLocation(program, "uKey"), source: gl.getUniformLocation(program, "uSource")
      };
    }
  }
  stretchPrograms.set(gl, made);
  return made;
}

/**
 * A sprite image as D3DX makes its texture for MilkDrop 3: keyed, stretched to `size` (each side a
 * power of two) in the GPU, every mip level made from it (D3DX_DEFAULT levels; a box filter). The
 * pixels are the file's own — no premultiplied alpha, no colour management, as D3DX reads them. Null
 * when the GPU cannot (the caller then uploads the image as it is). The state touched is put back.
 */
function stretchedTexture(
  gl: WebGL2RenderingContext,
  source: TexImageSource,
  from: { width: number; height: number },
  size: { width: number; height: number },
  colorKey: number | undefined
): WebGLTexture | null {
  const stretch = stretchProgram(gl);
  if (!stretch) return null;
  const pixelStore = [gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_COLORSPACE_CONVERSION_WEBGL] as const;
  const unpack = pixelStore.map((name) => gl.getParameter(name) as number | boolean);
  const capabilities = [gl.BLEND, gl.SCISSOR_TEST, gl.CULL_FACE, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE, gl.POLYGON_OFFSET_FILL];
  const enabled = capabilities.map((capability) => gl.isEnabled(capability));
  const saved = {
    draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
    mask: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
    program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
    active: gl.getParameter(gl.ACTIVE_TEXTURE) as number
  };
  gl.activeTexture(gl.TEXTURE0);
  const bound = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const boundSampler = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null;
  const input = gl.createTexture();
  const output = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  let done = false;
  if (input && output && framebuffer) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    gl.bindTexture(gl.TEXTURE_2D, output);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size.width, size.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      for (const capability of capabilities) gl.disable(capability);
      gl.colorMask(true, true, true, true);
      gl.viewport(0, 0, size.width, size.height);
      gl.useProgram(stretch.program);
      gl.bindVertexArray(stretch.vao);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.bindSampler(0, null);
      gl.uniform1i(stretch.source, 0);
      gl.uniform2i(stretch.size, from.width, from.height);
      gl.uniform2f(stretch.scale, from.width / size.width, from.height / size.height);
      gl.uniform4i(stretch.key, ...(colorKey === undefined ? [0, 0, 0, -1] : [(colorKey >> 16) & 0xff, (colorKey >> 8) & 0xff, colorKey & 0xff, 255]) as [number, number, number, number]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, output);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      done = true;
    }
  }
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
  gl.viewport(saved.viewport[0]!, saved.viewport[1]!, saved.viewport[2]!, saved.viewport[3]!);
  gl.colorMask(saved.mask[0]!, saved.mask[1]!, saved.mask[2]!, saved.mask[3]!);
  capabilities.forEach((capability, index) => (enabled[index] ? gl.enable(capability) : gl.disable(capability)));
  gl.useProgram(saved.program);
  gl.bindVertexArray(saved.vao);
  gl.bindSampler(0, boundSampler);
  gl.bindTexture(gl.TEXTURE_2D, bound);
  gl.activeTexture(saved.active);
  pixelStore.forEach((name, index) => gl.pixelStorei(name, unpack[index]!));
  if (framebuffer) gl.deleteFramebuffer(framebuffer);
  if (input) gl.deleteTexture(input);
  if (!done && output) gl.deleteTexture(output);
  return done ? output : null;
}

/**
 * `onload`, as butterchurn's own loader: `decode()` waits for the page to be
 * painted, and a page in a background tab or a hidden window is not.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`MilkDrop texture unavailable: ${url}`));
    image.src = url;
  });
}

/**
 * Hands each preset's textures to butterchurn. `prepare` never fails: a
 * texture that does not arrive leaves the preset with clouds2, as before.
 *
 * butterchurn looks every texture up by sampler name each frame
 * (`renderer.image.samplers`), so a texture registered there takes effect at
 * once and one let go falls back to clouds2. Should a later butterchurn not
 * have that map, its public `loadExtraImages` is used instead — without the
 * sampling modes and without letting anything go.
 */
export function textureBinder(
  visualizer: TextureHost,
  info: TexturesInfo | null,
  loadFallback: () => Promise<unknown>,
  random: () => number = () => Math.random()
): { prepare(preset: object): Promise<object> } {
  const gl = visualizer.gl ?? null;
  const samplers = ((visualizer as { renderer?: { image?: { samplers?: unknown } } }).renderer?.image?.samplers ?? null) as Record<string, WebGLTexture | undefined> | null;
  const anisotropy = gl?.getExtension("EXT_texture_filter_anisotropic") ?? null;
  const held = new Map<string, Held>();
  let catalog = buildCatalog(info);
  let fallback: Promise<void> | null = null;
  let generation = 0;

  /** butterchurn-presets' textures, fetched (~200 KB) only when a preset needs one the build has not. */
  const withFallback = (): Promise<void> => {
    fallback ??= loadFallback().then(
      (module) => {
        catalog = buildCatalog(info, imageDataTextures(module));
      },
      () => {
        fallback = null;
      }
    );
    return fallback;
  };

  const textureLimit = (): number => Number(gl?.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;

  const upload = (image: HTMLImageElement, bilinear: boolean, wrap: boolean, colorKey?: number, powerOfTwo = false): WebGLTexture | null => {
    if (!gl || gl.isContextLost()) return null;
    let source: TexImageSource = image;
    const limit = textureLimit();
    const oversized = image.naturalWidth > limit || image.naturalHeight > limit;
    if (powerOfTwo) {
      // A sprite, as D3DX loads it for MilkDrop 3: keyed and stretched to a power of two in the GPU.
      let from = { width: image.naturalWidth, height: image.naturalHeight };
      if (oversized) {
        const scale = limit / Math.max(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
        canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        source = canvas;
        from = { width: canvas.width, height: canvas.height };
      }
      const stretched = stretchedTexture(gl, source, from, d3dxTextureSize(image.naturalWidth, image.naturalHeight, limit), colorKey);
      if (stretched) return stretched;
      source = image;
    }
    if (oversized || colorKey !== undefined) {
      const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: colorKey !== undefined });
      context?.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (context && colorKey !== undefined) keyOut(context, canvas.width, canvas.height, colorKey);
      source = canvas;
    }
    const texture = gl.createTexture();
    if (!texture) return null;
    // butterchurn binds every texture it draws with before drawing; what was
    // bound here and the unpack alignment are put back all the same.
    const bound = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    if (bilinear) gl.generateMipmap(gl.TEXTURE_2D);
    const mode = wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, bilinear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, bilinear ? gl.LINEAR : gl.NEAREST);
    // Not a sprite's: MilkDrop 3 samples those linearly, never anisotropically.
    if (bilinear && anisotropy && !powerOfTwo) {
      gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
    gl.bindTexture(gl.TEXTURE_2D, bound);
    return texture;
  };

  /**
   * A GIF sprite's frames, each a texture of its own (one level, as MilkDrop 3 makes them); the first
   * stands for them all and carries the rest (`mdFrames`, which the engine draws by). Bytes counted
   * once they are known. Null when the file cannot be decoded or held: the first frame alone, then.
   */
  const uploadFrames = async (url: string, wrap: boolean, entry: { bytes: number }): Promise<WebGLTexture | null> => {
    // The decoder is fetched with the first GIF sprite (few presets have one).
    const [{ decodeGif, gifFrameAt }, response] = await Promise.all([import("./milkdrop-gif"), fetch(url)]);
    const gif = decodeGif(new Uint8Array(await response.arrayBuffer()));
    if (!gif || !gl || gl.isContextLost()) return null;
    const limit = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
    const size = gif.width * gif.height * 4 * gif.frames.length;
    if (gif.width > limit || gif.height > limit || size > GIF_BUDGET) return null;
    const bound = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const textures: WebGLTexture[] = [];
    for (const pixels of gif.frames) {
      const texture = gl.createTexture();
      if (!texture) break;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gif.width, gif.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const mode = wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // One level (CreateTexture with Levels 1, at the GIF's own size): complete under the engine's
      // trilinear sampler too, which then has no other level to blend — as D3D9's MIPFILTER LINEAR.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
      textures.push(texture);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
    gl.bindTexture(gl.TEXTURE_2D, bound);
    if (textures.length !== gif.frames.length) {
      for (const texture of textures) gl.deleteTexture(texture);
      return null;
    }
    const delays = gif.delays;
    const frames: SpriteFrames = { textures, pick: (seconds) => textures[gifFrameAt(delays, seconds)]! };
    (textures[0] as { mdFrames?: SpriteFrames }).mdFrames = frames;
    entry.bytes = size;
    return textures[0]!;
  };

  const bind = (binding: TextureBinding): Promise<unknown> => {
    const { texture: source, sampler, bilinear, wrap, colorKey, frames, powerOfTwo = false } = binding;
    if (!samplers) {
      // Without butterchurn's map: its own loader, which takes a name once and keeps it.
      visualizer.loadExtraImages?.({ [sampler]: { data: source.url, width: source.width, height: source.height } });
      return Promise.resolve();
    }
    const key = `${frames ? "g" : ""}${powerOfTwo ? "2" : ""}${bilinear ? "f" : "p"}${wrap ? "w" : "c"}${colorKey === undefined ? "" : `k${colorKey}`} ${source.url}`;
    let entry = held.get(key);
    if (!entry) {
      const stored = powerOfTwo ? d3dxTextureSize(source.width, source.height, textureLimit()) : source;
      const fresh: Held = {
        key,
        ready: null,
        bytes: stored.width * stored.height * 4 * (bilinear ? 4 / 3 : 1),
        used: generation,
        samplers: new Set(),
        texture: Promise.resolve(null)
      };
      const still = (): Promise<WebGLTexture | null> => loadImage(source.url).then((image) => upload(image, bilinear, wrap, colorKey, powerOfTwo));
      fresh.texture = frames
        ? uploadFrames(source.url, wrap, fresh).catch(() => null).then((texture) => texture ?? still())
        : still();
      fresh.texture.then(
        (texture) => {
          fresh.ready = texture;
          if (!texture) held.delete(key);
          else for (const name of fresh.samplers) samplers[name] = texture;
        },
        // Not there now (the network); asked for again with the next preset that needs it.
        () => held.delete(key)
      );
      held.set(key, fresh);
      entry = fresh;
    }
    entry.used = generation;
    entry.samplers.add(sampler);
    if (entry.ready) samplers[sampler] = entry.ready;
    return entry.texture.catch(() => null);
  };

  const release = (): void => {
    if (!gl || !samplers) return;
    for (const entry of texturesToRelease([...held.values()].filter((candidate) => candidate.ready), BUDGET, generation)) {
      held.delete(entry.key);
      for (const name of entry.samplers) if (samplers[name] === entry.ready) delete samplers[name];
      const frames = (entry.ready as { mdFrames?: SpriteFrames } | null)?.mdFrames;
      for (const texture of frames?.textures ?? [entry.ready]) gl.deleteTexture(texture);
    }
  };

  return {
    async prepare(preset: object): Promise<object> {
      generation += 1;
      try {
        const { roots, random: drawing } = requestedTextures(preset);
        if (roots.length === 0 && !drawing) return preset;
        if (roots.some((root) => !catalog.find(root) && IMAGE_DATA_NAMES.has(root)) || (drawing && catalog.pool.length === 0)) {
          await withFallback();
        }
        const plan = planTextures(preset, catalog, random);
        const loads = plan.bindings.map(bind);
        release();
        let timer = 0;
        await Promise.race([
          Promise.all(loads),
          new Promise((resolve) => {
            timer = window.setTimeout(resolve, WAIT_MS);
          })
        ]);
        window.clearTimeout(timer);
        return plan.preset;
      } catch (error) {
        console.warn("MilkDrop textures unavailable", error);
        return preset;
      }
    }
  };
}
