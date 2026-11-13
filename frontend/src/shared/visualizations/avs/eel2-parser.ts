/**
 * EEL2's syntax, for presets written for AVS builds on WDL's EEL2 (Cockos' chavs, AVS 2.82+).
 *
 * AVS 2.81 compiled code with ns-eel, which has no `a ? b : c`, no `x[y]` or `gmem[y]` memory,
 * no user functions, cut names to 8 characters, and cut the code at every `;`, also inside
 * brackets (`loop(n, a = a + 1; b = b * a)` did nothing there). EEL2 has all of them and groups
 * operators by its own grammar (eel2.y), not by ns-eel's. A preset that uses any of that syntax
 * was written for EEL2, so all of its code is read the EEL2 way (`presetEelDialect`); everything
 * else stays ns-eel (eel-grouping.ts), the AVS the presets were written in.
 *
 * EEL2's levels, tightest first (each left to right unless said):
 * - unary + − ! (then the operand: `-a^2` is (−a)²);
 * - `^`;
 * - `%`, `<<`, `>>` (their right side is a unary expression);
 * - `/` (its right side may be a `%` chain: a / b % c is a / (b % c));
 * - `*` (its right side may be a `/` chain);
 * - `-`, then `+` (a + b − c is a + (b − c));
 * - `&`, `|`, `~` (xor) on one level;
 * - comparisons `< > <= >= == != === !==`;
 * - `&&` and `||` on one level, to the right;
 * - `? :` (either part may be left out), to the right;
 * - assignment (`=`, `+=` … `~=`), whose right side is a whole `? :` expression;
 * - `;` sequences, also inside brackets and arguments.
 *
 * `x[y]` is the memory at x + y (`x[]` at x), `gmem[y]` the global memory at y. Functions
 * (`function f(a b) local(c) instance(d) ( … );`) are inlined at their calls with their
 * parameters and locals as their own variables, as EEL2 compiles them; `this.` and
 * `instance()` names take the namespace the function was called through (`ns.f()`).
 *
 * The tree uses eel-wasm's node types, with CONDITIONAL_EXPRESSION and MEMORY_EXPRESSION
 * added, so eel.ts converts both dialects alike. Pure (no imports): the tests load it with
 * plain Node.
 */

export interface Eel2Node {
  type: string;
  body?: Eel2Node[];
  left?: Eel2Node;
  right?: Eel2Node;
  operator?: string;
  value?: unknown;
  callee?: { type: string; value: string };
  arguments?: Eel2Node[];
  test?: Eel2Node;
  consequent?: Eel2Node;
  alternate?: Eel2Node;
  /** MEMORY_EXPRESSION: the address, and whether it is gmem (the global memory). */
  address?: Eel2Node;
  global?: boolean;
}

interface Token {
  kind: "number" | "name" | "op" | "end";
  text: string;
  value?: number;
  at: number;
}

const OPERATORS = [
  "===", "!==", "<<=", ">>=",
  "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=", "*=", "/=", "%=", "^=", "|=", "&=", "~=",
  "+", "-", "*", "/", "%", "^", "&", "|", "~", "!", "<", ">", "=", "?", ":", ";", ",", "(", ")", "[", "]"
];
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, phi: 1.618033988749895 };

export class Eel2SyntaxError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const fail = (message: string): never => {
    throw new Eel2SyntaxError(`${message} at ${at}`);
  };
  while (at < source.length) {
    const c = source[at]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      at += 1;
      continue;
    }
    if (c === "/" && source[at + 1] === "/") {
      while (at < source.length && source[at] !== "\n") at += 1;
      continue;
    }
    if (c === "/" && source[at + 1] === "*") {
      const end = source.indexOf("*/", at + 2);
      at = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c.charCodeAt(0) >= 0x80) {
      // A byte from 0x80 up: the reference's EEL2 reads nothing more up to the next `;` (also
      // past line breaks), as ns-eel did in its piece — authors' notes (ALT+0160, £, ¤, ·, ©).
      const end = source.indexOf(";", at);
      at = end < 0 ? source.length : end;
      continue;
    }
    const start = at;
    if (c === "$") {
      const rest = source.slice(at + 1);
      const hex = /^x([0-9a-f]+)/i.exec(rest);
      const char = /^'(.)'/.exec(rest);
      const named = /^(pi|phi|e)(?![A-Za-z0-9_.])/i.exec(rest);
      if (hex) {
        tokens.push({ kind: "number", text: source.slice(at, at + 1 + hex[0].length), value: parseInt(hex[1]!, 16), at: start });
        at += 1 + hex[0].length;
      } else if (char) {
        tokens.push({ kind: "number", text: source.slice(at, at + 4), value: char[1]!.charCodeAt(0), at: start });
        at += 4;
      } else if (named) {
        tokens.push({ kind: "number", text: source.slice(at, at + 1 + named[0].length), value: CONSTANTS[named[1]!.toLowerCase()]!, at: start });
        at += 1 + named[0].length;
      } else {
        fail("unknown $ constant");
      }
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const hex = /^0x([0-9a-f]+)/i.exec(source.slice(at));
      if (hex) {
        tokens.push({ kind: "number", text: hex[0], value: parseInt(hex[1]!, 16), at: start });
        at += hex[0].length;
        continue;
      }
      const number = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?/i.exec(source.slice(at));
      if (!number) fail("bad number");
      tokens.push({ kind: "number", text: number![0], value: Number(number![0]), at: start });
      at += number![0].length;
      continue;
    }
    if (/[A-Za-z_#]/.test(c)) {
      const name = /^[A-Za-z_#][A-Za-z0-9_.]*/.exec(source.slice(at))![0];
      tokens.push({ kind: "name", text: name, at: start });
      at += name.length;
      continue;
    }
    const operator = OPERATORS.find((op) => source.startsWith(op, at));
    if (!operator) fail(`unexpected ${JSON.stringify(c)}`);
    tokens.push({ kind: "op", text: operator!, at: start });
    at += operator!.length;
  }
  tokens.push({ kind: "end", text: "", at });
  return tokens;
}

const ASSIGNMENTS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "^=", "|=", "&=", "~="]);
const COMPARISONS = new Set(["<", ">", "<=", ">=", "==", "!=", "===", "!=="]);

interface FunctionDefinition {
  name: string;
  params: string[];
  locals: string[];
  instances: string[];
  body: Eel2Node;
}

class Parser {
  private at = 0;
  public readonly functions: FunctionDefinition[] = [];

  private readonly tokens: Token[];

  public constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.at + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (this.at < this.tokens.length - 1) this.at += 1;
    return token;
  }

  private isOp(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "op" && token.text === text;
  }

  private expect(text: string): void {
    if (!this.isOp(text)) throw new Eel2SyntaxError(`expected ${text} at ${this.peek().at}`);
    this.next();
  }

  /** program: statements separated by `;`, function definitions among them. */
  public program(): Eel2Node {
    const body: Eel2Node[] = [];
    while (this.peek().kind !== "end") {
      if (this.isOp(";")) {
        this.next();
        continue;
      }
      if (this.peek().kind === "name" && this.peek().text.toLowerCase() === "function" && this.peek(1).kind === "name") {
        this.functionDefinition();
        continue;
      }
      body.push(this.conditional());
      if (this.peek().kind !== "end") this.expect(";");
    }
    return { type: "SCRIPT", body };
  }

  private nameList(): string[] {
    this.expect("(");
    const names: string[] = [];
    while (!this.isOp(")")) {
      const token = this.next();
      if (token.kind === "name") names.push(token.text.toLowerCase());
      else if (!(token.kind === "op" && token.text === ",")) throw new Eel2SyntaxError(`bad name list at ${token.at}`);
    }
    this.expect(")");
    return names;
  }

  private functionDefinition(): void {
    this.next(); // function
    const name = this.next().text.toLowerCase();
    const params = this.nameList();
    const locals: string[] = [];
    const instances: string[] = [];
    while (this.peek().kind === "name") {
      const kind = this.next().text.toLowerCase();
      const names = this.nameList();
      if (kind === "local") locals.push(...names);
      else if (kind === "instance") instances.push(...names);
      else if (kind !== "global" && kind !== "globals") throw new Eel2SyntaxError(`unknown ${kind}() in function ${name}`);
    }
    this.expect("(");
    const body = this.sequence(")");
    this.expect(")");
    this.functions.push({ name, params, locals, instances, body });
  }

  /** `a; b; c` up to (not over) `close`: a block of its statements. */
  private sequence(close: string): Eel2Node {
    const body: Eel2Node[] = [];
    while (!this.isOp(close)) {
      if (this.isOp(";")) {
        this.next();
        continue;
      }
      if (this.peek().kind === "end") throw new Eel2SyntaxError(`expected ${close}`);
      body.push(this.conditional());
      if (!this.isOp(close)) this.expect(";");
    }
    return body.length === 1 ? body[0]! : { type: "EXPRESSION_BLOCK", body };
  }

  /** `c ? a : b`, either part optional, to the right. */
  private conditional(): Eel2Node {
    const test = this.logical();
    if (!this.isOp("?")) return test;
    this.next();
    const consequent = this.isOp(":") ? undefined : this.conditional();
    let alternate: Eel2Node | undefined;
    if (this.isOp(":")) {
      this.next();
      alternate = this.conditional();
    }
    return { type: "CONDITIONAL_EXPRESSION", test, consequent, alternate };
  }

  /** `&&` and `||` on one level, to the right. */
  private logical(): Eel2Node {
    const left = this.comparison();
    if (this.isOp("&&") || this.isOp("||")) {
      const operator = this.next().text;
      return { type: "LOGICAL_EXPRESSION", operator, left, right: this.logical() };
    }
    return left;
  }

  private comparison(): Eel2Node {
    let left = this.bitwise();
    while (this.peek().kind === "op" && COMPARISONS.has(this.peek().text)) {
      const operator = this.next().text;
      left = { type: "BINARY_EXPRESSION", operator, left, right: this.bitwise() };
    }
    return left;
  }

  private bitwise(): Eel2Node {
    let left = this.add();
    while (this.isOp("&") || this.isOp("|") || this.isOp("~")) {
      const operator = this.next().text;
      left = { type: "BINARY_EXPRESSION", operator, left, right: this.add() };
    }
    return left;
  }

  private add(): Eel2Node {
    let left = this.sub();
    while (this.isOp("+")) {
      this.next();
      left = { type: "BINARY_EXPRESSION", operator: "+", left, right: this.sub() };
    }
    return left;
  }

  private sub(): Eel2Node {
    let left = this.mul();
    while (this.isOp("-")) {
      this.next();
      left = { type: "BINARY_EXPRESSION", operator: "-", left, right: this.mul() };
    }
    return left;
  }

  private mul(): Eel2Node {
    let left = this.div();
    while (this.isOp("*")) {
      this.next();
      left = { type: "BINARY_EXPRESSION", operator: "*", left, right: this.div() };
    }
    return left;
  }

  private div(): Eel2Node {
    let left = this.mod();
    while (this.isOp("/")) {
      this.next();
      left = { type: "BINARY_EXPRESSION", operator: "/", left, right: this.mod() };
    }
    return left;
  }

  private mod(): Eel2Node {
    let left = this.pow();
    while (this.isOp("%") || this.isOp("<<") || this.isOp(">>")) {
      const operator = this.next().text;
      left = { type: "BINARY_EXPRESSION", operator, left, right: this.unary() };
    }
    return left;
  }

  private pow(): Eel2Node {
    let left = this.unary();
    while (this.isOp("^")) {
      this.next();
      left = { type: "BINARY_EXPRESSION", operator: "^", left, right: this.unary() };
    }
    return left;
  }

  private unary(): Eel2Node {
    if (this.isOp("-") || this.isOp("+") || this.isOp("!")) {
      const operator = this.next().text;
      return { type: "UNARY_EXPRESSION", operator, value: this.unary() };
    }
    return this.assignment();
  }

  /** An assignable value with `=` … after it, or an rvalue. */
  private assignment(): Eel2Node {
    const target = this.postfix();
    const token = this.peek();
    if (token.kind === "op" && ASSIGNMENTS.has(token.text)) {
      if (target.type === "NUMBER_LITERAL") throw new Eel2SyntaxError(`cannot assign to a number at ${token.at}`);
      this.next();
      return { type: "ASSIGNMENT_EXPRESSION", operator: token.text, left: target, right: this.conditional() };
    }
    return target;
  }

  /** A primary value with any `[index]` after it. */
  private postfix(): Eel2Node {
    let node = this.primary();
    while (this.isOp("[")) {
      this.next();
      const index = this.isOp("]") ? undefined : this.sequence("]");
      this.expect("]");
      const gmem = node.type === "IDENTIFIER" && String(node.value).toLowerCase() === "gmem";
      if (gmem) {
        node = { type: "MEMORY_EXPRESSION", global: true, address: index ?? { type: "NUMBER_LITERAL", value: 0 } };
      } else {
        const address = index ? { type: "BINARY_EXPRESSION", operator: "+", left: node, right: index } : node;
        node = { type: "MEMORY_EXPRESSION", global: false, address };
      }
    }
    return node;
  }

  private primary(): Eel2Node {
    const token = this.next();
    if (token.kind === "number") return { type: "NUMBER_LITERAL", value: token.value };
    if (token.kind === "op" && token.text === "(") {
      const inner = this.sequence(")");
      this.expect(")");
      return inner;
    }
    if (token.kind === "name") {
      if (this.isOp("(")) {
        this.next();
        const args: Eel2Node[] = [];
        while (!this.isOp(")")) {
          args.push(this.argument());
          if (this.isOp(",")) this.next();
          else if (!this.isOp(")")) throw new Eel2SyntaxError(`expected , or ) at ${this.peek().at}`);
        }
        this.expect(")");
        if (this.isOp("(") && token.text.toLowerCase() === "while" && args.length === 1) {
          // while (cond) (body) is while (cond ? (body; 1) : 0), as EEL2 rewrites it.
          this.next();
          const body = this.sequence(")");
          this.expect(")");
          const step: Eel2Node = { type: "EXPRESSION_BLOCK", body: [body, { type: "NUMBER_LITERAL", value: 1 }] };
          return { type: "CALL_EXPRESSION", callee: { type: "IDENTIFIER", value: token.text }, arguments: [{ type: "CONDITIONAL_EXPRESSION", test: args[0], consequent: step }] };
        }
        return { type: "CALL_EXPRESSION", callee: { type: "IDENTIFIER", value: token.text }, arguments: args };
      }
      return { type: "IDENTIFIER", value: token.text };
    }
    throw new Eel2SyntaxError(`unexpected ${token.text || "end"} at ${token.at}`);
  }

  /** One argument: statements up to the next `,` or `)` at this depth. */
  private argument(): Eel2Node {
    const body: Eel2Node[] = [];
    while (!this.isOp(",") && !this.isOp(")")) {
      if (this.isOp(";")) {
        this.next();
        continue;
      }
      if (this.peek().kind === "end") throw new Eel2SyntaxError("expected )");
      body.push(this.conditional());
      if (!this.isOp(",") && !this.isOp(")")) this.expect(";");
    }
    if (body.length === 0) throw new Eel2SyntaxError(`empty argument at ${this.peek().at}`);
    return body.length === 1 ? body[0]! : { type: "EXPRESSION_BLOCK", body };
  }
}

const MAX_INLINE_DEPTH = 16;

type Definitions = Map<string, FunctionDefinition & { index: number }>;

/** Where a name points inside the code being inlined: a function's own slot, or the preset's. */
interface Scope {
  name(name: string): string;
  /** The namespace `this.` stands for here ("" outside an instance call). */
  namespace: string;
}

const TOP: Scope = { name: (name) => name, namespace: "" };

/**
 * Calls to the definitions inlined: each argument into its own slot, then the parameters from
 * them (a call inside an argument cannot overwrite a parameter already set), then the body
 * with the function's own names. A function that nests itself too deep is an error.
 */
function inline(node: Eel2Node, functions: Definitions, depth: number, scope: Scope, counter: { calls: number }): Eel2Node {
  const visit = (child: Eel2Node | undefined): Eel2Node | undefined => (child ? inline(child, functions, depth, scope, counter) : child);
  switch (node.type) {
    case "IDENTIFIER":
      return { type: "IDENTIFIER", value: scope.name(String(node.value)) };
    case "CALL_EXPRESSION": {
      const full = String(node.callee!.value).toLowerCase();
      const args = (node.arguments ?? []).map((arg) => visit(arg)!);
      const dot = full.lastIndexOf(".");
      const own = functions.get(full);
      const through = !own && dot > 0 ? functions.get(full.slice(dot + 1)) : undefined;
      const fn = own ?? through;
      if (!fn) return { type: "CALL_EXPRESSION", callee: { type: "IDENTIFIER", value: String(node.callee!.value) }, arguments: args };
      if (depth >= MAX_INLINE_DEPTH) throw new Eel2SyntaxError(`function ${fn.name} nested too deep`);
      if (args.length !== fn.params.length) throw new Eel2SyntaxError(`function ${fn.name} takes ${fn.params.length} arguments`);
      let namespace = "";
      if (through) {
        const prefix = full.slice(0, dot);
        namespace = prefix === "this" ? scope.namespace : prefix.startsWith("this.") ? `${scope.namespace ? scope.namespace + "." : ""}${prefix.slice(5)}` : scope.name(prefix);
      }
      // Short names that stay apart when names are cut to 16 characters.
      const slot = (name: string): string => {
        const param = fn.params.indexOf(name);
        return param >= 0 ? `__f${fn.index}p${param}` : `__f${fn.index}l${fn.locals.indexOf(name)}`;
      };
      const inner: Scope = {
        namespace,
        name(name: string): string {
          const lower = name.toLowerCase();
          if (fn.params.includes(lower) || fn.locals.includes(lower)) return slot(lower);
          if (lower.startsWith("this.")) return namespace ? `${namespace}.${lower.slice(5)}` : lower.slice(5);
          if (fn.instances.includes(lower)) return namespace ? `${namespace}.${lower}` : lower;
          return name;
        }
      };
      const call = counter.calls++;
      const body: Eel2Node[] = [];
      args.forEach((arg, k) => body.push({ type: "ASSIGNMENT_EXPRESSION", operator: "=", left: { type: "IDENTIFIER", value: `__a${call}_${k}` }, right: arg }));
      fn.params.forEach((param, k) => body.push({ type: "ASSIGNMENT_EXPRESSION", operator: "=", left: { type: "IDENTIFIER", value: slot(param) }, right: { type: "IDENTIFIER", value: `__a${call}_${k}` } }));
      body.push(inline(fn.body, functions, depth + 1, inner, counter));
      return { type: "EXPRESSION_BLOCK", body };
    }
    default: {
      const out: Eel2Node = { ...node };
      if (node.body) out.body = node.body.map((child) => visit(child)!);
      if (node.left) out.left = visit(node.left);
      if (node.right) out.right = visit(node.right);
      if (node.type === "UNARY_EXPRESSION") out.value = visit(node.value as Eel2Node);
      if (node.test) out.test = visit(node.test);
      if (node.consequent) out.consequent = visit(node.consequent);
      if (node.alternate) out.alternate = visit(node.alternate);
      if (node.address) out.address = visit(node.address);
      return out;
    }
  }
}

/** EEL2 source to a tree, user functions inlined. Throws Eel2SyntaxError. */
export function parseEel2(source: string, shared: FunctionDefinition[] = []): Eel2Node {
  const parser = new Parser(tokenize(source));
  const tree = parser.program();
  const all = [...shared, ...parser.functions];
  const functions: Definitions = new Map(all.map((fn, index) => [fn.name, { ...fn, index }] as const));
  return inline(tree, functions, 0, TOP, { calls: 0 });
}

/** The function definitions in a section (for the other sections of the same effect). */
export function eel2Functions(source: string): FunctionDefinition[] {
  const parser = new Parser(tokenize(source));
  try {
    parser.program();
  } catch {
    /* the definitions read before the error still count */
  }
  return parser.functions;
}

/** Tokens only EEL2 has. */
function hasEel2Tokens(source: string): boolean {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return false;
  }
  /** `while (…) (…)`: the token after the while's closing bracket opens another. */
  const twoPartWhile = (k: number): boolean => {
    if (tokens[k + 1]?.text !== "(") return false;
    let depth = 0;
    for (let j = k + 1; j < tokens.length; j += 1) {
      if (tokens[j]!.text === "(") depth += 1;
      else if (tokens[j]!.text === ")" && --depth === 0) return tokens[j + 1]?.text === "(";
    }
    return false;
  };
  /** A `;` inside brackets: a sequence there, which 2.81 cut apart (grandchild's, ASD5A's loops). */
  let depth = 0;
  const sequenceInBrackets = tokens.some((token) => {
    if (token.kind !== "op") return false;
    if (token.text === "(") depth += 1;
    else if (token.text === ")") depth = Math.max(0, depth - 1);
    return token.text === ";" && depth > 0;
  });
  return sequenceInBrackets || tokens.some((token, k) =>
    (token.kind === "op" && ["?", "[", "]", "~", "<<", ">>", "===", "!==", "~=", "<<=", ">>="].includes(token.text))
    || (token.kind === "number" && token.text.startsWith("$") && !/^\$(pi|e|phi)$/i.test(token.text))
    || (token.kind === "name" && token.text.toLowerCase() === "function" && tokens[k + 1]?.kind === "name")
    || (token.kind === "name" && token.text.toLowerCase() === "while" && twoPartWhile(k)));
}

/** Whether code is EEL2: it has EEL2-only syntax, and reads as EEL2. */
export function usesEel2Syntax(source: string): boolean {
  if (!hasEel2Tokens(source)) return false;
  try {
    parseEel2(source);
    return true;
  } catch {
    return false;
  }
}

/** Every code string of a preset: each `code` field, or the strings in a `code` object. */
export function presetCode(preset: unknown, out: string[] = []): string[] {
  if (Array.isArray(preset)) {
    for (const item of preset) presetCode(item, out);
  } else if (preset && typeof preset === "object") {
    const node = preset as Record<string, unknown>;
    // AVS Trans' own text is macros for the other code, not code.
    if (node.type === "AVSTransAutomation") return out;
    for (const [key, value] of Object.entries(node)) {
      if (key === "code") {
        if (typeof value === "string") out.push(value);
        else if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const [section, text] of Object.entries(value as Record<string, unknown>)) {
            if (!section.startsWith("_") && typeof text === "string") out.push(text);
          }
        }
      } else if (value && typeof value === "object") {
        presetCode(value, out);
      }
    }
  }
  return out;
}

export type EelDialect = "ns-eel" | "eel2";

/** EEL2 when any of the preset's code has EEL2-only syntax that reads as EEL2; else ns-eel. */
export function presetEelDialect(preset: unknown): EelDialect {
  return presetCode(preset).some(usesEel2Syntax) ? "eel2" : "ns-eel";
}
