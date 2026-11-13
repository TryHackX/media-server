/**
 * One MilkDrop preset (.milk text) as the JSON butterchurn 3 plays with
 * `onlyUseWASM`: the base values that differ from the defaults, the equations
 * as EEL source (butterchurn compiles them to WebAssembly in the browser) and
 * the warp and composite shaders translated to GLSL.
 *
 * It is built from the parts of jberg's milkdrop-preset-converter (MIT) rather
 * than the package itself. Its `convertPreset` writes the equations as
 * JavaScript (`*_eqs_str`), which butterchurn would run through `new Function`
 * — refused by this site's CSP, and by onlyUseWASM; and its `convertShader`,
 * three steps over hlslparser-js and milkdrop-preset-utils, loses every global
 * `int` in its last step. So: milkdrop-preset-utils' `splitPreset` reads the
 * file, the equations stay EEL, and `hlslToGlsl` below takes convertShader's
 * three steps itself — on the shader milkdrop-hlsl.mjs rewrote around the
 * translator's own bug, and with that last step mended. (The hlslparser-js
 * the converter bundles gives the same GLSL, byte for byte, as the package.)
 *
 * Run as a worker (by milkdrop-presets.mjs) it converts presets one at a time
 * and reports each one back; the conversion is the slow part of a first build.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { translateEel } from "../src/shared/visualizations/milkdrop-eel.ts";
import { eelCompilerModule, patchedButterchurnSource } from "./butterchurn-patches.mjs";
import { FMOD, logicalOperators, rewriteShader, RewriteError, withFmod } from "./milkdrop-hlsl.mjs";
import { applyConversions } from "./shader-glsl-types.mjs";

const require = createRequire(import.meta.url);

/** The translator's parts, and their versions — which are part of every cache key. */
export function loadConverter() {
  return {
    hlslparser: require("hlslparser-js"),
    utils: require("milkdrop-preset-utils"),
    version: `hlslparser-js ${require("hlslparser-js/package.json").version}, milkdrop-preset-utils ${require("milkdrop-preset-utils/package.json").version}`
  };
}

/**
 * HLSL to GLSL as milkdrop-preset-converter's convertShader does it: the
 * prelude MilkDrop's shaders expect, hlslparser-js, and the clean-up for
 * butterchurn — which drops every line beginning with "in", meant for `in`
 * declarations; `int` ones went with them, so they are kept aside first.
 * Null when hlslparser cannot read the shader.
 */
export async function hlslToGlsl(source, { hlslparser, utils }) {
  const prepared = utils.prepareShader(source).replace("float4 shader_body (", "float4 main_shader_sentinel (");
  const raw = await hlslparser.convertHLSLShader(prepared, "main_shader_sentinel", "fs");
  if (!raw || /parsing failed/.test(raw)) return null;
  return utils.processUnOptimizedShader(raw.replace(/^(?=in(?:t|out|variant)\b)/gm, "\u0001")).replace(/\u0001/g, "");
}

/** Equations without comments and blank lines: butterchurn's EEL compiler skips them anyway. */
export function compactEel(source) {
  return String(source ?? "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/**
 * hlslparser puts the same few helper functions in front of every shader,
 * used or not — about 1.4 kB each time. The unused ones go, as does the
 * indentation.
 */
const HELPER = /^\s*\w+\s+((?:matrix_row|matrix_ctor|matrix_mul|m_scalar_swizzle[234]|bvecTernary|sincos|clip|tex[23]D(?:lod|bias|grad|proj|size|fetch|gather|cmp)|texCUBE(?:lod|bias))\d*)\s*\(.*\}\s*$/;

export function compactGlsl(source) {
  const lines = source.split("\n");
  const helpers = new Map();
  lines.forEach((line, index) => {
    const name = HELPER.exec(line)?.[1];
    if (name) helpers.set(index, name);
  });
  const names = [...new Set(helpers.values())];
  const calls = (text) => names.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
  // Used by the shader, or by a helper the shader uses.
  const used = new Set(calls(lines.filter((_, index) => !helpers.has(index)).join("\n")));
  for (let grown = true; grown;) {
    grown = false;
    for (const [index, name] of helpers) {
      if (!used.has(name)) continue;
      for (const callee of calls(lines[index].replace(new RegExp(`\\b${name}\\b`), ""))) {
        if (!used.has(callee)) {
          used.add(callee);
          grown = true;
        }
      }
    }
  }
  return lines
    .filter((line, index) => !helpers.has(index) || used.has(helpers.get(index)))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * What butterchurn 3 declares inside main() of each shader, where hlslparser's
 * function for the preset's code cannot see it: in the unoptimised GLSL the
 * code sits in `main_shader_sentinel(uv)`, and a preset that reads rad, ang,
 * uv_orig or hue_shader fails to compile. (butterchurn-presets' own
 * conversions were optimised, which inlines that function.) The values are
 * passed in instead.
 */
const PIXEL_VALUES = {
  warp: [["vec2", "uv_orig"], ["float", "rad"], ["float", "ang"]],
  comp: [["vec2", "uv_orig"], ["float", "rad"], ["float", "ang"], ["vec3", "hue_shader"]]
};
const SENTINEL = /vec4\s+main_shader_sentinel\s*\(\s*vec2\s+uv\s*\)\s*\{/g;
const SENTINEL_CALL = /main_shader_sentinel\s*\(\s*uv\s*\)/g;

/**
 * butterchurn's uniforms (its shader templates, 3.0.0-beta.5) and their types.
 * HLSL lets a shader write to them — the write stays within that pixel — and
 * GLSL does not, so a shader that writes one gets a copy of its own. q1–q32
 * are #defines over _qa–_qh there.
 */
const UNIFORMS = {
  time: "float", decay: "float", resolution: "vec2", aspect: "vec4", texsize: "vec4",
  texsize_noise_lq: "vec4", texsize_noise_mq: "vec4", texsize_noise_hq: "vec4", texsize_noise_lq_lite: "vec4",
  texsize_noisevol_lq: "vec4", texsize_noisevol_hq: "vec4",
  bass: "float", mid: "float", treb: "float", vol: "float", bass_att: "float", mid_att: "float", treb_att: "float", vol_att: "float",
  frame: "float", fps: "float",
  _qa: "vec4", _qb: "vec4", _qc: "vec4", _qd: "vec4", _qe: "vec4", _qf: "vec4", _qg: "vec4", _qh: "vec4",
  slow_roam_cos: "vec4", roam_cos: "vec4", slow_roam_sin: "vec4", roam_sin: "vec4",
  blur1_min: "float", blur1_max: "float", blur2_min: "float", blur2_max: "float", blur3_min: "float", blur3_max: "float",
  scale1: "float", scale2: "float", scale3: "float", bias1: "float", bias2: "float", bias3: "float",
  rand_frame: "vec4", rand_preset: "vec4",
  // What the patched butterchurn adds (butterchurn-patches.mjs), declared by beatdropShaderNames.
  _qi: "vec4", _qj: "vec4", _qk: "vec4", _ql: "vec4", _qm: "vec4", _qn: "vec4", _qo: "vec4", _qp: "vec4",
  mouse: "vec4", sysTime: "vec4", sysDate: "vec4", progress: "float",
  ...Object.fromEntries(["s", "d", "f", "vf", "uf", "rand"].flatMap((speed) => [1, 2, 3, 4].map((index) => [`rot_${speed}${index}`, "mat3x4"])))
};
const Q_VECTORS = ["_qa", "_qb", "_qc", "_qd", "_qe", "_qf", "_qg", "_qh"];

/**
 * An assignment to `name` — `name =`, `(name).xy +=`, `name++` — not a
 * comparison, and not a declaration of a variable of that name.
 */
function writes(code, name) {
  const declared = "(?<!\\b(?:float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?)\\s+)";
  return new RegExp(`${declared}\\b${name}\\b\\)?(?:\\s*\\.\\s*[xyzwrgba]{1,4})?\\s*(?:[-+*/]?=(?!=)|\\+\\+|--)`).test(code)
    || new RegExp(`(?:\\+\\+|--)\\s*\\(?${name}\\b`).test(code);
}

/** The uniforms a shader's code writes to (decay exists in the warp shader only). */
export function writtenUniforms(code, kind) {
  const written = new Set(Object.keys(UNIFORMS).filter((name) => (kind === "warp" || name !== "decay") && writes(code, name)));
  for (let q = 1; q <= 32; q += 1) if (writes(code, `q${q}`)) written.add(Q_VECTORS[(q - 1) >> 2]);
  return [...written];
}

function topLevelComma(text) {
  let depth = 0;
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) return true;
  }
  return false;
}

const GLOBAL_DECLARATION = /^((?:(?:highp|mediump|lowp)\s+)?(?:float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?))\s+(\w+(?:\s*\[\s*\d+\s*\])?\s*=.+|\w+\s*,.+);$/;

/** A value that names something other than a type: a variable, a uniform, a function. */
const NAMES_A_VALUE = /\b(?!(?:float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?)\b)[A-Za-z_]\w*/;

/** `a = 1, b, c[2] = f(x)` into its declarators (name, array size, value), commas inside brackets left alone. */
function declarators(text) {
  const parts = [""];
  let depth = 0;
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += char;
  }
  return parts.map((part) => /^\s*(\w+)(\s*\[\s*\d+\s*\])?\s*(?:=\s*([\s\S]+?))?\s*$/.exec(part));
}

/**
 * A global's initial value must be a constant in GLSL ES; HLSL computes it,
 * from uniforms or functions, before the shader runs. The global keeps its
 * declaration and gets its value at the start of the shader's function — an
 * array of a given size too (GLSL ES 3 assigns arrays whole).
 * (`const` ones stay as they are: an array size may need them.)
 */
export function deferInitializers(header) {
  let depth = 0;
  const deferred = [];
  const lines = header.split("\n").map((line) => {
    const outside = depth === 0;
    depth += line.split("{").length - line.split("}").length;
    const match = outside ? GLOBAL_DECLARATION.exec(line) : null;
    const parts = match ? declarators(match[2]) : [];
    // Anything else — a declarator it cannot read, an array of constants (which GLSL ES takes
    // where it is) — stays as it was.
    if (!match || parts.some((part) => !part) || !parts.some((part) => part[3] !== undefined)
      || parts.some((part) => part[2] && part[3] !== undefined && !NAMES_A_VALUE.test(part[3]))) return line;
    for (const part of parts) if (part[3] !== undefined) deferred.push(`${part[1]} = ${part[3]};`);
    return `${match[1]} ${parts.map((part) => `${part[1]}${part[2] ?? ""}`).join(", ")};`;
  });
  return { header: lines.join("\n"), deferred };
}

/**
 * The GLSL fitted into butterchurn's shader template: the per-pixel values
 * handed to the preset's function — its body one block deeper, so that a
 * preset declaring a `rad` of its own still may — copies of the uniforms it
 * writes to and the values of its globals set there too, and the textures a
 * preset declares (`sampler2D sampler_clouds;`) made the uniforms GLSL needs
 * them to be.
 */
export function fitButterchurn(glsl, kind) {
  const values = PIXEL_VALUES[kind];
  const body = glsl.indexOf("shader_body");
  const end = glsl.lastIndexOf("}", body);
  const start = glsl.search(SENTINEL);
  // The function must be the last thing before shader_body, its braces closing where it ends.
  const inner = start >= 0 && end > start ? glsl.slice(start, end + 1) : "";
  if (!values || (glsl.match(SENTINEL) ?? []).length !== 1 || (glsl.match(SENTINEL_CALL) ?? []).length !== 1
    || !inner || inner.split("{").length !== inner.split("}").length) {
    throw new Error("unexpected shader translation");
  }
  const parameters = values.map(([type, name]) => `${type} ${name}`).join(", ");
  const names = values.map(([, name]) => name).join(", ");
  const { header, deferred } = deferInitializers(glsl.slice(0, start));
  // At the function's own level, outside the preset's block, so that the
  // preset may still declare a `time` of its own.
  const setup = [...writtenUniforms(inner, kind).map((name) => `${UNIFORMS[name]} ${name} = ${name};`), ...deferred];
  const fitted = `${header}${glsl.slice(start, end)}}\n${glsl.slice(end)}`
    .replace(SENTINEL, `vec4 main_shader_sentinel(vec2 uv, ${parameters}) {\n${setup.map((line) => `${line}\n`).join("")}{`)
    .replace(SENTINEL_CALL, `main_shader_sentinel(uv, ${names})`);
  return samplerUniforms(fitted)
    // `sampler sampler_x = sampler_state { … }` comes out as a constructor of
    // nothing; it is a texture like any other (its addressing is butterchurn's).
    .replace(/^(sampler(?:2D|3D|Cube))\s+(sampler_\w+)\s*=\s*\1\s*\(.*\);$/gm, "uniform $1 $2;")
    // HLSL's `%` on floats comes out as int arithmetic — `(int (frame) % 7)` —
    // while the number it is compared with stays a float, `== float (0)`,
    // which GLSL will not compare with an int.
    .replace(/(%\s*\d+\s*\))(\s*(?:==|!=|<=|>=|<|>)\s*)float\s*\(\s*(\d+)\s*\)/g, "$1$2$3");
}

/**
 * The textures a translated shader declares, as the uniforms GLSL needs them to be, with
 * MilkDrop's names: one declaration a sampler (`sampler a, b;` declares two), the `sampler_`
 * prefix added where the preset left it out — MilkDrop takes the name either way, also when a
 * `#define` gave it (plugin.cpp, CacheParams) — and none for a sampler butterchurn's template
 * declares itself (`sampler noise_lq;` reads its noise texture).
 */
function samplerUniforms(glsl) {
  const renames = new Map();
  let text = glsl.replace(/^(?:uniform\s+)?(sampler(?:2D|3D|Cube))\s+(\w+(?:\s*,\s*\w+)*)\s*;$/gm, (_, type, list) => list.split(",")
    .map((raw) => raw.trim())
    .map((raw) => {
      // `sampler main;` (MilkDrop's previous frame) comes out of hlslparser as main0: GLSL's main is the entry point.
      const name = /^sampler_/.test(raw) ? raw : raw === "main0" ? "sampler_main" : `sampler_${raw}`;
      if (name !== raw) renames.set(raw, name);
      return DECLARED_SAMPLERS.has(name.slice("sampler_".length)) ? "" : `uniform ${type} ${name};`;
    })
    .filter(Boolean)
    .join("\n"));
  for (const [from, to] of renames) text = text.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  return text;
}

/**
 * hlslparser reads a row of a matrix (`rot_f3[0]`) with its helper `matrix_row0`, which it
 * defines for square matrices only; MilkDrop's rot_* are float4x3 (GLSL mat3x4).
 */
function matrixRowHelpers(glsl) {
  if (!/\bmatrix_row0\s*\(/.test(glsl) || !/\bmat3x4\b/.test(glsl) || /vec3\s+matrix_row0\s*\(\s*mat3x4/.test(glsl)) return glsl;
  return `vec3 matrix_row0(mat3x4 m, int i) { return vec3(m[0][i], m[1][i], m[2][i]); }\n${glsl}`;
}

const RETURNING_FUNCTION = /^(float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?)\s+\w+\s*\([^;{}]*\)\s*\{/;

/** The index of the `)` closing the `(` at `start` of a text, or -1. */
function closingParenthesis(text, start) {
  for (let index = start, depth = 0; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

/** Arguments of a call, split at the commas no bracket encloses. */
function callArguments(text) {
  const parts = [""];
  let depth = 0;
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += char;
  }
  return parts;
}

/**
 * What GLSL ES rejects in hlslparser's output where MilkDrop's compiler took the HLSL:
 *   - a function with no return at all: D3DX compiles only the functions a shader calls, so
 *     such a function is never called; it returns 0 here;
 *   - `saturate(!x)`, which comes out as clamp() of a bool (the bool is made a float);
 *   - an `out` argument of sincos() inside a conversion, `sincos0(rot, float (s), c)` for a
 *     float3 s (GLSL cannot write through a conversion; the types match without it);
 *   - a row of a matrix assigned to, `rot[0] = float2(…)`, which comes out as an assignment to
 *     the result of matrix_row0(); the row is written element by element instead.
 */
export function mendGlsl(glsl) {
  const lines = glsl.split("\n");
  let depth = 0;
  let open = null;
  lines.forEach((line, index) => {
    if (depth === 0 && !open) {
      const type = RETURNING_FUNCTION.exec(line)?.[1];
      if (type) open = { type, returns: false };
    }
    if (open && /\breturn\b/.test(line)) open.returns = true;
    depth += line.split("{").length - line.split("}").length;
    if (open && depth === 0) {
      const at = line.lastIndexOf("}");
      if (!open.returns && at >= 0) lines[index] = `${line.slice(0, at)}return ${open.type}(0);\n${line.slice(at)}`;
      open = null;
    }
  });
  let text = lines.join("\n");
  for (let at = text.indexOf("clamp((!"); at >= 0; at = text.indexOf("clamp((!", at + 1)) {
    const start = at + "clamp(".length;
    const close = closingParenthesis(text, start);
    if (close > 0 && text[close + 1] === ",") text = `${text.slice(0, start)}float${text.slice(start)}`;
  }
  text = text.replace(/^sincos0\((.*)\);$/gm, (call, list) => {
    const parts = callArguments(list);
    if (parts.length !== 3) return call;
    return `sincos0(${parts.map((part, index) => (index ? part.replace(/^\s*(?:float|[biu]?vec[234])\s*\(\s*(\w+)\s*\)\s*$/, " $1") : part)).join(",")});`;
  });
  return text.replace(/^\(matrix_row0\((\w+),\s*(\w+)\) = (.*)\);$/gm, (statement, name, row, value, offset) => {
    const declared = [...text.slice(0, offset).matchAll(new RegExp(`\\bmat([234])(?:x[234])?\\s+(?:\\w+\\s*,\\s*)*${name}\\b`, "g"))].at(-1);
    if (!declared) return statement;
    const columns = Number(declared[1]);
    const elements = Array.from({ length: columns }, (_, column) => `${name}[${column}][${row}] = md_row.${"xyzw"[column]};`);
    return `{ vec${columns} md_row = ${value}; ${elements.join(" ")} }`;
  });
}

/** The samplers butterchurn's template declares, and the ones that a MilkDrop prefix may stand in front of. */
const DECLARED_SAMPLERS = new Set([
  "main", "fw_main", "fc_main", "pw_main", "pc_main", "blur1", "blur2", "blur3",
  "noise_lq", "noise_lq_lite", "noise_mq", "noise_hq", "pw_noise_lq", "noisevol_lq", "noisevol_hq"
]);
const BUILTIN_ROOTS = new Set(["main", "blur1", "blur2", "blur3", "noise_lq", "noise_lq_lite", "noise_mq", "noise_hq", "noisevol_lq", "noisevol_hq"]);
/** MilkDrop's filtering-and-wrapping prefixes; it reads them either way round. */
const SAMPLER_MODES = { fw: "fw", wf: "fw", fc: "fc", cf: "fc", pw: "pw", wp: "pw", pc: "pc", cp: "pc" };

/**
 * MilkDrop's own textures under a prefix butterchurn does not declare —
 * `sampler_fw_noise_hq`, `sampler_pw_noisevol_hq` — would be taken for a
 * texture of the preset's, and get clouds2 (or, declared as a plain `sampler`
 * and read with tex3D, not translate at all; prepareShader also drops the
 * declaration of `sampler_pw_noise_hq` without declaring it). They are read
 * from butterchurn's texture of that name instead: the prefix only asked for
 * a filtering and wrapping, which butterchurn's noise textures have near enough.
 */
export function builtinSamplers(source) {
  let text = String(source ?? "");
  const seen = new Set();
  for (const [name, prefix, rest] of text.matchAll(/\bsampler_([A-Za-z]{2})_(\w+)\b/g)) {
    const mode = SAMPLER_MODES[prefix.toLowerCase()];
    const root = rest.toLowerCase();
    if (!mode || !BUILTIN_ROOTS.has(root) || seen.has(name)) continue;
    seen.add(name);
    const target = DECLARED_SAMPLERS.has(`${mode}_${root}`) ? `sampler_${mode}_${root}` : `sampler_${root}`;
    if (target === name) continue;
    text = text
      .replace(new RegExp(`(?:\\buniform\\s+)?\\bsampler(?:2D|3D|CUBE)?\\s+${name}\\s*;`, "g"), "")
      .replace(new RegExp(`\\b${name}\\b`, "g"), target);
  }
  return text;
}

const VECTORS = ["float", "float2", "float3", "float4"];

/**
 * HLSL intrinsics hlslparser-js does not know — round(), tanh(), log10(),
 * distance(), refract(), all() — as functions of the shader's own, which it
 * translates like any other: round() alone kept 85 presets of the packs out.
 * (An exact half rounds up here, where HLSL rounds it to the even number.)
 */
const INTRINSICS = {
  round: () => VECTORS.map((type) => `${type} hlsl_round(${type} x) { return floor(x + 0.5); }`),
  tanh: () => VECTORS.map((type) => `${type} hlsl_tanh(${type} x) { ${type} e = exp(-2.0 * abs(x)); return sign(x) * (1.0 - e) / (1.0 + e); }`),
  log10: () => VECTORS.map((type) => `${type} hlsl_log10(${type} x) { return log(x) * 0.4342944819; }`),
  distance: () => VECTORS.map((type) => `float hlsl_distance(${type} a, ${type} b) { return ${type === "float" ? "abs(a - b)" : "length(a - b)"}; }`),
  // GLSL's refract: zero where the ray is reflected entirely.
  refract: () => VECTORS.slice(1).map((type) => `${type} hlsl_refract(${type} i, ${type} n, float eta) { float d = dot(n, i); float k = 1.0 - eta * eta * (1.0 - d * d); return (eta * i - (eta * d + sqrt(max(k, 0.0))) * n) * step(0.0, k); }`),
  all: () => [
    "bool hlsl_all(float x) { return x != 0.0; }",
    "bool hlsl_all(float2 x) { return min(abs(x.x), abs(x.y)) != 0.0; }",
    "bool hlsl_all(float3 x) { return min(min(abs(x.x), abs(x.y)), abs(x.z)) != 0.0; }",
    "bool hlsl_all(float4 x) { return min(min(abs(x.x), abs(x.y)), min(abs(x.z), abs(x.w))) != 0.0; }"
  ],
  // What fwidth is (HLSL and GLSL define it so); hlslparser knows ddx/ddy but not fwidth.
  fwidth: () => VECTORS.map((type) => `${type} hlsl_fwidth(${type} x) { return abs(ddx(x)) + abs(ddy(x)); }`),
  // fmod truncates; hlslparser's GLSL mod() floors. Defined with `%` by milkdrop-hlsl.mjs (withFmod).
  fmod: () => [],
  // HLSL's trunc (BeatDrop's include.fx has it as a macro of its own): toward zero.
  trunc: () => VECTORS.map((type) => `${type} hlsl_trunc(${type} x) { return sign(x) * floor(abs(x)); }`)
};

export function hlslIntrinsics(source) {
  let text = String(source ?? "");
  const helpers = [];
  for (const [name, definitions] of Object.entries(INTRINSICS)) {
    const call = new RegExp(`\\b${name}(?=\\s*\\()`, "g");
    // Not when the preset has a function or macro of that name itself.
    if (!call.test(withoutComments(text)) || new RegExp(`\\b(?:float|half|int|bool)[234]?\\s+${name}\\s*\\(|#\\s*define\\s+${name}\\b`).test(text)) continue;
    text = text.replace(call, name === "fmod" ? FMOD : `hlsl_${name}`);
    helpers.push(...definitions());
  }
  return helpers.length ? `${helpers.join("\n")}\n${text}` : text;
}

function withoutComments(text) {
  return String(text ?? "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

/** BeatDrop and MilkDrop 3 draw up to 16 custom shapes and 16 custom waves (MAX_CUSTOM_SHAPES, MAX_CUSTOM_WAVES). */
export const MAX_CUSTOM = 16;

/**
 * What even the patched butterchurn (butterchurn-patches.mjs) does not play — as the reasons a
 * preset is left out: custom shapes or waves past BeatDrop's and MilkDrop 3's 16 (MilkDrop
 * reads no more either). Empty for every preset of the packs.
 */
export function beyondMilkdrop2(source) {
  const reasons = [];
  for (const kind of ["wave", "shape"]) {
    const extra = [...source.matchAll(new RegExp(`^${kind}code_(\\d+)_enabled\\s*=\\s*(-?[\\d.]+)`, "gim"))]
      .some((match) => Number(match[1]) >= MAX_CUSTOM && Number(match[2]) !== 0);
    if (extra) reasons.push(`more than ${MAX_CUSTOM} custom ${kind}s`);
  }
  return reasons;
}

/** BeatDrop's and MilkDrop 3's simple waveforms, 0–17 (NUM_WAVES 18): the mode is taken modulo this. */
export const BEATDROP_WAVE_MODES = 18;

/**
 * Whether a preset counts its simple waveform the BeatDrop way (modulo 18: mode 8 is a spectrum
 * line, 9–17 BeatDrop's own) or MilkDrop 2's (modulo 8: 8 is mode 0). A pack made for BeatDrop
 * or MilkDrop 3 counts so; elsewhere a mode MilkDrop 2 never writes (9 or above) says so.
 */
export function beatdropWaveModes(parts, engine) {
  if (engine === "beatdrop" || engine === "milkdrop3") return true;
  const equations = [
    parts.presetInit, parts.perFrame, parts.perVertex,
    ...parts.shapes.flatMap((shape) => [shape.init_eqs_str, shape.frame_eqs_str]),
    ...parts.waves.flatMap((wave) => [wave.init_eqs_str, wave.frame_eqs_str, wave.point_eqs_str])
  ].map(compactEel).join("\n");
  const modes = [Number(parts.baseVals?.wave_mode ?? 0), ...[...equations.matchAll(/\bwave_mode\s*=\s*(\d+(?:\.\d*)?)/gi)].map((match) => Number(match[1]))];
  return modes.some((mode) => Math.floor(mode) >= 9);
}

/**
 * Shapes and waves 4–15 (BeatDrop, MilkDrop 3): milkdrop-preset-utils reads 0–3 only, so each
 * further one is read by it as number 0 — its lines renamed, nothing else changed.
 */
export function extraShapesAndWaves(text, utils) {
  const shapes = [];
  const waves = [];
  for (let index = 4; index < MAX_CUSTOM; index += 1) {
    for (const [kind, list, prefixes] of [["shape", shapes, ["shapecode", "shape"]], ["wave", waves, ["wavecode", "wave"]]]) {
      const pattern = new RegExp(`^(${prefixes.join("|")})_${index}_`, "i");
      const lines = text.split("\n").filter((line) => pattern.test(line)).map((line) => line.replace(pattern, "$1_0_"));
      list[index] = lines.length ? utils.splitPreset(`${lines.join("\n")}\n`)[`${kind}s`][0] : null;
    }
  }
  return { shapes, waves };
}

/**
 * BeatDrop's and MilkDrop 3's additions to MilkDrop 2's shader language (BeatDrop's
 * include.fx), told to the translator as plain declarations and macros. In the GLSL the
 * declarations become uniforms the patched butterchurn sets (q33–q64, rot_*, mouse, sysTime,
 * sysDate), and textures it keeps current (sampler_fft, sampler_wave). Only what a shader
 * uses is declared, and nothing a shader declares itself.
 */
const Q_EXTRA = Array.from({ length: 8 }, (_, index) => `_q${"ijklmnop"[index]}`);
const ROTATIONS = ["s", "d", "f", "vf", "uf", "rand"].flatMap((speed) => [1, 2, 3, 4].map((index) => `rot_${speed}${index}`));
const BEATDROP_MACROS = {
  aspect_sd: "aspect", // "screen dependent" mode off: the normal aspect
  mouse_x: "mouse.x", mouse_y: "mouse.y", mouse_pos: "mouse.xy", mouse_clicked: "mouse.z", mouse_released: "mouse.w",
  sysTimeHour: "sysTime.x", sysTimeMinute: "sysTime.y", sysTimeSecond: "sysTime.z", sysTimeTotalSeconds: "sysTime.w",
  sysDateYear: "sysDate.x", sysDateMonth: "sysDate.y", sysDateDay: "sysDate.z", sysDateWeekday: "sysDate.w",
  M_PI: "3.14159265359", M_PI_2: "6.28318530718", M_INV_PI_2: "0.159154943091895",
  // include.fx says so: the peak-hold row of sampler_fft is there (`#if HAS_FFT_PEAK`).
  HAS_FFT_PEAK: "1"
};
const FFT_FUNCTIONS = `sampler2D sampler_fft;
float get_fft(float pos) { return sqrt(tex2D(sampler_fft, float2(saturate(pos), 0.25)).x); }
float get_fft_hz(float freq) { return get_fft(freq / 22050.0); }
float get_fft_peak(float pos) { return sqrt(tex2D(sampler_fft, float2(saturate(pos), 0.75)).x); }
float get_fft_peak_hz(float freq) { return get_fft_peak(freq / 22050.0); }`;
const WAVE_FUNCTIONS = `sampler2D sampler_wave;
float get_wave_left(float pos) { return tex2D(sampler_wave, float2(saturate(pos), 0.25)).x; }
float get_wave_right(float pos) { return tex2D(sampler_wave, float2(saturate(pos), 0.75)).x; }
float get_wave(float pos) { return (get_wave_left(pos) + get_wave_right(pos)) * 0.5; }`;

const declares = (text, name) => new RegExp(`\\b(?:float[234]?(?:x[234])?|half[234]?|int|bool|sampler\\w*)\\s+${name}\\b|#\\s*define\\s+${name}\\b`).test(text);
const uses = (text, name) => new RegExp(`\\b${name}\\b`).test(text);

/** The source with what it uses of BeatDrop's and MilkDrop 2.1's names declared; and which uniforms that made. */
export function beatdropShaderNames(source) {
  const text = String(source ?? "");
  const plain = withoutComments(text);
  const lines = [];
  const uniforms = [];
  for (const [name, value] of Object.entries(BEATDROP_MACROS)) {
    if (uses(plain, name) && !declares(plain, name)) lines.push(`#define ${name} ${value}`);
  }
  const expanded = `${plain}\n${lines.join("\n")}`;
  for (let q = 33; q <= 64; q += 1) {
    if (uses(plain, `q${q}`) && !declares(plain, `q${q}`)) lines.push(`#define q${q} ${Q_EXTRA[(q - 33) >> 2]}.${"xyzw"[(q - 33) & 3]}`);
  }
  const withQ = `${expanded}\n${lines.join("\n")}`;
  for (const vector of Q_EXTRA) {
    if (uses(withQ, vector) && !declares(plain, vector)) {
      lines.push(`float4 ${vector};`);
      uniforms.push(["vec4", vector]);
    }
  }
  for (const name of ["mouse", "sysTime", "sysDate"]) {
    if (uses(withQ, name) && !declares(plain, name)) {
      lines.push(`float4 ${name};`);
      uniforms.push(["vec4", name]);
    }
  }
  // MilkDrop 2's own `progress` (_c2.w in its shader include), which butterchurn's templates lack.
  if (uses(withQ, "progress") && !declares(plain, "progress")) {
    lines.push("float progress;");
    uniforms.push(["float", "progress"]);
  }
  for (const name of ROTATIONS) {
    if (uses(plain, name) && !declares(plain, name)) {
      lines.push(`float4x3 ${name};`);
      uniforms.push(["mat3x4", name]);
    }
  }
  if (/\bget_fft\w*\s*\(/.test(plain) && !declares(plain, "get_fft")) lines.push(FFT_FUNCTIONS);
  if (/\bget_wave\w*\s*\(/.test(plain) && !declares(plain, "get_wave")) lines.push(WAVE_FUNCTIONS);
  return { source: lines.length ? `${lines.join("\n")}\n${text}` : text, uniforms };
}

/** The declarations beatdropShaderNames made, as uniforms in the GLSL (hlslparser writes them as plain globals). */
function asUniforms(glsl, uniforms) {
  let text = glsl;
  for (const [type, name] of uniforms) text = text.replace(new RegExp(`^${type}\\s+${name}\\s*;$`, "m"), `uniform ${type} ${name};`);
  return text;
}

/**
 * `tex3D()` on a texture of the preset's own, which is 2D (a JPEG, a random slot): D3DX
 * compiled it, as the sampler's type follows its use, and the volume lookup on a 2D texture
 * reads it at (u, v). hlslparser refuses the call; it is written as that 2D lookup. The noise
 * volumes, MilkDrop's only 3D textures, are left alone.
 */
export function flatTex3D(source) {
  let text = String(source ?? "");
  const call = /\btex3[dD]\s*\(\s*(sampler_\w+)\s*,/g;
  for (let match = call.exec(text); match; match = call.exec(text)) {
    if (/noisevol/i.test(match[1])) continue;
    // The coordinate: up to the `)` closing the call.
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < text.length; end += 1) {
      if (text[end] === "(" || text[end] === "[") depth += 1;
      else if (text[end] === ")" || text[end] === "]") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (end >= text.length) break;
    const coordinate = text.slice(match.index + match[0].length, end);
    // `(+…)`: a `(` followed by a constructor would be hlslparser's parenthesised constructor.
    const replacement = `tex2D(${match[1]}, (+(${coordinate.trim()})).xy`;
    text = `${text.slice(0, match.index)}${replacement}${text.slice(end)}`;
    call.lastIndex = match.index + replacement.length;
  }
  return text;
}

/**
 * A sampler declared without the `sampler_` prefix (`sampler rand00;`): MilkDrop takes the
 * texture's name from it all the same — it only strips the prefix when there is one
 * (plugin.cpp, CacheParams) — while butterchurn binds `sampler_<name>`. It gets the prefix,
 * in its declaration and wherever the shader reads it.
 */
export function prefixedSamplers(source) {
  let text = String(source ?? "");
  const names = new Set();
  for (const [, name] of withoutComments(text).matchAll(/\bsampler(?:2D|3D|CUBE|Cube)?\s+([A-Za-z_]\w*)\s*[;=]/g)) {
    if (!/^sampler_/i.test(name)) names.add(name);
  }
  for (const name of names) text = text.replace(new RegExp(`\\b${name}\\b`, "g"), `sampler_${name}`);
  return text;
}

/**
 * butterchurn's shader templates declare `float PI` themselves; a preset that declares a PI of
 * its own (MilkDrop's templates have none) keeps it under another name.
 */
export function ownPi(source) {
  const text = String(source ?? "");
  return /\b(?:float|half|double)\s+PI\b/.test(withoutComments(text)) ? text.replace(/\bPI\b/g, "PI_md") : text;
}

/** MilkDrop's fallback shaders (data/warp_ps.fx and comp_ps.fx), for a shader it cannot compile either. */
export const FALLBACK_SHADERS = {
  warp: "shader_body {\nret = tex2D(sampler_main, uv).xyz;\nret -= 0.004;\n}",
  comp: "shader_body {\nret = tex2D(sampler_main, uv).xyz;\n}"
};

/**
 * Why MilkDrop itself could not compile a shader, when that shows in its text: MilkDrop
 * closes `shader_body` at the *last* `}` of the text, so a `}` left over from code commented
 * out closes it early and the rest stands outside any function. Null when nothing says so.
 */
export function milkdropShaderFault(source) {
  const text = withoutComments(source);
  const at = text.indexOf("shader_body");
  const open = at < 0 ? -1 : text.indexOf("{", at);
  const close = text.lastIndexOf("}");
  if (open < 0 || close < open) return null;
  // Its closing line (`_return_value = …`) goes in front of that last `}`: outside the function too.
  let depth = 0;
  for (let index = open + 1; index < close; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth < 0) return "a '}' closes shader_body before its end";
  }
  return null;
}

/** hlslparser reports through the console; a worker collects it as the reason a shader failed. */
const messages = [];

async function translateShader(source, tools, kind, notes = []) {
  if (!String(source ?? "").trim()) return "";
  const fault = milkdropShaderFault(source);
  if (fault) {
    // MilkDrop shows its fallback shader then, and so does the conversion.
    notes.push(`${kind} shader: MilkDrop cannot compile it either (${fault}); its fallback shader instead`);
    source = FALLBACK_SHADERS[kind];
  }
  const extras = beatdropShaderNames(hlslIntrinsics(builtinSamplers(flatTex3D(ownPi(prefixedSamplers(source))))));
  source = extras.source;
  let input = source;
  try {
    input = rewriteShader(source);
  } catch (error) {
    if (!(error instanceof RewriteError)) throw error;
  }
  input = withFmod(input);
  messages.length = 0;
  const glsl = await hlslToGlsl(input, tools);
  if (!glsl) {
    const reason = messages.join("; ").replace(/filename\.hlsl\(\d+\)\s*:\s*/g, "").trim();
    throw new Error(reason || "shader not translated");
  }
  // The translator's bug always leaves a `&&` the source did not have.
  if (logicalOperators(glsl).and > logicalOperators(input).and) throw new Error("shader translation changed an operator");
  const fitted = matrixRowHelpers(asUniforms(fitButterchurn(mendGlsl(compactGlsl(glsl)), kind), extras.uniforms));
  return esConversions(fitted, shaderTemplates(tools)[kind]);
}

/**
 * butterchurn's fragment shaders around a preset's code (warp and comp, from the patched
 * butterchurn the build ships), split where the preset's header and body go.
 */
export function shaderTemplates(tools) {
  if (tools.templates) return tools.templates;
  const source = tools.butterchurn;
  const templates = {};
  for (const [kind, className] of [["warp", "class WarpShader"], ["comp", "class CompShader"]]) {
    const at = source.indexOf(className);
    const fragment = source.indexOf("this.gl.FRAGMENT_SHADER", at);
    const open = source.indexOf("`", fragment);
    const close = source.indexOf("`.trim()", open);
    const text = source.slice(open + 1, close).replace("${this.floatPrecision}", "highp").replace("${Math.PI}", String(Math.PI));
    const [head, rest = ""] = text.split("${fragShaderHeaderText}");
    const [main, tail = ""] = rest.split("${fragShaderText}");
    if (at < 0 || !head || !main || !tail) throw new Error(`butterchurn's ${kind} shader template not found`);
    templates[kind] = { head: head.replace(/^\s*/, ""), main, tail };
  }
  tools.templates = templates;
  return templates;
}

const MARKS = ["/*md:header*/", "/*md:main*/", "/*md:body*/", "/*md:end*/"];

/**
 * Where desktop GLSL and HLSL convert an int to a float without being asked and GLSL ES 3.00
 * refuses (`x * 2`, `pow(x, 2)`, `float y = 1;`), the conversion written in — by the shaders
 * plugin's type checker (shader-glsl-types.mjs), run over the whole fragment shader as
 * butterchurn will compile it. Anything it cannot read stays as it was.
 */
export function esConversions(glsl, template) {
  const at = glsl.indexOf("shader_body");
  if (at < 0) return glsl;
  const rest = glsl.slice(at);
  const header = glsl.slice(0, at);
  const body = rest.slice(rest.indexOf("{") + 1, rest.lastIndexOf("}"));
  const whole = `${template.head}${MARKS[0]}\n${header}\n${MARKS[1]}${template.main}${MARKS[2]}\n${body}\n${MARKS[3]}${template.tail}`;
  let converted;
  try {
    ({ code: converted } = applyConversions(whole));
  } catch {
    return glsl;
  }
  const [h, m, b, e] = MARKS.map((mark) => converted.indexOf(mark));
  if (!(h >= 0 && m > h && b > m && e > b)) return glsl;
  const newHeader = converted.slice(h + MARKS[0].length, m).replace(/^\n/, "").replace(/\n$/, "");
  const newBody = converted.slice(b + MARKS[2].length, e).replace(/^\n/, "").replace(/\n$/, "");
  return `${newHeader}shader_body {${newBody}}`;
}

function finite(values) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value)));
}

/** Empty equations are what butterchurn assumes when a field is missing (see hydratePreset in the client). */
function withoutEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== "" && value !== undefined));
}

/** Disabled shapes and waves are left empty, and empty ones at the end are dropped. */
function trimList(list) {
  const result = [...list];
  while (result.length && Object.keys(result.at(-1)).length === 0) result.pop();
  return result;
}

const PRESET_VERSION = /MILKDROP_PRESET_VERSION\s*=\s*(\d+)/i;

/**
 * The names butterchurn 3 (as patched) gives each block of equations, and the variables its
 * pools hold — what `checkEquations` compiles them with, as loadWASMPreset does.
 */
const BASE_KEYS = ["decay", "gammaadj", "echo_zoom", "echo_alpha", "echo_orient", "red_blue", "brighten", "darken", "wrap", "darken_center", "solarize", "invert", "bmotionvectorson", "fshader", "b1n", "b2n", "b3n", "b1x", "b2x", "b3x", "b1ed", "wave_mode", "additivewave", "wave_dots", "wave_thick", "wave_a", "wave_scale", "wave_smoothing", "wave_mystery", "modwavealphabyvolume", "modwavealphastart", "modwavealphaend", "wave_r", "wave_g", "wave_b", "wave_x", "wave_y", "wave_brighten", "mv_x", "mv_y", "mv_dx", "mv_dy", "mv_l", "mv_r", "mv_g", "mv_b", "mv_a", "warpanimspeed", "warpscale", "zoomexp", "zoom", "rot", "cx", "cy", "dx", "dy", "warp", "sx", "sy", "ob_size", "ob_r", "ob_g", "ob_b", "ob_a", "ib_size", "ib_r", "ib_g", "ib_b", "ib_a"];
const POOL_GLOBALS = ["frame", "time", "fps", "bass", "bass_att", "mid", "mid_att", "treb", "treb_att", "meshx", "meshy", "aspectx", "aspecty", "pixelsx", "pixelsy", "rand_start", "rand_preset"];

function equationModule(preset) {
  const pools = { perFrame: new Set([...BASE_KEYS, ...POOL_GLOBALS]), perVertex: new Set([...BASE_KEYS, ...POOL_GLOBALS, "x", "y", "rad", "ang"]) };
  const functions = {
    presetInit: { pool: "perFrame", code: preset.init_eqs_eel ?? "" },
    perFrame: { pool: "perFrame", code: preset.frame_eqs_eel ?? "" }
  };
  if (preset.pixel_eqs_eel) functions.perPixel = { pool: "perVertex", code: preset.pixel_eqs_eel };
  (preset.shapes ?? []).forEach((shape, index) => {
    if (!shape?.baseVals?.enabled) return;
    pools[`shapePerFrame${index}`] = new Set([...POOL_GLOBALS, "instance"]);
    functions[`shapes_${index}_init_eqs`] = { pool: `shapePerFrame${index}`, code: shape.init_eqs_eel ?? "" };
    functions[`shapes_${index}_frame_eqs`] = { pool: `shapePerFrame${index}`, code: shape.frame_eqs_eel ?? "" };
  });
  (preset.waves ?? []).forEach((wave, index) => {
    if (!wave?.baseVals?.enabled) return;
    pools[`wavePerFrame${index}`] = new Set([...POOL_GLOBALS, "x", "y", "sample", "value1", "value2"]);
    functions[`waves_${index}_init_eqs`] = { pool: `wavePerFrame${index}`, code: wave.init_eqs_eel ?? "" };
    functions[`waves_${index}_frame_eqs`] = { pool: `wavePerFrame${index}`, code: wave.frame_eqs_eel ?? "" };
    if (wave.point_eqs_eel) functions[`waves_${index}_point_eqs`] = { pool: `wavePerFrame${index}`, code: wave.point_eqs_eel };
  });
  return { pools, functions };
}

/** The equations compiled by the eel-wasm butterchurn ships (patched); throws with eel-wasm's reason. */
export async function checkEquations(preset, tools) {
  const eel = await tools.eel();
  const { pools, functions } = equationModule(preset);
  for (const [name, fn] of Object.entries(functions)) {
    try {
      new WebAssembly.Module(eel.compileModule({ pools, functions: { [name]: fn }, eelVersion: preset.version || 2 }));
    } catch (error) {
      throw new Error(`equations (${name}) do not compile: ${String(error?.message ?? error).split("\n")[0].slice(0, 120)}`);
    }
  }
}

/** BeatDrop's engine variables in the equations (state.cpp): the mouse and keys, then the clock. */
const POINTER_VARIABLES = ["mousex", "mousey", "mousedown", "mouseclick", "ctrllt", "ctrlrt", "ctrldn", "ctrlup"];
const CLOCK_VARIABLES = ["year", "month", "day", "weekday", "hour", "minute", "second", "milliseconds", "totalseconds"];

const reads = (code, name) => new RegExp(`\\b${name}\\b`).test(code);
const assigns = (code, name) => new RegExp(`\\b${name}\\s*(?:[-+*/%]=|=(?!=))`).test(code);

/**
 * The BeatDrop variables a preset's equations read and never assign (translated code, names in
 * lower case): what the patched engine then sets — the clock and the mouse for the per-frame
 * code, the mouse for the per-vertex code, as BeatDrop registers them. A MilkDrop 2 preset that
 * calls a variable of its own `second` assigns it, and keeps it.
 *
 * And MilkDrop 2's `progress`, read anywhere (per frame, per vertex, shapes, waves): MilkDrop sets
 * it before each block runs (milkdropfs.cpp), so a preset that assigns it gets it back anyway.
 */
export function engineVariables({ init = "", frame = "", pixel = "", objects = "" }) {
  const frameCode = `${init}\n${frame}`;
  const names = new Set();
  for (const name of [...POINTER_VARIABLES, ...CLOCK_VARIABLES]) {
    if (reads(frameCode, name) && !assigns(frameCode, name)) names.add(name);
  }
  for (const name of POINTER_VARIABLES) {
    if (reads(pixel, name) && !assigns(pixel, name)) names.add(name);
  }
  if (reads(`${frameCode}\n${pixel}\n${objects}`, "progress")) names.add("progress");
  return [...names];
}

/**
 * One block of equations as eel-wasm source, read the way MilkDrop reads it
 * (src/shared/visualizations/milkdrop-eel.ts). A block MilkDrop could not compile either is
 * left empty, as MilkDrop leaves it, with a note why.
 */
function equations(raw, label, notes) {
  const { code, error } = translateEel(raw);
  if (error) notes.push(`${label}: ${error}`);
  return code;
}

/**
 * A MilkDrop 3 sprite block, `[SPRITE1_BEGIN]` … `[SPRITE1_END]` (one file opens it `[SPRITE1]`:
 * MilkDrop 3 reads the keys, not the markers, so it is a block all the same).
 */
const SPRITE_BLOCK = /\[SPRITE(\d+)(?:_BEGIN)?\]([\s\S]*?)\[SPRITE\1_END\]/gi;
/** The preset version MilkDrop 3.37 saves a preset with a sprite as, and the only one whose sprite block it reads in a `.milk`. */
const SPRITE_VERSION = 300;
/**
 * MilkDrop 3.37's own values before a block is read (the reset after its sprite is saved): blend 4
 * (colour key), burn 1, alpha 1, SX and SY −0.5 (added to the code's sx = sy = 1), repeats 1.
 */
const SPRITE_DEFAULTS = { colorKey: 0, layer: 0, blend: 4, alpha: 1, burn: 1, x: 0, y: 0, sx: -0.5, sy: -0.5, rot: 0, speed: 0, repeatX: 1, repeatY: 1 };
const SPRITE_KEYS = {
  spritecolorkey: "colorKey", spritelayer: "layer", spriteblend: "blend", spritealpha: "alpha", spriteburn: "burn",
  spritex: "x", spritey: "y", spritesx: "sx", spritesy: "sy", spriterot: "rot", spritespeed: "speed",
  spriterepeatx: "repeatX", spriterepeaty: "repeatY"
};
const SPRITE_INTEGERS = new Set(["colorKey", "layer", "blend", "burn"]);
/** The sprite code's own variables (MilkDrop 2's texmgr, which MilkDrop 3's sprites run in). */
export const SPRITE_VARIABLES = ["x", "y", "sx", "sy", "rot", "flipx", "flipy", "r", "g", "b", "a", "blendmode", "done", "burn",
  "repeatx", "repeaty", "time", "frame", "fps", "progress", "bass", "mid", "treb", "bass_att", "mid_att", "treb_att"];

/**
 * A sprite block as the engine draws it (`md.sprite`; how, butterchurn-patches.mjs): its values,
 * the texture of its image — `sprites\x.png` is `sprite_x` (vendor/milkdrop-textures/milkdrop3-sprites),
 * `textures\y.jpg` the texture `y` — and its per-frame code, translated as the preset's.
 */
export function parseSprite(block) {
  const sprite = { ...SPRITE_DEFAULTS };
  const code = new Map();
  let image = "";
  for (const line of String(block).split(/\r?\n/)) {
    const match = /^\s*(\w+)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "spritename") image = value;
    else if (/^code_\d+$/.test(key)) code.set(Number(key.slice(5)), value);
    else if (SPRITE_KEYS[key]) {
      const field = SPRITE_KEYS[key];
      const number = SPRITE_INTEGERS.has(field) ? parseInt(value, field === "colorKey" ? undefined : 10) : Number(value);
      if (Number.isFinite(number)) sprite[field] = number;
    }
  }
  const path = image.replace(/\\/g, "/").split("/").filter(Boolean);
  const file = path.at(-1) ?? "";
  const base = file.replace(/\.[^.]*$/, "").toLowerCase();
  sprite.image = image;
  sprite.texture = base ? (path.length > 1 && path[0].toLowerCase() !== "sprites" ? base : `sprite_${base}`) : "";
  // code_1, code_2 … up to the first one missing, as MilkDrop 2's ReadCode reads them.
  const lines = [];
  for (let index = 1; code.has(index); index += 1) lines.push(code.get(index));
  sprite.code = lines.join("\n");
  return sprite;
}

/** The sprite block converted: its code translated and compiled as the engine will (else left out, noted). */
async function spriteOf(block, tools, notes, version) {
  const sprite = parseSprite(block);
  if (!sprite.texture) notes.push("sprite block without an image: not drawn");
  const code = equations(sprite.code, "sprite code", notes);
  sprite.code = code ?? "";
  if (sprite.code) {
    try {
      const eel = await tools.eel();
      new WebAssembly.Module(eel.compileModule({
        pools: { mdSprite: new Set(SPRITE_VARIABLES) },
        functions: { mdSprite: { pool: "mdSprite", code: sprite.code } },
        eelVersion: version || 2
      }));
    } catch (error) {
      notes.push(`sprite code does not compile, left out: ${String(error?.message ?? error).split("\n")[0].slice(0, 100)}`);
      sprite.code = "";
    }
  }
  return sprite;
}

/**
 * Convert one preset. Throws with a short reason when it cannot be done
 * faithfully — the build then leaves the preset out. `notes` collects what
 * plays as MilkDrop plays it but not as its author wrote it (a block of
 * equations neither compiles). `engine: "beatdrop"` or `"milkdrop3"`: the preset's pack was made
 * for BeatDrop or MilkDrop 3, which count simple waveforms differently; `md3`:
 * it is half of a MilkDrop 3 double preset. A `.milk2` comes back as
 * `{ double: { first, second, blend } }`.
 */
export async function convertPreset(text, tools, notes = [], { engine, md3 = false, half = false } = {}) {
  const { utils } = tools;
  const double = splitMilk2(text);
  if (double) return convertDouble(double, tools, notes);
  const source = String(text).replace(/\r\n?/g, "\n");
  const start = source.indexOf("[preset00]");
  if (start < 0) throw new Error("no [preset00] section");
  // MilkDrop 3.25+ sprite blocks (in a .milk too) are the engine's (md.sprite, below); their keys
  // (SpriteX=…, code_1=…) are no preset values.
  const spriteBlocks = [...source.matchAll(SPRITE_BLOCK)];
  const body = source.slice(start + "[preset00]".length).replace(SPRITE_BLOCK, "");
  const parts = utils.splitPreset(body);
  const extra = extraShapesAndWaves(body, utils);
  const allShapes = [...parts.shapes, ...extra.shapes.slice(4)];
  const allWaves = [...parts.waves, ...extra.waves.slice(4)];
  const beyond = beyondMilkdrop2(source);
  if (beyond.length) throw new Error(`beyond BeatDrop and MilkDrop 3: ${beyond.join(", ")}`);
  // EEL 1 (MilkDrop 1.x) and EEL 2 differ in rand(); the version line is above [preset00].
  const preset = { version: Number(PRESET_VERSION.exec(source)?.[1] ?? 0) >= 200 ? 2 : 1 };
  // `rating` is how much its author liked it; it does not change the picture. BeatDrop's and
  // MilkDrop 3's FFTAttack/FFTDecay (get_fft()'s smoothing) go to the engine's own field.
  const { rating: _rating, fftattack, fftdecay, ...baseVals } = finite(parts.baseVals);
  // MilkDrop 3 writes the echo zoom from its menu's 0–100 scale (MDropDX12 reads 8 and above so).
  if (md3 && baseVals.echo_zoom >= 8) baseVals.echo_zoom = 1 + baseVals.echo_zoom * 0.01;
  if (Object.keys(baseVals).length) preset.baseVals = baseVals;
  const md = {};
  if (fftattack !== undefined || fftdecay !== undefined) md.fft = { attack: fftattack ?? 0.5, decay: fftdecay ?? 0.7 };
  if (beatdropWaveModes({ ...parts, shapes: allShapes.filter(Boolean), waves: allWaves.filter(Boolean) }, engine)) md.waveModes = BEATDROP_WAVE_MODES;
  const shapes = trimList(allShapes.map((shape, index) => shape?.baseVals?.enabled
    ? withoutEmpty({
        baseVals: finite(shape.baseVals),
        init_eqs_eel: equations(shape.init_eqs_str, `shape ${index} init`, notes),
        frame_eqs_eel: equations(shape.frame_eqs_str, `shape ${index} per frame`, notes)
      })
    : {}));
  const waves = trimList(allWaves.map((wave, index) => wave?.baseVals?.enabled
    ? withoutEmpty({
        baseVals: finite(wave.baseVals),
        init_eqs_eel: equations(wave.init_eqs_str, `wave ${index} init`, notes),
        frame_eqs_eel: equations(wave.frame_eqs_str, `wave ${index} per frame`, notes),
        point_eqs_eel: equations(wave.point_eqs_str, `wave ${index} per point`, notes)
      })
    : {}));
  if (shapes.length) preset.shapes = shapes;
  if (waves.length) preset.waves = waves;
  Object.assign(preset, withoutEmpty({
    init_eqs_eel: equations(parts.presetInit, "init", notes),
    frame_eqs_eel: equations(parts.perFrame, "per frame", notes),
    pixel_eqs_eel: equations(parts.perVertex, "per pixel", notes)
  }));
  const objects = [...shapes, ...waves].flatMap((item) => [item.init_eqs_eel, item.frame_eqs_eel, item.point_eqs_eel]).filter(Boolean).join("\n");
  const variables = engineVariables({ init: preset.init_eqs_eel, frame: preset.frame_eqs_eel, pixel: preset.pixel_eqs_eel, objects });
  if (variables.length) md.engine = variables;
  // Where BeatDrop differs from MilkDrop 2 and 3 (its milkdropfs.cpp): simple waves 0 and 6 from
  // the mean of both channels, the shaders' vol the mean of the bands, their time since start.
  if (engine === "beatdrop") md.beatdrop = true;
  // MilkDrop 3.37 reads a .milk's sprite block only when the preset is of version 300 (what it saves
  // a preset with a sprite as); a .milk2's is the file's, read with its second half (convertDouble).
  const version = Number(PRESET_VERSION.exec(source)?.[1] ?? 100);
  if (spriteBlocks.length && !half) {
    if (version === SPRITE_VERSION) {
      md.sprite = await spriteOf(spriteBlocks[0][2], tools, notes, preset.version);
      if (spriteBlocks.length > 1) notes.push(`${spriteBlocks.length} sprite blocks: the first is drawn (MilkDrop 3 has one preset sprite)`);
    } else {
      notes.push(`sprite block of a version ${version} preset: MilkDrop 3 reads one only in a version ${SPRITE_VERSION} preset, not drawn`);
    }
  }
  if (Object.keys(md).length) preset.md = md;
  await checkEquations(preset, tools);
  const [warp, comp] = [await translateShader(parts.warp, tools, "warp", notes), await translateShader(parts.comp, tools, "comp", notes)];
  return Object.assign(preset, withoutEmpty({ warp, comp }));
}

/** MilkDrop 3's blend patterns for a `.milk2` (the engine draws them: butterchurn-patches.mjs). */
export const MILK2_PATTERNS = new Set([
  "zoom", "side", "vertical", "horizontal", "curtain", "linesvertical", "lineshorizontal", "bubbles", "cercle", "square",
  "triangle", "corner", "patches", "donuts", "clock", "nuclear", "stars", "stars2", "cisor", "wave", "cross", "cross2",
  "snail", "snail2", "snail3", "checkerboard", "arrow", "plasma", "plasma2", "plasma3"
]);

/**
 * A MilkDrop 3 double preset (`.milk2`): two whole presets between `[PRESET1_BEGIN]` …
 * `[PRESET2_END]`, and a header of `key=value` lines (free text around them) saying how they
 * are blended — a MilkDrop 2 transition from the first to the second, frozen at
 * `blending_progress`, in the shape of `blending_pattern`, with the five randoms the pattern
 * was drawn with. Null when the text is no double preset.
 */
export function splitMilk2(text) {
  const source = String(text).replace(/\r\n?/g, "\n");
  const block = (index) => {
    const begin = `[PRESET${index}_BEGIN]`;
    const start = source.indexOf(begin);
    const end = start < 0 ? -1 : source.indexOf(`[PRESET${index}_END]`, start);
    return end < 0 ? null : source.slice(start + begin.length, end);
  };
  const first = block(1);
  const second = block(2);
  if (first === null || second === null) return null;
  const head = source.slice(0, source.indexOf("[PRESET1_BEGIN]"));
  const value = (key) => new RegExp(`^\\s*${key}\\s*=\\s*([^\\n]*)$`, "im").exec(head)?.[1].trim();
  const number = (text, fallback) => (text !== undefined && text !== "" && Number.isFinite(Number(text)) ? Number(text) : fallback);
  const pattern = (value("blending_pattern") ?? "").toLowerCase();
  return {
    first,
    second,
    blend: {
      pattern: MILK2_PATTERNS.has(pattern) ? pattern : "zoom",
      ...(MILK2_PATTERNS.has(pattern) ? {} : { unknownPattern: pattern }),
      progress: Math.min(1, Math.max(0, number(value("blending_progress"), 0.5))),
      direction: number(value("blending_direction"), 1),
      randoms: [1, 2, 3, 4, 5].map((index) => number(value(`random_${index}`), 0.5))
    },
    sprites: [...source.matchAll(SPRITE_BLOCK)].length,
    // MilkDrop 3.37 reads the sprite only with the second preset, and only when the header says
    // `sprite=1`; its splitter stretches that preset to the last [SPRITE1_END], so a block after
    // [PRESET2_END] (where MilkDrop 3 saves it) is the second preset's. Null when there is none.
    sprite: spriteOfSecond(source),
    spriteFlag: /sprite=1/.test(head),
    // A sprite block inside the first preset, which MilkDrop 3 never reads.
    firstSprite: [...first.matchAll(SPRITE_BLOCK)].length > 0
  };
}

/** The sprite block the second preset of a `.milk2` reads: the last from [PRESET2_BEGIN] to the last [SPRITE1_END]. */
function spriteOfSecond(source) {
  const start = source.indexOf("[PRESET2_BEGIN]");
  const end = source.lastIndexOf("[SPRITE1_END]");
  if (start < 0 || end < start) return null;
  const blocks = [...source.slice(start, end + "[SPRITE1_END]".length).matchAll(SPRITE_BLOCK)];
  return blocks.length ? blocks[blocks.length - 1][2] : null;
}

/**
 * A `.milk2` converted: each half as a `.milk` of MilkDrop 3's (BeatDrop's wave modes, MD3's
 * echo zoom scale), both given the file's randoms as rand_preset, and the blend for the engine.
 */
async function convertDouble(double, tools, notes) {
  const half = async (text, label) => {
    const own = [];
    try {
      const preset = await convertPreset(text, tools, own, { engine: "milkdrop3", md3: true, half: true });
      preset.md = { ...preset.md, randPreset: double.blend.randoms.slice(0, 4) };
      for (const note of own) notes.push(`${label}: ${note}`);
      return preset;
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const first = await half(double.first, "preset 1");
  const second = await half(double.second, "preset 2");
  if (double.blend.unknownPattern !== undefined) notes.push(`blend pattern '${double.blend.unknownPattern}' unknown: a plain crossfade instead`);
  // MilkDrop 3 has one preset sprite: the file's own, read with the second (current) preset.
  if (double.sprite && double.spriteFlag) {
    second.md = { ...second.md, sprite: await spriteOf(double.sprite, tools, notes, second.version) };
  } else if (double.sprite) {
    notes.push("sprite block not read by MilkDrop 3 (no sprite=1 in the header), not drawn");
  }
  if (double.firstSprite) notes.push("preset 1's sprite block is not read (MilkDrop 3 reads the sprite with the second preset)");
  const { unknownPattern: _unknown, ...blend } = double.blend;
  return { double: { first, second, blend } };
}

/** loadConverter's parts and the patched butterchurn: its shader templates and its eel-wasm. */
export function loadTools() {
  const tools = loadConverter();
  tools.butterchurn = patchedButterchurnSource(require);
  let eel = null;
  tools.eel = () => {
    eel ??= import(`data:text/javascript;base64,${Buffer.from(eelCompilerModule(tools.butterchurn)).toString("base64")}`).then((module) => module.default);
    return eel;
  };
  return tools;
}

// As a worker: one { key, path, engine } at a time, each answered with { key, preset, notes }
// or { key, error }; { done: true } ends it.
if (!isMainThread && workerData?.task === "milkdrop-convert") {
  // Before hlslparser loads: emscripten binds the console when it starts.
  console.log = console.warn = console.error = console.info = (...args) => {
    messages.push(args.map(String).join(" "));
  };
  const tools = loadTools();
  parentPort.on("message", async (job) => {
    if (job.done) process.exit(0);
    try {
      const notes = [];
      const preset = await convertPreset(readFileSync(job.path, "latin1"), tools, notes, { engine: job.engine });
      parentPort.postMessage({ key: job.key, preset, ...(notes.length ? { notes } : {}) });
    } catch (error) {
      parentPort.postMessage({ key: job.key, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  });
}
