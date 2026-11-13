/**
 * Where desktop GLSL converts an integer to a float (or an int to a uint) without being asked,
 * and GLSL ES 3.00 refuses: `float x = 1;`, `x * 2`, `pow(x, 2)`, `iTime / textureSize(t, 0).x`,
 * `return 0;` in a float function. Finds them by working out the type of every expression —
 * after the preprocessor, as the compiler sees the code — and writes the conversion into the
 * source: a literal becomes `1.0` (`1u`), anything else is wrapped in `float(…)` / `vec2(…)`.
 *
 * Only what is certain is changed. An expression whose type cannot be told (a name never
 * declared, a construct this does not read) is left as it was, and so is a function body this
 * cannot parse: the shader then fails to compile as it would have anyway.
 */
import { tokenize } from "./shader-glsl.mjs";

// ---------------------------------------------------------------------------------------------
// Preprocessor with origins

/**
 * Expands `tokens` (from tokenize) the way the GLSL preprocessor does, keeping for each code token
 * where it came from: `src` (index of the source token it is, or -1), `macro` ({ directive,
 * index } of the body token it is) and `site` ([first, last] source tokens of the outermost
 * macro call that produced it, or its own index twice).
 */
export function preprocess(tokens, predefined = { GL_ES: "1", __VERSION__: "300" }) {
  const macros = new Map();
  for (const [name, body] of Object.entries(predefined)) {
    macros.set(name, { params: null, body: tokenize(body).filter(code).map((token, index) => ({ ...token, macro: { directive: -1, index } })) });
  }
  const out = [];
  const stack = []; // conditional groups: { active, taken, parentActive }
  const active = () => stack.every((group) => group.active);
  let pending = [];
  const drain = () => {
    if (pending.length) out.push(...expand(pending, macros));
    pending = [];
  };
  tokens.forEach((token, index) => {
    if (token.type === "pp") {
      drain();
      directive(token.text.replace(/\\\r?\n/g, " "), index);
      return;
    }
    if (!active() || !code(token)) return;
    pending.push({ type: token.type, text: token.text, src: index, macro: null, site: [index, index], hide: null });
  });
  drain();
  return { tokens: out, macros };

  function directive(text, index) {
    const match = /^\s*#\s*(\w*)\s*([\s\S]*)$/.exec(text);
    if (!match) return;
    const [, name, rest] = match;
    if (name === "if" || name === "ifdef" || name === "ifndef") {
      const parentActive = active();
      let value = false;
      if (parentActive) {
        if (name === "ifdef") value = macros.has(rest.trim().split(/\s+/)[0]);
        else if (name === "ifndef") value = !macros.has(rest.trim().split(/\s+/)[0]);
        else value = evaluate(rest, macros) !== 0;
      }
      stack.push({ active: parentActive && value, taken: value, parentActive });
      return;
    }
    if (name === "elif") {
      const group = stack.at(-1);
      if (!group) return;
      const value = !group.taken && group.parentActive && evaluate(rest, macros) !== 0;
      group.active = value;
      group.taken ||= value;
      return;
    }
    if (name === "else") {
      const group = stack.at(-1);
      if (!group) return;
      group.active = group.parentActive && !group.taken;
      group.taken = true;
      return;
    }
    if (name === "endif") {
      stack.pop();
      return;
    }
    if (!active()) return;
    if (name === "define") {
      const head = /^([A-Za-z_]\w*)(\(([^)]*)\))?/.exec(rest);
      if (!head) return;
      const params = head[2] ? head[3].split(",").map((part) => part.trim()).filter(Boolean) : null;
      // Offsets of the body inside the directive's own tokens, for rewriting a literal there.
      const bodyTokens = tokenize(rest.slice(head[0].length)).filter(code)
        .map((token, at) => ({ ...token, macro: { directive: index, index: at } }));
      macros.set(head[1], { params, body: bodyTokens });
    } else if (name === "undef") {
      macros.delete(rest.trim().split(/\s+/)[0]);
    }
  }
}

const code = (token) => token.type !== "space" && token.type !== "comment" && token.type !== "pp";

function expand(input, macros) {
  const out = [];
  // Tokens to read again (a macro's replacement), last first; then the input in order.
  const again = [];
  let next = 0;
  const read = () => (again.length ? again.pop() : input[next++]);
  const look = () => (again.length ? again.at(-1) : input[next]);
  const putBack = (tokens) => {
    for (let index = tokens.length - 1; index >= 0; index -= 1) again.push(tokens[index]);
  };
  for (let token = read(); token !== undefined; token = read()) {
    const macro = token.type === "ident" ? macros.get(token.text) : undefined;
    if (!macro || token.hide?.has(token.text)) {
      out.push(token);
      continue;
    }
    const hide = new Set(token.hide ?? []);
    hide.add(token.text);
    if (macro.params === null) {
      putBack(macro.body.map((body) => ({ ...body, src: -1, site: token.site, hide })));
      continue;
    }
    if (look()?.text !== "(") {
      out.push(token);
      continue;
    }
    // Arguments: balanced, split at top-level commas.
    const args = [[]];
    let depth = 0;
    let end = null;
    for (let piece = read(); piece !== undefined; piece = read()) {
      if (piece.text === "(") {
        depth += 1;
        if (depth === 1) continue;
      } else if (piece.text === ")") {
        depth -= 1;
        if (depth === 0) {
          end = piece;
          break;
        }
      } else if (piece.text === "," && depth === 1) {
        args.push([]);
        continue;
      }
      args.at(-1).push(piece);
    }
    if (!end) {
      out.push(token);
      continue;
    }
    const site = [Math.min(token.site[0], end.site[0]), Math.max(token.site[1], end.site[1])];
    const expanded = args.map((arg) => expand(arg, macros));
    const body = [];
    for (const piece of macro.body) {
      const param = piece.type === "ident" ? macro.params.indexOf(piece.text) : -1;
      if (param >= 0) body.push(...(expanded[param] ?? []).map((arg) => ({ ...arg, hide: new Set([...(arg.hide ?? []), ...hide]) })));
      else body.push({ ...piece, src: -1, site, hide });
    }
    putBack(body);
  }
  return out;
}

/** A `#if` expression: integers, `defined`, macros; an unknown name is 0. */
function evaluate(text, macros) {
  const raw = tokenize(text).filter(code);
  const withDefined = [];
  for (let at = 0; at < raw.length; at += 1) {
    if (raw[at].text === "defined") {
      const paren = raw[at + 1]?.text === "(";
      const name = raw[at + (paren ? 2 : 1)]?.text;
      withDefined.push({ type: "number", text: macros.has(name) ? "1" : "0" });
      at += paren ? 3 : 1;
      continue;
    }
    withDefined.push({ ...raw[at], src: -1, site: [0, 0], hide: null });
  }
  const tokens = expand(withDefined, macros).map((token) => token.type === "ident" ? { type: "number", text: "0" } : token);
  let at = 0;
  const peek = () => tokens[at]?.text;
  const levels = [["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">="], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];
  const apply = (op, a, b) => ({ "||": a || b ? 1 : 0, "&&": a && b ? 1 : 0, "|": a | b, "^": a ^ b, "&": a & b,
    "==": a === b ? 1 : 0, "!=": a !== b ? 1 : 0, "<": a < b ? 1 : 0, ">": a > b ? 1 : 0, "<=": a <= b ? 1 : 0,
    ">=": a >= b ? 1 : 0, "<<": a << b, ">>": a >> b, "+": a + b, "-": a - b, "*": a * b,
    "/": b ? Math.trunc(a / b) : 0, "%": b ? a % b : 0 })[op];
  const unary = () => {
    const op = peek();
    if (op === "!" || op === "-" || op === "+" || op === "~") {
      at += 1;
      const value = unary();
      return op === "!" ? (value ? 0 : 1) : op === "-" ? -value : op === "~" ? ~value : value;
    }
    if (op === "(") {
      at += 1;
      const value = ternary();
      at += 1;
      return value;
    }
    const token = tokens[at++];
    return token ? parseInt(token.text, /^0x/i.test(token.text) ? 16 : 10) || 0 : 0;
  };
  const binary = (level) => {
    if (level === levels.length) return unary();
    let left = binary(level + 1);
    while (levels[level].includes(peek())) {
      const op = tokens[at++].text;
      left = apply(op, left, binary(level + 1));
    }
    return left;
  };
  const ternary = () => {
    const condition = binary(0);
    if (peek() !== "?") return condition;
    at += 1;
    const yes = ternary();
    at += 1;
    const no = ternary();
    return condition ? yes : no;
  };
  try {
    return ternary();
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Types

const VECTOR = /^([ibu]?)vec([234])$/;
const MATRIX = /^mat([234])(?:x([234]))?$/;
const SCALARS = new Set(["float", "int", "uint", "bool"]);

function scalarOf(type) {
  if (!type || type.endsWith("[]")) return null;
  if (SCALARS.has(type)) return type;
  const vector = VECTOR.exec(type);
  if (vector) return { "": "float", i: "int", u: "uint", b: "bool" }[vector[1]];
  if (MATRIX.test(type)) return "float";
  return null;
}

function sizeOf(type) {
  if (SCALARS.has(type)) return 1;
  const vector = VECTOR.exec(type ?? "");
  return vector ? Number(vector[2]) : 0;
}

function vectorOf(scalar, size) {
  if (size === 1) return scalar;
  return `${{ float: "", int: "i", uint: "u", bool: "b" }[scalar]}vec${size}`;
}

const isFloaty = (type) => scalarOf(type) === "float";
const isInty = (type) => scalarOf(type) === "int" || scalarOf(type) === "uint";
const isMatrix = (type) => MATRIX.test(type ?? "");

function matrixShape(type) {
  const match = MATRIX.exec(type);
  if (!match) return null;
  const columns = Number(match[1]);
  return { columns, rows: match[2] ? Number(match[2]) : columns };
}

/** The float (or uint) type an integer type converts to. */
function converted(type, to) {
  const size = sizeOf(type);
  return size ? vectorOf(to, size) : null;
}

// Built-in functions: how their result follows from the arguments, and which of them stay ints.
const GEN = "gen"; // the widest float-based argument
const BUILTINS = {
  radians: GEN, degrees: GEN, sin: GEN, cos: GEN, tan: GEN, asin: GEN, acos: GEN, atan: GEN, sinh: GEN, cosh: GEN,
  tanh: GEN, asinh: GEN, acosh: GEN, atanh: GEN, pow: GEN, exp: GEN, log: GEN, exp2: GEN, log2: GEN, sqrt: GEN,
  inversesqrt: GEN, floor: GEN, trunc: GEN, round: GEN, roundEven: GEN, ceil: GEN, fract: GEN, mod: GEN, step: GEN,
  smoothstep: GEN, normalize: GEN, faceforward: GEN, reflect: GEN, refract: "arg0", dFdx: GEN, dFdy: GEN, fwidth: GEN,
  abs: "intOk", sign: "intOk", min: "intOk", max: "intOk", clamp: "intOk", mix: "mix", modf: GEN,
  length: "float", distance: "float", dot: "float", determinant: "float", cross: "vec3",
  transpose: "transpose", inverse: "arg0", matrixCompMult: "arg0", outerProduct: "outer",
  lessThan: "bvec", lessThanEqual: "bvec", greaterThan: "bvec", greaterThanEqual: "bvec", equal: "bvec",
  notEqual: "bvec", any: "bool", all: "bool", not: "arg0", isnan: "bvecOf", isinf: "bvecOf",
  floatBitsToInt: "ivecOf", floatBitsToUint: "uvecOf", intBitsToFloat: "vecOfInt", uintBitsToFloat: "vecOfInt",
  packSnorm2x16: "uint", packUnorm2x16: "uint", packHalf2x16: "uint", unpackSnorm2x16: "vec2",
  unpackUnorm2x16: "vec2", unpackHalf2x16: "vec2",
  texture: "texture", textureLod: "texture", textureProj: "texture", textureProjLod: "texture",
  textureGrad: "texture", textureOffset: "texture", textureLodOffset: "texture", textureGradOffset: "texture",
  textureProjOffset: "texture", texelFetch: "fetch", texelFetchOffset: "fetch", textureSize: "size"
};
// Arguments that are integers by signature, by function: the rest of a texture call is float.
const INT_ARGS = { texelFetch: [1, 2], texelFetchOffset: [1, 2, 3], textureSize: [1], textureOffset: [2],
  textureLodOffset: [3], textureGradOffset: [4], textureProjOffset: [2] };
const SAMPLER_DIMENSIONS = { sampler2D: 2, samplerCube: 2, sampler3D: 3, sampler2DArray: 3, sampler2DShadow: 2,
  samplerCubeShadow: 2, isampler2D: 2, usampler2D: 2, isampler3D: 3, usampler3D: 3 };

const VARIABLES = {
  gl_FragCoord: "vec4", gl_FragColor: "vec4", gl_Position: "vec4", gl_PointSize: "float", gl_VertexID: "int",
  gl_InstanceID: "int", gl_FrontFacing: "bool", gl_PointCoord: "vec2", gl_FragDepth: "float"
};

// ---------------------------------------------------------------------------------------------
// Parser and checker over the expanded tokens

class Unsupported extends Error {}

/**
 * Finds the conversions `source` needs. Returns the list of fixes as positions in the expanded
 * token stream; `applyFixes` writes them into the source tokens.
 */
export function findConversions(source) {
  const tokens = tokenize(source);
  const { tokens: stream } = preprocess(tokens);
  const fixes = [];
  const structs = new Map(); // name -> { field: type }
  const functions = new Map(); // name -> [{ params: [type], returns }]
  const globals = new Map();
  let at = 0;

  const peek = (offset = 0) => stream[at + offset];
  const text = (offset = 0) => stream[at + offset]?.text;
  const expect = (value) => {
    if (text() !== value) throw new Unsupported(`expected ${value} at ${text()}`);
    at += 1;
  };
  const isType = (name) => SCALARS.has(name) || name === "void" || VECTOR.test(name) || MATRIX.test(name)
    || name in SAMPLER_DIMENSIONS || name === "sampler1D" || structs.has(name);
  const QUALIFIERS = new Set(["const", "uniform", "in", "out", "inout", "highp", "mediump", "lowp", "flat", "smooth",
    "centroid", "invariant", "precise", "noperspective"]);

  // A conversion of the expression spanning stream[first..last] to `to` ("float" or "uint").
  const convert = (node, to) => {
    if (!node || node.first === undefined) return;
    fixes.push({ first: node.first, last: node.last, to: converted(node.type, to), literal: node.literal ?? null });
    node.type = converted(node.type, to) ?? node.type;
  };

  // Scopes: a stack of maps name -> type.
  let scopes = [globals];
  const lookup = (name) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) if (scopes[index].has(name)) return scopes[index].get(name);
    return VARIABLES[name];
  };

  // Types written as `float`, `vec3`, `float[3]`, `S` — the array part after the name too.
  const readType = () => {
    while (QUALIFIERS.has(text()) || text() === "layout") {
      if (text() === "layout") {
        at += 1;
        skipBalanced();
      } else at += 1;
    }
    const name = text();
    if (!name || !isType(name)) return null;
    at += 1;
    let type = name;
    if (text() === "[") {
      skipBalanced();
      type += "[]";
    }
    return type;
  };
  const skipBalanced = () => {
    const open = text();
    const close = { "(": ")", "[": "]", "{": "}" }[open];
    let depth = 0;
    do {
      if (text() === open) depth += 1;
      else if (text() === close) depth -= 1;
      at += 1;
    } while (at < stream.length && depth > 0);
  };

  // ---- expressions (Pratt)
  const BINARY = { "||": 3, "^^": 4, "&&": 5, "|": 6, "^": 7, "&": 8, "==": 9, "!=": 9, "<": 10, ">": 10, "<=": 10,
    ">=": 10, "<<": 11, ">>": 11, "+": 12, "-": 12, "*": 13, "/": 13, "%": 13 };
  const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="]);

  const expression = () => {
    let node = assignment();
    while (text() === ",") {
      at += 1;
      const next = assignment();
      node = { type: next.type, first: node.first, last: next.last };
    }
    return node;
  };

  const assignment = () => {
    const left = ternary();
    if (ASSIGN.has(text())) {
      const op = text();
      at += 1;
      const right = assignment();
      if (op === "=") coerceTo(left.type, right);
      else if (op === "+=" || op === "-=" || op === "*=" || op === "/=") {
        // `v *= 2`: the integer side converts, whatever its size, as it would in `v * 2`.
        if (isFloaty(left.type) && isInty(right.type)) convert(right, "float");
        else if (scalarOf(left.type) === "uint" && scalarOf(right.type) === "int" && right.literal != null) convert(right, "uint");
      }
      return { type: left.type, first: left.first, last: right.last };
    }
    return left;
  };

  const ternary = () => {
    const condition = binary(3);
    if (text() !== "?") return condition;
    at += 1;
    const yes = assignment();
    expect(":");
    const no = assignment();
    if (isFloaty(yes.type) && isInty(no.type)) convert(no, "float");
    else if (isFloaty(no.type) && isInty(yes.type)) convert(yes, "float");
    return { type: yes.type ?? no.type, first: condition.first, last: no.last };
  };

  const binary = (minimum) => {
    let left = unary();
    for (;;) {
      const op = text();
      const precedence = BINARY[op];
      if (precedence === undefined || precedence < minimum) return left;
      at += 1;
      const right = binary(precedence + 1);
      left = combine(op, left, right);
    }
  };

  const combine = (op, left, right) => {
    const node = { first: left.first, last: right.last, type: null };
    const arithmetic = op === "+" || op === "-" || op === "*" || op === "/";
    const compare = op === "<" || op === ">" || op === "<=" || op === ">=" || op === "==" || op === "!=";
    if (arithmetic || compare) {
      if (isFloaty(left.type) && isInty(right.type)) convert(right, "float");
      else if (isFloaty(right.type) && isInty(left.type)) convert(left, "float");
      else if (scalarOf(left.type) === "uint" && scalarOf(right.type) === "int" && right.literal != null) convert(right, "uint");
      else if (scalarOf(right.type) === "uint" && scalarOf(left.type) === "int" && left.literal != null) convert(left, "uint");
    }
    if (compare || op === "&&" || op === "||" || op === "^^") node.type = "bool";
    else if (op === "%" || op === "&" || op === "|" || op === "^" || op === "<<" || op === ">>") node.type = left.type;
    else node.type = arithmeticType(op, left.type, right.type);
    return node;
  };

  const arithmeticType = (op, a, b) => {
    if (!a || !b) return null;
    if (isMatrix(a) && isMatrix(b)) {
      if (op !== "*") return a;
      const left = matrixShape(a);
      const right = matrixShape(b);
      return right.columns === left.rows ? (left.rows === right.columns && left.columns === left.rows ? a : `mat${right.columns}x${left.rows}`) : a;
    }
    if (isMatrix(a) && sizeOf(b) > 1 && op === "*") return vectorOf("float", matrixShape(a).rows);
    if (sizeOf(a) > 1 && isMatrix(b) && op === "*") return vectorOf("float", matrixShape(b).columns);
    if (isMatrix(a)) return a;
    if (isMatrix(b)) return b;
    return sizeOf(a) >= sizeOf(b) ? a : b;
  };

  const unary = () => {
    const op = text();
    if (op === "-" || op === "+" || op === "!" || op === "~" || op === "++" || op === "--") {
      const first = at;
      at += 1;
      const operand = unary();
      const node = { type: op === "!" ? "bool" : operand.type, first, last: operand.last };
      if ((op === "-" || op === "+") && operand.literal != null) node.literal = operand.literal;
      return node;
    }
    return postfix(primary());
  };

  const postfix = (node) => {
    for (;;) {
      if (text() === "[") {
        at += 1;
        expression();
        const close = at;
        expect("]");
        node = { type: indexType(node.type), first: node.first, last: close };
      } else if (text() === ".") {
        at += 1;
        const field = text();
        const last = at;
        at += 1;
        if (text() === "(" && field === "length") {
          at += 1;
          const close = at;
          expect(")");
          node = { type: "int", first: node.first, last: close };
          continue;
        }
        node = { type: fieldType(node.type, field), first: node.first, last };
      } else if (text() === "++" || text() === "--") {
        node = { type: node.type, first: node.first, last: at };
        at += 1;
      } else return node;
    }
  };

  const indexType = (type) => {
    if (!type) return null;
    if (type.endsWith("[]")) return type.slice(0, -2);
    if (isMatrix(type)) return vectorOf("float", matrixShape(type).rows);
    const size = sizeOf(type);
    return size > 1 ? scalarOf(type) : null;
  };

  const fieldType = (type, field) => {
    if (!type) return null;
    if (structs.has(type)) return structs.get(type)[field] ?? null;
    const scalar = scalarOf(type);
    if (!scalar || isMatrix(type) || !/^[xyzwrgbastpq]{1,4}$/.test(field ?? "")) return null;
    return vectorOf(scalar, field.length);
  };

  const primary = () => {
    const token = peek();
    if (!token) throw new Unsupported("end of input");
    if (token.text === "(") {
      const first = at;
      at += 1;
      const inner = expression();
      const last = at;
      expect(")");
      return { type: inner.type, first, last, literal: inner.literal };
    }
    if (token.type === "number") {
      at += 1;
      const isFloat = /[.eE]/.test(token.text) && !/^0[xX]/.test(token.text) || /[fF]$/.test(token.text);
      const type = isFloat ? "float" : /[uU]$/.test(token.text) ? "uint" : "int";
      return { type, first: at - 1, last: at - 1, literal: type === "int" ? at - 1 : null };
    }
    if (token.type !== "ident") throw new Unsupported(`unexpected ${token.text}`);
    if (token.text === "true" || token.text === "false") {
      at += 1;
      return { type: "bool", first: at - 1, last: at - 1 };
    }
    const first = at;
    at += 1;
    // Constructors: `vec3(…)`, `float[3](…)`, `S(…)`.
    if (isType(token.text)) {
      let type = token.text;
      if (text() === "[") {
        skipBalanced();
        type += "[]";
      }
      if (text() !== "(") throw new Unsupported("type without call");
      const args = callArguments();
      const last = at - 1;
      if (type.endsWith("[]")) {
        const element = type.slice(0, -2);
        for (const arg of args) coerceTo(element, arg);
      } else if (structs.has(type)) {
        const fields = Object.values(structs.get(type));
        args.forEach((arg, index) => coerceTo(fields[index], arg));
      }
      return { type, first, last };
    }
    if (text() === "(") {
      const args = callArguments();
      const last = at - 1;
      return { type: callType(token.text, args), first, last };
    }
    return { type: lookup(token.text) ?? null, first, last: first };
  };

  const callArguments = () => {
    expect("(");
    const args = [];
    if (text() === "void" && text(1) === ")") at += 1;
    while (text() !== ")") {
      args.push(assignment());
      if (text() === ",") at += 1;
      else if (text() !== ")") throw new Unsupported("argument list");
    }
    expect(")");
    return args;
  };

  const coerceTo = (target, node) => {
    if (!target || !node?.type) return;
    if (isFloaty(target) && isInty(node.type) && sizeOf(target) >= 1 && (sizeOf(node.type) === sizeOf(target) || sizeOf(node.type) === 1 && sizeOf(target) === 1)) {
      convert(node, "float");
    } else if (scalarOf(target) === "uint" && scalarOf(node.type) === "int" && sizeOf(node.type) === sizeOf(target)) {
      convert(node, "uint");
    }
  };

  const callType = (name, args) => {
    const user = functions.get(name);
    if (user) {
      const candidates = user.filter((signature) => signature.params.length === args.length);
      const exact = candidates.find((signature) => signature.params.every((param, index) => param === args[index].type));
      if (exact) return exact.returns;
      const loose = candidates.find((signature) => signature.params.every((param, index) => param === args[index].type
        || (isFloaty(param) && isInty(args[index].type) && sizeOf(param) === sizeOf(args[index].type))
        || (scalarOf(param) === "uint" && scalarOf(args[index].type) === "int" && sizeOf(param) === sizeOf(args[index].type))));
      if (loose) {
        loose.params.forEach((param, index) => coerceTo(param, args[index]));
        return loose.returns;
      }
      return candidates[0]?.returns ?? null;
    }
    const rule = BUILTINS[name];
    if (!rule) return null;
    if (rule === "texture" || rule === "fetch" || rule === "size") {
      const sampler = args[0]?.type;
      const ints = INT_ARGS[name] ?? [];
      args.forEach((arg, index) => {
        if (index > 0 && !ints.includes(index) && isInty(arg.type)) convert(arg, "float");
      });
      if (rule === "size") return vectorOf("int", SAMPLER_DIMENSIONS[sampler] ?? 2);
      if (sampler === "isampler2D" || sampler === "isampler3D") return "ivec4";
      if (sampler === "usampler2D" || sampler === "usampler3D") return "uvec4";
      return "vec4";
    }
    const numeric = args.filter((arg) => arg.type && scalarOf(arg.type) !== "bool");
    const anyFloat = numeric.some((arg) => isFloaty(arg.type));
    const allInt = numeric.length > 0 && numeric.every((arg) => isInty(arg.type));
    // Integer arguments by signature (intBitsToFloat, unpackHalf2x16…), and the comparisons,
    // which have integer overloads: converted only beside a float.
    const integerSignature = rule === "vecOfInt" || rule === "vec2" || name === "not" || rule === "bool";
    const keepsInts = rule === "intOk" || rule === "bvec";
    if (!integerSignature && !(keepsInts && allInt)) {
      // mix(genType, genType, genBType) keeps its bool; the rest is float.
      for (const arg of args) if (isInty(arg.type) && (anyFloat || !keepsInts)) convert(arg, "float");
    }
    const widest = args.reduce((best, arg) => (arg.type && sizeOf(arg.type) > sizeOf(best ?? "") ? arg.type : best), args[0]?.type ?? null);
    switch (rule) {
      case GEN:
      case "intOk":
      case "mix":
        return isMatrix(args[0]?.type) ? args[0].type : widest;
      case "float": return "float";
      case "vec3": return "vec3";
      case "vec2": return "vec2";
      case "uint": return "uint";
      case "bool": return "bool";
      case "arg0": return args[0]?.type ?? null;
      case "bvec": return vectorOf("bool", sizeOf(args[0]?.type));
      case "bvecOf": return vectorOf("bool", sizeOf(args[0]?.type));
      case "ivecOf": return vectorOf("int", sizeOf(args[0]?.type));
      case "uvecOf": return vectorOf("uint", sizeOf(args[0]?.type));
      case "vecOfInt": return vectorOf("float", sizeOf(args[0]?.type));
      case "transpose": {
        const shape = matrixShape(args[0]?.type ?? "");
        return shape ? (shape.rows === shape.columns ? args[0].type : `mat${shape.rows}x${shape.columns}`) : null;
      }
      case "outer": return `mat${sizeOf(args[1]?.type)}x${sizeOf(args[0]?.type)}`;
      default: return null;
    }
  };

  // ---- statements
  const declarationAhead = () => {
    let offset = 0;
    while (QUALIFIERS.has(text(offset))) offset += 1;
    const name = text(offset);
    if (!name || !isType(name)) return false;
    // `vec3(…)` begins an expression; `vec3 x` or `float[2] x` a declaration.
    const next = text(offset + 1);
    return next !== "(" && next !== "." && (next !== "[" || stream.slice(at + offset + 1).findIndex((token) => token.text === "]") >= 0 && declaresAfterBracket(offset + 1));
  };
  const declaresAfterBracket = (offset) => {
    let depth = 0;
    let index = offset;
    do {
      if (text(index) === "[") depth += 1;
      if (text(index) === "]") depth -= 1;
      index += 1;
    } while (text(index) !== undefined && depth > 0);
    return peek(index)?.type === "ident";
  };

  const declaration = (scope) => {
    const type = readType();
    if (!type) throw new Unsupported("declaration type");
    if (text() === ";") {
      at += 1;
      return;
    }
    for (;;) {
      const name = text();
      at += 1;
      let declared = type;
      if (text() === "[") {
        skipBalanced();
        if (!declared.endsWith("[]")) declared += "[]";
      }
      scope.set(name, declared);
      if (text() === "=") {
        at += 1;
        const init = assignment();
        coerceTo(declared, init);
        if (declared.endsWith("[]") && init.type?.endsWith("[]")) {
          // `float a[2] = float[](1, 2)` is handled by the constructor.
        }
      }
      if (text() === ",") {
        at += 1;
        continue;
      }
      expect(";");
      return;
    }
  };

  const statement = (returns) => {
    const word = text();
    if (word === "{") {
      at += 1;
      scopes.push(new Map());
      while (text() !== "}") {
        if (text() === undefined) throw new Unsupported("unclosed block");
        statement(returns);
      }
      at += 1;
      scopes.pop();
      return;
    }
    if (word === ";") {
      at += 1;
      return;
    }
    if (word === "if") {
      at += 1;
      expect("(");
      expression();
      expect(")");
      statement(returns);
      if (text() === "else") {
        at += 1;
        statement(returns);
      }
      return;
    }
    if (word === "for") {
      at += 1;
      expect("(");
      scopes.push(new Map());
      if (text() !== ";") {
        if (declarationAhead()) declaration(scopes.at(-1));
        else {
          expression();
          expect(";");
        }
      } else at += 1;
      if (text() !== ";") expression();
      expect(";");
      if (text() !== ")") expression();
      expect(")");
      statement(returns);
      scopes.pop();
      return;
    }
    if (word === "while") {
      at += 1;
      expect("(");
      expression();
      expect(")");
      statement(returns);
      return;
    }
    if (word === "do") {
      at += 1;
      statement(returns);
      if (text() !== "while") throw new Unsupported("do without while");
      at += 1;
      expect("(");
      expression();
      expect(")");
      expect(";");
      return;
    }
    if (word === "switch") {
      at += 1;
      expect("(");
      expression();
      expect(")");
      statement(returns);
      return;
    }
    if (word === "case") {
      at += 1;
      expression();
      expect(":");
      return;
    }
    if (word === "default") {
      at += 1;
      expect(":");
      return;
    }
    if (word === "return") {
      at += 1;
      if (text() !== ";") {
        const value = expression();
        coerceTo(returns, value);
      }
      expect(";");
      return;
    }
    if (word === "break" || word === "continue" || word === "discard") {
      at += 1;
      expect(";");
      return;
    }
    if (word === "struct") {
      structDefinition(scopes.at(-1));
      return;
    }
    if (declarationAhead()) {
      declaration(scopes.at(-1));
      return;
    }
    expression();
    expect(";");
  };

  const structDefinition = (scope) => {
    at += 1; // struct
    const name = text();
    at += 1;
    expect("{");
    const fields = {};
    structs.set(name, fields);
    while (text() !== "}") {
      const type = readType();
      if (!type) throw new Unsupported("struct field");
      for (;;) {
        const field = text();
        at += 1;
        let declared = type;
        if (text() === "[") {
          skipBalanced();
          declared += "[]";
        }
        fields[field] = declared;
        if (text() === ",") {
          at += 1;
          continue;
        }
        expect(";");
        break;
      }
    }
    at += 1;
    // `struct S { … } s;`
    while (text() !== ";" && text() !== undefined) {
      if (peek().type === "ident") scope.set(text(), name);
      at += 1;
    }
    at += 1;
  };

  // ---- the file
  const external = () => {
    const word = text();
    if (word === "precision") {
      while (text() !== ";" && text() !== undefined) at += 1;
      at += 1;
      return;
    }
    if (word === ";") {
      at += 1;
      return;
    }
    if (word === "struct" || (QUALIFIERS.has(word) && text(1) === "struct")) {
      while (text() !== "struct") at += 1;
      structDefinition(globals);
      return;
    }
    const start = at;
    const type = readType();
    if (!type) {
      // An interface block or something else this does not read: skip to its end.
      at = start;
      skipStatement();
      return;
    }
    if (peek()?.type === "ident" && text(1) === "(") {
      const name = text();
      at += 1;
      // Parameters.
      expect("(");
      const params = [];
      const paramNames = [];
      while (text() !== ")") {
        if (text() === "void" && text(1) === ")") {
          at += 1;
          break;
        }
        const paramType = readType();
        if (!paramType) throw new Unsupported("parameter type");
        let declared = paramType;
        if (peek()?.type === "ident") {
          paramNames.push(text());
          at += 1;
        } else paramNames.push(null);
        if (text() === "[") {
          skipBalanced();
          if (!declared.endsWith("[]")) declared += "[]";
        }
        params.push(declared);
        if (text() === ",") at += 1;
      }
      expect(")");
      const list = functions.get(name) ?? [];
      if (!list.some((signature) => signature.params.join() === params.join())) list.push({ params, returns: type });
      functions.set(name, list);
      if (text() === ";") {
        at += 1;
        return;
      }
      const bodyStart = at;
      scopes = [globals, new Map(paramNames.filter(Boolean).map((paramName, index) => [paramName, params[index]]))];
      const before = fixes.length;
      try {
        statement(type);
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        // Not read: whatever it found in this function is dropped, the body skipped.
        fixes.length = before;
        at = bodyStart;
        skipBalanced();
      }
      scopes = [globals];
      return;
    }
    at = start;
    const before = fixes.length;
    try {
      declaration(globals);
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      fixes.length = before;
      at = start;
      skipStatement();
    }
  };

  const skipStatement = () => {
    let depth = 0;
    while (at < stream.length) {
      const value = text();
      if (value === "{" || value === "(" || value === "[") depth += 1;
      else if (value === "}" || value === ")" || value === "]") depth -= 1;
      at += 1;
      if (depth === 0 && (value === ";" || value === "}")) {
        if (value === "}" && text() === ";") at += 1;
        return;
      }
    }
  };

  while (at < stream.length) {
    const before = at;
    try {
      external();
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      at = before;
      skipStatement();
    }
    if (at === before) at += 1;
  }
  return { tokens, stream, fixes };
}

/**
 * The source with the conversions written in. A literal from the source is rewritten in place;
 * an expression whose tokens cover a stretch of the source exactly is wrapped; a literal that
 * comes from a macro's body is rewritten in the macro when nothing else would do.
 */
export function applyConversions(source) {
  const { tokens, stream, fixes } = findConversions(source);
  if (!fixes.length) return { code: source, converted: 0, skipped: 0 };
  const before = new Map(); // source index -> text to put before
  const after = new Map();
  const replace = new Map();
  const directives = new Map(); // directive index -> Map(body index -> new text)
  let converted = 0;
  let skipped = 0;
  const literalText = (text, to) => {
    const value = /^0[xX]/.test(text) ? parseInt(text, 16) : parseInt(text.replace(/[uU]$/, ""), 10);
    if (to === "uint" || /^u/.test(to)) return `${value}u`;
    return `${value}.0`;
  };
  // The outermost fixes first: a wrap that contains a literal already rewritten is fine.
  const seen = new Set();
  for (const fix of fixes) {
    const key = `${fix.first}:${fix.last}:${fix.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scalar = fix.to && !/vec/.test(fix.to);
    const literal = fix.literal !== null && scalar && fix.first === fix.last ? stream[fix.literal] : null;
    // A negative literal (`-1`) is a unary minus and a literal; the literal alone is rewritten.
    const negative = fix.literal !== null && scalar && fix.last === fix.literal && fix.first !== fix.last
      && stream.slice(fix.first, fix.literal).every((token) => token.text === "-" || token.text === "+" || token.text === "(")
      ? stream[fix.literal] : null;
    const target = literal ?? negative;
    if (target) {
      const to = fix.to.startsWith("u") || fix.to === "uint" ? "uint" : "float";
      if (target.src >= 0) {
        replace.set(target.src, literalText(tokens[target.src].text, to));
        converted += 1;
        continue;
      }
      if (target.macro && target.macro.directive >= 0 && wrapRange(fix) === null) {
        const edits = directives.get(target.macro.directive) ?? new Map();
        edits.set(target.macro.index, literalText(target.text, to));
        directives.set(target.macro.directive, edits);
        converted += 1;
        continue;
      }
    }
    const range = wrapRange(fix);
    if (range === null || !fix.to) {
      skipped += 1;
      continue;
    }
    before.set(range[0], `${before.get(range[0]) ?? ""}${fix.to}(`);
    after.set(range[1], `)${after.get(range[1]) ?? ""}`);
    converted += 1;
  }
  const out = tokens.map((token, index) => {
    let text = replace.get(index) ?? token.text;
    if (token.type === "pp" && directives.has(index)) text = rewriteDirective(text, directives.get(index));
    return `${before.get(index) ?? ""}${text}${after.get(index) ?? ""}`;
  });
  return { code: out.join(""), converted, skipped };

  /** The source tokens [first, last] the expression covers exactly, or null. */
  function wrapRange(fix) {
    let first = Infinity;
    let last = -Infinity;
    for (let index = fix.first; index <= fix.last; index += 1) {
      first = Math.min(first, stream[index].site[0]);
      last = Math.max(last, stream[index].site[1]);
    }
    if (!Number.isFinite(first)) return null;
    // Nothing outside the expression may come from that stretch of the source.
    const outside = (index) => index >= 0 && index < stream.length && stream[index].site[1] >= first && stream[index].site[0] <= last;
    if (outside(fix.first - 1) || outside(fix.last + 1)) return null;
    // A directive inside the stretch would be cut in two.
    for (let index = first; index <= last; index += 1) if (tokens[index].type === "pp") return null;
    return [first, last];
  }
}

function rewriteDirective(text, edits) {
  const match = /^(\s*#\s*define\s+[A-Za-z_]\w*(?:\([^)]*\))?)([\s\S]*)$/.exec(text);
  if (!match) return text;
  const body = tokenize(match[2]);
  let index = -1;
  return match[1] + body.map((token) => {
    if (token.type === "space" || token.type === "comment") return token.text;
    index += 1;
    return edits.get(index) ?? token.text;
  }).join("");
}

