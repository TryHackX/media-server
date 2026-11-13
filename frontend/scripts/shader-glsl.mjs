/**
 * Desktop GLSL (4.50 as Monkey Hi Hat writes it, 3.30 as music_visualizer does) rewritten as the
 * GLSL ES 3.00 that WebGL 2 compiles. Used by shader-visualizers.mjs at build time; nothing here
 * knows any particular shader — the rules are the language's.
 *
 * The two dialects are close: Shadertoy, where most of this content began, already speaks ES 3.00.
 * What desktop GLSL allows and ES does not, and what this rewrites:
 *
 *   - a `#version` of its own, default precision, no `#extension` lines;
 *   - uniforms with initial values (`uniform float x = 0.5;`): the value goes to the caller, who
 *     sets it, and the declaration loses it;
 *   - global variables initialised with anything but a constant (`vec2 uv = fragCoord * resolution;`,
 *     `float direction = sign(randomrun - 0.5);`): declared bare, and assigned in the same order
 *     when `main` begins — where desktop GLSL runs them too;
 *   - `const` locals initialised with what is not constant (desktop GLSL 4.20 reads them as
 *     read-only variables): the `const` goes;
 *   - integers where a float is meant (`float x = 1;`, `x * 2`, `pow(x, 2)`, `return 0;`):
 *     desktop GLSL converts them silently, ES refuses. The types are worked out in
 *     shader-glsl-types.mjs (declarations, built-in functions, constructors, swizzles, operators)
 *     and a literal becomes `1.0`, an int expression `float(…)`, where a float is wanted;
 *   - names with two underscores in a row, which ES reserves;
 *   - 1D textures (music_visualizer's sound and spectrum) become N×1 2D ones.
 */

// ---------------------------------------------------------------------------------------------
// Tokens

const TOKEN = new RegExp([
  /(\/\/[^\n]*)/.source,                                   // 1 line comment
  /(\/\*[\s\S]*?\*\/)/.source,                             // 2 block comment
  /([ \t\f\v]*\n|[ \t\f\v]+)/.source,                      // 3 white space (a newline ends it)
  /(\\\r?\n)/.source,                                      // 4 line continuation outside a directive
  /([A-Za-z_][A-Za-z0-9_]*)/.source,                       // 5 identifier
  /((?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?|\d+[eE][+-]?\d+[fF]?|0[xX][0-9a-fA-F]+[uU]?|\d+[uU]?)/.source, // 6 number
  /(<<=|>>=|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\^\^|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|[{}()[\];,.?:+\-*/%<>=!~&|^#])/.source, // 7 punctuation
  /(\r)/.source,                                           // 8 stray carriage return
  /([\s\S])/.source                                        // 9 anything else
].join("|"), "y");

/**
 * Tokens of `source`. A preprocessor directive (from `#` at the start of a line to the end of the
 * line, continuations included) is one token of type "pp"; comments and white space are kept, so
 * that the text comes back as it was where nothing changes.
 */
export function tokenize(source) {
  const tokens = [];
  let lineStart = true;
  TOKEN.lastIndex = 0;
  for (let at = 0; at < source.length;) {
    if (lineStart) {
      const directive = /[ \t]*#(?:[^\n\\]|\\\r?\n|\\)*/y;
      directive.lastIndex = at;
      const found = directive.exec(source);
      if (found) {
        tokens.push({ type: "pp", text: found[0] });
        at += found[0].length;
        lineStart = false;
        continue;
      }
    }
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(source);
    const text = match[0];
    const type = match[1] || match[2] ? "comment"
      : match[3] || match[8] ? "space"
        : match[4] ? "space"
          : match[5] ? "ident"
            : match[6] ? "number"
              : match[7] ? "punct" : "other";
    tokens.push({ type, text });
    at += text.length;
    if (type === "space" || type === "comment") {
      if (text.includes("\n")) lineStart = true;
    } else {
      lineStart = false;
    }
  }
  return tokens;
}

export const join = (tokens) => tokens.map((token) => token.text).join("");

const isCode = (token) => token.type !== "space" && token.type !== "comment";

// ---------------------------------------------------------------------------------------------
// Names

const STORAGE = new Set(["const", "uniform", "in", "out", "inout", "attribute", "varying", "buffer", "shared",
  "centroid", "flat", "smooth", "noperspective", "invariant", "precise", "highp", "mediump", "lowp",
  "readonly", "writeonly", "coherent", "volatile", "restrict", "patch", "sample"]);

const VECTORS = {
  vec2: ["float", 2], vec3: ["float", 3], vec4: ["float", 4],
  ivec2: ["int", 2], ivec3: ["int", 3], ivec4: ["int", 4],
  uvec2: ["uint", 2], uvec3: ["uint", 3], uvec4: ["uint", 4],
  bvec2: ["bool", 2], bvec3: ["bool", 3], bvec4: ["bool", 4]
};
const MATRICES = { mat2: [2, 2], mat3: [3, 3], mat4: [4, 4], mat2x2: [2, 2], mat2x3: [2, 3], mat2x4: [2, 4],
  mat3x2: [3, 2], mat3x3: [3, 3], mat3x4: [3, 4], mat4x2: [4, 2], mat4x3: [4, 3], mat4x4: [4, 4] };
const SAMPLERS = new Set(["sampler1D", "sampler2D", "sampler3D", "samplerCube", "sampler2DArray", "sampler2DShadow",
  "samplerCubeShadow", "isampler2D", "usampler2D", "isampler3D", "usampler3D"]);
const BASIC = new Set(["void", "bool", "int", "uint", "float", ...Object.keys(VECTORS), ...Object.keys(MATRICES), ...SAMPLERS]);

export const isTypeName = (name, structs = new Set()) => BASIC.has(name) || structs.has(name);


// ---------------------------------------------------------------------------------------------
// Statements at file level

/**
 * The file cut into what stands at its top level: directives, declarations (up to `;`), function
 * definitions (head and body), struct definitions; each with its tokens.
 */
export function topLevel(tokens) {
  const items = [];
  let current = [];
  let depth = 0;
  let paren = 0;
  const flush = (kind) => {
    if (current.length) items.push({ kind, tokens: current });
    current = [];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (depth === 0 && paren === 0 && token.type === "pp") {
      if (current.some(isCode)) {
        // A directive inside a declaration that spans lines: it stays where it is.
        current.push(token);
        continue;
      }
      flush("space");
      items.push({ kind: "pp", tokens: [token] });
      continue;
    }
    current.push(token);
    if (token.type !== "punct") continue;
    if (token.text === "(") paren += 1;
    else if (token.text === ")") paren -= 1;
    else if (token.text === "{") {
      if (depth === 0 && paren === 0) {
        const code = current.filter(isCode);
        // `struct S {`, or `uniform Block {` — a type, not a function body.
        const head = code.slice(0, -1);
        const isFunction = head.length >= 3 && head.at(-1).text === ")";
        current.kind = isFunction ? "func" : "struct";
      }
      depth += 1;
    } else if (token.text === "}") {
      depth -= 1;
      if (depth === 0 && current.kind === "func") {
        // A function ends at its brace; trailing white space goes with what follows.
        const kind = "func";
        items.push({ kind, tokens: current });
        current = [];
      }
    } else if (token.text === ";" && depth === 0 && paren === 0) {
      const kind = current.kind === "struct" ? "struct" : "decl";
      items.push({ kind, tokens: current });
      current = [];
    }
  }
  if (current.some(isCode)) items.push({ kind: "other", tokens: current });
  else flush("space");
  return items;
}

/** The text of a declaration split at its top-level commas (`float a = 1., b;`). */
function splitTopLevel(tokens, separator = ",") {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "punct") {
      if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
      else if (token.text === ")" || token.text === "]" || token.text === "}") depth -= 1;
      else if (token.text === separator && depth === 0) {
        parts.push([]);
        continue;
      }
    }
    parts.at(-1).push(token);
  }
  return parts;
}

/**
 * A declaration's parts: its qualifiers, its type (with an array size written after the type),
 * and each declarator's name, array size and initialiser. Null for what is not a declaration
 * (a prototype, a statement).
 */
export function readDeclaration(tokens, structs = new Set()) {
  const code = tokens.filter(isCode);
  if (code.at(-1)?.text === ";") code.pop();
  let at = 0;
  const qualifiers = [];
  while (at < code.length && (STORAGE.has(code[at].text) || code[at].text === "layout")) {
    if (code[at].text === "layout") {
      let depth = 0;
      const start = at;
      do {
        if (code[at].text === "(") depth += 1;
        if (code[at].text === ")") depth -= 1;
        at += 1;
      } while (at < code.length && depth > 0);
      qualifiers.push(join(code.slice(start, at)));
      continue;
    }
    qualifiers.push(code[at].text);
    at += 1;
  }
  const type = code[at];
  if (!type || type.type !== "ident" || !isTypeName(type.text, structs)) return null;
  at += 1;
  let typeArray = "";
  if (code[at]?.text === "[") {
    const start = at;
    while (at < code.length && code[at].text !== "]") at += 1;
    at += 1;
    typeArray = join(code.slice(start, at));
  }
  const rest = code.slice(at);
  if (rest.length === 0) return { qualifiers, type: type.text, typeArray, declarators: [] };
  // A prototype: a name and a parenthesis.
  if (rest[0]?.type === "ident" && rest[1]?.text === "(") return null;
  const declarators = [];
  for (const part of splitTopLevel(rest)) {
    const name = part[0];
    if (!name || name.type !== "ident") return null;
    let index = 1;
    let array = "";
    while (part[index]?.text === "[") {
      const start = index;
      let depth = 0;
      do {
        if (part[index].text === "[") depth += 1;
        if (part[index].text === "]") depth -= 1;
        index += 1;
      } while (index < part.length && depth > 0);
      array += join(part.slice(start, index));
    }
    let init = null;
    if (part[index]?.text === "=") init = part.slice(index + 1);
    else if (index < part.length) return null;
    declarators.push({ name: name.text, array, init });
  }
  return { qualifiers, type: type.text, typeArray, declarators };
}

// ---------------------------------------------------------------------------------------------
// Constant expressions

const BUILTIN_FUNCTIONS = new Set(["radians", "degrees", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh",
  "tanh", "asinh", "acosh", "atanh", "pow", "exp", "log", "exp2", "log2", "sqrt", "inversesqrt", "abs", "sign",
  "floor", "trunc", "round", "roundEven", "ceil", "fract", "mod", "modf", "min", "max", "clamp", "mix", "step",
  "smoothstep", "isnan", "isinf", "floatBitsToInt", "floatBitsToUint", "intBitsToFloat", "uintBitsToFloat",
  "packSnorm2x16", "unpackSnorm2x16", "packUnorm2x16", "unpackUnorm2x16", "packHalf2x16", "unpackHalf2x16",
  "length", "distance", "dot", "cross", "normalize", "faceforward", "reflect", "refract", "matrixCompMult",
  "outerProduct", "transpose", "determinant", "inverse", "lessThan", "lessThanEqual", "greaterThan",
  "greaterThanEqual", "equal", "notEqual", "any", "all", "not"]);

/**
 * Whether the tokens are a constant expression for GLSL ES 3.00: literals, constants, built-in
 * functions other than texture lookups, constructors — nothing that reads a uniform, an input, a
 * variable or a user's function.
 */
export function isConstantExpression(tokens, constants, structs = new Set()) {
  const code = tokens.filter(isCode);
  for (let index = 0; index < code.length; index += 1) {
    const token = code[index];
    if (token.type !== "ident") continue;
    if (code[index - 1]?.text === ".") continue; // a swizzle or a field
    if (constants.has(token.text) || isTypeName(token.text, structs)) continue;
    if (BUILTIN_FUNCTIONS.has(token.text) && code[index + 1]?.text === "(") continue;
    if (token.text === "true" || token.text === "false") continue;
    return false;
  }
  return true;
}

/** Object-like macros whose bodies are constant: their names count as constants. */
function constantMacros(tokens, constants, structs) {
  for (const token of tokens) {
    if (token.type !== "pp") continue;
    const match = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\()\s*(.*)$/s.exec(token.text.replace(/\\\r?\n/g, " "));
    if (!match) continue;
    const body = tokenize(match[2]);
    if (body.some(isCode) && isConstantExpression(body, constants, structs)) constants.add(match[1]);
  }
}

// ---------------------------------------------------------------------------------------------
// Uniform defaults

/** The numbers of an initial value: `0.5`, `-1`, `vec3(1., 0, .5)`; null for anything else. */
export function literalValue(tokens) {
  const text = join(tokens.filter(isCode));
  const scalar = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[fF]?$/.exec(text);
  if (scalar) return [Number(scalar[1])];
  const vector = /^(?:[ib]?vec[234]|float|int|bool)\(([^()]*)\)$/.exec(text);
  if (vector) {
    const values = vector[1].split(",").map((part) => part.trim().replace(/[fF]$/, ""));
    if (values.every((value) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) return values.map(Number);
  }
  if (text === "true") return [1];
  if (text === "false") return [0];
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rewrites

/** Without a byte-order mark, with Unix line ends, without `#version` and `#extension` lines. */
export function cleanSource(text) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*#[ \t]*(version|extension)\b[^\n]*$/gm, "");
}

const PREFIX = "sl_";

/** Code tokens as text, a space between each: `a - -b` must not become `a--b`. */
const spaced = (tokens) => tokens.filter(isCode).map((token) => token.text).join(" ");

/** Names declared `const` with a constant value anywhere in the file, and constant macros. */
function constantNames(tokens) {
  const constants = new Set();
  const structs = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].text === "struct" && tokens[index + 2]?.text) {
      const name = tokens.slice(index + 1).find(isCode);
      if (name?.type === "ident") structs.add(name.text);
    }
  }
  constantMacros(tokens, constants, structs);
  // Declarations `const T a = …, b = …;` wherever they stand.
  let statement = [];
  for (const token of tokens) {
    if (token.type === "pp") continue;
    if (token.text === ";" || token.text === "{" || token.text === "}") {
      const code = statement.filter(isCode);
      if (code[0]?.text === "const" || (code[0]?.text && STORAGE.has(code[0].text) && code.some((t) => t.text === "const"))) {
        const declaration = readDeclaration([...statement], structs);
        for (const declarator of declaration?.declarators ?? []) {
          if (declarator.init && isConstantExpression(declarator.init, constants, structs)) constants.add(declarator.name);
        }
      }
      statement = [];
      continue;
    }
    statement.push(token);
  }
  return { constants, structs };
}

/**
 * The file-level rewrites: uniform initial values out (returned as `defaults`), global
 * initialisers that are not constant moved into a function `main` calls first, `const` taken off
 * locals that are not constant.
 */
export function rewriteDeclarations(text) {
  const tokens = tokenize(text);
  const { constants, structs } = constantNames(tokens);
  const items = topLevel(tokens);
  const defaults = {};
  const deferred = [];
  let mainItem = null;
  for (const item of items) {
    if (item.kind === "decl") {
      const declaration = readDeclaration(item.tokens, structs);
      if (!declaration || declaration.declarators.length === 0) continue;
      const qualifiers = new Set(declaration.qualifiers.map((qualifier) => qualifier.split("(")[0].trim()));
      const head = `${declaration.qualifiers.join(" ")}${declaration.qualifiers.length ? " " : ""}${declaration.type}${declaration.typeArray}`;
      if (qualifiers.has("uniform")) {
        if (!declaration.declarators.some((declarator) => declarator.init)) continue;
        for (const declarator of declaration.declarators) {
          const value = declarator.init ? literalValue(declarator.init) : null;
          if (value) defaults[declarator.name] = value.length === 1 ? value[0] : value;
        }
        item.tokens = [{ type: "other", text: `${head} ${declaration.declarators.map((d) => `${d.name}${d.array}`).join(", ")};` }];
        continue;
      }
      if (qualifiers.has("const") || qualifiers.has("in") || qualifiers.has("out")) continue;
      const moving = declaration.declarators.filter((d) => d.init && !isConstantExpression(d.init, constants, structs));
      if (!moving.length) continue;
      const kept = declaration.declarators.map((d) => (moving.includes(d) || !d.init
        ? `${d.name}${d.array}` : `${d.name}${d.array} = ${spaced(d.init)}`));
      for (const d of moving) deferred.push(`  ${d.name} = ${spaced(d.init)};`);
      // Leading comments and white space stay where they were.
      const lead = [];
      for (const token of item.tokens) {
        if (isCode(token)) break;
        lead.push(token);
      }
      item.tokens = [...lead, { type: "other", text: `${head} ${kept.join(", ")};` }];
    } else if (item.kind === "func") {
      const code = item.tokens.filter(isCode);
      const brace = code.findIndex((token) => token.text === "{");
      if (code[brace - 3]?.text === "main" || (code[1]?.text === "main" && code[2]?.text === "(")) mainItem = item;
      relaxConsts(item.tokens, constants, structs);
    }
  }
  if (deferred.length && mainItem) {
    const open = mainItem.tokens.findIndex((token) => token.text === "{");
    mainItem.tokens.splice(open + 1, 0, { type: "other", text: ` ${PREFIX}initGlobals();` });
    const at = items.indexOf(mainItem);
    // On a line of its own: what stands before main may be a directive, which ends at the line.
    items.splice(at, 0, { kind: "decl", tokens: [{ type: "other", text: `\nvoid ${PREFIX}initGlobals();\n` }] });
    items.push({ kind: "func", tokens: [{ type: "other", text: `\nvoid ${PREFIX}initGlobals() {\n${deferred.join("\n")}\n}\n` }] });
  }
  return { code: items.map((item) => join(item.tokens)).join(""), defaults, moved: deferred.length };
}

/** `const` off the local declarations whose value is not a constant expression. */
function relaxConsts(tokens, constants, structs) {
  let start = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const text = tokens[index].text;
    if (text !== ";" && text !== "{" && text !== "}") continue;
    const statement = tokens.slice(start, index + 1);
    const first = statement.findIndex(isCode);
    if (first >= 0 && statement[first].text === "const") {
      const declaration = readDeclaration(statement, structs);
      const loose = declaration?.declarators.some((d) => d.init && !isConstantExpression(d.init, constants, structs));
      if (loose) tokens[start + first] = { type: "space", text: "" };
      else for (const d of declaration?.declarators ?? []) if (d.init) constants.add(d.name);
    }
    start = index + 1;
  }
}

/**
 * Global declarations of `library` that `main` already makes (the same uniform in both), left
 * out; what remains is appended after `main`, with `main`'s macros undefined first — a library
 * was its own compilation unit, linked, where `main`'s macros never reached it.
 */
export function appendLibrary(main, library) {
  const declared = new Set();
  const macros = [];
  for (const item of topLevel(tokenize(main))) {
    if (item.kind === "decl") for (const d of readDeclaration(item.tokens)?.declarators ?? []) declared.add(d.name);
    if (item.kind === "pp") {
      const match = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(item.tokens[0].text);
      if (match) macros.push(match[1]);
    }
  }
  const kept = topLevel(tokenize(library)).filter((item) => {
    if (item.kind !== "decl") return true;
    const declaration = readDeclaration(item.tokens);
    return !declaration || !declaration.declarators.every((d) => declared.has(d.name));
  });
  const undefs = [...new Set(macros)].map((name) => `#undef ${name}\n`).join("");
  return `${main}\n${undefs}${kept.map((item) => join(item.tokens)).join("")}\n`;
}

/**
 * 1D samplers as N×1 2D ones: `sampler1D` parameters become `sampler2D`, and lookups through
 * any of `names` (or those parameters) go through helpers the header defines.
 */
export function twoDimensional(text, names) {
  const tokens = tokenize(text);
  const oneD = new Set(names);
  tokens.forEach((token, index) => {
    if (token.text !== "sampler1D") return;
    token.text = "sampler2D";
    const name = tokens.slice(index + 1).find(isCode);
    if (name?.type === "ident") oneD.add(name.text);
  });
  const LOOKUPS = { texture: `${PREFIX}texture1D`, textureLod: `${PREFIX}textureLod1D`, texelFetch: `${PREFIX}texelFetch1D`, textureSize: `${PREFIX}textureSize1D` };
  tokens.forEach((token, index) => {
    if (token.type !== "ident" || !LOOKUPS[token.text]) return;
    const code = [];
    for (let at = index + 1; at < tokens.length && code.length < 2; at += 1) if (isCode(tokens[at])) code.push(tokens[at]);
    if (code[0]?.text === "(" && code[1]?.type === "ident" && oneD.has(code[1].text)) token.text = LOOKUPS[token.text];
  });
  return join(tokens);
}

/** The helpers `twoDimensional` calls. */
export const ONE_D_HELPERS = `
vec4 ${PREFIX}texture1D(sampler2D s, float x) { return texture(s, vec2(x, 0.5)); }
vec4 ${PREFIX}textureLod1D(sampler2D s, float x, float lod) { return textureLod(s, vec2(x, 0.5), lod); }
vec4 ${PREFIX}texelFetch1D(sampler2D s, int x, int lod) { return texelFetch(s, ivec2(x, 0), lod); }
int ${PREFIX}textureSize1D(sampler2D s, int lod) { return textureSize(s, lod).x; }
`;

const PREDEFINED = new Set(["__VERSION__", "__LINE__", "__FILE__"]);

/**
 * Names with two underscores in a row (`__to_srgb`), which GLSL ES reserves, renamed throughout
 * — in directives too — to `_u2_to_srgb`; the predefined macros keep theirs.
 */
export function esIdentifiers(text) {
  return text.replace(/\b[A-Za-z_]\w*/g, (word) => (word.includes("__") && !PREDEFINED.has(word)
    ? word.replace(/_{2,}/g, (run) => `_u${run.length}_`) : word));
}

/** The ES 3.00 header every stage starts with. */
export const ES_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp samplerCube;
`;

export { isCode, splitTopLevel, constantMacros, BUILTIN_FUNCTIONS, VECTORS, MATRICES, SAMPLERS, STORAGE };
