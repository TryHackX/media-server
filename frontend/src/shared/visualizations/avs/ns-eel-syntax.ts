/**
 * What AVS 2.81's ns-eel compiler accepts, and so which code sections it compiled at all.
 *
 * NSEEL_code_compile (nseel-compiler.c, AVS 2.81d) cuts the preprocessed text at every `;` —
 * brackets do not protect one — skips empty pieces, and parses each piece on its own with the
 * grammar of cal.y. When any piece fails, it returns no code at all: the whole section (a scope's
 * per-point code, a movement's code…) does nothing, also the statements that read well. Presets
 * carried such sections along (`x=x/2=30-5+y`, `: r=r+d*d`, two statements without a `;`), and
 * in AVS they did nothing.
 *
 * cal.y, as its parser tables have it:
 * - a piece is `identifier = expression` or an expression;
 * - expressions: `|` < `&` < `+ -` < `* / %` (each left to right) < unary `+ -`;
 * - operands: a number, a variable, `( expression )`, or a function with exactly its number of
 *   arguments, from ns-eel's table and AVS's (getosc, getspec, gettime, getkbmouse, setmousepos,
 *   megabuf, gmegabuf).
 *
 * The lexer (nseel-lextab.c, its DFA run on test strings) knows names, `+ - * / % & | ( ) = , ;`
 * and numbers: `[0-9]+` with an optional `d` (atoi), `[0-9]*.[0-9]*` with an optional exponent
 * after the dot — `.` alone is 0 — (atof), and `[0-9][0-9a-f]*h` (ns-eel's hex reading, which
 * shifts one nibble too many). A byte from 0x80 up ends the piece for the lexer, as the end of
 * the text does: the rest of the piece is not read. A piece that is only such a note (it starts
 * with the byte) is skipped. By the 2.81d sources it would fail the section (cal.y wants an
 * expression), but authors built whole sections around such notes (UnConeD's `©;` between the
 * parts of a frame's code, Jheriko's `·hyperboloid 1;`, `£ Phase 2: Slow down;`), so the AVS
 * they ran skipped them; the EEL2 reference does too. Any other
 * character (`<`, `!`, `?`, `:`, `[`, `^`, `"`…) is an error, and so is an assignment inside an
 * expression — AVS presets wrote `assign(x, v)` there.
 * `$pi`, `$e`, `$phi` and comments were replaced before (preprocessCode).
 * Pure (no imports): the tests load it with plain Node.
 */

/** ns-eel 2.81's functions (nseel-compiler.c fnTable) and AVS 2.81's (avs_eelif.cpp), by arity. */
export const NSEEL_281_FUNCTIONS: Readonly<Record<string, number>> = {
  if: 3, loop: 2, sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, atan2: 2, sqr: 1, sqrt: 1,
  pow: 2, exp: 1, log: 1, log10: 1, abs: 1, min: 2, max: 2, sigmoid: 2, sign: 1, rand: 1, band: 2,
  bor: 2, bnot: 1, equal: 2, below: 2, above: 2, floor: 1, ceil: 1, invsqrt: 1, assign: 2,
  exec2: 2, exec3: 3,
  getosc: 3, getspec: 3, gettime: 1, getkbmouse: 1, setmousepos: 2, megabuf: 1, gmegabuf: 1
};

type Token = { kind: "number" | "name" | "op"; text: string; value?: number };

/** preprocessCode: comments out, `$pi`/`$e`/`$phi` as their numbers, CR, LF and TAB as spaces. */
export function nsEelPreprocess(source: string): string {
  return source
    .replace(/\/\/[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
    .replace(/\$pi/gi, "3.141592653589793")
    .replace(/\$phi/gi, "1.61803399")
    .replace(/\$e/gi, "2.71828183")
    .replace(/[\r\n\t]/g, " ");
}

/**
 * The pieces NSEEL_code_compile parses one by one: cut at every `;`, empty ones skipped. Only
 * spaces are trimmed (preprocessCode made CR, LF and TAB spaces): a no-break space is the byte
 * 0xA0 to ns-eel, a note, not white space as String.trim has it.
 */
export function nsEelSegments(preprocessed: string): string[] {
  return preprocessed.split(";").map((piece) => piece.replace(/^ +| +$/g, "")).filter((piece) => piece.length > 0);
}

const NUMBERS: Array<[RegExp, (text: string) => number]> = [
  [/^[0-9][0-9a-fA-F]*[hH]/, (text) => {
    // nseel_translate(HEXCONST): add the digit, then shift — one nibble more than the digits.
    let value = 0;
    for (const c of text) {
      const digit = parseInt(c, 16);
      if (Number.isNaN(digit)) break;
      value = ((value + digit) << 4) | 0;
    }
    return value;
  }],
  [/^[0-9]*\.[0-9]*(?:[eE][+-]?[0-9]*)?/, (text) => {
    const value = parseFloat(text);
    return Number.isFinite(value) ? value : 0; // atof: "." and ".e" are 0
  }],
  [/^[0-9]+[dD]?/, (text) => parseInt(text, 10)]
];

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    // A byte from 0x80 up is a negative `char` to the lexer (lexgetc), which llinp takes for
    // the end of the text: the rest of the piece is not read. Authors wrote notes so — an
    // ALT+0160 (or £, ¤, ·, ©) after a piece's code, or as a piece of its own (no tokens).
    if (text.charCodeAt(at) >= 0x80) break;
    const rest = text.slice(at);
    const space = /^ +/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    // The lexer takes the longest match.
    let best: Token | null = null;
    for (const [pattern, value] of NUMBERS) {
      const match = pattern.exec(rest);
      if (match && (!best || match[0].length > best.text.length)) best = { kind: "number", text: match[0], value: value(match[0]) };
    }
    const name = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(rest);
    if (name && (!best || name[0].length > best.text.length)) best = { kind: "name", text: name[0] };
    if (!best && "+-*/%&|()=,".includes(rest[0]!)) best = { kind: "op", text: rest[0]! };
    if (!best) return null;
    tokens.push(best);
    at += best.text.length;
  }
  return tokens;
}

/** The piece's tokens when it parses with cal.y, else null; none for a piece that is only a note. */
function parsePiece(piece: string): Token[] | null {
  const tokens = tokenize(piece);
  if (!tokens) return null;
  if (tokens.length === 0) return /^ *[\u0080-\uffff]/.test(piece) ? [] : null;
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const isOp = (text: string): boolean => peek()?.kind === "op" && peek()?.text === text;
  const expect = (text: string): boolean => {
    if (!isOp(text)) return false;
    at += 1;
    return true;
  };
  const LEVELS = [["|"], ["&"], ["+", "-"], ["*", "/", "%"]];
  const binary = (level: number): boolean => {
    if (level === LEVELS.length) return unary();
    if (!binary(level + 1)) return false;
    while (peek()?.kind === "op" && LEVELS[level]!.includes(peek()!.text)) {
      at += 1;
      if (!binary(level + 1)) return false;
    }
    return true;
  };
  const unary = (): boolean => {
    if (isOp("-") || isOp("+")) {
      at += 1;
      return unary();
    }
    return primary();
  };
  const primary = (): boolean => {
    const token = peek();
    if (!token) return false;
    if (token.kind === "number") {
      at += 1;
      return true;
    }
    if (token.kind === "op") {
      if (token.text !== "(") return false;
      at += 1;
      return binary(0) && expect(")");
    }
    at += 1;
    const arity = NSEEL_281_FUNCTIONS[token.text.toLowerCase()];
    if (arity === undefined) return true; // a variable
    if (!expect("(")) return false;
    for (let index = 0; index < arity; index += 1) {
      if (index > 0 && !expect(",")) return false;
      if (!binary(0)) return false;
    }
    return expect(")");
  };
  // `identifier = expression`, or an expression.
  const first = tokens[0]!;
  if (first.kind === "name" && NSEEL_281_FUNCTIONS[first.text.toLowerCase()] === undefined && tokens[1]?.kind === "op" && tokens[1].text === "=") {
    at = 2;
  }
  return binary(0) && at === tokens.length ? tokens : null;
}

/** Whether one piece (no `;` in it) parses with cal.y (a note alone counts: it was skipped). */
export function nsEelAccepts(piece: string): boolean {
  return parsePiece(piece) !== null;
}

/**
 * A piece cal.y accepts, written for an ordinary EEL reader: numbers as ns-eel read them
 * (`.` is 0, `3d` is 3, `0FFh` is 4080), the rest as it was. Null when it does not parse, ""
 * for a note alone.
 */
export function nsEelNormalize(piece: string): string | null {
  const tokens = parsePiece(piece);
  if (!tokens) return null;
  return tokens.map((token) => (token.kind === "number" ? plainNumber(token.value!) : token.text)).join(" ");
}

/**
 * A number as digits and a point, never JavaScript's exponent form: the EEL reader after
 * nsEelNormalize takes no exponent, so `0.0000001` written back as `1e-7` failed the whole
 * section (Effekthasch — Theory Of Pretty Much Everything: Texer II's frame code with
 * `size = osize/(prspctv+0.0000001)` did nothing, the picture stayed black). The digits are
 * String()'s shortest ones with the point moved, so they read back as the same double.
 */
export function plainNumber(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = "", exponent] = match;
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponent);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Whether AVS 2.81 compiled this code at all (an empty section compiles to nothing anyway). */
export function nsEelCompiles(source: string): boolean {
  return nsEelSegments(nsEelPreprocess(source)).every(nsEelAccepts);
}
