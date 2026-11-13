/**
 * The textures MilkDrop presets ask for by name (`sampler_worms`), for an
 * owner who has them: projectM's texture pack — MilkDrop's own textures and
 * the ones community presets came to expect — or any folder of images.
 *
 * butterchurn knows two textures of its own, clouds2 and an empty one, and
 * gives every preset that asks for anything else clouds2. A build with a
 * texture folder ships its images beside the presets, and the visualizer
 * hands each preset the ones it names (shared/visualizations/milkdrop-textures.ts).
 *
 * Like the presets, the images live in a git-ignored folder,
 * `frontend/vendor/milkdrop-textures/` — MilkDrop's textures came without a
 * licence — and are found by their file name, as MilkDrop finds them:
 * `worms.jpg` is the texture `worms`, case ignored. Every image there is also
 * one the random slots (`sampler_rand00`…`rand15`) may draw. Images inside a
 * preset pack's own folder count as well, but only when a preset asks for
 * them by name (covers and logos lie there too) and never for a random slot.
 *
 * Nothing is decoded at build time; the size each texture is drawn at comes
 * from its file's header, because presets may read it (`texsize_lichen`).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/** What a browser decodes into a texture; MilkDrop's .tga and .dds it does not. */
// `.jfif` is JPEG under another name (MilkDrop 3's textures have one: Pattern_047.jfif).
const FORMATS = new Set([".jpg", ".jpeg", ".jfif", ".png", ".gif", ".webp", ".bmp"]);
const UNSHOWN = new Set([".tga", ".dds", ".dib"]);

/** Width and height from an image file's header, or null when it is not one this knows. */
export function imageSize(data) {
  if (data.length < 24) return null;
  // PNG: the IHDR chunk comes first.
  if (data.readUInt32BE(0) === 0x89504e47 && data.toString("latin1", 12, 16) === "IHDR") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // GIF: the logical screen.
  if (data.toString("latin1", 0, 4) === "GIF8") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  // BMP: BITMAPINFOHEADER and its successors (a negative height is a top-down bitmap).
  if (data.toString("latin1", 0, 2) === "BM" && data.length >= 26) {
    return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  }
  // WebP: lossy, lossless or extended.
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP" && data.length >= 30) {
    const chunk = data.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    return null;
  }
  // JPEG: the first start-of-frame marker.
  if (data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = data[at + 1];
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      }
      at += 2 + data.readUInt16BE(at + 2);
    }
  }
  return null;
}

/**
 * What a folder's SOURCE.txt says of the random slots (`rand00`…), for it and every folder
 * below: `random-pool: no` — its textures are asked for by name only; `random-pool: prefixed`
 * — drawn only by a slot that names their prefix (`rand00_chelsea` draws a Chelsea*); nothing —
 * drawn by any slot, as MilkDrop draws from its whole texture folder.
 */
const RANDOM_POOL = /^random-pool:\s*(no|prefixed)\b/im;

function findImages(folder, found = [], modes = new Map(), inherited = null) {
  const entries = readdirSync(folder, { withFileTypes: true });
  const source = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "source.txt");
  const mode = (source && RANDOM_POOL.exec(readFileSync(join(folder, source.name), "utf8"))?.[1].toLowerCase()) || inherited;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) findImages(path, found, modes, mode);
    else {
      const extension = extname(entry.name).toLowerCase();
      if (FORMATS.has(extension) || UNSHOWN.has(extension)) {
        found.push(path);
        if (mode) modes.set(path, mode);
      }
    }
  }
  return found;
}

/**
 * The images in `directory` (all its folders), by MilkDrop name: the file name
 * without its extension, lower case. The first of two with the same name wins
 * (folders sorted by name); formats a browser cannot show are reported, not used.
 */
export function findTextures(directory, { pool = true } = {}) {
  const textures = [];
  const skipped = [];
  if (!directory || !existsSync(directory)) return { textures, skipped };
  const seen = new Set();
  const modes = new Map();
  for (const file of findImages(directory, [], modes).sort()) {
    const extension = extname(file).toLowerCase();
    const name = file.slice(file.lastIndexOf(sep) + 1, file.length - extension.length);
    const key = name.toLowerCase();
    if (UNSHOWN.has(extension)) {
      skipped.push({ file: relative(directory, file), reason: `${extension} cannot be shown by a browser` });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ file: relative(directory, file), reason: `a texture named ${key} came first` });
      continue;
    }
    seen.add(key);
    const mode = modes.get(file);
    textures.push({ key, name, file, extension: extension === ".jpeg" || extension === ".jfif" ? ".jpg" : extension, pool: !pool || mode === "no" ? false : mode === "prefixed" ? "prefixed" : true });
  }
  return { textures, skipped };
}

/** butterchurn's own textures, which a preset asking for them gets without any file. */
export const BUTTERCHURN_TEXTURES = new Map([["clouds2", { width: 128, height: 128 }], ["empty", { width: 1, height: 1 }]]);

/**
 * The stock MilkDrop textures butterchurn-presets carries as data (imageData.js,
 * MIT) — the same files as in projectM's pack; `cloudsImage` there is clouds.jpg.
 * The visualizer falls back on them when a build has no texture of that name.
 */
export const IMAGE_DATA_TEXTURES = new Map([
  ["cells", { width: 256, height: 256 }],
  ["seaweed", { width: 256, height: 256 }],
  ["smalltiled_lizard_scales", { width: 256, height: 256 }],
  ["prayerwheel", { width: 128, height: 128 }],
  ["lichen", { width: 256, height: 256 }],
  ["clouds", { width: 128, height: 128 }]
]);

/**
 * The samplers butterchurn's shader template declares itself, and the two the patched engine
 * keeps current (BeatDrop's get_fft() and get_wave(): butterchurn-patches.mjs); they are no
 * texture of the preset's.
 */
export const BUILTIN_SAMPLERS = new Set([
  "main", "fw_main", "fc_main", "pw_main", "pc_main", "blur1", "blur2", "blur3",
  "noise_lq", "noise_lq_lite", "noise_mq", "noise_hq", "pw_noise_lq", "noisevol_lq", "noisevol_hq",
  "fft", "wave"
]);

/**
 * A sampler's texture, as MilkDrop reads its name: two letters and an
 * underscore in front (`fw_`, `pc_` — filtering and wrapping) are not part of it.
 */
export function samplerRoot(name) {
  return (name.length > 3 && name[2] === "_" ? name.slice(3) : name).toLowerCase();
}

/**
 * `rand00`…`rand15`, optionally `_prefix`: a texture MilkDrop draws at random
 * when the preset loads (one whose name starts with the prefix). Null for any
 * other name.
 */
export function randomSlot(root) {
  const match = /^rand(\d\d)(?:_(.*))?$/.exec(root);
  return match && Number(match[1]) <= 15 ? { slot: Number(match[1]), prefix: (match[2] ?? "").toLowerCase() } : null;
}

/**
 * The textures a GLSL shader declares (`uniform sampler2D sampler_worms;`) and
 * samples, by sampler name: the translation keeps declarations nothing reads.
 */
export function declaredSamplers(glsl) {
  const text = String(glsl ?? "");
  const end = text.indexOf("shader_body");
  return [...(end >= 0 ? text.slice(0, end) : text).matchAll(/uniform\s+sampler2D\s+sampler_(\w+)\s*;/g)]
    .map((match) => match[1])
    .filter((name) => (text.match(new RegExp(`\\bsampler_${name}\\b`, "g")) ?? []).length > 1);
}

/** Names of the textures a preset asks for that butterchurn does not have itself, as roots. */
export function requestedTextures(preset) {
  const roots = new Set();
  for (const name of [...declaredSamplers(preset?.warp), ...declaredSamplers(preset?.comp)]) {
    if (BUILTIN_SAMPLERS.has(name)) continue;
    const root = samplerRoot(name);
    if (!BUTTERCHURN_TEXTURES.has(root)) roots.add(root);
  }
  return roots;
}

const float = (value) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** `vec4(w, h, 1/w, 1/h)`, as MilkDrop fills `texsize_<name>`. */
export function texsizeValue({ width, height }) {
  return `vec4(${float(width)}, ${float(height)}, ${float(1 / width)}, ${float(1 / height)})`;
}

/**
 * Globals `vec4 texsize_<name>;` given the size of the texture they describe —
 * MilkDrop sets them, butterchurn does not, and left alone they are zero. The
 * random slots are left to the visualizer, which knows what it drew;
 * `sizeOf(root)` answers for every other name (with butterchurn's clouds2,
 * which stands in for any texture it does not have).
 */
export function fillTexsizes(glsl, sizeOf) {
  if (!glsl || !glsl.includes("texsize_")) return glsl;
  let depth = 0;
  return glsl.split("\n").map((line) => {
    const outside = depth === 0;
    depth += line.split("{").length - line.split("}").length;
    const match = outside ? /^vec4\s+(texsize_\w+(?:\s*,\s*texsize_\w+)*)\s*;$/.exec(line) : null;
    if (!match) return line;
    const names = match[1].split(",").map((name) => name.trim());
    const filled = names.map((name) => {
      const root = name.slice("texsize_".length).toLowerCase();
      if (/^noise/.test(root) || randomSlot(root)) return null;
      return `vec4 ${name} = ${texsizeValue(sizeOf(root))};`;
    });
    if (filled.every((text) => text === null)) return line;
    return names.map((name, index) => filled[index] ?? `vec4 ${name};`).join("\n");
  }).join("\n");
}

const slug = (name) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "texture";

/**
 * The texture files a build serves, under `prefix`, and the list the
 * visualizer reads: `[name, file, width, height, pool]` each. Files are named
 * by their contents' hash, as everything under assets/ is.
 */
export function textureAssets(textures, prefix, read = (file) => readFileSync(file)) {
  const files = new Map();
  const list = [];
  const unreadable = [];
  let bytes = 0;
  for (const texture of textures) {
    const data = read(texture.file);
    const size = imageSize(data);
    if (!size || size.width < 1 || size.height < 1) {
      unreadable.push(texture.file);
      continue;
    }
    const fileName = `${slug(texture.name)}-${createHash("sha256").update(data).digest("hex").slice(0, 10)}${texture.extension}`;
    files.set(`${prefix}${fileName}`, data);
    bytes += data.length;
    // 1: drawn by any random slot; 2: only by a slot that names its prefix; 0: by name only.
    list.push([texture.key, fileName, size.width, size.height, texture.pool === "prefixed" ? 2 : texture.pool ? 1 : 0]);
  }
  return { files, list, bytes, unreadable };
}

export const CONTENT_TYPES = {
  ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".json": "application/json; charset=utf-8"
};
