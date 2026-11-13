/**
 * Winamp AVS presets, for an owner who has some.
 *
 * Preset packs are the work of their authors and come with no licence that
 * would let a public repository carry them, so — like Font Awesome Pro — they
 * live in `frontend/vendor/avs-presets/` (git-ignored) and only on the server
 * that uses them. Without the folder the build has only mscopes' own presets
 * (see mscopesPresets below).
 *
 * Every folder there is a pack, as MilkDrop's packs are (milkdrop-presets.mjs):
 * an author's folder from the VISBOT archive holding their packs
 * (`<author>/<pack>/…`), or one pack on its own (AVSociety's). Its first level of
 * folders are the categories the panel offers, deeper ones the headings of its
 * list. mscopes' presets are one more pack.
 *
 * Each `.avs` file is converted by webvsc (MIT, ./webvsc) into the JSON webvs
 * reads — once: results are kept in node_modules/.cache/avs-presets by the
 * file's content, so a rebuild converts only what is new or changed. Thirteen
 * thousand presets must not reach a browser at once, so the build writes one
 * index (every pack's presets by category and group) and chunks of a few dozen
 * presets, fetched when one of them is about to play.
 *
 * A preset keeps the name it always had — its file name, then the folders it
 * sits in after a dash ("Name — Anthology / 01 - Mirror Us CD1"), because two
 * packs may well share a title; favourites and the remembered choice store it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { packAssets } from "./milkdrop-presets.mjs";

// webvsc (MIT), vendored with fixes in ./webvsc (see its README).
const require = createRequire(import.meta.url);
const { convertBlob } = require("./webvsc/browser.js");

const VIRTUAL_ID = "virtual:avs-presets";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
/** Bumped by hand when the cached form changes in a way webvsc's sources do not show. */
const CACHE_FORMAT = 1;
const WEBVSC = fileURLToPath(new URL("./webvsc/", import.meta.url));
/** A chunk: a few dozen presets of one folder, at most this many bytes (a preset larger alone). */
export const CHUNK_LIMITS = { maxBytes: 192 * 1024, maxPresets: 40 };
const IMAGE = /\.(bmp|png|jpe?g|gif)$/i;
const CONTENT_TYPES = { ".json": "application/json; charset=utf-8", ".bmp": "image/bmp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };

export function findPresets(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder)) {
      const path = join(folder, entry);
      const isFolder = statSync(path).isDirectory();
      // Hidden folders and files (.git, .DS_Store) are no presets, but a preset's name may start
      // with dots: "... and what become.avs" (Tonic — B&W Power).
      if (entry.startsWith(".") && (isFolder || !entry.toLowerCase().endsWith(".avs"))) continue;
      if (isFolder) visit(path);
      else if (entry.toLowerCase().endsWith(".avs")) found.push(path);
    }
  };
  visit(directory);
  return found.sort();
}

/**
 * Images that came with the packs (Texer, Texer II and Picture bitmaps — AVS looked them up by
 * name in its folder), one per name: the first found wins, and webvs's own bitmaps of the same
 * name are kept. `{ name, path }`, sorted by name.
 */
export function findPackImages(directory, builtin = []) {
  if (!existsSync(directory)) return [];
  const taken = new Set(builtin.map((name) => name.toLowerCase()));
  const found = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder).sort()) {
      if (entry.startsWith(".")) continue;
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (IMAGE.test(entry) && !taken.has(entry.toLowerCase())) {
        taken.add(entry.toLowerCase());
        found.push({ name: entry, path });
      }
    }
  };
  visit(directory);
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/** Every image of the packs, `{ name, path }`, in the order findPackImages meets them. */
export function findAllImages(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder).sort()) {
      if (entry.startsWith(".")) continue;
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (IMAGE.test(entry)) found.push({ name: entry, path });
    }
  };
  visit(directory);
  return found;
}

/**
 * Bitmaps whose name two packs use for different pictures (AVS had one folder: the pack
 * installed last won). A preset takes the copy nearest to it — its own folder, then the ones
 * above — so the build serves the other copies beside the first and tells such a preset where
 * its copy is (`resources.uris`, which webvs's ResourceManager reads before the shared names).
 * Returns `{ served: Map(asset path → file), uris(file, preset) }`; uris gives the preset's
 * overrides, or null.
 */
export function imageOverrides(all, prefix, base) {
  const byName = new Map();
  for (const image of all) {
    const key = image.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ ...image, digest: hash(readFileSync(image.path)) });
  }
  const clashes = new Map([...byName].filter(([, copies]) => new Set(copies.map((copy) => copy.digest)).size > 1));
  const served = new Map();
  const urlOf = (copy) => {
    const asset = `${prefix}resources/${copy.digest.slice(0, 10)}/${copy.name}`;
    served.set(asset, copy.path);
    return `${base}${prefix}resources/${copy.digest.slice(0, 10)}/${encodeURIComponent(copy.name)}`;
  };
  const uris = (file, preset) => {
    if (clashes.size === 0) return null;
    const names = new Map();
    const walk = (value) => {
      if (typeof value === "string") {
        const key = value.toLowerCase();
        if (clashes.has(key)) names.set(value, key);
      } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) walk(item);
      }
    };
    walk(preset.components);
    let result = null;
    for (const [written, key] of names) {
      const copies = clashes.get(key);
      // The nearest copy: the longest folder of the preset's path that holds one.
      let nearest = null;
      for (const copy of copies) {
        const folder = dirname(copy.path);
        if (!(file.startsWith(folder + sep) || dirname(file) === folder)) continue;
        if (!nearest || folder.length > dirname(nearest.path).length) nearest = copy;
      }
      if (!nearest || nearest.digest === copies[0].digest) continue;
      result ??= {};
      result[written] = urlOf(nearest);
    }
    return result;
  };
  return { served, uris };
}

/**
 * The AVI clips of the packs (Render / AVI played `g_path\name`): frame atlases made from the
 * packs' .avi files (scratch/avs-reference/visbot/plugins/avi_atlas.py) in a folder mirroring
 * vendor/avs-presets — `<name>.json` and its WebP pages. `{ name, folder, meta, pages: [path] }`.
 */
export function findVideos(directory) {
  if (!directory || !existsSync(directory)) return [];
  const found = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder).sort()) {
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.avi\.json$/i.test(entry)) {
        try {
          const meta = JSON.parse(readFileSync(path, "utf8"));
          const pages = (meta.pages ?? []).map((page) => join(folder, page));
          if (pages.length && pages.every((page) => existsSync(page))) found.push({ name: meta.file ?? entry.slice(0, -5), folder, meta, pages });
        } catch {
          // not a clip's map
        }
      }
    }
  };
  visit(directory);
  return found;
}

/**
 * Each AVI effect's clip: the copy of its file name nearest the preset (its pack's own, as the
 * pack's installer put it into the AVS folder), else any copy. Returns the preset with `video`
 * set on its AVI effects (a copy; null when nothing changed), the pages to serve and the names
 * no pack carried.
 */
export function videoResolver(videos, presetsDirectory, videosDirectory, prefix, base) {
  const byName = new Map();
  for (const video of videos) {
    const key = video.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ ...video, relative: relative(videosDirectory, video.folder) });
  }
  const served = new Map();
  const missing = new Map();
  const pageUrl = (video, page) => {
    const digest = hash(readFileSync(page)).slice(0, 10);
    const asset = `${prefix}videos/${digest}/${basename(page)}`;
    served.set(asset, page);
    return `${base}${prefix}videos/${digest}/${encodeURIComponent(basename(page))}`;
  };
  const resolve = (file, preset) => {
    const folder = relative(presetsDirectory, dirname(file));
    let changed = false;
    const walk = (components) => (components ?? []).map((component) => {
      if (!component || typeof component !== "object") return component;
      let next = component;
      if (component.type === "AVI" && typeof component.file === "string" && component.file) {
        const name = component.file.split(/[\\/]/).pop().toLowerCase();
        const copies = byName.get(name) ?? [];
        let nearest = null;
        for (const copy of copies) {
          if (!(folder === copy.relative || folder.startsWith(copy.relative + sep))) continue;
          if (!nearest || copy.relative.length > nearest.relative.length) nearest = copy;
        }
        nearest ??= copies[0] ?? null;
        if (nearest) {
          const { width, height, length, cols, rows, map } = nearest.meta;
          next = { ...component, video: { pages: nearest.pages.map((page) => pageUrl(nearest, page)), width, height, length, cols, rows, map } };
          changed = true;
        } else {
          missing.set(name, (missing.get(name) ?? 0) + 1);
        }
      }
      if (Array.isArray(component.components)) {
        const inner = walk(component.components);
        if (inner !== component.components) {
          next = next === component ? { ...component } : next;
          next.components = inner;
        }
      }
      return next;
    });
    const components = walk(preset.components);
    return changed ? { ...preset, components } : null;
  };
  return { resolve, served, missing };
}

const FONT_WEIGHTS = {
  DONTCARE: 0, THIN: 100, EXTRALIGHT: 200, LIGHT: 300, REGULAR: 400,
  MEDIUM: 500, SEMIBOLD: 600, BOLD: 700, EXTRABOLD: 800, BLACK: 900
};

/**
 * webvsc skips the font size of a Text effect (LOGFONT.lfHeight). It sits 28
 * bytes before the font name in the preset, where the weight 16 bytes after it
 * confirms the place; each Text effect is looked up in order.
 */
export function addFontHeights(raw, preset) {
  let from = 0;
  const visit = (components) => {
    for (const component of components ?? []) {
      if (component.type === "Text" && typeof component.fontName === "string" && component.fontName) {
        const name = Buffer.from(component.fontName + "\0", "latin1");
        const weight = FONT_WEIGHTS[String(component.weight).toUpperCase()];
        for (let at = raw.indexOf(name, from); at >= 28; at = raw.indexOf(name, at + 1)) {
          if (weight === undefined || raw.readInt32LE(at - 12) === weight) {
            const height = raw.readInt32LE(at - 28);
            if (height !== 0 && Math.abs(height) <= 400) component.fontHeight = height;
            from = at + name.length;
            break;
          }
        }
      }
      if (component.components) visit(component.components);
    }
  };
  visit(preset.components);
  return preset;
}

/** One `.avs` file's bytes as webvs's JSON; throws when webvsc cannot read it. */
export function convertPreset(raw, name) {
  let failure = "";
  const error = console.error;
  // webvsc catches what stops it reading, prints it and returns what it had so far: that fails
  // the preset here. Its other messages (a field it does not know) are only printed.
  console.error = (message) => {
    // An Error, or webvsc's own ConvertException (not an Error subclass).
    if (message instanceof Error || message?.name === "ConvertException") failure ||= String(message.message);
  };
  let preset;
  try {
    preset = convertBlob(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), name, undefined, { quiet: true });
  } finally {
    console.error = error;
  }
  if (failure || !preset || !Array.isArray(preset.components)) throw new Error(failure || "not an AVS preset");
  return addFontHeights(raw, JSON.parse(JSON.stringify(preset)));
}

/** `{ "Name — Pack": webvsJson }` for the files given; files webvsc cannot read are reported, not fatal. */
export function convertPresets(directory, files = findPresets(directory)) {
  const presets = {};
  const failed = [];
  for (const file of files) {
    const name = basename(file).replace(/\.avs$/i, "");
    const folder = relative(directory, dirname(file)).split(sep).filter(Boolean);
    try {
      presets[presetId(name, folder[0] ?? "", folder.slice(1).join("/"))] = convertPreset(readFileSync(file), name);
    } catch (error) {
      failed.push(`${relative(directory, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { presets, failed };
}

/**
 * mscopes' own presets (GarAlex/mscopes, BSD-3), converted by hand from its
 * core/effects/Presets.cpp into the JSON webvs reads: they can live in the
 * repository (src/shared/visualizations/avs/webvs/mscopes/presets.json), so every
 * build has them, as the pack "mscopes".
 */
export function mscopesPresets() {
  const file = new URL("../src/shared/visualizations/avs/webvs/mscopes/presets.json", import.meta.url);
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * What a preset is called: its name, then its pack and folders after a dash — the name presets
 * always had (shared/visualizations/avs/packs.ts says it the same way).
 */
export function presetId(name, pack, folder = "") {
  const where = [pack, ...folder.split("/")].filter(Boolean).join(" / ");
  return where ? `${name} — ${where}` : name;
}

function slug(name) {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The packs in `directory`: each top-level folder, its presets placed in a category (the
 * first folder below it — an author's pack) and group (the folders below that, joined with
 * " / "). `folder` is where the file is, below the pack, and stays part of its name.
 */
export function findAvsPacks(directory) {
  if (!existsSync(directory)) return [];
  const packs = [];
  const taken = new Set(["mscopes"]);
  const folders = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  for (const folder of folders.map((entry) => entry.name).sort()) {
    const root = join(directory, folder);
    const files = findPresets(root);
    if (files.length === 0) continue;
    let id = slug(folder) || `pack-${packs.length + 1}`;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${slug(folder) || "pack"}-${suffix}`;
    taken.add(id);
    packs.push({
      id,
      name: folder,
      root,
      presets: files.map((file) => {
        const folders = relative(root, dirname(file)).split(sep).filter(Boolean);
        return {
          file,
          name: basename(file).replace(/\.avs$/i, ""),
          category: folders[0] ?? "",
          group: folders.slice(1).join(" / "),
          folder: folders.join("/")
        };
      })
    });
  }
  return packs;
}

const hash = (data) => createHash("sha256").update(data).digest("hex");

function readCache(file, salt) {
  try {
    const cache = JSON.parse(readFileSync(file, "utf8"));
    if (cache.salt === salt && cache.entries && typeof cache.entries === "object") return cache.entries;
  } catch { /* missing or unreadable: everything is converted again */ }
  return {};
}

function writeCache(file, salt, entries) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ salt, entries }));
  renameSync(temporary, file);
}

/** Every webvsc source: a change there converts everything again. */
function converterSalt() {
  const sources = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder).sort()) {
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry.endsWith(".js")) sources.push(readFileSync(path, "utf8"));
    }
  };
  visit(WEBVSC);
  return hash(`${CACHE_FORMAT}\n${addFontHeights.toString()}\n${sources.join("\n")}`);
}

/**
 * Everything the plugin serves: the virtual module's value, the index and chunks (`files`),
 * and the images (`images`: name → path on disk).
 */
export function buildAvsPacks({ directory, resourceDirectory, videoDirectory, cacheDirectory, prefix, base, logger, limits = CHUNK_LIMITS }) {
  const started = performance.now();
  const vendorPacks = findAvsPacks(directory);
  const cacheFile = join(cacheDirectory, "presets.json");
  const salt = converterSalt();
  const cache = vendorPacks.length ? readCache(cacheFile, salt) : {};
  const fresh = {};
  const failures = [];
  let convertedNow = 0;
  let fromCache = 0;
  const packs = [];
  // mscopes' presets: converted by hand, in the repository, the same in every build.
  const mscopes = mscopesPresets();
  const mscopesPack = {
    id: "mscopes",
    name: "mscopes",
    presets: Object.keys(mscopes).map((name) => ({ name, category: "", group: "", folder: "" }))
  };
  const converted = new Map(mscopesPack.presets.map((preset) => [preset, mscopes[preset.name]]));
  for (const pack of vendorPacks) {
    for (const preset of pack.presets) {
      const raw = readFileSync(preset.file);
      const key = hash(raw);
      let value = cache[key] ?? fresh[key];
      if (value === undefined) {
        convertedNow += 1;
        try {
          value = convertPreset(raw, preset.name);
        } catch (error) {
          value = { error: error instanceof Error ? error.message : String(error) };
        }
      } else if (!fresh[key]) {
        fromCache += 1;
      }
      fresh[key] = value;
      if (value.error) failures.push(`${pack.name}/${preset.folder ? `${preset.folder}/` : ""}${preset.name}.avs: ${value.error}`);
      else converted.set(preset, value);
    }
    packs.push(pack);
  }
  if (vendorPacks.length && (convertedNow || Object.keys(cache).length !== Object.keys(fresh).length)) writeCache(cacheFile, salt, fresh);
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(join(cacheDirectory, "failed.txt"), failures.length ? `${failures.sort().join("\n")}\n` : "");
  // A bitmap name two packs use for different pictures: each preset gets its own pack's copy.
  const overrides = imageOverrides(findAllImages(directory), prefix, base);
  let overridden = 0;
  for (const pack of vendorPacks) {
    for (const preset of pack.presets) {
      const value = converted.get(preset);
      const uris = value ? overrides.uris(preset.file, value) : null;
      if (!uris) continue;
      converted.set(preset, { ...value, resources: { uris } });
      overridden += 1;
    }
  }
  // The AVI effects' clips (vendor/avs-videos), the nearest copy of each name.
  const videos = videoResolver(findVideos(videoDirectory), directory, videoDirectory ?? directory, prefix, base);
  let withVideo = 0;
  for (const pack of vendorPacks) {
    for (const preset of pack.presets) {
      const value = converted.get(preset);
      const resolved = value ? videos.resolve(preset.file, value) : null;
      if (!resolved) continue;
      converted.set(preset, resolved);
      withVideo += 1;
    }
  }

  const files = new Map();
  const index = { packs: {} };
  const info = [];
  let count = 0;
  for (const pack of [...packs, mscopesPack]) {
    const assets = packAssets(pack.presets, converted, `${prefix}${pack.id}/`, limits);
    if (assets.count === 0) continue;
    const packIndex = JSON.parse(assets.files.get(assets.indexName));
    assets.files.delete(assets.indexName);
    for (const [name, source] of assets.files) files.set(name, source);
    index.packs[pack.id] = { chunks: packIndex.chunks.map((chunk) => `${pack.id}/${chunk}`), groups: packIndex.groups };
    info.push({ id: pack.id, name: pack.name, count: assets.count, categories: assets.categories });
    count += assets.count;
  }
  if (count === 0) return { info: null, files, images: new Map() };
  const indexSource = JSON.stringify(index);
  const indexName = `${prefix}index-${hash(indexSource).slice(0, 12)}.json`;
  files.set(indexName, indexSource);

  // webvs's own bitmaps (Texer sprites, MIT with webvs), then the packs' images, served beside.
  const images = new Map();
  const builtin = existsSync(resourceDirectory) ? readdirSync(resourceDirectory).filter((name) => IMAGE.test(name)) : [];
  for (const name of builtin) images.set(`${prefix}resources/${name}`, join(resourceDirectory, name));
  const packImages = findPackImages(directory, builtin);
  let imageBytes = 0;
  for (const image of packImages) {
    images.set(`${prefix}resources/${image.name}`, image.path);
    imageBytes += statSync(image.path).size;
  }
  for (const [asset, path] of overrides.served) {
    images.set(asset, path);
    imageBytes += statSync(path).size;
  }
  let videoBytes = 0;
  for (const [asset, path] of videos.served) {
    images.set(asset, path);
    videoBytes += statSync(path).size;
  }
  const bytes = [...files.values()].reduce((total, source) => total + source.length, 0);
  const chunks = files.size - 1;
  logger.info(`AVS: ${count} presets in ${info.length} packs — ${convertedNow} converted now, ${fromCache} from cache, `
    + `${((performance.now() - started) / 1000).toFixed(1)} s; index ${(indexSource.length / 1024).toFixed(0)} kB, `
    + `${chunks} chunks, ${(bytes / 1048576).toFixed(1)} MB`
    + (packImages.length ? `; ${packImages.length} pack images, ${(imageBytes / 1048576).toFixed(1)} MB` : "")
    + (overridden ? ` (${overrides.served.size} more copies of a name another pack uses, for ${overridden} presets)` : "")
    + (withVideo ? `; AVI clips for ${withVideo} presets, ${videos.served.size} pages, ${(videoBytes / 1048576).toFixed(1)} MB` : "")
    + (videos.missing.size ? ` (not in any pack: ${[...videos.missing.keys()].sort().join(", ")})` : "")
    + (failures.length ? `; ${failures.length} unreadable: ${relative(process.cwd(), join(cacheDirectory, "failed.txt"))}` : ""));
  return {
    info: { index: `${base}${indexName}`, count, packs: info },
    files,
    images,
    imageNames: packImages.map((image) => image.name)
  };
}

export function avsPresets(options) {
  let settings = null;
  let built = null;
  const prepare = () => {
    built ??= (() => {
      try {
        return buildAvsPacks(settings);
      } catch (error) {
        settings.logger.warn(`AVS: presets left out — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        return { info: null, files: new Map(), images: new Map(), imageNames: [] };
      }
    })();
    return built;
  };
  return {
    name: "tryhackx-avs-presets",
    // Thirteen thousand presets are nothing the dev server needs to watch: they are read when it starts.
    config() {
      const folder = options.directory.replace(/\\/g, "/").replace(/\/+$/, "");
      return { server: { watch: { ignored: [isAbsolute(options.directory) ? `${folder}/**` : `**/${folder}/**`] } } };
    },
    configResolved(config) {
      const resolve = (path) => (isAbsolute(path) ? path : join(config.root, path));
      settings = {
        directory: resolve(options.directory),
        resourceDirectory: resolve(options.resources),
        videoDirectory: options.videos ? resolve(options.videos) : null,
        cacheDirectory: join(config.root, "node_modules", ".cache", "avs-presets"),
        prefix: `${config.build.assetsDir}/avs/`,
        base: config.base,
        logger: config.logger,
        limits: options.limits
      };
    },
    buildStart() {
      prepare();
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const { info, imageNames = [] } = prepare();
      return `export default ${JSON.stringify(info)};`
        + `\nexport const resources = ${JSON.stringify(`${settings.base}${settings.prefix}resources/`)};`
        + `\nexport const images = ${JSON.stringify(info ? imageNames : [])};`;
    },
    // Written beside the bundle rather than emitted into it: a thousand chunks and
    // images would fill Vite's report line by line. The summary above says what was written.
    writeBundle(output) {
      const directory = output.dir ?? dirname(output.file ?? "");
      const { info, files, images } = prepare();
      if (!info) return;
      for (const [fileName, source] of files) {
        const target = join(directory, fileName);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
      }
      for (const [fileName, path] of images) {
        const target = join(directory, fileName);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(path));
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = decodeURIComponent((request.url ?? "").split("?")[0]);
        if (!settings || !path.startsWith(`${settings.base}${settings.prefix}`)) return next();
        const { files, images } = prepare();
        const name = path.slice(settings.base.length);
        const source = files.get(name) ?? (images.has(name) ? readFileSync(images.get(name)) : undefined);
        if (source === undefined) return next();
        response.setHeader("Content-Type", CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream");
        return response.end(source);
      });
    }
  };
}
