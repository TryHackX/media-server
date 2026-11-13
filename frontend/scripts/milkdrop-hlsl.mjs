/**
 * MilkDrop 2 shader source, rewritten so that hlslparser-js translates it
 * faithfully.
 *
 * milkdrop-preset-converter (0.1.2) turns a preset's HLSL warp and composite
 * shaders into GLSL with hlslparser-js, and that translator has a bug: in an
 * operator chain, every operator after the first one at the same nesting level
 * comes out as `&&`. `a + b + c` becomes `bool(a + b) && bool(c)`, and
 * `x * scale1 + bias1` — the body of GetBlur1, which nearly every MilkDrop 2
 * shader calls — becomes `bvec3(x * scale1) && bvec3(bias1)`. The GLSL compiles
 * and draws nonsense; of the 8 500 shaders in the two projectM packs, 8 387 were
 * hit. (The operator a nested parse stops at is rejected for its priority and
 * then accepted by the outer one; it is the second look that loses the operator.)
 *
 * The bug never fires when every binary operation stands in parentheses of its
 * own: then a nested parse always stops at `)`, never at an operator. So before
 * the converter sees a shader, this module
 *
 *   1. expands the macros the converter's prelude defines (GetBlur1–3,
 *      GetPixel, GetMain, lum, tex2d, tex3d) and the preset's own `#define`s,
 *      resolving `#if 0` / `#if 1` blocks, because a macro body is an operator
 *      chain the parenthesising below would otherwise never see;
 *   2. writes every expression that contains an operator fully parenthesised,
 *      by the ordinary C precedence and associativity HLSL uses — which leaves
 *      its meaning exactly as it was.
 *
 * It also unwraps `(float2(1, 0))`: a constructor alone in parentheses is a
 * parse error for hlslparser as soon as an operator follows it.
 *
 * Whatever this module does not understand it leaves untouched: an unknown
 * directive makes `rewriteShader` throw (the caller then converts the original
 * text), and an expression it cannot parse is copied as it was. The caller
 * checks the result either way (`logicalOperators`): the bug always produces a
 * `&&`, so GLSL with more of them than its HLSL had is rejected.
 */

export class RewriteError extends Error {}

/** The macros milkdrop-preset-utils' prepareShader puts in front of every shader. */
export const PRELUDE_MACROS = `
#define GetMain(uv) (tex2D(sampler_main,uv).xyz)
#define GetPixel(uv) (tex2D(sampler_main,uv).xyz)
#define GetBlur1(uv) (tex2D(sampler_blur1,uv).xyz*scale1 + bias1)
#define GetBlur2(uv) (tex2D(sampler_blur2,uv).xyz*scale2 + bias2)
#define GetBlur3(uv) (tex2D(sampler_blur3,uv).xyz*scale3 + bias3)
#define lum(x) (dot(x,float3(0.32,0.49,0.29)))
#define tex2d tex2D
#define tex3d tex3D
`;

const MULTI_CHAR_OPERATORS = ["<<=", ">>=", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||"];
const SINGLE_CHAR_OPERATORS = "+-*/%<>=!~&|^?:;,.()[]{}";
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[fFhHlLuU]*/y;

/**
 * Tokens with the whitespace that preceded each one (`pre`), so that text this
 * module does not change comes out exactly as it went in. Comments become
 * whitespace; a preprocessor line is one `directive` token.
 */
export function tokenize(source) {
  const tokens = [];
  let pre = "";
  let lineStart = true;
  let at = 0;
  const push = (type, text) => {
    tokens.push({ type, text, pre: pre.replace(/[ \t]+\n/g, "\n") });
    pre = "";
  };
  while (at < source.length) {
    const char = source[at];
    if (char === "\n") {
      pre += "\n";
      at += 1;
      lineStart = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\f" || char === "\v" || char === "\r") {
      if (char !== "\r") pre += char;
      at += 1;
      continue;
    }
    if (char === "/" && source[at + 1] === "/") {
      while (at < source.length && source[at] !== "\n") at += 1;
      continue;
    }
    if (char === "/" && source[at + 1] === "*") {
      const end = source.indexOf("*/", at + 2);
      const comment = source.slice(at, end < 0 ? source.length : end + 2);
      pre += comment.includes("\n") ? "\n" : " ";
      at += comment.length;
      continue;
    }
    if (char === "#" && lineStart) {
      let text = "";
      while (at < source.length && source[at] !== "\n") {
        if (source[at] === "\\" && /^\\\r?\n/.test(source.slice(at, at + 3))) {
          at += source[at + 1] === "\r" ? 3 : 2;
          text += " ";
        } else if (source[at] === "/" && source[at + 1] === "/") {
          while (at < source.length && source[at] !== "\n") at += 1;
        } else if (source[at] === "/" && source[at + 1] === "*") {
          const end = source.indexOf("*/", at + 2);
          at = end < 0 ? source.length : end + 2;
          text += " ";
        } else {
          text += source[at];
          at += 1;
        }
      }
      push("directive", text.replace(/^#\s*/, "").trim());
      continue;
    }
    lineStart = false;
    IDENTIFIER.lastIndex = at;
    NUMBER.lastIndex = at;
    let match;
    if ((match = IDENTIFIER.exec(source))) {
      push("ident", match[0]);
    } else if ((match = NUMBER.exec(source))) {
      push("number", match[0]);
    } else if (char === "\"") {
      const end = source.indexOf("\"", at + 1);
      match = [source.slice(at, end < 0 ? source.length : end + 1)];
      push("string", match[0]);
    } else {
      const operator = MULTI_CHAR_OPERATORS.find((candidate) => source.startsWith(candidate, at));
      match = [operator ?? char];
      push(operator || SINGLE_CHAR_OPERATORS.includes(char) ? "op" : "other", match[0]);
    }
    at += match[0].length;
  }
  return { tokens, trailing: pre };
}

/** Text again: every token after the whitespace it came with. */
export function untokenize(tokens, trailing = "") {
  let text = "";
  for (const token of tokens) text += token.pre + token.text;
  return text + trailing;
}

const DEFINE = /^define\s+([A-Za-z_]\w*)(\(([^)]*)\))?\s*([\s\S]*)$/;

function parseDefine(text) {
  const match = DEFINE.exec(text);
  if (!match) throw new RewriteError(`unreadable #${text}`);
  const params = match[2] === undefined ? null : match[3].split(",").map((name) => name.trim()).filter(Boolean);
  return { name: match[1], macro: { params, body: tokenize(match[4]).tokens } };
}

/** The prelude's macros, as `preprocess` keeps them. */
export function preludeMacros() {
  const macros = new Map();
  for (const token of tokenize(PRELUDE_MACROS).tokens) {
    const { name, macro } = parseDefine(token.text);
    macros.set(name, macro);
  }
  return macros;
}

const CONDITION_LEVELS = [["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">="], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];

/**
 * The value of an `#if`/`#elif` expression as a C preprocessor computes it: `defined(X)`,
 * object-like macros expanded (BeatDrop's `#if HAS_FFT_PEAK`), any other name 0, integer
 * arithmetic, comparisons, logic and `?:`. Throws RewriteError for what it cannot read.
 */
export function evaluateCondition(expression, definitions = new Map()) {
  const expand = (tokens, depth = 0) => {
    if (depth > 32) throw new RewriteError("macro expansion does not end");
    const out = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const item = tokens[index];
      if (item.type === "ident" && item.text === "defined") {
        const parenthesised = isOp(tokens[index + 1], "(");
        const name = tokens[index + (parenthesised ? 2 : 1)];
        if (name?.type !== "ident" || (parenthesised && !isOp(tokens[index + 3], ")"))) throw new RewriteError("unreadable defined()");
        out.push({ type: "number", text: definitions.has(name.text) ? "1" : "0" });
        index += parenthesised ? 3 : 1;
      } else if (item.type === "ident" && definitions.get(item.text)?.params === null) {
        out.push(...expand(definitions.get(item.text).body, depth + 1));
      } else {
        out.push(item);
      }
    }
    return out;
  };
  const tokens = expand(tokenize(String(expression)).tokens);
  let at = 0;
  const unary = () => {
    const item = tokens[at];
    if (!item) throw new RewriteError(`unsupported #if ${expression}`);
    at += 1;
    if (isOp(item, "!")) return unary() === 0 ? 1 : 0;
    if (isOp(item, "-")) return -unary();
    if (isOp(item, "+")) return unary();
    if (isOp(item, "~")) return ~unary();
    if (isOp(item, "(")) {
      const value = ternary();
      if (!isOp(tokens[at], ")")) throw new RewriteError(`unsupported #if ${expression}`);
      at += 1;
      return value;
    }
    if (item.type === "number") {
      const value = Number.parseInt(item.text.replace(/[uUlL]+$/, ""), /^0[xX]/.test(item.text) ? 16 : 10);
      if (!Number.isFinite(value) || /[.eE]/.test(item.text.replace(/^0[xX][0-9a-fA-F]+/, ""))) throw new RewriteError(`unsupported #if ${expression}`);
      return value;
    }
    if (item.type === "ident") return 0;
    throw new RewriteError(`unsupported #if ${expression}`);
  };
  const binary = (level) => {
    if (level === CONDITION_LEVELS.length) return unary();
    let left = binary(level + 1);
    while (tokens[at]?.type === "op" && CONDITION_LEVELS[level].includes(tokens[at].text)) {
      const op = tokens[at].text;
      at += 1;
      const right = binary(level + 1);
      left = {
        "||": () => (left || right ? 1 : 0), "&&": () => (left && right ? 1 : 0), "|": () => left | right, "^": () => left ^ right, "&": () => left & right,
        "==": () => (left === right ? 1 : 0), "!=": () => (left !== right ? 1 : 0), "<": () => (left < right ? 1 : 0), ">": () => (left > right ? 1 : 0),
        "<=": () => (left <= right ? 1 : 0), ">=": () => (left >= right ? 1 : 0), "<<": () => left << right, ">>": () => left >> right,
        "+": () => left + right, "-": () => left - right, "*": () => left * right,
        "/": () => (right === 0 ? 0 : Math.trunc(left / right)), "%": () => (right === 0 ? 0 : left % right)
      }[op]();
    }
    return left;
  };
  const ternary = () => {
    const condition = binary(0);
    if (!isOp(tokens[at], "?")) return condition;
    at += 1;
    const whenTrue = ternary();
    if (!isOp(tokens[at], ":")) throw new RewriteError(`unsupported #if ${expression}`);
    at += 1;
    const whenFalse = ternary();
    return condition ? whenTrue : whenFalse;
  };
  const value = ternary();
  if (at !== tokens.length) throw new RewriteError(`unsupported #if ${expression}`);
  return value;
}

const MAX_EXPANSIONS = 20000;

/** A macro's tokens in place of its name, marked so that it is not expanded again inside itself. */
function substitute(macro, args, call) {
  const hide = new Set(call.hide ?? []);
  hide.add(call.text);
  const result = [];
  for (const token of macro.body) {
    const index = token.type === "ident" && macro.params ? macro.params.indexOf(token.text) : -1;
    if (index >= 0) {
      args[index].forEach((arg, position) => result.push({ ...arg, pre: position === 0 ? token.pre : arg.pre, hide: new Set([...(arg.hide ?? []), ...hide]) }));
    } else {
      result.push({ ...token, hide });
    }
  }
  if (result.length) result[0] = { ...result[0], pre: call.pre };
  return result;
}

/** The argument lists of a function-like macro call, `(` already taken. */
function collectArguments(stack) {
  const args = [[]];
  let depth = 0;
  for (;;) {
    const token = stack.pop();
    if (!token) throw new RewriteError("unterminated macro call");
    if (token.type === "directive") throw new RewriteError("directive inside a macro call");
    if (token.type === "op" && (token.text === "(" || token.text === "[" || token.text === "{")) depth += 1;
    if (token.type === "op" && (token.text === ")" || token.text === "]" || token.text === "}")) {
      if (depth === 0) return args;
      depth -= 1;
    }
    if (depth === 0 && token.type === "op" && token.text === ",") args.push([]);
    else args.at(-1).push(token);
  }
}

/**
 * Expand macros and resolve conditional blocks, the way a C preprocessor would
 * for the little MilkDrop shaders use: object-like `#define`s anywhere, the
 * prelude's function-like macros, `#undef`, `#if <number>`, `#ifdef`,
 * `#ifndef`, `#elif <number>`, `#else` and `#endif`. Anything else is refused.
 */
export function preprocess(tokens, macros = preludeMacros()) {
  const definitions = new Map(macros);
  const output = [];
  const stack = [...tokens].reverse();
  const conditions = [];
  let expansions = 0;
  const active = () => conditions.every((condition) => condition.active);
  const number = (expression) => evaluateCondition(expression, definitions) !== 0;
  const expand = (list) => {
    const inner = [...list].reverse();
    const result = [];
    while (inner.length) step(inner.pop(), inner, result);
    return result;
  };
  function step(token, source, target) {
    const macro = token.type === "ident" && !token.hide?.has(token.text) ? definitions.get(token.text) : undefined;
    if (!macro) {
      target.push(token);
      return;
    }
    const next = source.at(-1);
    if (macro.params && !(next?.type === "op" && next.text === "(")) {
      target.push(token);
      return;
    }
    expansions += 1;
    if (expansions > MAX_EXPANSIONS) throw new RewriteError("macro expansion does not end");
    let args = [];
    if (macro.params) {
      source.pop();
      args = collectArguments(source);
      if (macro.params.length === 0 && args.length === 1 && args[0].length === 0) args = [];
      if (args.length !== macro.params.length) throw new RewriteError(`${token.text} takes ${macro.params.length} arguments`);
      args = args.map(expand);
    }
    const replacement = substitute(macro, args, token);
    for (let index = replacement.length - 1; index >= 0; index -= 1) source.push(replacement[index]);
  }
  while (stack.length) {
    const token = stack.pop();
    if (token.type !== "directive") {
      if (active()) step(token, stack, output);
      continue;
    }
    const [keyword = "", ...rest] = token.text.split(/\s+/);
    const argument = rest.join(" ");
    if (keyword === "if") conditions.push({ active: active() && number(argument), taken: false, parent: active() });
    else if (keyword === "ifdef" || keyword === "ifndef") conditions.push({ active: active() && definitions.has(argument.trim()) === (keyword === "ifdef"), taken: false, parent: active() });
    else if (keyword === "elif" || keyword === "else" || keyword === "endif") {
      const condition = conditions.at(-1);
      if (!condition) throw new RewriteError(`#${keyword} without #if`);
      if (keyword === "endif") conditions.pop();
      else {
        condition.taken ||= condition.active;
        conditions.pop();
        const enter = !condition.taken && condition.parent && (keyword === "else" || number(argument));
        conditions.push({ active: enter, taken: condition.taken, parent: condition.parent });
      }
    } else if (!active()) continue;
    else if (keyword === "define") {
      const { name, macro } = parseDefine(token.text);
      definitions.set(name, macro);
    } else if (keyword === "undef") definitions.delete(argument.trim());
    else throw new RewriteError(`unsupported #${keyword}`);
  }
  if (conditions.length) throw new RewriteError("#if without #endif");
  return output;
}

const OPENING = { "(": ")", "[": "]", "{": "}" };
const CLOSING = { ")": "(", "]": "[", "}": "{" };

function isOp(item, ...texts) {
  return item?.type === "op" && texts.includes(item.text);
}

function isGroup(item, open) {
  return item?.type === "group" && item.open.text === open;
}

/** Brackets become groups, so that an expression can treat one as a single operand. */
function nest(tokens) {
  const root = { children: [] };
  const stack = [root];
  for (const token of tokens) {
    if (token.type === "op" && OPENING[token.text]) {
      const group = { type: "group", open: token, children: [], close: null };
      stack.at(-1).children.push(group);
      stack.push(group);
    } else if (token.type === "op" && CLOSING[token.text]) {
      const group = stack.pop();
      if (stack.length === 0 || group.open.text !== CLOSING[token.text]) throw new RewriteError("unbalanced brackets");
      group.close = token;
    } else {
      stack.at(-1).children.push(token);
    }
  }
  if (stack.length !== 1) throw new RewriteError("unbalanced brackets");
  return root.children;
}

const PRECEDENCE = {
  "*": 10, "/": 10, "%": 10,
  "+": 9, "-": 9,
  "<<": 8, ">>": 8,
  "<": 7, ">": 7, "<=": 7, ">=": 7,
  "==": 6, "!=": 6,
  "&": 5,
  "^": 4,
  "|": 3,
  "&&": 2,
  "||": 1
};
const TERNARY = 0;
const ASSIGNMENTS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);
const TYPE_NAME = /^(?:float|half|double|int|uint|bool|dword|min16float|min10float|min16int|min12int|min16uint)(?:[1-4](?:x[1-4])?)?$/;
const TEMPLATE_TYPES = /^(?:vector|matrix|Texture\w*|Sampler\w*|sampler\w*|Buffer)$/;
const STATEMENT_HEADS = new Set(["if", "while", "for", "switch"]);
const STATEMENT_WORDS = new Set(["else", "do", "return"]);

const opening = () => ({ type: "op", text: "(", pre: "", inserted: true });
const closing = () => ({ type: "op", text: ")", pre: "", inserted: true });

function isTypeName(item) {
  return item?.type === "ident" && TYPE_NAME.test(item.text);
}

/** `(float3)` before an operand. */
function isCast(item, following) {
  return isGroup(item, "(") && item.children.length === 1 && isTypeName(item.children[0])
    && Boolean(following) && !isOp(following, ")", "]", "}", ";", ",", "?", ":") && !(following.type === "op" && PRECEDENCE[following.text] !== undefined && !isOp(following, "-", "+"));
}

class ExpressionParser {
  constructor(items) {
    this.items = items;
    this.at = 0;
  }

  parse() {
    const tree = this.expression(TERNARY);
    if (this.at !== this.items.length) throw new RewriteError("not an expression");
    return tree;
  }

  expression(minimum) {
    let left = this.unary();
    for (;;) {
      const item = this.items[this.at];
      const precedence = item?.type === "op" ? PRECEDENCE[item.text] : undefined;
      if (precedence !== undefined && precedence >= minimum) {
        this.at += 1;
        left = { kind: "binary", op: item, left, right: this.expression(precedence + 1) };
      } else if (isOp(item, "?") && minimum <= TERNARY) {
        this.at += 1;
        const whenTrue = this.expression(TERNARY);
        const colon = this.items[this.at];
        if (!isOp(colon, ":")) throw new RewriteError("? without :");
        this.at += 1;
        left = { kind: "ternary", condition: left, question: item, whenTrue, colon, whenFalse: this.expression(TERNARY) };
      } else {
        return left;
      }
    }
  }

  unary() {
    const item = this.items[this.at];
    if (isOp(item, "-", "+", "!", "~", "++", "--")) {
      this.at += 1;
      return { kind: "unary", op: item, operand: this.unary() };
    }
    if (isCast(item, this.items[this.at + 1])) {
      this.at += 1;
      return { kind: "cast", type: item, operand: this.unary() };
    }
    return this.postfix();
  }

  postfix() {
    const first = this.items[this.at];
    if (!first || !(first.type === "ident" || first.type === "number" || first.type === "string" || isGroup(first, "("))) {
      throw new RewriteError("operand expected");
    }
    this.at += 1;
    const parts = [first];
    for (;;) {
      const item = this.items[this.at];
      const last = parts.at(-1);
      if ((isGroup(item, "(") && (last.type === "ident" || isGroup(last, "[") || isGroup(last, "("))) || isGroup(item, "[")) {
        parts.push(item);
        this.at += 1;
      } else if (isOp(item, ".") && this.items[this.at + 1]?.type === "ident") {
        parts.push(item, this.items[this.at + 1]);
        this.at += 2;
      } else if (isOp(item, "++", "--")) {
        parts.push(item);
        this.at += 1;
      } else {
        return { kind: "atom", parts };
      }
    }
  }
}

/** A group whose whole content is a constructor call — `(float2(1, 0))` — loses its parentheses. */
function lonelyConstructor(children) {
  if (children.length < 2 || !isTypeName(children[0]) || !isGroup(children[1], "(")) return false;
  for (let index = 2; index < children.length; index += 1) {
    const item = children[index];
    if (isGroup(item, "[")) continue;
    if (isOp(item, ".") && children[index + 1]?.type === "ident") {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function emitItem(item, out, unwrap = false) {
  if (item.type !== "group") {
    out.push(item);
    return;
  }
  const children = rewriteSequence(item.children);
  const start = out.length;
  if (unwrap && item.open.text === "(" && lonelyConstructor(item.children)) {
    for (const child of children) emitItem(child, out);
    if (out.length > start) out[start] = { ...out[start], pre: item.open.pre + out[start].pre };
    return;
  }
  out.push(item.open);
  for (const child of children) emitItem(child, out);
  out.push(item.close);
}

const inserted = (type, text) => ({ type, text, pre: "", inserted: true });

/**
 * Whether a node's text begins with a constructor, `float3(…)` — directly or as `(float3(…))`,
 * which emitItem unwraps. Right after a `(` hlslparser takes that for a parenthesised
 * constructor and returns before reading what follows it, so `(float3(a, b, c).z * 2)` is a
 * syntax error there; a unary `+` in front (a no-op) keeps it an ordinary operand.
 */
function leadingConstructor(node) {
  if (node.kind === "binary") return leadingConstructor(node.left);
  if (node.kind === "ternary") return leadingConstructor(node.condition);
  if (node.kind !== "atom") return false;
  const [first, second] = node.parts;
  if (isTypeName(first) && isGroup(second, "(")) return !/^bool/.test(first.text);
  return isGroup(first, "(") && lonelyConstructor(first.children) && !/^bool/.test(first.children[0].text);
}

/** The opening bracket of an operation; with a `+` after it when the operation begins with a constructor. */
function open(node, out) {
  out.push(opening());
  if (leadingConstructor(node)) out.push(inserted("op", "+"));
}

function emitNode(node, out) {
  switch (node.kind) {
    case "binary":
      // HLSL's % on floats is fmod; hlslparser writes int(a) % int(b) (and nothing valid for vectors).
      if (node.op.text === "%") {
        out.push(inserted("ident", FMOD), opening());
        emitNode(node.left, out);
        out.push(inserted("op", ","));
        emitNode(node.right, out);
        out.push(closing());
        return;
      }
      open(node, out);
      emitNode(node.left, out);
      out.push(node.op);
      emitNode(node.right, out);
      out.push(closing());
      return;
    case "ternary":
      open(node, out);
      emitNode(node.condition, out);
      out.push(node.question);
      emitNode(node.whenTrue, out);
      out.push(node.colon);
      emitNode(node.whenFalse, out);
      out.push(closing());
      return;
    case "unary":
      out.push(node.op);
      emitNode(node.operand, out);
      return;
    case "cast":
      out.push(opening());
      emitItem(node.type, out);
      emitNode(node.operand, out);
      out.push(closing());
      return;
    default:
      node.parts.forEach((part, index) => emitItem(part, out, index === 0));
  }
}

/** Groups stay groups here; `emitItem` flattens them. */
function rewriteSpan(span) {
  let start = 0;
  for (;;) {
    const item = span[start];
    if (item?.type === "ident" && STATEMENT_HEADS.has(item.text) && isGroup(span[start + 1], "(")) start += 2;
    else if (item?.type === "ident" && STATEMENT_WORDS.has(item.text)) start += 1;
    else if (start === 0 && isGroup(item, "[")) start += 1;
    else break;
  }
  const body = span.slice(start);
  const operators = body.filter((item) => item.type === "op" && (PRECEDENCE[item.text] !== undefined || item.text === "?")).length;
  const template = body.some((item, index) => item.type === "ident" && TEMPLATE_TYPES.test(item.text) && isOp(body[index + 1], "<"));
  const out = [];
  span.slice(0, start).forEach((item) => emitItem(item, out));
  if (operators === 0 || template) {
    body.forEach((item) => emitItem(item, out));
    return out;
  }
  let tree;
  try {
    tree = new ExpressionParser(body).parse();
  } catch (error) {
    if (!(error instanceof RewriteError)) throw error;
    body.forEach((item) => emitItem(item, out));
    return out;
  }
  const emitted = [];
  emitNode(tree, emitted);
  // The span's leading whitespace goes in front of whatever now comes first.
  const original = emitted.findIndex((token) => !token.inserted);
  if (original > 0) {
    emitted[0] = { ...emitted[0], pre: emitted[original].pre };
    emitted[original] = { ...emitted[original], pre: "" };
  }
  out.push(...emitted);
  return out;
}

function isSeparator(item) {
  return isGroup(item, "{") || isOp(item, ";", ",") || (item.type === "op" && ASSIGNMENTS.has(item.text));
}

/** Statements, declarations, argument lists: split at separators, each piece an expression or not. */
function rewriteSequence(items) {
  const out = [];
  let span = [];
  for (const item of items) {
    if (isSeparator(item)) {
      out.push(...rewriteSpan(span), item);
      span = [];
    } else {
      span.push(item);
    }
  }
  out.push(...rewriteSpan(span));
  return out;
}

/** HLSL's fmod, as the shader's own function: hlslparser writes GLSL's mod(), which floors where fmod truncates. */
export const FMOD = "hlsl_fmod";

const FMOD_SHAPES = [["float", "float"], ["float2", "float2"], ["float3", "float3"], ["float4", "float4"],
  ["float2", "float"], ["float3", "float"], ["float4", "float"], ["float", "float2"], ["float", "float3"], ["float", "float4"]];

/** HLSL's fmod (x − y·trunc(x / y), the sign of x) for every shape `%` and fmod() take; prepended when the shader calls it. */
export function withFmod(text) {
  if (!new RegExp(`\\b${FMOD}\\s*\\(`).test(text) || new RegExp(`\\b(?:float[234]?)\\s+${FMOD}\\s*\\(`).test(text)) return text;
  const definitions = FMOD_SHAPES.map(([a, b]) => {
    const result = a === "float" ? b : a;
    // trunc() as hlslparser knows it: sign × floor of the magnitude.
    return `${result} ${FMOD}(${a} a, ${b} b) { ${result} q = a / b; return a - b * (sign(q) * floor(abs(q))); }`;
  });
  return `${definitions.join("\n")}\n${text}`;
}

/**
 * Names D3DX's shader model 2/3 compiler let presets use for their own variables and hlslparser
 * reads as keywords (`sample` is an interpolation modifier from shader model 4 on).
 */
const RESERVED_NAMES = new Set(["sample"]);

/** The index of the bracket closing the one at `start`, or -1. */
function matchingBracket(tokens, start) {
  const opener = tokens[start].text;
  const closer = OPENING[opener];
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (isOp(tokens[index], opener)) depth += 1;
    else if (isOp(tokens[index], closer)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Tokens split at `separator` where no bracket is open; the separators themselves dropped. */
function splitTopLevel(tokens, separator) {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (isOp(token, "(", "[", "{")) depth += 1;
    else if (isOp(token, ")", "]", "}")) depth -= 1;
    if (depth === 0 && isOp(token, separator)) parts.push([]);
    else parts.at(-1).push(token);
  }
  return parts;
}

const makeToken = (type, text, pre = "") => ({ type, text, pre });
const LOOP_WORDS = new Set(["for", "while", "do"]);
const isWord = (item, ...words) => item?.type === "ident" && words.includes(item.text);

/**
 * The index of the last token of the statement that begins at `start` — a block, an if/else,
 * a loop with its body, or a plain statement up to its `;` — or -1.
 */
function statementEnd(tokens, start) {
  const first = tokens[start];
  if (!first) return -1;
  if (isOp(first, "{")) return matchingBracket(tokens, start);
  if (isWord(first, "for", "while", "if", "switch") && isOp(tokens[start + 1], "(")) {
    const close = matchingBracket(tokens, start + 1);
    const end = close < 0 ? -1 : statementEnd(tokens, close + 1);
    if (end < 0 || !isWord(first, "if") || !isWord(tokens[end + 1], "else")) return end;
    return statementEnd(tokens, end + 2);
  }
  if (isWord(first, "do")) {
    const end = statementEnd(tokens, start + 1);
    if (end < 0 || !isWord(tokens[end + 1], "while") || !isOp(tokens[end + 2], "(")) return -1;
    const close = matchingBracket(tokens, end + 2);
    return close >= 0 && isOp(tokens[close + 1], ";") ? close + 1 : -1;
  }
  for (let at = start, depth = 0; at < tokens.length; at += 1) {
    if (isOp(tokens[at], "(", "[", "{")) depth += 1;
    else if (isOp(tokens[at], ")", "]", "}")) {
      depth -= 1;
      if (depth < 0) return -1;
    } else if (depth === 0 && isOp(tokens[at], ";")) return at;
  }
  return -1;
}

/**
 * `for` headers hlslparser does not read, the comma operator in them above all (it reads a
 * comma only between statements):
 *   - an empty first or third clause (`for (; i++ < 9; )`) gets a `0`;
 *   - a first clause of several expressions (`pos = a, ent = b`; a declaration is left alone)
 *     becomes statements in front of the loop, the two in a block of their own;
 *   - a third clause of several (`z += d, o += c / z`) becomes statements at the end of the
 *     loop's body, in their order, and in front of every `continue` of this loop.
 * A loop whose body cannot be delimited, or whose `continue`s might belong to a nested loop, is
 * left as it was.
 */
function mendForLoops(tokens) {
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const close = isWord(current, "for") && isOp(tokens[index + 1], "(") ? matchingBracket(tokens, index + 1) : -1;
    const clauses = close > 0 ? splitTopLevel(tokens.slice(index + 2, close), ";") : [];
    if (clauses.length !== 3) {
      out.push(current);
      continue;
    }
    const [init, test, step] = clauses;
    const inits = splitTopLevel(init, ",").filter((part) => part.length);
    const hoisted = inits.length > 1 && !isTypeName(init[0]) && !isWord(init[0], "static", "const");
    const steps = splitTopLevel(step, ",").filter((part) => part.length);
    const statements = (parts) => parts.flatMap((part) => [...part.map((item) => ({ ...item })), makeToken("op", ";")]);
    const header = (third) => [current, tokens[index + 1], ...(init.length && !hoisted ? init : [makeToken("number", "0")]), makeToken("op", ";"), ...test,
      makeToken("op", ";"), ...third, tokens[close]];
    const end = statementEnd(tokens, close + 1);
    const braced = isOp(tokens[close + 1], "{");
    const body = end < 0 ? null : braced ? tokens.slice(close + 2, end) : tokens.slice(close + 1, end + 1);
    const nested = body?.some((item) => item.type === "ident" && LOOP_WORDS.has(item.text));
    const continues = body?.some((item) => isWord(item, "continue"));
    if ((steps.length > 1 && (!body || (nested && continues))) || (hoisted && !body)) {
      out.push(current);
      continue;
    }
    if (hoisted) out.push(makeToken("op", "{", current.pre), ...statements(inits));
    if (steps.length <= 1) {
      out.push(...header(step.length ? step : [makeToken("number", "0", " ")]));
      if (hoisted) {
        // The loop's body as well, inside the block that holds the hoisted statements.
        out.push(...mendForLoops(tokens.slice(close + 1, end + 1)), makeToken("op", "}", "\n"));
        index = end;
      } else {
        index = close;
      }
      continue;
    }
    const mended = [];
    for (let at = 0; at < body.length; at += 1) {
      const item = body[at];
      if (isWord(item, "continue") && isOp(body[at + 1], ";")) {
        mended.push(makeToken("op", "{", item.pre), ...statements(steps), { ...item, pre: " " }, body[at + 1], makeToken("op", "}"));
        at += 1;
      } else {
        mended.push(item);
      }
    }
    out.push(...header([makeToken("number", "0", " ")]), makeToken("op", "{", " "), ...mendForLoops(mended), ...statements(steps), makeToken("op", "}", "\n"));
    if (hoisted) out.push(makeToken("op", "}"));
    index = end;
  }
  return out;
}

/**
 * What hlslparser does not read in HLSL that MilkDrop's D3DX compiled: `a %= b` (written out
 * with fmod), `for` headers (mendForLoops), and variables with reserved names.
 */
/**
 * HLSL fills an array from the components of what it is given, where GLSL wants one value an
 * element: `float spec[16] = { a, b, c, d }` with four float4s, and `float4 s[4] = { 16 numbers }`.
 * The first is written out component by component (when the count divides the size: 2, 3 or 4
 * each), the second grouped into constructors (when there are exactly size × components).
 */
function flattenArrayInitializers(tokens) {
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const size = tokens[index + 2]?.type === "number" ? Number(tokens[index + 2].text) : NaN;
    const type = tokens[index - 1];
    const named = tokens[index]?.type === "ident" && isOp(tokens[index + 1], "[") && isOp(tokens[index + 3], "]") && isOp(tokens[index + 4], "=")
      && isOp(tokens[index + 5], "{") && isTypeName(type) && /^(?:float|half)[1-4]?$/.test(type.text);
    const close = named ? matchingBracket(tokens, index + 5) : -1;
    const values = close > 0 ? splitTopLevel(tokens.slice(index + 6, close), ",").filter((part) => part.length) : [];
    const width = Number(/[234]$/.exec(type?.text ?? "")?.[0] ?? 1);
    const each = values.length && width === 1 ? size / values.length : 0;
    const grouped = close > 0 && width > 1 && Number.isInteger(size) && size > 0 && values.length === size * width;
    if (!grouped && (!(each === 2 || each === 3 || each === 4) || !Number.isInteger(size))) {
      out.push(tokens[index]);
      continue;
    }
    const parts = [];
    if (grouped) {
      for (let at = 0; at < values.length; at += width) {
        if (parts.length) parts.push(makeToken("op", ","));
        parts.push(makeToken("ident", type.text), makeToken("op", "("));
        values.slice(at, at + width).forEach((value, position) => {
          if (position) parts.push(makeToken("op", ","));
          parts.push(...value.map((item) => ({ ...item })));
        });
        parts.push(makeToken("op", ")"));
      }
    } else {
      for (const value of values) {
        for (const component of "xyzw".slice(0, each)) {
          if (parts.length) parts.push(makeToken("op", ","));
          parts.push(makeToken("op", "("), makeToken("op", "+"), makeToken("op", "("), ...value.map((item) => ({ ...item })), makeToken("op", ")"),
            makeToken("op", ")"), makeToken("op", "."), makeToken("ident", component));
        }
      }
    }
    out.push(...tokens.slice(index, index + 6), ...parts, tokens[close]);
    index = close;
  }
  return out;
}

/**
 * An index that is not a plain number, written `int(…)`: HLSL takes a float index (truncated),
 * GLSL ES only an integer one — `tab[uv.x % 4]`. A declaration's size is left alone.
 */
function integerSubscripts(tokens) {
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const close = isOp(token, "[") ? matchingBracket(tokens, index) : -1;
    const inside = close > 0 ? tokens.slice(index + 1, close) : [];
    const declaration = tokens[index - 1]?.type === "ident" && (isTypeName(tokens[index - 2]) || isOp(tokens[index - 2], ","));
    if (close < 0 || declaration || !inside.length || (inside.length === 1 && inside[0].type === "number")) {
      out.push(token);
      continue;
    }
    out.push(token, makeToken("ident", "int"), makeToken("op", "("), ...integerSubscripts(inside), makeToken("op", ")"), tokens[close]);
    index = close;
  }
  return out;
}

/**
 * The comma operator in parentheses — `lerp(a, 1, (max(l1, l2), max(l3, l4)))` — which hlslparser
 * reads as more arguments of the call around it. HLSL takes the last value, and so does this: the
 * values before it are dropped, unless one of them assigns, and then the group stays as it was.
 * A `(` after a name or a bracket opens a call or a cast's operand, not a group.
 */
function commaExpressions(tokens) {
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const call = (previous?.type === "ident" && previous.text !== "return") || isOp(previous, ")", "]");
    const close = isOp(token, "(") && !call ? matchingBracket(tokens, index) : -1;
    const parts = close > 0 ? splitTopLevel(tokens.slice(index + 1, close), ",") : [];
    const assigns = parts.slice(0, -1).some((part) => part.some((item) => item.type === "op" && (ASSIGNMENTS.has(item.text) || item.text === "++" || item.text === "--")));
    if (parts.length < 2 || parts.some((part) => !part.length) || assigns) {
      out.push(token);
      continue;
    }
    out.push(token, ...commaExpressions(parts.at(-1)), tokens[close]);
    index = close;
  }
  return out;
}

/**
 * pow(), sqrt(), rsqrt() and log()/log2() as MilkDrop's compiler builds them. MilkDrop 2 and
 * BeatDrop compile with D3DXSHADER_USE_LEGACY_D3DX9_31_DLL, i.e. d3dx9_31.dll's HLSL compiler,
 * profiles ps_2_0, ps_2_a/ps_2_b and ps_3_0; compiled with that DLL, all four profiles give:
 *   - pow(x, y) as D3D9's pow instruction (ps_2_x) or log·mul·exp (ps_3_0) — both |x|^y — and
 *     sqrt, rsqrt and log through rsq and log, which take |x| too. GLSL gives NaN (a black pixel)
 *     for a negative x, so x becomes abs(x);
 *   - a constant scalar exponent of 0, ±0.5, 1, 2, 3, 4, 5, 6, 8 or −1…−4 written out instead:
 *     multiplications that keep the sign (x·(x·x) for 3), a reciprocal of them for −1…−4, rsq for
 *     ±0.5, x itself for 1 and 1 for 0. Other constants (7, 16, 1.5…) are the pow instruction;
 *   - a constant vector exponent (`float3(5, 1, .5)`) as log·mul·exp per component, except that a
 *     component of 1 is x itself and one of 0 is 1.
 * A constant is also a named one the compiler folds (namedConstants): `static const float k = 3;`.
 */
const D3D_POWERS = new Map([[0, "0"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"], [8, "8"],
  [-1, "m1"], [-2, "m2"], [-3, "m3"], [-4, "m4"], [0.5, "h"], [-0.5, "mh"]]);
const ABSOLUTE_FUNCTIONS = new Set(["sqrt", "rsqrt", "log", "log2"]);
export const D3D_POW = "hlsl_pow";

const QUALIFIERS = /^(?:static|const|uniform|extern|volatile|shared|groupshared|row_major|column_major|in|out|inout)$/;
// Functions that write to an argument: HLSL's own, and any with an out or inout parameter (found below).
const WRITING_INTRINSICS = ["sincos", "modf", "frexp"];

/**
 * Named constants as d3dx9_31 folds them (measured on the DLL): a `static` global, const or not,
 * and any local, given a constant value and never assigned again — `pow(x, k)` then compiles as
 * `pow(x, 3)` would. A global without `static` is a uniform (its value can be set from outside)
 * and stays a variable, as it does for the compiler. A name declared more than once (a parameter
 * or a second function's local of that name) is left alone, and so is one that is assigned
 * anywhere, also through a function's out parameter.
 */
function namedConstants(tokens) {
  const count = new Map();
  const values = new Map();
  const declaredAt = new Set();
  const assigned = new Set();
  const writers = new Set(WRITING_INTRINSICS);
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isOp(token, "{")) depth += 1;
    else if (isOp(token, "}")) depth -= 1;
    // A function with an out or inout parameter: TYPE NAME ( … out … ) {
    if (token.type === "ident" && isOp(tokens[index + 1], "(") && isTypeName(tokens[index - 1])) {
      const close = matchingBracket(tokens, index + 1);
      if (close > 0 && isOp(tokens[close + 1], "{") && tokens.slice(index + 2, close).some((item) => isWord(item, "out", "inout"))) writers.add(token.text);
    }
    if (!isTypeName(token)) continue;
    const qualifiers = [];
    for (let back = index - 1; back >= 0 && tokens[back].type === "ident" && QUALIFIERS.test(tokens[back].text); back -= 1) qualifiers.push(tokens[back].text);
    for (let at = index + 1; tokens[at]?.type === "ident" && !isTypeName(tokens[at]) && isOp(tokens[at + 1], "=", ",", ";", ")", "[", ":");) {
      const name = tokens[at].text;
      count.set(name, (count.get(name) ?? 0) + 1);
      declaredAt.add(at);
      let next = at + 1;
      let array = false;
      if (isOp(tokens[next], "[")) {
        array = true;
        next = matchingBracket(tokens, next) + 1;
      }
      let value = null;
      if (next > 0 && isOp(tokens[next], "=")) {
        let end = next + 1;
        for (let nested = 0; end < tokens.length; end += 1) {
          const item = tokens[end];
          if (isOp(item, "(", "[", "{")) nested += 1;
          else if (isOp(item, ")", "]", "}")) {
            if (nested === 0) break;
            nested -= 1;
          } else if (nested === 0 && isOp(item, ",", ";")) break;
        }
        if (!array && (depth > 0 || qualifiers.includes("static"))) value = { type: token.text, tokens: tokens.slice(next + 1, end) };
        next = end;
      }
      if (!values.has(name) || value) values.set(name, value);
      if (!isOp(tokens[next], ",") || isTypeName(tokens[next + 1])) break;
      at = next + 1;
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "ident") continue;
    if (writers.has(token.text) && isOp(tokens[index + 1], "(")) {
      const close = matchingBracket(tokens, index + 1);
      const args = close > 0 ? splitTopLevel(tokens.slice(index + 2, close), ",") : [];
      for (const arg of args) if (arg.length && arg[0].type === "ident") assigned.add(arg[0].text);
      continue;
    }
    if (declaredAt.has(index)) continue;
    let next = index + 1;
    while (isOp(tokens[next], ".") && tokens[next + 1]?.type === "ident") next += 2;
    if (isOp(tokens[next], "[")) next = matchingBracket(tokens, next) + 1;
    const after = tokens[next];
    if ((next > 0 && after?.type === "op" && (ASSIGNMENTS.has(after.text) || after.text === "++" || after.text === "--")) || isOp(tokens[index - 1], "++", "--")) {
      assigned.add(token.text);
    }
  }
  const constants = new Map();
  for (const [name, value] of values) {
    if (!value || count.get(name) !== 1 || assigned.has(name)) continue;
    const width = Number(/[234]$/.exec(value.type)?.[0] ?? 1);
    if (width === 1) {
      const scalar = constantValue(value.tokens, constants);
      if (scalar !== null) constants.set(name, scalar);
    } else {
      const vector = constantVector(value.tokens, constants);
      if (vector?.length === width) constants.set(name, vector);
    }
  }
  return constants;
}

const COMPONENTS = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

/** The value of a constant scalar expression (numbers, named constants, + − * /, brackets), or null. */
function constantValue(tokens, constants = new Map()) {
  let at = 0;
  const peek = () => tokens[at];
  const primary = () => {
    const token = tokens[at++];
    if (token?.type === "number" && !/^0[xX]/.test(token.text)) return Math.fround(Number(token.text.replace(/[fFhHlLuU]+$/, "")));
    if (token?.type === "ident" && constants.has(token.text)) {
      const value = constants.get(token.text);
      if (isOp(tokens[at], ".") && tokens[at + 1]?.text in COMPONENTS) {
        const component = COMPONENTS[tokens[at + 1].text];
        at += 2;
        return Array.isArray(value) ? value[component] ?? NaN : component === 0 ? value : NaN;
      }
      return Array.isArray(value) ? NaN : value;
    }
    if (isOp(token, "(")) {
      const value = sum();
      return isOp(tokens[at++], ")") ? value : NaN;
    }
    if (isOp(token, "-")) return -primary();
    if (isOp(token, "+")) return primary();
    return NaN;
  };
  const product = () => {
    let value = primary();
    while (isOp(peek(), "*", "/")) value = tokens[at++].text === "*" ? Math.fround(value * primary()) : Math.fround(value / primary());
    return value;
  };
  function sum() {
    let value = product();
    while (isOp(peek(), "+", "-")) value = tokens[at++].text === "+" ? Math.fround(value + product()) : Math.fround(value - product());
    return value;
  }
  const value = tokens.length ? sum() : NaN;
  return at === tokens.length && Number.isFinite(value) ? value : null;
}

/** The components of a constant vector (`float3(5, 1, .5)`, in brackets or not, or a named one), or null. */
function constantVector(tokens, constants = new Map()) {
  let inner = tokens;
  while (isOp(inner[0], "(") && matchingBracket(inner, 0) === inner.length - 1) inner = inner.slice(1, -1);
  if (inner.length === 1 && Array.isArray(constants.get(inner[0].text))) return constants.get(inner[0].text);
  if (!(inner[0]?.type === "ident" && /^(?:float|half)[234]$/.test(inner[0].text) && isOp(inner[1], "(") && matchingBracket(inner, 1) === inner.length - 1)) return null;
  const values = splitTopLevel(inner.slice(2, -1), ",").map((part) => constantValue(part, constants));
  return values.length === Number(inner[0].text.at(-1)) && values.every((value) => value !== null) ? values : null;
}

function d3dMath(tokens, constants = namedConstants(tokens)) {
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const called = token.type === "ident" && isOp(tokens[index + 1], "(") && !isOp(tokens[index - 1], ".");
    const close = called && (token.text === "pow" || ABSOLUTE_FUNCTIONS.has(token.text)) ? matchingBracket(tokens, index + 1) : -1;
    const args = close > 0 ? splitTopLevel(tokens.slice(index + 2, close), ",") : [];
    const absolute = (base) => [makeToken("ident", "abs"), makeToken("op", "("), ...base, makeToken("op", ")")];
    if (close > 0 && token.text !== "pow" && args.length === 1 && args[0].length) {
      out.push(token, tokens[index + 1], ...absolute(d3dMath(args[0], constants)), tokens[close]);
      index = close;
      continue;
    }
    if (close < 0 || token.text !== "pow" || args.length !== 2 || !args[0].length || !args[1].length) {
      out.push(token);
      continue;
    }
    const base = d3dMath(args[0], constants);
    const exponent = d3dMath(args[1], constants);
    const scalar = constantValue(exponent, constants);
    const vector = scalar === null ? constantVector(exponent, constants) : null;
    if (scalar === 1) {
      out.push({ ...tokens[index + 1], pre: token.pre }, ...base, tokens[close]);
    } else if (scalar !== null && D3D_POWERS.has(scalar)) {
      out.push({ ...token, text: `${D3D_POW}_${D3D_POWERS.get(scalar)}` }, tokens[index + 1], ...base, tokens[close]);
    } else if (vector?.some((value) => value === 0 || value === 1)) {
      out.push({ ...token, text: `${D3D_POW}_v` }, tokens[index + 1], ...base, makeToken("op", ","), ...exponent, tokens[close]);
    } else {
      out.push(token, tokens[index + 1], ...absolute(base), makeToken("op", ","), ...exponent, tokens[close]);
    }
    index = close;
  }
  return out;
}

const D3D_POWER_BODIES = {
  0: () => "return (T)1;",
  2: () => "return x * x;",
  3: () => "return x * (x * x);",
  4: () => "T y = x * x; return y * y;",
  5: () => "T y = x * x; return x * (y * y);",
  6: () => "T y = x * x; return y * (y * y);",
  8: () => "T y = x * x; y = y * y; return y * y;",
  m1: () => "return 1 / x;",
  m2: () => "return 1 / (x * x);",
  m3: () => "return 1 / (x * (x * x));",
  m4: () => "T y = x * x; return 1 / (y * y);",
  h: () => "return sqrt(abs(x));",
  mh: () => "return rsqrt(abs(x));"
};
const VECTOR_TYPES = ["float", "float2", "float3", "float4"];

/** The helpers d3dMath's calls need, in front of the shader: one of each shape, as withFmod's. */
export function withD3dMath(text) {
  const definitions = [];
  for (const [name, body] of Object.entries(D3D_POWER_BODIES)) {
    if (!new RegExp(`\\b${D3D_POW}_${name}\\s*\\(`).test(text) || new RegExp(`\\bfloat\\s+${D3D_POW}_${name}\\s*\\(`).test(text)) continue;
    for (const type of VECTOR_TYPES) definitions.push(`${type} ${D3D_POW}_${name}(${type} x) { ${body().replaceAll("T", type)} }`);
  }
  if (new RegExp(`\\b${D3D_POW}_v\\s*\\(`).test(text) && !new RegExp(`\\bfloat2\\s+${D3D_POW}_v\\s*\\(`).test(text)) {
    for (const type of VECTOR_TYPES.slice(1)) {
      const parts = "xyzw".slice(0, Number(type.at(-1))).split("")
        .map((c) => `r.${c} = ((e.${c} == 1) ? x.${c} : ((e.${c} == 0) ? 1 : r.${c}));`).join(" ");
      definitions.push(`${type} ${D3D_POW}_v(${type} x, ${type} e) { ${type} r = pow(abs(x), e); ${parts} return r; }`);
      definitions.push(`${type} ${D3D_POW}_v(float x, ${type} e) { return ${D3D_POW}_v((${type})x, e); }`);
    }
  }
  return definitions.length ? `${definitions.join("\n")}\n${text}` : text;
}

function mendStatements(input) {
  const tokens = integerSubscripts(flattenArrayInitializers(d3dMath(commaExpressions(mendForLoops(input)))));
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "ident" && RESERVED_NAMES.has(token.text)) {
      result.push({ ...token, text: `${token.text}_md` });
      continue;
    }
    if (isOp(token, "%=")) {
      // The target: back to the start of its statement (or clause), at its own bracket depth.
      let start = result.length;
      for (let depth = 0; start > 0; start -= 1) {
        const previous = result[start - 1];
        if (isOp(previous, ")", "]")) depth += 1;
        else if (isOp(previous, "(", "[")) {
          if (depth === 0) break;
          depth -= 1;
        } else if (depth === 0 && (isOp(previous, ";", ",", "{", "}") || previous.type === "directive")) break;
      }
      const target = result.splice(start);
      // The value: up to the end of the statement (or clause).
      let end = index + 1;
      for (let depth = 0; end < tokens.length; end += 1) {
        const next = tokens[end];
        if (isOp(next, "(", "[")) depth += 1;
        else if (isOp(next, ")", "]")) {
          if (depth === 0) break;
          depth -= 1;
        } else if (depth === 0 && isOp(next, ";", ",")) break;
      }
      const value = tokens.slice(index + 1, end);
      const copy = target.map((part, position) => ({ ...part, pre: position === 0 ? "" : part.pre }));
      result.push(...target, { type: "op", text: "=", pre: " " }, { type: "ident", text: FMOD, pre: " " }, { type: "op", text: "(", pre: "" },
        ...copy, { type: "op", text: ",", pre: "" }, { type: "op", text: "(", pre: " " }, ...value, { type: "op", text: ")", pre: "" },
        { type: "op", text: ")", pre: "" });
      index = end - 1;
      continue;
    }
    result.push(token);
  }
  return result;
}

/**
 * The shader with macros expanded and every operator chain parenthesised.
 * Throws RewriteError for what it will not handle; nothing it returns has a
 * different meaning from what it was given.
 */
export function rewriteShader(source) {
  const { tokens, trailing } = tokenize(source);
  const expanded = mendStatements(preprocess(tokens));
  const out = [];
  for (const item of rewriteSequence(nest(expanded))) emitItem(item, out);
  return withD3dMath(withFmod(untokenize(out, trailing)));
}

/** How many `&&` and `||` a text has: the bug's signature is a `&&` that was not in the source. */
export function logicalOperators(text) {
  return { and: text.split("&&").length - 1, or: text.split("||").length - 1 };
}
