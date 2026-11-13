/**
 * MilkDrop presets beyond butterchurn's own, for an owner who has some:
 * projectM's "Cream of the Crop" and "MilkDrop original" packs, or any folder
 * of .milk files.
 *
 * Like the AVS presets and Font Awesome Pro they live in a git-ignored folder,
 * `frontend/vendor/milkdrop-presets/`, and only on the server that uses them:
 * MilkDrop presets were released without a licence, so a public repository
 * does not carry them. Every folder there is a pack:
 *
 *     vendor/milkdrop-presets/<pack>/<category>/<group>/<name>.milk
 *
 * — category and group optional; a pack whose presets all sit in one folder,
 * as projectM's "MilkDrop original" does, reads as if they sat at its top.
 *
 * Each preset is converted at build time by milkdrop-convert.mjs, in worker
 * threads, and only once: results are kept in node_modules/.cache by the
 * file's contents, so a rebuild converts only what is new or changed. A preset
 * that cannot be converted faithfully is left out and listed in that folder's
 * failed.txt; it never stops the build.
 *
 * Ten thousand presets must not reach a browser at once, so each pack becomes
 * an index (names, by category and group) and chunks of a few dozen presets —
 * hashed JSON assets fetched when one of their presets is about to play.
 *
 * The textures presets name come from `frontend/vendor/milkdrop-textures/`
 * (milkdrop-textures.mjs): served beside the packs, each fetched only when a
 * preset asks for it, and their sizes written into the presets that read them.
 *
 * `virtual:milkdrop-presets` lists the packs and where their indexes are, and
 * the textures; with neither it is null and the build is what it was without
 * this plugin.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  BUTTERCHURN_TEXTURES, CONTENT_TYPES, IMAGE_DATA_TEXTURES, fillTexsizes, findTextures, randomSlot, requestedTextures, textureAssets
} from "./milkdrop-textures.mjs";

const VIRTUAL_ID = "virtual:milkdrop-presets";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const CONVERTER = fileURLToPath(new URL("./milkdrop-convert.mjs", import.meta.url));
/** Every source a conversion depends on; their text is part of the cache key. */
const CONVERSION_SOURCES = [
  CONVERTER,
  fileURLToPath(new URL("./milkdrop-hlsl.mjs", import.meta.url)),
  fileURLToPath(new URL("./butterchurn-patches.mjs", import.meta.url)),
  fileURLToPath(new URL("./shader-glsl-types.mjs", import.meta.url)),
  fileURLToPath(new URL("./shader-glsl.mjs", import.meta.url)),
  fileURLToPath(new URL("../src/shared/visualizations/milkdrop-eel.ts", import.meta.url))
];
/** Bumped by hand when the cached form changes in a way the sources below do not show. */
const CACHE_FORMAT = 2;

function findMilk(folder, found = []) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) findMilk(path, found);
    // .milk2: a MilkDrop 3 double preset (milkdrop-convert.mjs splitMilk2).
    else if (/\.milk2?$/i.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * The engine a pack was made for, by its folder's name: "beatdrop" for BeatDrop's presets and
 * "milkdrop3" for MilkDrop 3's (`milkdrop3`, `md3`…) — both count simple waveforms modulo 18, and
 * BeatDrop draws modes 0 and 6 from both channels; otherwise MilkDrop 2 (undefined).
 */
export function packEngine(folder) {
  if (/beatdrop/i.test(folder)) return "beatdrop";
  return /milk\s*drop\s*-?\s*3|(?:^|[^a-z0-9])md3(?:[^a-z0-9]|$)/i.test(folder) ? "milkdrop3" : undefined;
}

function slug(name) {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The packs in `directory`, each with its presets placed in a category (first
 * folder) and group (the folders below it, joined with " / ").
 */
export function findPacks(directory) {
  if (!existsSync(directory)) return [];
  const packs = [];
  const taken = new Set();
  const folders = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  for (const folder of folders.map((entry) => entry.name).sort()) {
    const root = join(directory, folder);
    const files = findMilk(root).sort();
    if (files.length === 0) continue;
    let parts = files.map((file) => relative(root, file).split(sep));
    // One folder holding everything is a wrapper, not a category.
    while (parts.every((path) => path.length > 1 && path[0] === parts[0][0])) parts = parts.map((path) => path.slice(1));
    let id = slug(folder) || `pack-${packs.length + 1}`;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${slug(folder) || "pack"}-${suffix}`;
    taken.add(id);
    const engine = packEngine(folder);
    packs.push({
      id,
      name: folder,
      root,
      ...(engine ? { engine } : {}),
      presets: files.map((file, index) => {
        const path = parts[index];
        const folders = path.slice(0, -1);
        return {
          file,
          name: path.at(-1).replace(/\.milk2?$/i, ""),
          category: folders[0] ?? "",
          group: folders.slice(1).join(" / "),
          folder: folders.join("/"),
          ...(engine ? { engine } : {})
        };
      })
    });
  }
  return packs;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The order the panel lists them in: by category, then group, then name. */
export function sortPresets(presets) {
  return [...presets].sort((left, right) => collator.compare(left.category, right.category)
    || collator.compare(left.group, right.group)
    || collator.compare(left.name, right.name));
}

/**
 * Presets cut into chunks that never mix groups — neighbours in the list are
 * usually asked for together — and stay under `maxBytes` and `maxPresets`.
 */
export function planChunks(presets, sizeOf, { maxBytes = 160 * 1024, maxPresets = 32 } = {}) {
  const chunks = [];
  let current = null;
  for (const preset of presets) {
    const size = sizeOf(preset);
    if (!current || current.folder !== preset.folder || current.presets.length >= maxPresets || (current.bytes + size > maxBytes && current.presets.length > 0)) {
      current = { folder: preset.folder, presets: [], bytes: 0 };
      chunks.push(current);
    }
    current.presets.push(preset);
    current.bytes += size;
  }
  return chunks.map((chunk) => chunk.presets);
}

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** A pack's assets: `index-<hash>.json` and one `<hash>.json` per chunk, under `prefix`. */
export function packAssets(presets, converted, prefix, limits) {
  const ready = sortPresets(presets.filter((preset) => converted.has(preset)));
  const key = (preset) => (preset.folder ? `${preset.folder}/${preset.name}` : preset.name);
  const sources = new Map(ready.map((preset) => [preset, JSON.stringify(converted.get(preset))]));
  const files = new Map();
  const chunkOf = new Map();
  const chunks = planChunks(ready, (preset) => sources.get(preset).length + key(preset).length + 6, limits).map((chunk, index) => {
    const source = `{${chunk.map((preset) => `${JSON.stringify(key(preset))}:${sources.get(preset)}`).join(",")}}`;
    const fileName = `${hash(source).slice(0, 12)}.json`;
    files.set(`${prefix}${fileName}`, source);
    for (const preset of chunk) chunkOf.set(preset, index);
    return fileName;
  });
  const groups = [];
  for (const preset of ready) {
    let group = groups.at(-1);
    if (!group || group.folder !== preset.folder) {
      group = { category: preset.category, group: preset.group, folder: preset.folder, presets: [] };
      groups.push(group);
    }
    group.presets.push([preset.name, chunkOf.get(preset)]);
  }
  const index = JSON.stringify({ chunks, groups });
  const indexName = `${prefix}index-${hash(index).slice(0, 12)}.json`;
  files.set(indexName, index);
  const categories = [];
  for (const preset of ready) {
    if (!preset.category) continue;
    if (categories.at(-1)?.name !== preset.category) categories.push({ name: preset.category, count: 0 });
    categories.at(-1).count += 1;
  }
  return { files, indexName, count: ready.length, categories };
}

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

/**
 * Convert `jobs` ({ key, path }) in worker threads, one preset at a time per
 * worker: a preset that crashes the converter costs that preset alone, and a
 * fresh worker takes over the rest. Workers that keep stopping before they
 * convert anything are not replaced; what is left is then reported as failed.
 */
function convertInWorkers(jobs, size, onResult) {
  return new Promise((resolve) => {
    let next = 0;
    let running = 0;
    let stalls = 0;
    let lastError = "";
    const finish = () => {
      if (running > 0) return;
      for (; next < jobs.length; next += 1) onResult({ key: jobs[next].key, error: `converter unavailable${lastError ? `: ${lastError}` : ""}` });
      resolve();
    };
    const start = () => {
      running += 1;
      let current = null;
      let converted = 0;
      const worker = new Worker(CONVERTER, { workerData: { task: "milkdrop-convert" } });
      const feed = () => {
        if (next >= jobs.length) {
          current = null;
          worker.postMessage({ done: true });
          return;
        }
        current = jobs[next];
        next += 1;
        worker.postMessage(current);
      };
      worker.on("message", (message) => {
        if (message.key !== current?.key) return;
        converted += 1;
        stalls = 0;
        onResult(message);
        feed();
      });
      worker.on("error", (error) => {
        lastError = error instanceof Error ? error.message : String(error);
      });
      worker.on("exit", () => {
        running -= 1;
        if (current) onResult({ key: current.key, error: `converter stopped${lastError ? `: ${lastError}` : ""}` });
        if (converted === 0) stalls += 1;
        if (next < jobs.length && stalls < 3) start();
        else finish();
      });
      feed();
    };
    const count = Math.min(size, jobs.length);
    if (count === 0) resolve();
    for (let index = 0; index < count; index += 1) start();
  });
}

/** The translator's packages, by version — part of the cache key; null when they are not installed. */
function converterVersion() {
  try {
    const require = createRequire(import.meta.url);
    return ["hlslparser-js", "milkdrop-preset-utils", "butterchurn"].map((name) => `${name} ${require(`${name}/package.json`).version}`).join(", ");
  } catch {
    return null;
  }
}

/**
 * The textures a build serves: every image of the texture folder, and those of
 * a pack's own folder that a preset asks for by name. With the converted
 * presets' requests (`roots`: name → how many presets), so that the log can
 * say what is still missing.
 */
export function collectTextures(textureDirectory, packs, roots, prefix) {
  const library = findTextures(textureDirectory);
  const chosen = new Map(library.textures.map((texture) => [texture.key, texture]));
  let fromPacks = 0;
  for (const pack of packs) {
    for (const texture of findTextures(pack.root, { pool: false }).textures) {
      if (chosen.has(texture.key) || !roots.has(texture.key)) continue;
      chosen.set(texture.key, texture);
      fromPacks += 1;
    }
  }
  const assets = textureAssets([...chosen.values()], prefix);
  const sizes = new Map(assets.list.map(([key, , width, height]) => [key, { width, height }]));
  // What butterchurn draws for a name: its own textures, the build's, butterchurn-presets', or clouds2.
  const sizeOf = (root) => BUTTERCHURN_TEXTURES.get(root) ?? sizes.get(root) ?? IMAGE_DATA_TEXTURES.get(root) ?? BUTTERCHURN_TEXTURES.get("clouds2");
  // A random slot draws from the texture folder — or, without one, from butterchurn-presets' textures;
  // a slot naming a prefix also from the folders kept for prefixed slots (milkdrop-textures.mjs).
  const poolKeys = assets.list.filter((entry) => entry[4] === 1).map((entry) => entry[0]);
  const prefixedKeys = assets.list.filter((entry) => entry[4] === 1 || entry[4] === 2).map((entry) => entry[0]);
  const fallbackKeys = [...IMAGE_DATA_TEXTURES.keys()];
  const has = (root) => {
    const slot = randomSlot(root);
    if (slot) return (slot.prefix ? (prefixedKeys.length ? prefixedKeys : fallbackKeys) : (poolKeys.length ? poolKeys : fallbackKeys)).some((key) => key.startsWith(slot.prefix));
    return BUTTERCHURN_TEXTURES.has(root) || sizes.has(root) || IMAGE_DATA_TEXTURES.has(root);
  };
  return { ...assets, sizeOf, has, skipped: library.skipped, fromPacks };
}

/** Everything the plugin serves: the virtual module's value and the asset files. */
export async function buildPacks({ directory, textureDirectory, cacheDirectory, prefix, base, logger, limits, workers }) {
  let packs = findPacks(directory);
  const hasTextures = findTextures(textureDirectory).textures.length > 0;
  if (packs.length === 0 && !hasTextures) return { info: null, files: new Map() };
  const version = packs.length ? converterVersion() : null;
  if (packs.length && !version) {
    logger.warn("MilkDrop: presets found in vendor/milkdrop-presets, but hlslparser-js and milkdrop-preset-utils are not installed (npm install) — left out");
    packs = [];
  }
  const started = performance.now();
  const salt = hash(`${CACHE_FORMAT}\n${version}\n${CONVERSION_SOURCES.map((file) => readFileSync(file, "utf8")).join("\n")}`);
  const caches = new Map(packs.map((pack) => [pack.id, readCache(join(cacheDirectory, `${pack.id}.json`), salt)]));
  // The same file in two packs is converted once.
  const known = (key) => {
    for (const cache of caches.values()) if (cache[key]) return cache[key];
    return undefined;
  };
  const all = packs.flatMap((pack) => pack.presets);
  // A file's key is its content — and the engine, which changes what it converts to.
  const keys = new Map((await hashFiles(all)).map(([preset, digest]) => [preset, preset.engine ? `${digest}|${preset.engine}` : digest]));
  const jobs = [];
  const queued = new Set();
  let cachedCount = 0;
  for (const preset of all) {
    const key = keys.get(preset);
    if (known(key)) cachedCount += 1;
    else if (!queued.has(key)) {
      queued.add(key);
      jobs.push({ key, path: preset.file, ...(preset.engine ? { engine: preset.engine } : {}) });
    }
  }
  const fresh = new Map();
  if (jobs.length) {
    logger.info(`MilkDrop: converting ${jobs.length} presets (cached results are reused next time)…`);
    await convertInWorkers(jobs, workers ?? Math.max(1, Math.min(availableParallelism() - 1, 8)), (message) => {
      fresh.set(message.key, message.error === undefined ? { preset: message.preset, ...(message.notes ? { notes: message.notes } : {}) } : { error: message.error });
    });
  }
  const files = new Map();
  const info = [];
  const failures = [];
  const notes = [];
  const summary = [];
  const convertedByPack = new Map();
  // Which textures the presets ask for, and how many presets ask for each.
  const requests = new Map();
  for (const pack of packs) {
    const entries = {};
    const converted = new Map();
    for (const preset of pack.presets) {
      const key = keys.get(preset);
      const result = known(key) ?? fresh.get(key) ?? { error: "not converted" };
      entries[key] = result;
      if (result.preset) {
        converted.set(preset, result.preset);
        for (const note of result.notes ?? []) notes.push(`${pack.name}/${preset.folder ? `${preset.folder}/` : ""}${preset.name}.milk: ${note}`);
        for (const root of presetTextures(result.preset)) requests.set(root, (requests.get(root) ?? 0) + 1);
      } else failures.push(`${pack.name}/${preset.folder ? `${preset.folder}/` : ""}${preset.name}.milk: ${result.error}`);
    }
    // Written again only when something was added or has gone.
    const previous = caches.get(pack.id);
    const keysNow = Object.keys(entries);
    if (keysNow.length !== Object.keys(previous).length || keysNow.some((key) => !previous[key])) {
      writeCache(join(cacheDirectory, `${pack.id}.json`), salt, entries);
    }
    convertedByPack.set(pack, converted);
  }
  const textures = collectTextures(textureDirectory, packs, requests, `${prefix}textures/`);
  for (const [name, data] of textures.files) files.set(name, data);
  let asking = 0;
  let missing = 0;
  const absent = new Map();
  for (const pack of packs) {
    const converted = convertedByPack.get(pack);
    for (const [preset, value] of converted) {
      const roots = [...presetTextures(value)];
      if (roots.length) {
        asking += 1;
        const lacking = roots.filter((root) => !textures.has(root));
        if (lacking.length) missing += 1;
        for (const root of lacking) absent.set(root, (absent.get(root) ?? 0) + 1);
      }
      // MilkDrop fills texsize_<name>; the cached conversion stays as it was.
      const filled = (part) => (part.warp?.includes("texsize_") || part.comp?.includes("texsize_")
        ? { ...part, warp: fillTexsizes(part.warp, textures.sizeOf), comp: fillTexsizes(part.comp, textures.sizeOf) }
        : part);
      if (value.double) converted.set(preset, { double: { ...value.double, first: filled(value.double.first), second: filled(value.double.second) } });
      else converted.set(preset, filled(value));
    }
    const assets = packAssets(pack.presets, converted, `${prefix}${pack.id}/`, limits);
    const left = pack.presets.length - assets.count;
    summary.push(`${pack.name} ${assets.count}${left ? ` (${left} left out)` : ""}`);
    // A pack with nothing that converted is not offered at all.
    if (assets.count === 0) continue;
    for (const [name, source] of assets.files) files.set(name, source);
    info.push({ id: pack.id, name: pack.name, count: assets.count, index: `${base}${assets.indexName}`, categories: assets.categories });
  }
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(join(cacheDirectory, "failed.txt"), failures.length ? `${failures.sort().join("\n")}\n` : "");
  // Presets that play as MilkDrop plays them: without a block of equations it could not compile either.
  writeFileSync(join(cacheDirectory, "notes.txt"), notes.length ? `${notes.sort().join("\n")}\n` : "");
  const absentList = [...absent].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  writeFileSync(join(cacheDirectory, "textures-missing.txt"), absentList.map(([name, count]) => `${name}\t${count}\n`).join(""));
  const bytes = [...files.values()].reduce((total, source) => total + source.length, 0);
  if (packs.length) {
    logger.info(`MilkDrop: ${summary.join(", ")} — ${jobs.length} converted now, ${cachedCount} from cache, `
      + `${((performance.now() - started) / 1000).toFixed(1)} s; ${files.size} files, ${(bytes / 1048576).toFixed(1)} MB`
      + (failures.length ? `; why: ${relative(process.cwd(), join(cacheDirectory, "failed.txt"))}` : ""));
  }
  if (textures.list.length || asking) {
    const top = absentList.slice(0, 6).map(([name, count]) => `${name} ${count}`).join(", ");
    logger.info(`MilkDrop textures: ${textures.list.length} (${(textures.bytes / 1048576).toFixed(1)} MB`
      + `${textures.fromPacks ? `, ${textures.fromPacks} from the packs' folders` : ""}); ${asking} presets ask for textures butterchurn lacks, `
      + `${asking - missing} get all of them${missing ? `; still missing: ${top}${absentList.length > 6 ? "…" : ""} — ${relative(process.cwd(), join(cacheDirectory, "textures-missing.txt"))}` : ""}`
      + (textures.skipped.length ? `; left out: ${textures.skipped.length} (${[...new Set(textures.skipped.map((entry) => entry.reason))].join("; ")})` : "")
      + (textures.unreadable.length ? `; unreadable: ${textures.unreadable.map((file) => relative(process.cwd(), file)).join(", ")}` : ""));
  }
  const textureInfo = textures.list.length ? { base: `${base}${prefix}textures/`, list: textures.list } : null;
  return { info: info.length || textureInfo ? { packs: info, textures: textureInfo } : null, files };
}

/** The textures a converted preset asks for — both halves of a MilkDrop 3 double preset, and its sprite's image. */
function presetTextures(preset) {
  const halves = preset?.double ? [preset.double.first, preset.double.second] : [preset];
  const roots = new Set();
  for (const half of halves) {
    for (const root of requestedTextures(half)) roots.add(root);
    if (half?.md?.sprite?.texture) roots.add(half.md.sprite.texture);
  }
  return roots;
}

/** Each preset's content hash, read many at a time: one by one, ten thousand small files take seconds. */
async function hashFiles(presets, parallel = 64) {
  const result = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, presets.length) }, async () => {
    while (next < presets.length) {
      const preset = presets[next];
      next += 1;
      result.push([preset, hash(await readFile(preset.file))]);
    }
  }));
  return result;
}

export function milkdropPresets(options) {
  let settings = null;
  let ready = null;
  const prepare = () => {
    ready ??= buildPacks(settings).catch((error) => {
      settings.logger.warn(`MilkDrop: extra presets left out — ${error instanceof Error ? error.message : String(error)}`);
      return { info: null, files: new Map() };
    });
    return ready;
  };
  return {
    name: "tryhackx-milkdrop-presets",
    // Ten thousand presets (and their clones' .git folders) are nothing the dev
    // server needs to watch: they are read when it starts. The textures neither.
    config() {
      const ignored = [options.directory, options.textures].filter(Boolean).map((path) => {
        const folder = path.replace(/\\/g, "/").replace(/\/+$/, "");
        return isAbsolute(path) ? `${folder}/**` : `**/${folder}/**`;
      });
      return { server: { watch: { ignored } } };
    },
    configResolved(config) {
      const resolve = (path) => (isAbsolute(path) ? path : join(config.root, path));
      settings = {
        directory: resolve(options.directory),
        textureDirectory: options.textures ? resolve(options.textures) : null,
        cacheDirectory: join(config.root, "node_modules", ".cache", "milkdrop-presets"),
        prefix: `${config.build.assetsDir}/milkdrop/`,
        base: config.base,
        logger: config.logger,
        limits: options.limits,
        workers: options.workers,
        command: config.command
      };
    },
    // A build waits for the packs; the dev server starts at once, and the
    // virtual module and the middleware below wait for them instead.
    async buildStart() {
      const pending = prepare();
      if (settings.command === "build") await pending;
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export default ${JSON.stringify((await prepare()).info)};`;
    },
    // Written beside the bundle rather than emitted into it: hundreds of
    // chunks would fill Vite's report line by line (and be gzipped for it).
    // The summary above says what was written.
    async writeBundle(output) {
      const directory = output.dir ?? dirname(output.file ?? "");
      for (const [fileName, source] of (await prepare()).files) {
        const target = join(directory, fileName);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        if (!path.startsWith(`${settings.base}${settings.prefix}`)) return next();
        void prepare().then(({ files }) => {
          const source = files.get(path.slice(settings.base.length));
          if (source === undefined) return next();
          response.setHeader("Content-Type", CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream");
          return response.end(source);
        }, next);
      });
    }
  };
}
