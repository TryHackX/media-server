import { avsGrouping, type GroupingNode } from "./eel-grouping";
import { eelBitwise, eelGettime, eelModulo, eelShift, eelTrue, eelXor, x87Cos, x87Sin, x87Tan } from "./eel-math";
import { eel2Functions, parseEel2, type EelDialect } from "./eel2-parser";
import { nsEelNormalize, nsEelPreprocess, nsEelSegments } from "./ns-eel-syntax";
import { avsGetvis, type AvsVisdata } from "./winamp-visdata";
import { eelRand } from "./webvs/avsRandom";
import { parse as parseEel } from "eel-wasm";

import * as Ast from "./webvs/expr/Ast";

/**
 * AVS scripts without `eval`.
 *
 * webvs turned every preset's per-frame code into JavaScript source and ran it
 * through `new Function` — which this site's policy refuses, and rightly: it is
 * the same door `eval` opens. Here the code is parsed (eel-wasm's EEL parser,
 * MIT), converted into webvs's own syntax tree — so its symbol tables and its
 * GLSL generator for per-pixel code keep working unchanged — and the per-frame
 * part is compiled into nested JavaScript closures. No source text is ever
 * executed; a closure is just a function that calls the ones under it.
 *
 * eel-wasm-backend.ts runs the same trees as WebAssembly once they first ran (compileExpr attaches
 * it); these closures stay the fallback and the reference the wasm agrees with bit for bit.
 *
 * It also gives AVS back what webvs left out: `getspec`, `megabuf`, `loop`,
 * `while`, blocks in parentheses, comparison operators, compound assignment.
 * And it never lets NaN or infinity into a variable: in AVS a single 0/0 in a
 * scope sends every point to nowhere and the picture goes black for good.
 */

type EelNode = {
  type: string;
  body?: EelNode[];
  left?: EelNode;
  right?: EelNode;
  operator?: string;
  value?: unknown;
  callee?: { value: string };
  arguments?: EelNode[];
  test?: EelNode;
  consequent?: EelNode;
  alternate?: EelNode;
  address?: EelNode;
  global?: boolean;
};

export type { EelDialect };

/**
 * The constants as each compiler had them. AVS 2.81's ns-eel pasted fixed text in place of
 * `$PI`, `$E` and `$PHI` (nseel-compiler.c): 3.141592653589793, 2.71828183 and 1.61803399.
 */
const CONSTANT_VALUES: Record<EelDialect, Record<string, string>> = {
  "ns-eel": { pi: "3.141592653589793", e: "2.71828183", phi: "1.61803399" },
  eel2: { pi: String(Math.PI), e: String(Math.E), phi: "1.618033988749895" }
};

/** How long a variable name counts: AVS 2.81's ns-eel compared 8 characters, EEL2 16. */
const NAME_LENGTH: Record<EelDialect, number> = { "ns-eel": 8, eel2: 16 };

export interface ParseOptions {
  /** ns-eel (AVS 2.81, the default) or EEL2 (eel2-parser.ts). */
  dialect?: EelDialect;
  /** Characters of a variable name that count; the dialect's by default. */
  nameLength?: number;
  /** EEL2: the code of the effect's other sections, whose functions this one may call. */
  siblings?: readonly string[];
  /**
   * A preset's code, compiled as AVS compiled it: the section runs only when all of it compiles,
   * else it runs nothing (ns-eel-syntax.ts; EEL2 too failed a whole section). Without it — code of
   * this project's own (mscopes' pixel scripts) — readable statements run and the rest is left out.
   */
  strict?: boolean;
}

/** Settings convert() works under. */
interface Conversion {
  constants: string[];
  dialect: EelDialect;
  nameLength: number;
}

/**
 * AVS source to webvs's syntax tree.
 *
 * Names are case-insensitive in both compilers: every name is lowercased, and a variable
 * counts only its first 8 characters in ns-eel (16 in EEL2), so `abcdefgh1` and `abcdefgh2`
 * are one variable in an AVS 2.81 preset, as they were in AVS. Functions keep their whole
 * names. `$pi`, `$e` and `$phi` become the numbers the dialect's compiler put there.
 */
export function parse(source: string, options: ParseOptions = {}): Ast.Program {
  const dialect = options.dialect ?? "ns-eel";
  const conversion: Conversion = { constants: [], dialect, nameLength: options.nameLength ?? NAME_LENGTH[dialect] };
  // Control characters (bytes a preset carried along) are not code.
  // eslint-disable-next-line no-control-regex
  const clean = source.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  if (dialect === "eel2") return parseEel2Program(clean, options.siblings ?? [], conversion, options.strict === true);
  if (options.strict) {
    // AVS 2.81 (NSEEL_code_compile): every piece between semicolons must parse, or the whole
    // section is no code. The pieces are what it parsed, so they are what runs (a note alone
    // is nothing).
    const pieces = nsEelSegments(nsEelPreprocess(clean)).map(nsEelNormalize);
    if (pieces.some((piece) => piece === null)) return new Ast.Program([]);
    const text = pieces.filter((piece) => piece !== "").join(";\n");
    let tree: EelNode;
    try {
      tree = avsGrouping(parseEel(text) as unknown as GroupingNode, text) as unknown as EelNode;
    } catch {
      return new Ast.Program([]); // not expected: the pieces are plain EEL by now
    }
    return new Ast.Program((tree.body ?? []).map((node) => convert(node, conversion)));
  }
  const constants = conversion.constants;
  const prepared = clean.replace(/\$(pi|e|phi)\b/gi, (match) => {
    constants.push(CONSTANT_VALUES[dialect][match.slice(1).toLowerCase()]!);
    return `__avs_const_${constants.length - 1}`;
  });
  let tree: EelNode;
  // Operators grouped as AVS 2.81's parser did (eel-grouping.ts), against the text parsed.
  const grouped = (text: string): EelNode => avsGrouping(parseEel(text) as unknown as GroupingNode, text) as unknown as EelNode;
  try {
    tree = grouped(prepared);
  } catch {
    // Not a preset's code (see `strict`): the statements that read on their own.
    const kept = statements(prepared.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")).filter((statement) => {
      try {
        parseEel(statement);
        return true;
      } catch {
        return false;
      }
    });
    if (kept.length === 0) return new Ast.Program([]);
    tree = grouped(kept.join(";\n"));
  }
  return new Ast.Program((tree.body ?? []).map((node) => convert(node, conversion)));
}

/**
 * EEL2 code: the whole section through eel2-parser.ts. Where that fails, a preset's section
 * (`strict`) is no code, as EEL2 compiled it; other code keeps each statement that reads on its
 * own. Functions of the effect's other sections can be called from all.
 */
function parseEel2Program(source: string, siblings: readonly string[], conversion: Conversion, strict: boolean): Ast.Program {
  const shared = siblings.flatMap((sibling) => eel2Functions(sibling));
  let tree: EelNode;
  try {
    tree = parseEel2(source, shared) as EelNode;
  } catch {
    if (strict) return new Ast.Program([]);
    const own = eel2Functions(source);
    const body: EelNode[] = [];
    const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    for (const statement of statements(uncommented)) {
      if (/^function\s/i.test(statement)) continue;
      try {
        body.push(...((parseEel2(statement, [...shared, ...own]) as EelNode).body ?? []));
      } catch { /* left out, as an unreadable statement */ }
    }
    tree = { type: "SCRIPT", body };
  }
  return new Ast.Program((tree.body ?? []).map((node) => convert(node, conversion)));
}

/** Top-level statements: split at semicolons outside parentheses. */
function statements(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const call = (name: string, args: Ast.Expression[]): Ast.FuncCall => new Ast.FuncCall(name, args, null as unknown as string);

/** A binary operator as webvs's tree has it (comparisons and the rest as calls). */
function binary(operator: string, left: Ast.Expression, right: Ast.Expression): Ast.Expression {
  switch (operator) {
    case "^": return call("pow", [left, right]);
    case "==": return call("equal", [left, right]);
    case "!=": return call("bnot", [call("equal", [left, right])]);
    case "===": return call("equal_exact", [left, right]);
    case "!==": return call("bnot", [call("equal_exact", [left, right])]);
    case "<": return call("below", [left, right]);
    case ">": return call("above", [left, right]);
    case "<=": return call("bnot", [call("above", [left, right])]);
    case ">=": return call("bnot", [call("below", [left, right])]);
    case "~": return call("bxor", [left, right]);
    case "<<": return call("shl", [left, right]);
    case ">>": return call("shr", [left, right]);
    default: return new Ast.BinaryExpr(operator, left, right);
  }
}

/** A variable's name as the compiler matched it: lowercased, cut to the dialect's length. */
function variableName(name: string, conversion: Conversion): string {
  const lower = name.toLowerCase();
  return lower.length > conversion.nameLength ? lower.slice(0, conversion.nameLength) : lower;
}

function convert(node: EelNode, conversion: Conversion): Ast.Expression | Ast.Assignment {
  const sub = (child: EelNode | undefined): Ast.Expression => convert(child!, conversion) as Ast.Expression;
  switch (node.type) {
    case "NUMBER_LITERAL":
      return new Ast.PrimaryExpr(String(node.value), Ast.PrimaryExprType.VALUE);
    case "IDENTIFIER": {
      const raw = String(node.value);
      const constant = /^__avs_const_(\d+)$/.exec(raw);
      if (constant) return new Ast.PrimaryExpr(conversion.constants[Number(constant[1])]!, Ast.PrimaryExprType.VALUE);
      const name = variableName(raw, conversion);
      return new Ast.PrimaryExpr(name, /^reg\d\d$/.test(name) ? Ast.PrimaryExprType.REG : Ast.PrimaryExprType.ID);
    }
    case "EXPRESSION_BLOCK":
      return call("execn", (node.body ?? []).map(sub));
    case "UNARY_EXPRESSION":
      if (node.operator === "!") return call("bnot", [sub(node.value as EelNode)]);
      if (node.operator === "+") return sub(node.value as EelNode);
      return new Ast.UnaryExpr(node.operator!, sub(node.value as EelNode));
    case "LOGICAL_EXPRESSION":
      return call(node.operator === "&&" ? "band" : "bor", [sub(node.left), sub(node.right)]);
    case "BINARY_EXPRESSION":
      return binary(node.operator!, sub(node.left), sub(node.right));
    case "CONDITIONAL_EXPRESSION": {
      // EEL2's c ? a : b, either side optional (0 when left out).
      const zero = new Ast.PrimaryExpr("0", Ast.PrimaryExprType.VALUE);
      return call("if", [sub(node.test), node.consequent ? sub(node.consequent) : zero, node.alternate ? sub(node.alternate) : zero]);
    }
    case "MEMORY_EXPRESSION":
      return call(node.global ? "gmegabuf" : "megabuf", [sub(node.address)]);
    case "CALL_EXPRESSION": {
      const name = node.callee!.value.toLowerCase();
      const result = call(name, (node.arguments ?? []).map(sub));
      // ns-eel's rand(x) took x by its address and set x to 1 when below (nseel-cfunc.c).
      if (name === "rand" && conversion.dialect === "ns-eel") (result as Ast.FuncCall & { setsArgument?: boolean }).setsArgument = true;
      return result;
    }
    case "ASSIGNMENT_EXPRESSION": {
      const operator = node.operator!;
      const right = sub(node.right);
      const target = node.left!;
      const compound = (current: Ast.Expression): Ast.Expression => (operator === "=" ? right : binary(operator.slice(0, -1), current, right));
      if (target.type === "CALL_EXPRESSION" || target.type === "MEMORY_EXPRESSION") {
        // megabuf(i) = v, gmegabuf(i) += v, x[i] = v, gmem[i] += v
        const name = target.type === "MEMORY_EXPRESSION" ? (target.global ? "gmegabuf" : "megabuf") : target.callee!.value.toLowerCase();
        const index = sub(target.type === "MEMORY_EXPRESSION" ? target.address : target.arguments?.[0]);
        return call(`${name}_set`, [index, compound(call(name, [index]))]);
      }
      if (target.type === "CONDITIONAL_EXPRESSION" && operator === "=") {
        // (c ? a : b) = v writes a or b, as assign(if(c, a, b), v) does.
        return call("assign", [sub(target), right]);
      }
      const lhs = sub(target) as Ast.PrimaryExpr;
      return new Ast.Assignment(lhs, compound(lhs));
    }
    default:
      throw new Error(`Unsupported AVS expression: ${node.type}`);
  }
}

/** The functions this compiler adds to webvs's table, with their argument counts. */
export const EXTRA_FUNCTIONS: Record<string, number | { min: number }> = {
  execn: { min: 1 }, exec2: 2, exec3: 3, loop: 2, while: 1, assign: 2,
  megabuf: 1, gmegabuf: 1, megabuf_set: 2, gmegabuf_set: 2,
  getspec: 3, exp: 1, log10: 1, sign: 1, sigmoid: 2, getkbmouse: 1, setmousepos: 2,
  // EEL2's ~, <<, >> and ===.
  bxor: 2, shl: 2, shr: 2, equal_exact: 2,
  // EEL2's memory functions (nseel-ram.c); ns-eel 2.81 had none, so its presets cannot call them.
  memset: 3, memcpy: 3, freembuf: 1
};

export type Scope = Record<string, unknown> & {
  registerBank?: Record<string, number>;
  analyser?: { getWaveform(): ArrayLike<number>; getSpectrum(): ArrayLike<number>; getVisdata?(): AvsVisdata };
  bootTime?: number;
  /** The track playing: position and length in seconds (null outside the player). */
  playback?: () => { position: number; duration: number } | null;
};
type Run = (scope: Scope) => number;

/** megabuf/gmegabuf slots (eel-wasm-backend.ts keeps the same sizes). */
export const BUFFER = 1 << 20;
/** gmegabuf: one for the page, as AVS had one for the process (shared with eel-wasm-backend.ts). */
export const globalBuffer = new Float64Array(BUFFER);
/** Each code instance's megabuf, made on first use (eel-wasm-backend.ts puts one here when it gives an instance back). */
export const localBuffers = new WeakMap<object, Float64Array>();
const bufferOf = (scope: object): Float64Array => {
  let buffer = localBuffers.get(scope);
  if (!buffer) localBuffers.set(scope, (buffer = new Float64Array(BUFFER)));
  return buffer;
};
const slot = (index: number): number => {
  const position = Math.floor(index + 0.00001);
  return position >= 0 && position < BUFFER ? position : -1;
};
const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * getosc/getspec as AVS computes them (avs_eelif.cpp getvis): band and width
 * in 0…1 of the 576 values, the width at least one value, the band centred on
 * the position and cut at the ends; channel 0 (centre), 1 or 2, anything else 0.
 */
export const band = (values: ArrayLike<number>, centre: number, width: number, channel = 0): number => {
  const which = Math.trunc(channel + 0.5);
  if (which !== 0 && which !== 1 && which !== 2) return 0;
  const count = values.length;
  let size = Math.trunc(width * count);
  if (size < 1) size = 1;
  let from = Math.trunc(centre * count) - Math.trunc(size / 2);
  if (from < 0) {
    size += from;
    from = 0;
  }
  if (from > count - 1) from = count - 1;
  if (from + size > count) size = count - from;
  if (size <= 0 || !Number.isFinite(size)) return 0;
  let sum = 0;
  for (let index = from; index < from + size; index += 1) sum += values[index] ?? 0;
  return sum / size;
};

export const MATH: Record<string, (...values: number[]) => number> = {
  sin: x87Sin, cos: x87Cos, tan: x87Tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  atan2: Math.atan2, pow: Math.pow, exp: Math.exp, abs: Math.abs, min: Math.min, max: Math.max,
  floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
  log: (value) => (value > 0 ? Math.log(value) : 0),
  log10: (value) => (value > 0 ? Math.log10(value) : 0),
  sqrt: (value) => Math.sqrt(Math.abs(value)),
  invsqrt: (value) => (value !== 0 ? 1 / Math.sqrt(Math.abs(value)) : 0),
  sqr: (value) => value * value,
  sigmoid: (value, constraint) => {
    const denominator = 1 + Math.exp(-value * constraint);
    return Math.abs(denominator) > 0.00001 ? 1 / denominator : 0;
  }
};

function compileNode(node: Ast.Statement): Run {
  if (node instanceof Ast.PrimaryExpr) {
    switch (node.type) {
      case Ast.PrimaryExprType.VALUE: {
        const constant = Number(node.value);
        return () => constant;
      }
      case Ast.PrimaryExprType.CONST: {
        const constant = node.value === "pi" ? Math.PI : node.value === "e" ? Math.E : 1.6180339887;
        return () => constant;
      }
      case Ast.PrimaryExprType.REG: {
        const name = node.value;
        return (scope) => scope.registerBank?.[name] ?? 0;
      }
      default: {
        const name = node.value;
        return (scope) => (scope[name] as number | undefined) ?? 0;
      }
    }
  }
  if (node instanceof Ast.Assignment) {
    const name = node.lhs.value;
    const value = compileNode(node.expr);
    if (node.lhs.type === Ast.PrimaryExprType.REG) {
      return (scope) => {
        const result = finite(value(scope));
        if (scope.registerBank) scope.registerBank[name] = result;
        return result;
      };
    }
    return (scope) => (scope[name] = finite(value(scope))) as number;
  }
  if (node instanceof Ast.UnaryExpr) {
    const operand = compileNode(node.operand);
    return node.operator === "-" ? (scope) => -operand(scope) : operand;
  }
  if (node instanceof Ast.BinaryExpr) {
    const left = compileNode(node.leftOperand);
    const right = compileNode(node.rightOperand);
    switch (node.operator) {
      case "+": return (scope) => left(scope) + right(scope);
      case "-": return (scope) => left(scope) - right(scope);
      case "*": return (scope) => left(scope) * right(scope);
      // AVS divides by zero into zero; infinity would blank the picture.
      case "/": return (scope) => {
        const divisor = right(scope);
        return divisor !== 0 ? left(scope) / divisor : 0;
      };
      case "%": return (scope) => eelModulo(left(scope), right(scope));
      case "&": return (scope) => eelBitwise(left(scope), right(scope), false);
      case "|": return (scope) => eelBitwise(left(scope), right(scope), true);
      default: throw new Error(`Unsupported AVS operator ${node.operator}`);
    }
  }
  if (node instanceof Ast.FuncCall) return compileCall(node);
  throw new Error("Unsupported AVS syntax");
}

function compileCall(node: Ast.FuncCall): Run {
  const name = node.funcName;
  const args = node.args.map(compileNode);
  const [first, second, third] = args;
  switch (name) {
    case "if": return (scope) => (eelTrue(first!(scope)) ? second!(scope) : third!(scope));
    case "above": return (scope) => (first!(scope) > second!(scope) ? 1 : 0);
    case "below": return (scope) => (first!(scope) < second!(scope) ? 1 : 0);
    case "equal": return (scope) => (Math.abs(first!(scope) - second!(scope)) < 0.00001 ? 1 : 0);
    case "equal_exact": return (scope) => (first!(scope) === second!(scope) ? 1 : 0);
    case "bxor": return (scope) => eelXor(first!(scope), second!(scope));
    case "shl": return (scope) => eelShift(first!(scope), second!(scope), true);
    case "shr": return (scope) => eelShift(first!(scope), second!(scope), false);
    case "band": return (scope) => (eelTrue(first!(scope)) && eelTrue(second!(scope)) ? 1 : 0);
    case "bor": return (scope) => (eelTrue(first!(scope)) || eelTrue(second!(scope)) ? 1 : 0);
    case "bnot": return (scope) => (eelTrue(first!(scope)) ? 0 : 1);
    case "execn":
    case "exec2":
    case "exec3": return (scope) => {
      let result = 0;
      for (const run of args) result = run(scope);
      return result;
    };
    case "loop": return (scope) => {
      const count = Math.min(BUFFER, Math.max(0, Math.floor(first!(scope))));
      let result = 0;
      for (let index = 0; index < count; index += 1) result = second!(scope);
      return result;
    };
    case "while": return (scope) => {
      let guard = 0;
      while (eelTrue(first!(scope)) && guard < BUFFER) guard += 1;
      return 0;
    };
    case "assign":
      // AVS idioms: assign(if(c, a, b), v) writes to a or b; assign(megabuf(i), v)
      // writes a buffer slot; ifs may nest.
      return assignTo(node.args[0]!, node.args[1]!);
    case "megabuf":
    case "gmegabuf": return (scope) => {
      const position = slot(first!(scope));
      return position < 0 ? 0 : (name === "gmegabuf" ? globalBuffer : bufferOf(scope))[position]!;
    };
    // nseel-ram.c: offsets and counts as (int)(x + 0.0001), cut to the memory; both return dest.
    case "memset": return (scope) => {
      const dest = first!(scope);
      let offset = Math.trunc(dest + 0.0001);
      let count = Math.trunc(third!(scope) + 0.0001);
      const value = second!(scope);
      if (offset < 0) {
        count += offset;
        offset = 0;
      }
      if (count > 0 && offset < BUFFER) bufferOf(scope).fill(value, offset, Math.min(BUFFER, offset + count));
      return dest;
    };
    case "memcpy": return (scope) => {
      const dest = first!(scope);
      let to = Math.trunc(dest + 0.0001);
      let from = Math.trunc(second!(scope) + 0.0001);
      let count = Math.trunc(third!(scope) + 0.0001);
      if (to < 0) {
        count += to;
        from -= to;
        to = 0;
      }
      if (from < 0) {
        count += from;
        to -= from;
        from = 0;
      }
      count = Math.min(count, BUFFER - to, BUFFER - from);
      if (count > 0) {
        const memory = bufferOf(scope);
        memory.copyWithin(to, from, from + count); // overlapping ranges as memmove
      }
      return dest;
    };
    // EEL2 frees the 65536-slot blocks above `top`; freed memory reads 0 again.
    case "freembuf": return (scope) => {
      const top = first!(scope);
      const block = 65536;
      const start = Math.max(0, Math.ceil(Math.trunc(top + 0.0001) / block) * block);
      if (start < BUFFER) bufferOf(scope).fill(0, start);
      return top;
    };
    case "megabuf_set":
    case "gmegabuf_set": return (scope) => {
      const position = slot(first!(scope));
      const value = finite(second!(scope));
      if (position >= 0) (name === "gmegabuf_set" ? globalBuffer : bufferOf(scope))[position] = value;
      return value;
    };
    // AVS: 0 … floor(x) - 1 (see webvs/avsRandom.ts for the comparison mode).
    case "rand": {
      // ns-eel: rand(v) on a variable below 1 sets it to 1 (the argument went by address).
      const target = (node as Ast.FuncCall & { setsArgument?: boolean }).setsArgument ? node.args[0] : null;
      if (target instanceof Ast.PrimaryExpr && (target.type === Ast.PrimaryExprType.ID || target.type === Ast.PrimaryExprType.REG)) {
        const name = target.value;
        const register = target.type === Ast.PrimaryExprType.REG;
        return (scope) => {
          const value = first!(scope);
          if (value < 1) {
            if (register) {
              if (scope.registerBank) scope.registerBank[name] = 1;
            } else {
              scope[name] = 1;
            }
          }
          return eelRand(value);
        };
      }
      return (scope) => eelRand(first!(scope));
    }
    // AVS: mouse position, buttons or a key held down; nothing is, here.
    case "getkbmouse": return (scope) => (first!(scope), 0);
    // AVS: moves the mouse pointer; a page cannot, and the call is no code error.
    case "setmousepos": return (scope) => (first!(scope), second!(scope), 0);
    // AVS: the track's position (-1) or length (-2), else seconds on one clock minus s (eel-math.ts).
    // The clock counts from the engine's start; until 09.11 gettime(s) for s other than 0 took the
    // wall clock (seconds since 1970) instead, so gettime(start) and frame times built from
    // gettime(0) were off by decades of seconds (micro-d — octopus skin stayed black). The clock is
    // whole milliseconds over 1000, as AVS's: (now − start) / 1000, not now / 1000 − start / 1000,
    // whose rounding at 1.7·10^9 s (up to 2.4·10^-7 s) fed presets that add up frame times.
    case "gettime": return (scope) => eelGettime(first!(scope), (Date.now() - (scope.bootTime ?? 0)) / 1000, scope.playback?.());
    case "getosc":
    case "getspec": return (scope) => {
      const analyser = scope.analyser;
      const centre = first!(scope);
      const width = second!(scope);
      const channel = third ? third(scope) : 0;
      // AVS's bytes (avs_eelif.cpp getvis) where the analyser has them.
      const visdata = analyser?.getVisdata?.();
      if (visdata) return avsGetvis(visdata, name === "getosc", centre, width, channel);
      const values = name === "getosc" ? analyser?.getWaveform() : analyser?.getSpectrum();
      return values ? band(values, centre, width, channel) : 0;
    };
  }
  const math = MATH[name];
  if (math) {
    if (args.length === 1) return (scope) => finite(math(first!(scope)));
    if (args.length === 2) return (scope) => finite(math(first!(scope), second!(scope)));
    return (scope) => finite(math(...args.map((run) => run(scope))));
  }
  throw new Error(`Unknown AVS function ${name}`);
}

function assignTo(target: Ast.Expression, value: Ast.Expression): Run {
  if (target instanceof Ast.PrimaryExpr && (target.type === Ast.PrimaryExprType.ID || target.type === Ast.PrimaryExprType.REG)) {
    return compileNode(new Ast.Assignment(target, value));
  }
  if (target instanceof Ast.FuncCall && target.funcName === "if" && target.args.length === 3) {
    const condition = compileNode(target.args[0]!);
    const whenTrue = assignTo(target.args[1]!, value);
    const whenFalse = assignTo(target.args[2]!, value);
    return (scope) => (eelTrue(condition(scope)) ? whenTrue(scope) : whenFalse(scope));
  }
  if (target instanceof Ast.FuncCall && (target.funcName === "megabuf" || target.funcName === "gmegabuf")) {
    return compileCall(new Ast.FuncCall(`${target.funcName}_set`, [target.args[0]!, value], null as unknown as string));
  }
  // Anything else is evaluated for its value, as AVS would, and the write dropped.
  return compileNode(value);
}

/** A webvs code section, compiled: called as a method of its CodeInstance, like the original. */
export function compileProgram(program: Ast.Program): (this: Scope) => void {
  const statements = program.statements.map(compileNode);
  return function run(this: Scope): void {
    for (const statement of statements) statement(this);
  };
}
