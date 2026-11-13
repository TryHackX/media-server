/**
 * MilkDrop's preset equations, read the way MilkDrop reads them and written out for eel-wasm,
 * the compiler butterchurn runs them with.
 *
 * eel-wasm (0.0.16) does not read all of MilkDrop's expression language, and some of what it
 * reads it groups differently:
 *   - it has no `a ? b : c`, no `x[i]` (megabuf), no `$pi`, `$e`, `$phi`, `$x1F` or `$'c'`, no
 *     numbers with an exponent, no `^=`, `|=` or `&=`, and none of `memcpy`, `memset`,
 *     `freembuf`, `invsqrt` or the internal names (`_aboeq`, `_set`…) presets sometimes call;
 *   - it gives `&&` and `||` a higher precedence than comparisons, so `a == 1 && b == 2` is
 *     `a == ((1 && b) == 2)` there — false for a = 1, b = 2 — where MilkDrop (and BeatDrop's
 *     projectM-eval) read `(a == 1) && (b == 2)`; and it puts `&` and `|` above `* /`, where
 *     MilkDrop has them below `+ -`.
 *
 * So the text is parsed here exactly as MilkDrop 2 parses it — ns-eel2's text preprocessor,
 * which turns assignments, comparisons, `&& || ! ? : [ ] % ^` into function calls with its own
 * rules for how far each operand reaches, and then its yacc grammar for `| & + - * /` (levels
 * read from its parser tables: `|` < `&` < `+ -` < `* /` < unary signs, all left to right) — and
 * written back fully bracketed, in what eel-wasm reads. Lines are first joined as MilkDrop joins
 * them: `//` and `\\` end a line's code, and lines follow each other with nothing in between.
 *
 * The reference is ns-eel2 as shipped with MilkDrop 2 and MilkDrop 3 (Cockos/Nullsoft, zlib
 * licence; nseel-compiler.c `preprocessCode`, nseel-caltab.c). This is a reimplementation of
 * its rules, not its code. A block that MilkDrop could not compile either is reported, and the
 * build then leaves that block empty — as MilkDrop does, which plays the preset without it.
 *
 * Pure: no imports, so the build's workers and Node's test runner load it as it is.
 */

/** What MilkDrop's StripLinefeedCharsAndComments makes of a block: comments gone, lines run together. */
export function joinMilkdropLines(text: string): string {
  return String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const comment = /\/\/|\\\\/.exec(line);
      return comment ? line.slice(0, comment.index) : line;
    })
    .join("");
}

const isSpace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\v" || char === "\f";
const isAlnum = (char: string | undefined): boolean => char !== undefined && /^[A-Za-z0-9]$/.test(char);
const upper = (char: string | undefined): string => (char ?? "").toUpperCase();

/** What ns-eel2 scans back (left) or forward (right) to, by scan kind. */
const SCAN_STOPS = ["", ":(,;?%", ",):?;", ",);", ",);", ""];

interface PreprocessorOperator {
  text: string;
  /** How the left operand is found: 0 the atom before, 1 back to a separator, -1 none. */
  left: number;
  /** How the right operand is found: 0 the next atom, 2 to a separator or && ||, 3/4 to the end of the statement, 5 to the matching ]. */
  right: number;
  call: string;
}

/** ns-eel2's preprocessor operators, in the order it tries them. */
const OPERATORS: readonly PreprocessorOperator[] = [
  { text: "+=", left: 0, right: 3, call: "_addop" },
  { text: "-=", left: 0, right: 3, call: "_subop" },
  { text: "%=", left: 0, right: 3, call: "_modop" },
  { text: "|=", left: 0, right: 3, call: "_orop" },
  { text: "&=", left: 0, right: 3, call: "_andop" },
  { text: "/=", left: 0, right: 3, call: "_divop" },
  { text: "*=", left: 0, right: 3, call: "_mulop" },
  { text: "^=", left: 0, right: 3, call: "_powop" },
  { text: "==", left: 1, right: 2, call: "_equal" },
  { text: "<=", left: 1, right: 2, call: "_beleq" },
  { text: ">=", left: 1, right: 2, call: "_aboeq" },
  { text: "<", left: 1, right: 2, call: "_below" },
  { text: ">", left: 1, right: 2, call: "_above" },
  { text: "!=", left: 1, right: 2, call: "_noteq" },
  { text: "||", left: 1, right: 2, call: "_or" },
  { text: "&&", left: 1, right: 2, call: "_and" },
  { text: "=", left: 0, right: 3, call: "_set" },
  { text: "%", left: 0, right: 0, call: "_mod" },
  { text: "^", left: 0, right: 0, call: "pow" },
  { text: "[", left: 0, right: 5, call: "" },
  { text: "!", left: -1, right: 0, call: "" },
  { text: "?", left: 1, right: 4, call: "" }
];

/**
 * ns-eel2's text preprocessor: constants spelled out, and every operator the yacc grammar does
 * not know turned into a call, its operands found by scanning the text as ns-eel2 scans it.
 * `;` inside brackets becomes `%`, which that grammar reads as "then".
 */
export function preprocessEel(source: string): string {
  let at = 0;
  let out = "";
  let depth = 0;
  while (at < source.length) {
    const first = source[at];
    if (first === "/" && source[at + 1] === "/") {
      at += 2;
      while (at < source.length && source[at] !== "\n") at += 1;
      continue;
    }
    if (first === "/" && source[at + 1] === "*") {
      at += 2;
      while (at < source.length && !(source[at] === "*" && source[at + 1] === "/")) at += 1;
      if (at < source.length) at += 2;
      continue;
    }
    if (first === "$") {
      const next = upper(source[at + 1]);
      if (next === "X") {
        const digits = /^[0-9A-Fa-f]*/.exec(source.slice(at + 2))?.[0] ?? "";
        const value = digits ? Number.parseInt(digits, 16) : 0;
        out += String(Math.min(value, 4294967295));
        at += 2 + digits.length;
        continue;
      }
      if (source[at + 1] === "'" && source[at + 2] !== undefined && source[at + 3] === "'") {
        out += String(source.charCodeAt(at + 2) & 255);
        at += 4;
        continue;
      }
      if (next === "P" && upper(source[at + 2]) === "I") {
        out += "3.141592653589793";
        at += 3;
        continue;
      }
      if (next === "E") {
        out += "2.71828183";
        at += 2;
        continue;
      }
      if (next === "P" && upper(source[at + 2]) === "H" && upper(source[at + 3]) === "I") {
        out += "1.61803399";
        at += 4;
        continue;
      }
    }
    let char = source[at]!;
    at += 1;
    if (isSpace(char)) char = " ";
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth > 0) {
      // Inside brackets: "then" when something follows, otherwise nothing.
      let ahead = at;
      let comment = 0;
      let next = "";
      while (ahead < source.length) {
        const peek = source[ahead]!;
        if (!comment && peek === "/") {
          if (source[ahead + 1] === "/") comment = 1;
          else if (source[ahead + 1] === "*") comment = 2;
        }
        if (comment === 1 && peek === "\n") comment = 0;
        else if (comment === 2 && peek === "*" && source[ahead + 1] === "/") {
          ahead += 1;
          comment = 0;
        } else if (!comment && !isSpace(peek)) {
          next = peek;
          break;
        }
        ahead += 1;
      }
      char = next && (isAlnum(next) || "(_!$".includes(next)) ? "%" : " ";
    } else if (!isSpace(char) && !isAlnum(char)) {
      const operator = OPERATORS.find((candidate) => char === candidate.text[0] && (candidate.text.length === 1 || source[at] === candidate.text[1]));
      if (operator) {
        let left: string | null = null;
        if (operator.left >= 0) {
          const stops = SCAN_STOPS[operator.left]!;
          let level = 0;
          let index = out.length - 1;
          for (; index >= 0; index -= 1) {
            const back = out[index]!;
            if (back === ")") level += 1;
            else if (back === "(") {
              level -= 1;
              if (level < 0) break;
            } else if (!level) {
              if (!stops) {
                if (!isSpace(back) && !isAlnum(back) && back !== "_" && back !== ".") break;
              } else if (stops.includes(back)) break;
            }
          }
          left = out.slice(index + 1);
          out = out.slice(0, index + 1);
        }
        if (operator.text.length === 2) at += 1;
        let end = at;
        let level = 0;
        let questions = 0;
        let comment = 0;
        let seen = false;
        let brackets = 0;
        const stops = SCAN_STOPS[operator.right]!;
        for (; end < source.length; end += 1) {
          const peek = source[end]!;
          if (!comment && peek === "/") {
            if (source[end + 1] === "/") comment = 1;
            else if (source[end + 1] === "*") comment = 2;
          }
          if (comment === 1 && peek === "\n") comment = 0;
          else if (comment === 2 && peek === "*" && source[end + 1] === "/") {
            end += 1;
            comment = 0;
          } else if (!comment) {
            if (peek === "(") {
              seen = true;
              level += 1;
            } else if (peek === ")") {
              level -= 1;
              if (level < 0) break;
            } else if (!level) {
              if (peek === ";" || peek === ",") break;
              if (!operator.right) {
                if (peek === ":") break;
                if (!isSpace(peek) && !isAlnum(peek) && peek !== "_" && peek !== "." && seen) break;
                if (isAlnum(peek) || peek === "_") seen = true;
              } else if (operator.right === 2 && ((peek === "|" && source[end + 1] === "|") || (peek === "&" && source[end + 1] === "&"))) break;
              else if (operator.right === 3 || operator.right === 4) {
                if (peek === ":") questions -= 1;
                else if (peek === "?") questions += 1;
                if (questions < 3 - operator.right) break;
              } else if (operator.right === 5) {
                if (peek === "[") brackets += 1;
                else if (peek === "]") brackets -= 1;
                if (brackets < 0) break;
              }
              if (stops.includes(peek)) break;
            }
          }
        }
        const right = preprocessEel(source.slice(at, end));
        at = end;
        if (operator.text === "[") {
          const leftText = (left ?? "").replace(/^\s+/, "");
          const rightText = right.replace(/^\s+/, "");
          if (/^gmem(?:\s|$)/i.test(leftText)) out += `_gmem(${right ? right : "0"}`;
          else if (rightText && rightText !== "0") out += `_mem((${leftText})+(${rightText})`;
          else out += `_mem(${leftText}`;
          if (source[at] === "]") at += 1;
        } else if (operator.text === "!") {
          out += `_not(${right}`;
        } else if (operator.text === "?") {
          let split = 0;
          let parens = 0;
          let open = 1;
          for (; split < right.length; split += 1) {
            const peek = right[split];
            if (peek === "?") open += 1;
            else if (peek === ":") open -= 1;
            else if (peek === "(") parens += 1;
            else if (peek === ")") parens -= 1;
            if (parens < 0) break;
            if (!parens && !open && peek === ":") break;
          }
          const whenTrue = right.slice(0, split).replace(/^\s+/, "");
          const whenFalse = split < right.length ? right.slice(split + 1).replace(/^\s+/, "") : "";
          out += `_if(${left ?? ""},${whenTrue || "0"},${whenFalse || "0"}`;
        } else {
          out += `${operator.call}(${left ?? ""},${right}`;
        }
        char = ")";
      }
    }
    out += char;
  }
  return out;
}

/** The functions MilkDrop's ns-eel2 knows, by the number of arguments it takes (calls with another count do not compile). */
const FUNCTIONS: Readonly<Record<string, number>> = {
  _if: 3, _and: 2, _or: 2, loop: 2, while: 1, _not: 1, _equal: 2, _noteq: 2, _below: 2, _above: 2, _beleq: 2, _aboeq: 2,
  _set: 2, _mod: 2, _mulop: 2, _divop: 2, _orop: 2, _andop: 2, _addop: 2, _subop: 2, _modop: 2, _powop: 2,
  sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, atan2: 2, sqr: 1, sqrt: 1, pow: 2, exp: 1, log: 1, log10: 1,
  abs: 1, min: 2, max: 2, sign: 1, rand: 1, floor: 1, ceil: 1, invsqrt: 1, sigmoid: 2, band: 2, bor: 2,
  exec2: 2, exec3: 3, _mem: 1, _gmem: 1, freembuf: 1, memcpy: 3, memset: 3
};
/** Names ns-eel2 reads as another function. */
const ALIASES: Readonly<Record<string, string>> = {
  if: "_if", bnot: "_not", assign: "_set", equal: "_equal", below: "_below", above: "_above",
  megabuf: "_mem", gmegabuf: "_gmem", int: "floor"
};

type Node =
  | { kind: "number"; value: number }
  | { kind: "name"; name: string }
  | { kind: "unary"; op: "-" | "+"; operand: Node }
  | { kind: "binary"; op: "|" | "&" | "+" | "-" | "*" | "/" | "%"; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

export class EelError extends Error {}

type Token = { type: "number"; value: number } | { type: "name"; name: string } | { type: "function"; name: string; arity: number } | { type: "op"; op: string };

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_.]*/;

function tokenize(statement: string): Token[] {
  const tokens: Token[] = [];
  let rest = statement;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (!rest) return tokens;
    const number = NUMBER.exec(rest);
    if (number) {
      tokens.push({ type: "number", value: Number(number[0]) });
      rest = rest.slice(number[0].length);
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      const lower = name[0].toLowerCase();
      const resolved = ALIASES[lower] ?? lower;
      const arity = FUNCTIONS[resolved];
      tokens.push(arity === undefined ? { type: "name", name: lower } : { type: "function", name: resolved, arity });
      rest = rest.slice(name[0].length);
      continue;
    }
    const op = rest[0]!;
    if (!"|&+-*/%(),=".includes(op)) throw new EelError(`unexpected '${op}'`);
    tokens.push({ type: "op", op });
    rest = rest.slice(1);
  }
}

const LEVELS: Readonly<Record<string, number>> = { "|": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "%": 4 };

/** One statement after preprocessing, by ns-eel2's yacc grammar. */
function parseStatement(statement: string): Node {
  const tokens = tokenize(statement);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const isOp = (op: string): boolean => {
    const token = peek();
    return token?.type === "op" && token.op === op;
  };
  const expect = (op: string): void => {
    if (!isOp(op)) throw new EelError(`expected '${op}'`);
    at += 1;
  };
  const primary = (): Node => {
    const token = peek();
    if (!token) throw new EelError("expression expected");
    at += 1;
    if (token.type === "number") return { kind: "number", value: token.value };
    if (token.type === "name") return { kind: "name", name: token.name };
    if (token.type === "function") {
      expect("(");
      const args = [expression(0)];
      while (args.length < token.arity) {
        expect(",");
        args.push(expression(0));
      }
      expect(")");
      return { kind: "call", name: token.name, args };
    }
    if (token.op === "(") {
      const inner = expression(0);
      expect(")");
      return inner;
    }
    if (token.op === "-" || token.op === "+") return { kind: "unary", op: token.op, operand: primary() };
    throw new EelError(`unexpected '${token.op}'`);
  };
  const expression = (minimum: number): Node => {
    let left = primary();
    for (;;) {
      const token = peek();
      const level = token?.type === "op" ? LEVELS[token.op] : undefined;
      if (level === undefined || level < minimum || token?.type !== "op") return left;
      at += 1;
      left = { kind: "binary", op: token.op as "|", left, right: expression(level + 1) };
    }
  };
  // yacc's statement rule `IDENTIFIER '=' expression` (the preprocessor normally leaves no bare `=`).
  let tree: Node;
  if (peek()?.type === "name" && tokens[at + 1]?.type === "op" && (tokens[at + 1] as { op: string }).op === "=") {
    const name = (peek() as { name: string }).name;
    at += 2;
    tree = { kind: "call", name: "_set", args: [{ kind: "name", name }, expression(0)] };
  } else {
    tree = expression(0);
  }
  if (at !== tokens.length) throw new EelError("unexpected text after the expression");
  return tree;
}

/** A number as eel-wasm reads one: digits, an optional point, no exponent. */
export function eelNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = String(value);
  if (!/e/i.test(text)) return text;
  if (Math.abs(value) >= 1) return BigInt(Math.round(value)).toString();
  const fixed = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  if (Number(fixed) === value) return fixed;
  // Tiny: a quotient of two integers eel-wasm can read.
  const [mantissa = "0", exponent = "0"] = value.toExponential().split("e");
  const digits = mantissa.replace(".", "").replace("-", "");
  const scale = -Number(exponent) + (mantissa.split(".")[1]?.length ?? 0);
  return `(${value < 0 ? "-" : ""}${digits}/1${"0".repeat(Math.max(0, scale))})`;
}

/** Writes trees back as eel-wasm source; numbered temporaries for what MilkDrop computes in C. */
class Writer {
  private temporaries = 0;
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  private temporary(role: string): string {
    this.temporaries += 1;
    return `${this.prefix}${this.temporaries}${role}`;
  }

  write(node: Node): string {
    switch (node.kind) {
      case "number":
        return eelNumber(node.value);
      case "name":
        return node.name;
      case "unary":
        return node.op === "-" ? `(-${this.write(node.operand)})` : this.write(node.operand);
      case "binary":
        if (node.op === "%") return `(${this.write(node.left)};\n${this.write(node.right)})`;
        return `(${this.write(node.left)} ${node.op} ${this.write(node.right)})`;
      default:
        return this.call(node.name, node.args);
    }
  }

  private call(name: string, args: Node[]): string {
    const [a, b, c] = args as [Node, Node, Node];
    const binary = (op: string): string => `(${this.write(a)} ${op} ${this.write(b)})`;
    switch (name) {
      case "_set": return this.assign(a, b);
      case "_addop": return this.update(a, b, "+=");
      case "_subop": return this.update(a, b, "-=");
      case "_mulop": return this.update(a, b, "*=");
      case "_divop": return this.update(a, b, "/=");
      case "_modop": return this.update(a, b, "%=");
      case "_powop": return this.update(a, b, "pow");
      case "_orop": return this.update(a, b, "|");
      case "_andop": return this.update(a, b, "&");
      case "_equal": return binary("==");
      case "_noteq": return binary("!=");
      case "_below": return binary("<");
      case "_above": return binary(">");
      case "_beleq": return binary("<=");
      case "_aboeq": return binary(">=");
      case "_and": return binary("&&");
      case "_or": return binary("||");
      case "_mod": return binary("%");
      case "_not": return `(!${this.write(a)})`;
      case "_if": return `if(${this.write(a)}, ${this.write(b)}, ${this.write(c)})`;
      case "_mem": return `megabuf(${this.write(a)})`;
      case "_gmem": return `gmegabuf(${this.write(a)})`;
      case "exec2": return `(${this.write(a)};\n${this.write(b)})`;
      case "exec3": return `(${this.write(a)};\n${this.write(b)};\n${this.write(c)})`;
      // MilkDrop's freembuf frees nothing and returns its argument.
      case "freembuf": return `(${this.write(a)})`;
      // The fast approximation MilkDrop uses is within 0.2 % of this; at 0 it gives 0, as eel-wasm's division does.
      case "invsqrt": return `(1 / sqrt(${this.write(a)}))`;
      case "memset": return this.memset(a, b, c);
      case "memcpy": return this.memcpy(a, b, c);
      default:
        return `${name}(${args.map((arg) => this.write(arg)).join(", ")})`;
    }
  }

  /** `target = value`, where MilkDrop's target may be any reference — a variable, megabuf(i), or an if() of references. */
  private assign(target: Node, value: Node): string {
    if (target.kind === "name") return `(${target.name} = ${this.write(value)})`;
    if (target.kind === "call" && (target.name === "_mem" || target.name === "_gmem")) {
      return `(${target.name === "_mem" ? "megabuf" : "gmegabuf"}(${this.write(target.args[0]!)}) = ${this.write(value)})`;
    }
    if (target.kind === "call" && target.name === "_if") {
      const held = this.temporary("v");
      const [test, whenTrue, whenFalse] = target.args as [Node, Node, Node];
      const branch = (reference: Node): string => (isReference(reference) ? this.assign(reference, { kind: "name", name: held }) : held);
      return `(${held} = ${this.write(value)};\nif(${this.write(test)}, ${branch(whenTrue)}, ${branch(whenFalse)}))`;
    }
    if (target.kind === "call" && isUpdate(target.name)) {
      // `(a = b) = c`: the inner assignment returns its target, which then gets c.
      return `(${this.write(target)};\n${this.assign(target.args[0]!, value)})`;
    }
    // Not a reference: MilkDrop writes into a temporary, and the value is what remains.
    return `(${this.write(target)};\n${this.write(value)})`;
  }

  /** `target op= value`; for the operators eel-wasm has no compound form of, written out, the index computed once. */
  private update(target: Node, value: Node, op: string): string {
    if (op === "+=" || op === "-=" || op === "*=" || op === "/=" || op === "%=") {
      if (target.kind === "name") return `(${target.name} ${op} ${this.write(value)})`;
      if (target.kind === "call" && (target.name === "_mem" || target.name === "_gmem")) {
        return `(${target.name === "_mem" ? "megabuf" : "gmegabuf"}(${this.write(target.args[0]!)}) ${op} ${this.write(value)})`;
      }
    }
    const combine = (current: string): string => (op === "pow" ? `pow(${current}, ${this.write(value)})` : `(${current} ${op.replace("=", "")} ${this.write(value)})`);
    if (target.kind === "name") return `(${target.name} = ${combine(target.name)})`;
    if (target.kind === "call" && (target.name === "_mem" || target.name === "_gmem")) {
      const buffer = target.name === "_mem" ? "megabuf" : "gmegabuf";
      const index = this.temporary("i");
      return `(${index} = ${this.write(target.args[0]!)};\n${buffer}(${index}) = ${combine(`${buffer}(${index})`)})`;
    }
    // A target that is no reference: the operation on a temporary, as MilkDrop computes it.
    return combine(this.write(target));
  }

  /** `int()` as MilkDrop's C code takes one: toward zero, after adding 0.0001. */
  private truncated(variable: string): string {
    return `${variable} = ${variable} + 0.0001;\n${variable} = if(${variable} < 0, -floor(-${variable}), floor(${variable}))`;
  }

  /**
   * A loop of `count` iterations without eel-wasm's limit of 1 048 576 per loop: MilkDrop's
   * memset and memcpy are C and fill all 8 388 608 slots of a buffer if asked.
   */
  private chunked(count: string, body: string): string {
    const left = this.temporary("n");
    return `${left} = ${count};\nloop((${left} + 65535) / 65536, loop(min(${left}, 65536), ${body});\n${left} -= 65536)`;
  }

  /** MilkDrop's memset (nseel-ram.c): the range trimmed to the buffer, the destination returned. */
  private memset(dest: Node, value: Node, count: Node): string {
    const result = this.temporary("r");
    const offset = this.temporary("o");
    const fill = this.temporary("v");
    const length = this.temporary("l");
    return `(${result} = ${this.write(dest)};\n${fill} = ${this.write(value)};\n${length} = ${this.write(count)};\n`
      + `${offset} = ${result};\n${this.truncated(offset)};\n${this.truncated(length)};\n`
      + `if(${offset} < 0, ${length} += ${offset};\n${offset} = 0, 0);\n`
      + `${length} = min(${length}, 8388608 - ${offset});\n`
      + `${this.chunked(length, `megabuf(${offset}) = ${fill};\n${offset} += 1`)};\n${result})`;
  }

  /** MilkDrop's memcpy (nseel-ram.c): trimmed at the front and to the buffer, overlapping ranges allowed, the destination returned. */
  private memcpy(dest: Node, source: Node, count: Node): string {
    const result = this.temporary("r");
    const to = this.temporary("d");
    const from = this.temporary("s");
    const length = this.temporary("l");
    const step = (sign: string): string => `megabuf(${to}) = megabuf(${from});\n${to} ${sign}= 1;\n${from} ${sign}= 1`;
    return `(${result} = ${this.write(dest)};\n${from} = ${this.write(source)};\n${length} = ${this.write(count)};\n`
      + `${to} = ${result};\n${this.truncated(to)};\n${this.truncated(from)};\n${this.truncated(length)};\n`
      + `if(${from} < 0, ${length} += ${from};\n${to} -= ${from};\n${from} = 0, 0);\n`
      + `if(${to} < 0, ${length} += ${to};\n${from} -= ${to};\n${to} = 0, 0);\n`
      + `${length} = min(${length}, 8388608 - max(${to}, ${from}));\n`
      + `if(${length} > 0, if(${to} <= ${from}, ${this.chunked(length, step("+"))}, `
      + `${to} += ${length} - 1;\n${from} += ${length} - 1;\n${this.chunked(length, step("-"))}), 0);\n${result})`;
  }
}

const isUpdate = (name: string): boolean => name === "_set" || /^_(?:add|sub|mul|div|mod|pow|or|and)op$/.test(name);

function isReference(node: Node): boolean {
  return node.kind === "name" || (node.kind === "call" && (node.name === "_mem" || node.name === "_gmem" || node.name === "_if" || isUpdate(node.name)));
}

export interface EelTranslation {
  /** eel-wasm source, empty when there is nothing to run. */
  code: string;
  /** Why the block does not compile in MilkDrop either; then `code` is empty. */
  error?: string;
}

/**
 * A block of preset equations (the lines of one `per_frame_`, `per_pixel_`, … section, joined
 * by newlines as milkdrop-preset-utils gives them) as eel-wasm source with MilkDrop's meaning.
 * `prefix` names the temporaries memcpy and memset need; it only has to be unlike the preset's
 * own variable names.
 */
export function translateEel(text: string, prefix = "__md"): EelTranslation {
  const joined = joinMilkdropLines(text);
  if (!joined.trim()) return { code: "" };
  const statements = preprocessEel(joined).split(";").map((part) => part.trim()).filter(Boolean);
  const writer = new Writer(prefix);
  const out: string[] = [];
  for (const statement of statements) {
    try {
      out.push(writer.write(parseStatement(statement)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { code: "", error: `${reason} in '${statement.slice(0, 80)}'` };
    }
  }
  return { code: out.map((line) => `${line};`).join("\n") };
}
