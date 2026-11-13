/**
 * Shader visualizations for an owner who has them: Monkey Hi Hat's (Jon McGuire's Volt's
 * Laboratory — visualizers, post-processing effects, crossfades) and music_visualizer's
 * (Bradley Bauer's).
 *
 * The content is not this project's to publish: Volt's Laboratory comes without a licence, its
 * shaders are adaptations of Shadertoy and VertexShaderArt originals (Shadertoy's default licence
 * is CC BY-NC-SA 3.0), and music_visualizer is GPL-3. So, like the MilkDrop and AVS presets, it
 * lives in a git-ignored folder and only on the server that uses it:
 *
 *     vendor/shader-visualizers/volts-laboratory/   shaders/ fx/ crossfades/ libraries/ (textures/)
 *     vendor/shader-visualizers/music_visualizer/   src/shaders/ (or shaders/)
 *
 * — the repositories' own folders, as they are. This plugin reads them at build time, rewrites
 * each shader as GLSL ES 3.00 (shader-glsl.mjs, shader-glsl-types.mjs), works out how each
 * visualization renders (passes, buffers, inputs, textures, audio) and writes the result beside
 * the bundle as hashed JSON: an index and one file per preset, fetched when the visualizer opens
 * and when a preset is about to play. Nothing of the content reaches the repository or the
 * JavaScript bundle. Without the folders `virtual:shader-visualizers` is null and the visualizer
 * is not offered.
 *
 * What does not convert is left out and listed in node_modules/.cache/shader-visualizers/
 * failed.txt; it never stops the build.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";

import { applyConversions } from "./shader-glsl-types.mjs";
import {
  appendLibrary, cleanSource, ES_HEADER, esIdentifiers, isCode, ONE_D_HELPERS, readDeclaration, rewriteDeclarations,
  tokenize, topLevel, twoDimensional
} from "./shader-glsl.mjs";

/** A stage's text made ES: conversions written in, reserved names renamed. */
const finish = (code) => esIdentifiers(applyConversions(code).code);

const VIRTUAL_ID = "virtual:shader-visualizers";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

// ---------------------------------------------------------------------------------------------
// Monkey Hi Hat's .conf files

/**
 * A .conf as Monkey Hi Hat reads it: `[section]` headings, `key=value` lines (a line without `=`
 * gets the next number as its key), everything after `#` a comment. Section and key names are
 * lowercase; values keep their case.
 */
export function parseConf(text) {
  const sections = new Map();
  let section = "";
  let counter = 0;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const line = (raw.includes("#") ? raw.split("#")[0] : raw).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).toLowerCase();
      counter = 0;
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    if (!section) continue;
    const entries = sections.get(section);
    const equals = line.indexOf("=");
    const key = equals >= 0 ? line.slice(0, equals).trim().toLowerCase() : String(counter++);
    const value = equals >= 0 ? line.slice(equals + 1).trim() : line;
    if (!entries.has(key)) entries.set(key, value);
  }
  return {
    sections,
    value: (name, key, fallback = "") => sections.get(name)?.get(key) ?? fallback,
    list: (name) => [...(sections.get(name)?.values() ?? [])],
    has: (name) => sections.has(name)
  };
}

/** `[uniforms]`: a number, or `lo:hi` drawn at random when the visualization starts. */
export function parseUniforms(entries) {
  const uniforms = {};
  for (const [key, raw] of entries ?? []) {
    if (/^\d+$/.test(key)) continue;
    const parts = raw.split(":").map((part) => part.trim()).filter(Boolean);
    const numbers = parts.map(Number);
    if (parts.length === 1 && Number.isFinite(numbers[0])) uniforms[key] = numbers[0];
    else if (parts.length >= 2 && Number.isFinite(numbers[0]) && Number.isFinite(numbers[1])) {
      uniforms[key] = [Math.min(numbers[0], numbers[1]), Math.max(numbers[0], numbers[1])];
    } else uniforms[key] = 0;
  }
  return uniforms;
}

/** `[textures]`-style sections: uniform → files (one is chosen at random); `name!` clamps. */
export function parseTextures(entries, cube = false) {
  const byUniform = new Map();
  for (const raw of entries ?? []) {
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    let uniform = raw.slice(0, colon).trim();
    const file = raw.slice(colon + 1).trim();
    let clamp = false;
    if (uniform.endsWith("!")) {
      uniform = uniform.slice(0, -1);
      clamp = true;
    }
    if (!uniform || !file) continue;
    const entry = byUniform.get(uniform) ?? { uniform, files: [], clamp, cube };
    if (!entry.files.includes(file)) entry.files.push(file);
    byUniform.set(uniform, entry);
  }
  return [...byUniform.values()];
}

const DRAW_MODES = new Set(["Points", "Lines", "LineStrip", "LineLoop", "Triangles", "TriangleStrip", "TriangleFan"]);

/** The name a visualization is listed under: its file name, words capitalised. */
export function prettyName(file) {
  return file.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim()
    .split(/\s+/).map((word) => (/^(fft|fx|vu|tv|dj|3d|4d)$/i.test(word) ? word.toUpperCase()
      : /^\d/.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

const FILLER = new Set(["original", "originals", "by", "and", "from", "the", "work", "of", "adapted", "adaptation",
  "based", "on", "derived", "heavily", "modified", "altered", "an", "a", "anonymous", "creation", "contribution",
  "submission", "adpated", "for", "programs", "many", "sources", "frag", "conversion", "author", "unknown", "milkdrop",
  "with", "in", "at", "to", "after", "shader", "jam", "vj", "set", "festival", "viii", "ozora", "fieldfx", "is"]);

/**
 * The people a by-line names (`Original by Shane and aiekick @Shadertoy` → Shane, aiekick),
 * for the list's labels; the full line stays in the index.
 */
export function bylineAuthors(byline) {
  const names = [];
  const cleaned = byline.replace(/@\w+/g, " ").replace(/[(),.;]/g, " ");
  for (const word of cleaned.split(/\s+/)) {
    if (!word || FILLER.has(word.toLowerCase())) continue;
    if (!/[A-Za-z0-9]/.test(word)) continue;
    if (!names.includes(word)) names.push(word);
  }
  // "Kali @Shadertoy for a VJ set by Tony Leys" names a set's artist too; keep the shader's.
  return names.slice(0, 4);
}

// ---------------------------------------------------------------------------------------------
// Files

function readText(path) {
  return readFileSync(path, "utf8");
}

/** The file `name` (with `extension` added when it has none) in the first folder that has it. */
function findFile(folders, name, extension) {
  const wanted = extname(name) ? name : `${name}${extension}`;
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    const exact = join(folder, wanted);
    if (existsSync(exact)) return exact;
    // Monkey Hi Hat runs on Windows, where names are not case-sensitive.
    const match = readdirSync(folder).find((entry) => entry.toLowerCase() === wanted.toLowerCase());
    if (match) return join(folder, match);
  }
  return null;
}

/** A library entry (`frag:color_conversions.glsl`, `name`) as the stages and files it links. */
function libraryFiles(entry, folders) {
  let stage = null;
  let name = entry;
  if (/^(vert|frag):/i.test(entry)) {
    stage = entry.slice(0, 4).toLowerCase() === "vert" ? "vertex" : "fragment";
    name = entry.slice(5);
  }
  const files = [];
  if (extname(name)) {
    const path = findFile(folders, basename(name), "");
    if (!path) throw new Error(`library ${entry} not found`);
    const ext = extname(path).toLowerCase();
    files.push({ path, stage: stage ?? (ext === ".vert" ? "vertex" : ext === ".frag" ? "fragment" : "both") });
  } else {
    const glsl = findFile(folders, name, ".glsl");
    if (glsl) files.push({ path: glsl, stage: stage ?? "both" });
    if (!stage) {
      const vert = findFile(folders, name, ".vert");
      const frag = findFile(folders, name, ".frag");
      if (vert) files.push({ path: vert, stage: "vertex" });
      if (frag) files.push({ path: frag, stage: "fragment" });
    }
    if (!files.length) throw new Error(`library ${entry} not found`);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Stages

/** The vertex shader of a full-screen quad, as Monkey Hi Hat's VertexQuad draws it. */
export const QUAD_VERTEX = `${ES_HEADER}layout(location = 0) in vec3 vertices;
layout(location = 1) in vec2 vertexTexCoords;
out vec2 fragCoord;
void main() {
  fragCoord = vertexTexCoords;
  gl_Position = vec4(vertices, 1.0);
}
`;

/** The fragment shader of a vertex visualization (VertexShaderArt): the colour it computed. */
export const POINT_FRAGMENT = `${ES_HEADER}in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}
`;

/**
 * One stage as GLSL ES 3.00: the file's own declarations rewritten, its libraries appended, the
 * header in front, integer/float conversions written in. Returns the code and the uniforms'
 * initial values.
 */
export function convertStage(source, { libraries = [], header = "", oneD = null } = {}) {
  let main = cleanSource(source);
  if (oneD) main = twoDimensional(main, oneD);
  const first = rewriteDeclarations(main);
  const defaults = { ...first.defaults };
  let body = first.code;
  for (const library of libraries) {
    const lib = rewriteDeclarations(cleanSource(library));
    for (const [name, value] of Object.entries(lib.defaults)) if (!(name in defaults)) defaults[name] = value;
    body = appendLibrary(body, lib.code);
  }
  return { code: finish(`${ES_HEADER}${header}${body}`), defaults };
}

// ---------------------------------------------------------------------------------------------
// Volt's Laboratory

/** A visualizer's .conf as the parts that make its passes. */
function readVisualizerConf(path, folders) {
  const conf = parseConf(readText(path));
  const vertexName = conf.value("shader", "vertexshaderfilename", "*");
  const fragmentName = conf.value("shader", "fragmentshaderfilename", "*");
  const type = conf.value("shader", "vertexsourcetypename", "VertexQuad");
  if (type !== "VertexQuad" && type !== "VertexIntegerArray") throw new Error(`vertex source ${type} is not supported`);
  const vertexPath = vertexName === "*" ? null : findFile(folders, vertexName, ".vert");
  const fragmentPath = fragmentName === "*" ? null : findFile(folders, fragmentName, ".frag");
  if (vertexName !== "*" && !vertexPath) throw new Error(`${vertexName} not found`);
  if (fragmentName !== "*" && !fragmentPath) throw new Error(`${fragmentName} not found`);
  const libraries = conf.list("libraries").flatMap((entry) => libraryFiles(entry, folders));
  return {
    conf,
    type,
    vertexPath,
    fragmentPath,
    libraries,
    count: Number.parseInt(conf.value("vertexintegerarray", "vertexintegercount", "1000"), 10) || 1000,
    mode: DRAW_MODES.has(conf.value("vertexintegerarray", "arraydrawingmode", "Points"))
      ? conf.value("vertexintegerarray", "arraydrawingmode", "Points") : "Points",
    uniforms: parseUniforms(conf.sections.get("uniforms"))
  };
}

const ordinal = (letter) => letter.toUpperCase().charCodeAt(0) - 65;

/** The stages of a pass, converted; null paths are the built-in ones. */
function passStages(vertexPath, fragmentPath, type, libraries, cache) {
  const key = `${vertexPath}|${fragmentPath}|${type}|${libraries.map((library) => `${library.stage}:${library.path}`).join(",")}`;
  if (cache.has(key)) return cache.get(key);
  const forStage = (stage) => libraries.filter((library) => library.stage === stage || library.stage === "both")
    .map((library) => readText(library.path));
  const vertex = vertexPath ? convertStage(readText(vertexPath), { libraries: forStage("vertex") })
    : { code: QUAD_VERTEX, defaults: {} };
  const fragment = fragmentPath ? convertStage(readText(fragmentPath), { libraries: forStage("fragment") })
    : { code: POINT_FRAGMENT, defaults: {} };
  const result = { vertex: vertex.code, fragment: fragment.code, defaults: { ...vertex.defaults, ...fragment.defaults } };
  cache.set(key, result);
  return result;
}

function geometryOf(type, count, mode) {
  return type === "VertexIntegerArray" ? { type: "array", count, mode } : { type: "quad" };
}

/** A [multipass] input list (`0,B`) as buffers: numbers this frame's, letters the previous frame's. */
function readInputs(text, passes, problems) {
  if (text === "*") return [];
  return text.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    if (/^\d+$/.test(part)) {
      const index = Number(part);
      const pass = passes[index];
      if (!pass) throw new Error(`input ${part} names no earlier pass`);
      if (pass.draw !== index) problems.push(`input ${part} is pass ${index}, which draws buffer ${pass.draw}`);
      return { uniform: `input${pass.draw}`, buffer: pass.draw, previous: false };
    }
    if (/^[A-Za-z]$/.test(part)) return { uniform: `input${part.toUpperCase()}`, buffer: ordinal(part), previous: true };
    throw new Error(`input ${part} is not a buffer`);
  });
}

/** The draw passes of a visualizer .conf. */
function visualizerPasses(path, folders, cache) {
  const own = readVisualizerConf(path, folders);
  const passes = [];
  const problems = [];
  const lines = own.conf.has("multipass") ? own.conf.list("multipass") : null;
  if (!lines) {
    const stages = passStages(own.vertexPath, own.fragmentPath, own.type, own.libraries, cache);
    passes.push({ draw: 0, inputs: [], ...stages, geometry: geometryOf(own.type, own.count, own.mode), uniforms: {} });
    return { own, passes, problems };
  }
  for (const line of lines) {
    const columns = line.split(/\s+/).filter(Boolean);
    if (columns.length < 3 || columns.length > 6) throw new Error(`[multipass] line "${line}"`);
    const draw = Number.parseInt(columns[0], 10);
    const highest = Math.max(-1, ...passes.map((pass) => pass.draw));
    if (!Number.isInteger(draw) || draw < 0 || draw > highest + 1) throw new Error(`[multipass] draw buffer ${columns[0]}`);
    const inputs = readInputs(columns[1], passes, problems);
    if (columns.length === 3) {
      // A visualizer .conf (or * for this one) draws the pass, with its own uniforms.
      const other = columns[2] === "*" ? own : readVisualizerConf(findFile(folders, columns[2], ".conf") ?? "", folders);
      const stages = passStages(other.vertexPath, other.fragmentPath, other.type, other.libraries, cache);
      passes.push({ draw, inputs, ...stages, geometry: geometryOf(other.type, other.count, other.mode), uniforms: other === own ? {} : other.uniforms });
      continue;
    }
    const vertexPath = columns[2] === "*" ? own.vertexPath : findFile(folders, columns[2], ".vert");
    const fragmentPath = columns[3] === "*" ? own.fragmentPath : findFile(folders, columns[3], ".frag");
    if (columns[2] !== "*" && !vertexPath) throw new Error(`${columns[2]} not found`);
    if (columns[3] !== "*" && !fragmentPath) throw new Error(`${columns[3]} not found`);
    let geometry = geometryOf(own.type, own.count, own.mode);
    let type = own.type;
    if (columns.length >= 5) {
      type = columns[4];
      if (type === "VertexQuad") geometry = { type: "quad" };
      else if (type === "VertexIntegerArray") {
        const settings = Object.fromEntries((columns[5] ?? "").split(";").map((part) => part.split(":").map((s) => s.trim())));
        const count = Number.parseInt(settings.VertexIntegerCount ?? "", 10) || 1000;
        const mode = DRAW_MODES.has(settings.ArrayDrawingMode) ? settings.ArrayDrawingMode : "Points";
        geometry = { type: "array", count, mode };
      } else throw new Error(`vertex source ${type} is not supported`);
    }
    const stages = passStages(vertexPath, fragmentPath, type, own.libraries, cache);
    passes.push({ draw, inputs, ...stages, geometry, uniforms: {} });
  }
  return { own, passes, problems };
}

/** Textures a .conf names: images, cube maps; videos are noted, not played. */
function confTextures(conf) {
  return [
    ...parseTextures(conf.list("textures")),
    ...parseTextures(conf.list("cubemaps"), true),
    ...parseTextures(conf.list("videos")).map((texture) => ({ ...texture, video: true }))
  ];
}

const AUDIO_TEXTURES = new Map([["eyecandyshadertoy", "eyecandyShadertoy"], ["eyecandyfreqdb", "eyecandyFreqDB"],
  ["eyecandywebaudio", "eyecandyWebAudio"]]);

function confAudio(conf, problems) {
  const names = [];
  for (const entry of conf.list("audiotextures")) {
    const known = AUDIO_TEXTURES.get(entry.toLowerCase());
    if (known) names.push({ name: known, uniform: entry });
    else problems.push(`audio texture ${entry} is not supported`);
  }
  return names;
}

/** The program of one graph: buffers, the ones kept for the next frame, and where it ends. */
function finishGraph(passes) {
  const buffers = 1 + Math.max(0, ...passes.map((pass) => pass.draw), ...passes.flatMap((pass) => pass.inputs.map((input) => input.buffer)));
  const previous = [...new Set(passes.flatMap((pass) => pass.inputs.filter((input) => input.previous).map((input) => input.buffer)))].sort();
  return { buffers, previous, output: passes.at(-1).draw };
}

function stripPass(pass) {
  const { defaults, ...rest } = pass;
  return { ...rest, defaults };
}

export function buildVolts(root, warn = () => undefined) {
  const shaders = join(root, "shaders");
  const fx = join(root, "fx");
  const libraries = join(root, "libraries");
  const vizFolders = [shaders, libraries];
  const fxFolders = [fx, libraries];
  const cache = new Map();
  const presets = [];
  const failed = [];
  const confs = (folder) => (existsSync(folder) ? readdirSync(folder).filter((name) => name.toLowerCase().endsWith(".conf")).sort() : []);

  for (const file of confs(shaders)) {
    const name = file.replace(/\.conf$/i, "");
    try {
      const { own, passes, problems } = visualizerPasses(join(shaders, file), vizFolders, cache);
      const conf = own.conf;
      // Monkey Hi Hat's own test and template content.
      if (/^do not load/i.test(conf.value("shader", "description"))) continue;
      const audio = confAudio(conf, problems);
      const byline = conf.value("shader", "byline");
      const authors = bylineAuthors(byline);
      const graph = finishGraph(passes);
      const vertexArt = own.type === "VertexIntegerArray";
      presets.push({
        id: `volts/${name}`,
        source: "volts",
        kind: "viz",
        group: vertexArt ? "volts-vertex" : audio.length ? "volts-audio" : "volts-ambient",
        name: prettyName(name),
        file: name,
        authors,
        byline,
        description: conf.value("shader", "description"),
        audio: audio.length > 0,
        blacklist: conf.list("fx-blacklist").map((entry) => entry.toLowerCase()),
        switchHint: conf.value("playlist", "switchtimehint", ""),
        program: {
          passes: passes.map(stripPass),
          ...graph,
          swap: "frame",
          limit: Number.parseInt(conf.value("shader", "renderresolutionlimit", "0"), 10) || 0,
          fxLimit: Number.parseInt(conf.value("shader", "fxresolutionlimit", "0"), 10) || 0,
          timeOffset: Number.parseInt(conf.value("shader", "randomtimeoffset", "0"), 10) || 0,
          uniforms: own.uniforms,
          fxUniforms: Object.fromEntries([...conf.sections.keys()].filter((key) => key.startsWith("fx-uniforms:"))
            .map((key) => [key.slice("fx-uniforms:".length).toLowerCase(), parseUniforms(conf.sections.get(key))])),
          textures: confTextures(conf),
          textureSync: /^true$/i.test(conf.value("shader", "randomtexturesync", "false")),
          audio
        }
      });
      for (const problem of problems) warn(`volts/${name}: ${problem}`);
    } catch (error) {
      failed.push(`volts-laboratory/shaders/${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const file of confs(fx)) {
    const name = file.replace(/\.conf$/i, "");
    try {
      const conf = parseConf(readText(join(fx, file)));
      const libs = conf.list("libraries").flatMap((entry) => libraryFiles(entry, fxFolders));
      const problems = [];
      // Pass 0 is the visualization the effect works on; it is drawn by the visualizer.
      const passes = [{ draw: 0, inputs: [], primary: true }];
      for (const line of conf.list("multipass")) {
        const columns = line.split(/\s+/).filter(Boolean);
        if (columns.length !== 3) throw new Error(`[multipass] line "${line}"`);
        const draw = Number.parseInt(columns[0], 10);
        const highest = Math.max(...passes.map((pass) => pass.draw));
        if (!Number.isInteger(draw) || draw < 1 || draw > highest + 1) throw new Error(`[multipass] draw buffer ${columns[0]}`);
        const inputs = readInputs(columns[1], passes, problems);
        const fragmentPath = findFile(fxFolders, columns[2], ".frag");
        if (!fragmentPath) throw new Error(`${columns[2]} not found`);
        const stages = passStages(null, fragmentPath, "VertexQuad", libs, cache);
        // passStages gives the point fragment for null; an effect's vertex stage is the quad.
        passes.push({ draw, inputs, vertex: QUAD_VERTEX, fragment: stages.fragment, defaults: stages.defaults, geometry: { type: "quad" }, uniforms: {} });
      }
      if (passes.length < 2) throw new Error("no passes");
      const textures = confTextures(conf);
      const graph = finishGraph(passes);
      presets.push({
        id: `volts-fx/${name}`,
        source: "volts",
        kind: "fx",
        group: "volts-fx",
        name: prettyName(name),
        file: name,
        authors: [],
        byline: "",
        description: conf.value("fx", "description"),
        audio: confAudio(conf, problems).length > 0,
        program: {
          passes: passes.map((pass) => (pass.primary ? pass : stripPass(pass))),
          ...graph,
          swap: "frame",
          limit: Number.parseInt(conf.value("fx", "renderresolutionlimit", "0"), 10) || 0,
          applyPrimaryLimit: /^true$/i.test(conf.value("fx", "applyprimaryresolutionlimit", "false")),
          crossfade: !/^false$/i.test(conf.value("fx", "crossfade", "true")),
          uniforms: parseUniforms(conf.sections.get("uniforms")),
          textures,
          textureSync: /^true$/i.test(conf.value("fx", "randomtexturesync", "false")),
          audio: confAudio(conf, [])
        }
      });
      for (const problem of problems) warn(`volts-fx/${name}: ${problem}`);
    } catch (error) {
      failed.push(`volts-laboratory/fx/${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const crossfades = [];
  const fades = join(root, "crossfades");
  for (const file of existsSync(fades) ? readdirSync(fades).filter((entry) => entry.toLowerCase().endsWith(".frag")).sort() : []) {
    try {
      crossfades.push({ name: file.replace(/\.frag$/i, ""), fragment: convertStage(readText(join(fades, file))).code });
    } catch (error) {
      failed.push(`volts-laboratory/crossfades/${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { presets, crossfades, failed };
}

// ---------------------------------------------------------------------------------------------
// music_visualizer

/** JSON with // and /* comments and trailing commas, as rapidjson reads shader.json. */
export function parseLooseJson(text) {
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\"") {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = at;
      const match = end.exec(text);
      out += match ? match[0] : char;
      at += match ? match[0].length - 1 : 0;
    } else if (char === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at += 1;
      out += "\n";
    } else if (char === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      at = close < 0 ? text.length : close + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The uniforms music_visualizer declares for every stage (its 1D textures as N×1 2D ones). */
function mvHeader(buffers, uniforms) {
  return [
    "uniform vec2 iMouse;", "uniform bool iMouseDown;", "uniform vec2 iMouseDownPos;", "uniform vec2 iRes;",
    "uniform float iTime;", "uniform int iFrame;", "uniform float iNumGeomIters;",
    "uniform sampler2D iSoundR;", "uniform sampler2D iSoundL;", "uniform sampler2D iFreqR;", "uniform sampler2D iFreqL;",
    "uniform vec2 iBuffRes;", "#define iResolution iRes",
    ...buffers.map((name) => `uniform sampler2D i${name};`),
    ...Object.entries(uniforms).map(([name, values]) => `uniform ${values.length === 1 ? "float" : `vec${values.length}`} ${name};`),
    ONE_D_HELPERS
  ].join("\n") + "\n";
}

const MV_SAMPLERS = ["iSoundR", "iSoundL", "iFreqR", "iFreqL"];

/** The full-screen quad music_visualizer's default geometry shader emits, with `geom_p` 0–1. */
const MV_QUAD = `out vec2 geom_p;
void main() {
  vec2 p = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : -1.0, gl_VertexID >= 2 ? 1.0 : -1.0);
  geom_p = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

/**
 * How many triangles one run of a geometry shader can emit, read from its text: each
 * function's EmitVertex/EndPrimitive sequence, calls counted where they are written. A loop
 * around an emission makes the count unknowable, and the declared maximum is used.
 */
export function geometryTriangles(source, maxVertices) {
  const items = topLevel(tokenize(source)).filter((item) => item.kind === "func");
  const bodies = new Map();
  for (const item of items) {
    const code = item.tokens.filter(isCode);
    const brace = code.findIndex((token) => token.text === "{");
    const paren = code.findIndex((token) => token.text === "(");
    bodies.set(code[paren - 1]?.text, code.slice(brace));
  }
  // The emissions in the order they are written, calls inlined; null when a loop repeats them.
  const flatten = (name, depth) => {
    const body = bodies.get(name);
    if (!body || depth > 8) return null;
    const events = [];
    let loop = false;
    for (let index = 0; index < body.length; index += 1) {
      const text = body[index].text;
      if (text === "for" || text === "while" || text === "do") loop = true;
      if (text === "EmitVertex") events.push(true);
      else if (text === "EndPrimitive") events.push(false);
      else if (text !== name && bodies.has(text) && body[index + 1]?.text === "(") {
        const inner = flatten(text, depth + 1);
        if (inner === null) return null;
        events.push(...inner);
      }
    }
    return loop && events.length ? null : events;
  };
  const ceiling = Math.max(1, maxVertices - 2);
  const events = flatten("main", 0);
  if (!events) return ceiling;
  // Strips: a triangle for every vertex after the second; EndPrimitive starts a new strip.
  let strip = 0;
  let triangles = 0;
  for (const emit of events) {
    if (!emit) strip = 0;
    else {
      if (strip >= 2) triangles += 1;
      strip += 1;
    }
  }
  return Math.max(1, Math.min(ceiling, triangles));
}

/**
 * A geometry shader run as a vertex shader, for WebGL 2 has no geometry stage. Each instance is
 * one run (gl_InstanceID is iGeomIter); vertex k of the instance re-runs it and keeps the
 * corner k % 3 of the triangle k / 3 it emits, strips cut into triangles; a vertex past what it
 * emits is put outside the picture. The outputs it writes are copied per emitted vertex.
 */
export function geometryToVertex(source, header) {
  const text = cleanSource(source);
  const max = /max_vertices\s*=\s*(\d+)/.exec(text);
  const maxVertices = max ? Number(max[1]) : 6;
  let body = text.replace(/^[ \t]*layout\s*\([^)]*\)\s*(in|out)\s*;[^\n]*$/gm, "");
  const outputs = [];
  for (const item of topLevel(tokenize(body))) {
    if (item.kind !== "decl") continue;
    const declaration = readDeclaration(item.tokens);
    if (!declaration?.qualifiers.includes("out")) continue;
    for (const d of declaration.declarators) outputs.push({ type: declaration.type, name: d.name, flat: declaration.qualifiers.includes("flat") });
  }
  const names = new Set(outputs.map((output) => output.name));
  const tokens = tokenize(body);
  for (const token of tokens) {
    if (token.type !== "ident") continue;
    if (names.has(token.text)) token.text = `sl_g_${token.text}`;
    else if (token.text === "gl_Position") token.text = "sl_g_Position";
    else if (token.text === "EmitVertex") token.text = "sl_emit";
    else if (token.text === "EndPrimitive") token.text = "sl_end";
    else if (token.text === "main") token.text = "sl_geometry";
  }
  body = tokens.map((token) => token.text).join("")
    .replace(/^([ \t]*)(flat\s+|smooth\s+|noperspective\s+)?out\s+/gm, "$1");
  const all = [{ type: "vec4", name: "Position" }, ...outputs.map((output) => ({ ...output, name: output.name }))];
  const varName = (prefix, output) => (output.name === "Position" ? `${prefix}Position` : `${prefix}${output.name}`);
  const copy = (to, from) => all.map((output) => `${varName(to, output)} = ${varName(from, output)};`).join(" ");
  const zero = (type) => (type === "float" || type === "int" || type === "uint" ? `${type}(0)` : `${type}(0)`);
  const emulation = `
${all.map((output) => `${output.type} ${varName("sl_h0_", output)}, ${varName("sl_h1_", output)}, ${varName("sl_c_", output)};`).join("\n")}
int sl_target;
int sl_corner;
int sl_strip = 0;
int sl_triangle = 0;
bool sl_found = false;
void sl_emit() {
  if (sl_found) return;
  if (sl_strip >= 2) {
    if (sl_triangle == sl_target) {
      if (sl_corner == 0) { ${copy("sl_c_", "sl_h0_")} }
      else if (sl_corner == 1) { ${copy("sl_c_", "sl_h1_")} }
      else { ${copy("sl_c_", "sl_g_")} }
      sl_found = true;
    }
    sl_triangle += 1;
  }
  ${copy("sl_h0_", "sl_h1_")}
  ${copy("sl_h1_", "sl_g_")}
  sl_strip += 1;
}
void sl_end() { sl_strip = 0; }
void main() {
  sl_target = gl_VertexID / 3;
  sl_corner = gl_VertexID - sl_target * 3;
  sl_geometry();
  if (sl_found) {
    gl_Position = sl_c_Position;
    ${outputs.map((output) => `${output.name} = sl_c_${output.name};`).join("\n    ")}
  } else {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    ${outputs.map((output) => `${output.name} = ${zero(output.type)};`).join("\n    ")}
  }
}
`;
  const declarations = [
    "vec4 sl_g_Position;",
    ...outputs.map((output) => `${output.flat ? "flat " : ""}out ${output.type} ${output.name};`),
    "void sl_emit();",
    "void sl_end();",
    "#define iGeomIter (float(gl_InstanceID))"
  ].join("\n");
  const triangles = geometryTriangles(text, maxVertices);
  return {
    code: finish(`${ES_HEADER}${header}${declarations}\n${body}\n${emulation}`),
    vertices: triangles * 3
  };
}

export function buildMusicVisualizer(root) {
  const presets = [];
  const failed = [];
  const base = [join(root, "src", "shaders"), join(root, "shaders"), root].find((folder) => existsSync(folder)
    && readdirSync(folder).some((entry) => entry.endsWith(".frag") || existsSync(join(folder, entry, "image.frag"))));
  if (!base) return { presets, failed };
  const folders = [{ name: "default", path: base },
    ...readdirSync(base).filter((entry) => statSync(join(base, entry)).isDirectory()).sort().map((entry) => ({ name: entry, path: join(base, entry) }))];
  for (const folder of folders) {
    if (!existsSync(join(folder.path, "image.frag"))) continue;
    try {
      const configPath = join(folder.path, "shader.json");
      const config = existsSync(configPath) ? parseLooseJson(readText(configPath)) : {};
      const advanced = config.shader_mode === "advanced";
      let buffers;
      let order;
      if (advanced) {
        const declared = Object.entries(config.buffers ?? {});
        buffers = declared.map(([name, options]) => ({
          name,
          iterations: Math.max(1, Number.parseInt(options?.geom_iters ?? 1, 10) || 1),
          clear: Array.isArray(options?.clear_color) ? options.clear_color.slice(0, 3).map(Number) : [0, 0, 0],
          size: Array.isArray(options?.size) ? options.size.slice(0, 2).map(Number) : null
        }));
        const named = Array.isArray(config.render_order) ? config.render_order : buffers.map((buffer) => buffer.name);
        order = named.map((name) => buffers.findIndex((buffer) => buffer.name === name));
        if (order.some((index) => index < 0)) throw new Error("render_order names an unknown buffer");
        // Buffers never rendered are dropped, as music_visualizer drops them.
        const used = [...new Set(order)];
        buffers = used.map((index) => buffers[index]);
        order = order.map((index) => used.indexOf(index));
      } else {
        buffers = readdirSync(folder.path).filter((entry) => entry.toLowerCase().endsWith(".frag") && entry.slice(0, -5) !== "image")
          .map((entry) => entry.slice(0, -5)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
          .map((name) => ({ name, iterations: 1, clear: [0, 0, 0], size: null }));
        order = buffers.map((_, index) => index);
      }
      const image = {
        name: "image",
        iterations: advanced ? Math.max(1, Number.parseInt(config.image?.geom_iters ?? 1, 10) || 1) : 1,
        clear: advanced && Array.isArray(config.image?.clear_color) ? config.image.clear_color.slice(0, 3).map(Number) : [0, 0, 0],
        size: null
      };
      const uniforms = {};
      for (const [name, value] of Object.entries(config.uniforms ?? {})) {
        const values = (Array.isArray(value) ? value : [value]).map(Number).filter(Number.isFinite).slice(0, 4);
        if (values.length) uniforms[name] = values;
      }
      const names = buffers.map((buffer) => buffer.name);
      const header = mvHeader(names, uniforms);
      const blend = advanced && config.blend === true;
      const all = [...buffers, image];
      const passFor = (buffer, draw) => {
        const fragmentSource = readText(join(folder.path, `${buffer.name}.frag`));
        const wrapped = /\bmainImage\b/.test(fragmentSource)
          ? `${fragmentSource}\nout vec4 sl_fragColor;\nvoid main() { mainImage(sl_fragColor, gl_FragCoord.xy); }\n` : fragmentSource;
        const fragment = convertStage(wrapped, { header, oneD: MV_SAMPLERS }).code;
        const geometryPath = join(folder.path, `${buffer.name}.geom`);
        let vertex;
        let geometry;
        if (existsSync(geometryPath)) {
          const emulated = geometryToVertex(twoDimensional(readText(geometryPath), MV_SAMPLERS), header);
          vertex = emulated.code;
          geometry = { type: "instanced", mode: "Triangles", vertices: emulated.vertices, instances: buffer.iterations };
        } else {
          vertex = finish(`${ES_HEADER}${header}${MV_QUAD}`);
          geometry = { type: "instanced", mode: "TriangleStrip", vertices: 4, instances: buffer.iterations };
        }
        return {
          draw,
          inputs: names.map((name, index) => ({ uniform: `i${name}`, buffer: index, latest: true })),
          vertex,
          fragment,
          defaults: {},
          geometry,
          uniforms: {},
          clear: [...buffer.clear, 1],
          size: buffer.size,
          iterations: buffer.iterations
        };
      };
      const passes = [...order.map((index) => passFor(buffers[index], index)), passFor(image, buffers.length)];
      const audioOptions = { fft_sync: true, xcorr_sync: true, fft_smooth: 1, wave_smooth: 0.8, ...(config.audio_options ?? {}) };
      presets.push({
        id: `mv/${folder.name}`,
        source: "mv",
        kind: "viz",
        group: "mv",
        name: folder.name === "default" ? "Default" : prettyName(folder.name),
        file: folder.name,
        authors: ["bradleybauer"],
        byline: "music_visualizer by Bradley Bauer",
        description: "",
        audio: true,
        program: {
          passes,
          buffers: all.length,
          previous: [],
          output: buffers.length,
          swap: "draw",
          blend,
          limit: 0,
          uniforms: {},
          mvUniforms: uniforms,
          mvAudio: {
            fftSync: audioOptions.fft_sync !== false,
            xcorrSync: audioOptions.xcorr_sync !== false,
            fftSmooth: Number(audioOptions.fft_smooth ?? 1),
            waveSmooth: Number(audioOptions.wave_smooth ?? 0.8)
          },
          textures: [],
          audio: []
        }
      });
    } catch (error) {
      failed.push(`music_visualizer/${folder.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { presets, failed };
}

// ---------------------------------------------------------------------------------------------
// Assets

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** Image and video files the volts content names, if the owner put its textures/ folder there too. */
function textureFiles(root, presets) {
  const folder = join(root, "textures");
  if (!existsSync(folder)) return new Map();
  const wanted = new Set(presets.flatMap((preset) => preset.program.textures.flatMap((texture) => texture.files)));
  const found = new Map();
  for (const name of wanted) {
    const path = findFile([folder], name, "");
    if (path && /\.(png|jpe?g|webp|mp4|webm)$/i.test(path)) found.set(name, path);
  }
  return found;
}

/**
 * What a preset needs and the build lacks: a video or a picture that is not one of Shadertoy's
 * (those have stand-ins, textures.ts) and was not supplied; a cube map always has a stand-in.
 * Mirrors TextureBank.available.
 */
export function missingTextures(program, images) {
  for (const texture of program.textures) {
    if (texture.cube) continue;
    if (texture.video) {
      if (!texture.files.some((file) => images[file] !== undefined)) return "a video";
      continue;
    }
    if (!texture.files.some((file) => images[file] !== undefined || /^shadertoy\s/i.test(file))) return "pictures";
  }
  return null;
}

/**
 * Everything the plugin serves: the virtual module's value and the files. `prefix` is where the
 * files go in the build (assets/shaders/), `base` the site's base URL.
 */
export function buildCatalog({ directory, prefix, base, logger }) {
  const volts = join(directory, "volts-laboratory");
  const mv = join(directory, "music_visualizer");
  const started = performance.now();
  const warnings = [];
  const voltsResult = existsSync(volts) ? buildVolts(volts, (message) => warnings.push(message)) : { presets: [], crossfades: [], failed: [] };
  const mvResult = existsSync(mv) ? buildMusicVisualizer(mv) : { presets: [], failed: [] };
  const presets = [...voltsResult.presets, ...mvResult.presets];
  const failed = [...voltsResult.failed, ...mvResult.failed];
  const files = new Map();
  if (!presets.length) return { info: null, files, failed, warnings };
  // Images and videos, when present: hashed files of their own, referenced by name.
  const images = {};
  for (const [name, path] of textureFiles(volts, voltsResult.presets)) {
    const data = readFileSync(path);
    const fileName = `${prefix}textures/${hash(data).slice(0, 12)}${extname(path).toLowerCase()}`;
    files.set(fileName, data);
    images[name] = `${base}${fileName}`;
  }
  const entries = [];
  for (const preset of presets) {
    const { program, ...meta } = preset;
    const source = JSON.stringify(program);
    const fileName = `${prefix}${hash(source).slice(0, 12)}.json`;
    files.set(fileName, source);
    const missing = missingTextures(program, images);
    if (missing) warnings.push(`${preset.id}: left out of the list, it needs ${missing} the build does not have`);
    entries.push({ ...meta, url: `${base}${fileName}`, multipass: program.passes.length > 1, ...(missing ? { missing } : {}) });
  }
  let crossfades = null;
  if (voltsResult.crossfades.length) {
    const source = JSON.stringify(voltsResult.crossfades);
    const fileName = `${prefix}crossfades-${hash(source).slice(0, 12)}.json`;
    files.set(fileName, source);
    crossfades = `${base}${fileName}`;
  }
  const index = JSON.stringify({ presets: entries, crossfades, images });
  const indexName = `${prefix}index-${hash(index).slice(0, 12)}.json`;
  files.set(indexName, index);
  const count = (source, kind) => presets.filter((preset) => preset.source === source && preset.kind === kind).length;
  logger?.info(`Shaders: Monkey Hi Hat ${count("volts", "viz")} visualizers, ${count("volts", "fx")} effects, `
    + `${voltsResult.crossfades.length} crossfades; music_visualizer ${count("mv", "viz")}`
    + `${failed.length ? ` (${failed.length} left out)` : ""} — ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return {
    info: { index: `${base}${indexName}`, count: presets.length, sources: [...new Set(presets.map((preset) => preset.source))] },
    files,
    failed,
    warnings
  };
}

export function shaderVisualizers(options) {
  let settings = null;
  let result = null;
  const prepare = () => {
    if (result) return result;
    try {
      result = buildCatalog(settings);
    } catch (error) {
      settings.logger.warn(`Shaders: left out — ${error instanceof Error ? error.message : String(error)}`);
      result = { info: null, files: new Map(), failed: [], warnings: [] };
    }
    // Written every time, empty when nothing was left out: an old list must not outlive its cause.
    const lines = [...result.failed, ...result.warnings.map((line) => `(warning) ${line}`)];
    mkdirSync(settings.cacheDirectory, { recursive: true });
    writeFileSync(join(settings.cacheDirectory, "failed.txt"), lines.length ? `${lines.join("\n")}\n` : "");
    if (result.failed.length) {
      settings.logger.info(`Shaders: why — ${relative(process.cwd(), join(settings.cacheDirectory, "failed.txt"))}`);
    }
    return result;
  };
  return {
    name: "tryhackx-shader-visualizers",
    config() {
      const folder = options.directory.replace(/\\/g, "/").replace(/\/+$/, "");
      return { server: { watch: { ignored: [isAbsolute(options.directory) ? `${folder}/**` : `**/${folder}/**`] } } };
    },
    configResolved(config) {
      settings = {
        directory: isAbsolute(options.directory) ? options.directory : join(config.root, options.directory),
        cacheDirectory: join(config.root, "node_modules", ".cache", "shader-visualizers"),
        prefix: `${config.build.assetsDir}/shaders/`,
        base: config.base,
        logger: config.logger
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
      return `export default ${JSON.stringify(prepare().info)};`;
    },
    // Beside the bundle rather than in it, as the MilkDrop packs are: a few hundred files would
    // fill Vite's report line by line.
    writeBundle(output) {
      const directory = output.dir ?? dirname(output.file ?? "");
      for (const [fileName, source] of prepare().files) {
        const target = join(directory, fileName);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        if (!settings || !path.startsWith(`${settings.base}${settings.prefix}`)) return next();
        const source = prepare().files.get(path.slice(settings.base.length));
        if (source === undefined) return next();
        response.setHeader("Content-Type", path.endsWith(".json") ? "application/json; charset=utf-8"
          : path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp"
            : path.endsWith(".mp4") ? "video/mp4" : path.endsWith(".webm") ? "video/webm" : "image/jpeg");
        return response.end(source);
      });
    }
  };
}
