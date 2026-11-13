import { eelGettime } from "./eel-math";
import { BUFFER, MATH, band, globalBuffer, localBuffers, type Scope } from "./eel";
import { eelRand } from "./webvs/avsRandom";
import { AVS_SAMPLES, VISDATA_OFFSETS, avsGetvis, type AvsVisdata } from "./winamp-visdata";

import * as Ast from "./webvs/expr/Ast";

/**
 * AVS scripts as WebAssembly, computing what eel.ts's closures compute, bit for bit.
 *
 * The closures in eel.ts are exact but slow where a preset does a lot per point: every variable
 * is a property looked up by name on the code instance (a dictionary object to V8, the lookup
 * megamorphic), every operation a function call. Here the same syntax tree becomes one
 * WebAssembly module per code instance — bytes built below, no source text is ever executed —
 * with the variables in linear memory.
 *
 * Exactness, operation by operation: the generator walks the tree as compileNode/compileCall do,
 * evaluates operands in the same order (right before left for `/`, memset's count before its
 * value), skips what they skip (the left of a division by zero, the second operand of band/bor,
 * the branch not taken), and uses only operations whose IEEE results are those of JavaScript's:
 * + − × ÷ and sqrt are correctly rounded in both; floor, ceil, trunc, abs, min and max agree for
 * ±0 and NaN; fistp (round half to even) is f64.nearest; the 32- and 64-bit integer paths of `%`,
 * `&`, `|`, `~`, `<<`, `>>` are done in i32/i64 with eel-math.ts's out-of-range rules. sin, cos,
 * tan, asin, acos, atan, atan2, pow, exp, log and log10 are the Math functions themselves,
 * imported (V8 calls them from wasm directly); what eel.ts and eel-math.ts do around them — the
 * x87 range of sin/cos/tan, log of v ≤ 0 as 0, sigmoid — is done here. getosc and getspec are
 * winamp-visdata.ts's avsGetvis done here too, on the analyser's visdata, which lives in a
 * WebAssembly memory of its own (createVisdata(true)) that the module imports as its memory 1:
 * the bytes the closures read, read where they are, with no call out of the module (where the
 * engine has no multi-memory WebAssembly, or the analyser keeps plain arrays, they are imports
 * of the closures' function). rand, gettime and gmegabuf are imports of the functions the
 * closures use. NaN and infinity never
 * reach a variable (eel.ts's `finite`). eel-wasm-backend.test.ts holds both backends to the same
 * values on generated programs, every operation at edge values and AVS's idioms.
 *
 * Memory: one WebAssembly.Memory per register bank (Main makes one per preset load), holding
 * reg00…reg99 at bytes 0…799 — the bank's properties become accessors into it, so every code
 * instance of the preset, wasm or not, and the APE host see one set of registers — then each
 * code instance's variables, and its 8 MB megabuf when the code first touches it (as eel.ts
 * allocates it on first use). The memory goes with the preset. gmegabuf stays eel.ts's array,
 * shared with the closures (it outlives presets, as in AVS), reached through two imports.
 *
 * When: an instance's first run queues it; its bytes are made between frames and compiled in the
 * background while the closures run; at a run after the module came, the state moves into the
 * memory (variables from the properties, the megabuf from eel.ts) and the sections run as wasm.
 * Between two runs both backends leave the same state, so any run boundary is a safe point.
 *
 * The variables stay properties of the code instance for the effects that set and read them
 * (code.x, code.skip …): accessors into the memory; SuperScope and Texer II use EelPort's slots
 * in their point loops. Anything a slot cannot mirror sends the instance back to the closures,
 * exactly: a name that is not a plain number at the first run (a variable called `init` or
 * `analyser`, which name the instance's own members), a value other than a number written by the
 * effect, a register bank swapped by setup(), a clone made by CodeInstance.clone (it runs the
 * closures on its own properties, as before). Going back copies the variables and the megabuf
 * where the closures keep them. Without WebAssembly, or when a module does not compile, the
 * closures run. Switches: globalThis.__avsEelWasm = false (closures only), __avsEelWasmSync = true
 * (compiled at the first run, for tests), __avsEelWasmStats = {} (how instances went, and why),
 * __avsEelWasmHeaps = [] (a WeakRef to every memory made: what a page still holds after a GC),
 * __avsEelWasmVis = false (getosc/getspec as imports of the closures' function, as before 10.11 evening).
 */

// Value types and opcodes (WebAssembly 2.0 core: bulk memory, saturating conversions).
const I32 = 0x7f;
const I64 = 0x7e;
const F64 = 0x7c;
const VOID = 0x40;
const OP = {
  block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, brIf: 0x0d, return: 0x0f, call: 0x10,
  drop: 0x1a, select: 0x1b, localGet: 0x20, localSet: 0x21, localTee: 0x22, globalGet: 0x23, globalSet: 0x24,
  f64Load: 0x2b, i32Load8S: 0x2c, i32Load8U: 0x2d, f64Store: 0x39, i32Const: 0x41, i64Const: 0x42, f64Const: 0x44,
  i32Eqz: 0x45, i32GeS: 0x4e, i32GeU: 0x4f, f64Eq: 0x61, f64Ne: 0x62, f64Lt: 0x63, f64Gt: 0x64, f64Ge: 0x66,
  i32Add: 0x6a, i32And: 0x71, i32Or: 0x72, i32Shl: 0x74, i32ShrS: 0x75, i64RemU: 0x82, i64And: 0x83, i64Or: 0x84, i64Xor: 0x85,
  f64Abs: 0x99, f64Neg: 0x9a, f64Ceil: 0x9b, f64Floor: 0x9c, f64Trunc: 0x9d, f64Nearest: 0x9e, f64Sqrt: 0x9f,
  f64Add: 0xa0, f64Sub: 0xa1, f64Mul: 0xa2, f64Div: 0xa3, f64Min: 0xa4, f64Max: 0xa5,
  f64ConvertI32S: 0xb7, f64ConvertI32U: 0xb8, f64ConvertI64S: 0xb9, f64ConvertI64U: 0xba,
  prefix: 0xfc
} as const;
const SAT = { i32TruncF64S: 0x02, i32TruncF64U: 0x03, i64TruncF64S: 0x06, i64TruncF64U: 0x07, memoryCopy: 0x0a, memoryFill: 0x0b } as const;

/** The imports every module declares, in this order (function indices 0…). */
const IMPORTS = [
  ["sin", 0], ["cos", 0], ["tan", 0], ["asin", 0], ["acos", 0], ["atan", 0], ["atan2", 1], ["pow", 1],
  ["exp", 0], ["log", 0], ["log10", 0], ["rand", 0], ["gettime", 0], ["getosc", 2],
  ["getspec", 2], ["gmGet", 3], ["gmSet", 4], ["extGet", 3], ["extSet", 4], ["allocMb", 5]
] as const;
type ImportName = (typeof IMPORTS)[number][0];
const FN = Object.fromEntries(IMPORTS.map(([name], index) => [name, index])) as Record<ImportName, number>;
/** Function types: index → [params, results]. */
const TYPES: [number[], number[]][] = [
  [[F64], [F64]], [[F64, F64], [F64]], [[F64, F64, F64], [F64]], [[I32], [F64]], [[I32, F64], []], [[], [I32]], [[], []]
];
const TYPE_HELPER = 1;
const TYPE_VIS = 2;
const TYPE_SECTION = 6;
/**
 * Helpers a module defines after the imports when its code uses them: `%`, `&`, `|`, `~`, `<<`, `>>`,
 * and getosc / getspec on the visdata memory.
 */
const HELPERS = ["mod", "and", "or", "xor", "shl", "shr", "osc", "spec"] as const;
type HelperKind = (typeof HELPERS)[number];
/** Globals: 0 = the instance's variables (byte offset, imported), 1 = its megabuf (0 until allocated). */
const VARS_BASE = 0;
const MEGABUF_BASE = 1;
/** Registers reg00…reg99 at the start of every memory. */
const REGISTER_BYTES = 800;
const MEGABUF_BYTES = BUFFER * 8;
const PAGE = 65536;

const TWO_31 = 2 ** 31;
const TWO_63 = 2 ** 63;
const CLOSE = 0.00001;

/** An own key (MATH is a plain object: `constructor` must not count as one of its functions). */
const own = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
/** The two-argument functions of eel.ts's MATH. */
const BINARY_MATH = new Set(["atan2", "pow", "sigmoid", "min", "max"]);
/** x87 fsin/fcos/fptan leave operands at or beyond ±2^63 (eel-math.ts). */
const X87_RANGE = 2 ** 63;

class Unsupported extends Error {}

// ---------------------------------------------------------------------------------------------
// Encoding

const uleb = (value: number, out: number[]): void => {
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
};

const sleb = (value: bigint, out: number[]): void => {
  let rest = value;
  for (;;) {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if ((rest === 0n && (byte & 0x40) === 0) || (rest === -1n && (byte & 0x40) !== 0)) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
};

const f64Bytes = new DataView(new ArrayBuffer(8));

const section = (id: number, body: number[], out: number[]): void => {
  out.push(id);
  uleb(body.length, out);
  for (const byte of body) out.push(byte);
};

/** A name of this module's (ASCII). */
const name = (text: string, out: number[]): void => {
  uleb(text.length, out);
  for (let k = 0; k < text.length; k += 1) out.push(text.charCodeAt(k));
};

/** One function's code: instructions and the locals it asks for (temporaries are reused). */
class Code {
  readonly bytes: number[] = [];
  private readonly declared: number[] = [];
  private readonly free = new Map<number, number[]>();
  private readonly params: number;

  constructor(params: number) {
    this.params = params;
  }

  op(...codes: number[]): this {
    for (const code of codes) this.bytes.push(code);
    return this;
  }

  index(value: number): this {
    uleb(value, this.bytes);
    return this;
  }

  f64(value: number): this {
    this.bytes.push(OP.f64Const);
    f64Bytes.setFloat64(0, value, true);
    for (let k = 0; k < 8; k += 1) this.bytes.push(f64Bytes.getUint8(k));
    return this;
  }

  i32(value: number): this {
    this.bytes.push(OP.i32Const);
    sleb(BigInt(value | 0), this.bytes);
    return this;
  }

  i64(value: bigint): this {
    this.bytes.push(OP.i64Const);
    sleb(value, this.bytes);
    return this;
  }

  get(local: number): this {
    return this.op(OP.localGet).index(local);
  }

  set(local: number): this {
    return this.op(OP.localSet).index(local);
  }

  tee(local: number): this {
    return this.op(OP.localTee).index(local);
  }

  call(fn: number): this {
    return this.op(OP.call).index(fn);
  }

  sat(code: number): this {
    return this.op(OP.prefix, code);
  }

  load(offset: number): this {
    return this.op(OP.f64Load, 3).index(offset);
  }

  store(offset: number): this {
    return this.op(OP.f64Store, 3).index(offset);
  }

  temp(type: number): number {
    const pool = this.free.get(type);
    if (pool && pool.length > 0) return pool.pop()!;
    this.declared.push(type);
    return this.params + this.declared.length - 1;
  }

  release(type: number, local: number): void {
    const pool = this.free.get(type);
    if (pool) pool.push(local);
    else this.free.set(type, [local]);
  }

  /** The function body: locals, code and the final `end`. */
  finish(): number[] {
    const out: number[] = [];
    const groups: [number, number][] = [];
    for (const type of this.declared) {
      const last = groups[groups.length - 1];
      if (last && last[1] === type) last[0] += 1;
      else groups.push([1, type]);
    }
    uleb(groups.length, out);
    for (const [count, type] of groups) {
      uleb(count, out);
      out.push(type);
    }
    for (const byte of this.bytes) out.push(byte);
    out.push(OP.end);
    const sized: number[] = [];
    uleb(out.length, sized);
    return sized.concat(out);
  }
}

/** eelTrue on the f64 on the stack: |v| ≥ 0.00001 (NaN false), as an i32. */
const truth = (code: Code): Code => code.op(OP.f64Abs).f64(CLOSE).op(OP.f64Ge);

/** fistp of the f64 in `local` into a 64-bit integer; out of range and NaN: the "integer indefinite". */
const qword = (code: Code, local: number): Code =>
  code.get(local).op(OP.f64Nearest).tee(local).op(OP.f64Abs).f64(TWO_63).op(OP.f64Lt)
    .op(OP.if, I64).get(local).sat(SAT.i64TruncF64S).op(OP.else).i64(-(2n ** 63n)).op(OP.end);

/** fistp into 32 bits, out of range and NaN as 0x80000000 (eelShift's int32). */
const dword = (code: Code, local: number): Code =>
  code.get(local).op(OP.f64Nearest).tee(local).op(OP.f64Abs).f64(TWO_31).op(OP.f64Lt)
    .op(OP.if, I32).get(local).sat(SAT.i32TruncF64S).op(OP.else).i32(-TWO_31).op(OP.end);

/** fistp of |v| as `%` reads it: up to 2^31, out of range and NaN 2^31 (eelModulo's unsignedDword). */
const unsignedDword = (code: Code, local: number): Code =>
  code.get(local).op(OP.f64Abs, OP.f64Nearest).tee(local).f64(TWO_31).op(OP.f64Lt)
    .op(OP.if, F64).get(local).op(OP.else).f64(TWO_31).op(OP.end);

/** x86's (int) of the f64 in `local` (winamp-visdata.ts cInt), as an f64: truncated, 0x80000000 when out of range or NaN. */
const cInt = (code: Code, local: number): Code =>
  code.get(local).f64(-2147483649).op(OP.f64Gt).get(local).f64(2147483648).op(OP.f64Lt, OP.i32And)
    .op(OP.if, F64).get(local).op(OP.f64Trunc, OP.else).f64(-2147483648).op(OP.end);

/** A byte of the visdata memory (memory 1) at the address on the stack + `offset`: signed for the waveform. */
const visByte = (code: Code, waveform: boolean, offset: number): Code => {
  code.op(waveform ? OP.i32Load8S : OP.i32Load8U, 0x40, 1);
  return code.index(offset);
};

/**
 * winamp-visdata.ts avsGetvis(visdata, waveform, band, width, channel) on the visdata memory, step by step
 * (params: band, width, channel). The positions are whole numbers far inside 2^53, so f64 holds them as the
 * double arithmetic does; the bytes add up as integers (at most 576 · 510).
 */
function visHelper(waveform: boolean): number[] {
  const code = new Code(3);
  const t = code.temp(F64);
  const which = code.temp(F64);
  const bw = code.temp(F64);
  const bc = code.temp(F64);
  const at = code.temp(I32);
  const end = code.temp(I32);
  const sum = code.temp(I32);
  const base = code.temp(I32);
  const [left, right] = waveform ? [VISDATA_OFFSETS[2], VISDATA_OFFSETS[3]] : [VISDATA_OFFSETS[0], VISDATA_OFFSETS[1]];
  // which = cInt(channel + 0.5); not 0, 1 or 2: 0
  code.get(2).f64(0.5).op(OP.f64Add).set(t);
  cInt(code, t).set(which);
  code.get(which).f64(0).op(OP.f64Eq).get(which).f64(1).op(OP.f64Eq, OP.i32Or).get(which).f64(2).op(OP.f64Eq, OP.i32Or)
    .op(OP.i32Eqz, OP.if, VOID).f64(0).op(OP.return, OP.end);
  // bw = cInt(width · 576), bc = cInt(band · 576)
  code.get(1).f64(AVS_SAMPLES).op(OP.f64Mul).set(t);
  cInt(code, t).set(bw);
  code.get(0).f64(AVS_SAMPLES).op(OP.f64Mul).set(t);
  cInt(code, t).set(bc);
  // if (bw < 1) bw = 1; bc -= trunc(bw / 2)
  code.get(bw).f64(1).op(OP.f64Lt, OP.if, VOID).f64(1).set(bw).op(OP.end);
  code.get(bc).get(bw).f64(2).op(OP.f64Div, OP.f64Trunc, OP.f64Sub).set(bc);
  // if (bc < 0) { bw += bc; bc = 0 }  if (bc > 575) bc = 575  if (bc + bw > 576) bw = 576 − bc
  code.get(bc).f64(0).op(OP.f64Lt, OP.if, VOID).get(bw).get(bc).op(OP.f64Add).set(bw).f64(0).set(bc).op(OP.end);
  code.get(bc).f64(AVS_SAMPLES - 1).op(OP.f64Gt, OP.if, VOID).f64(AVS_SAMPLES - 1).set(bc).op(OP.end);
  code.get(bc).get(bw).op(OP.f64Add).f64(AVS_SAMPLES).op(OP.f64Gt, OP.if, VOID).f64(AVS_SAMPLES).get(bc).op(OP.f64Sub).set(bw).op(OP.end);
  // The bytes bc … bc + bw − 1 (none when bw ≤ 0): both channels' for 0, else one channel's.
  code.i32(0).set(sum);
  code.get(bw).f64(0).op(OP.f64Gt, OP.if, VOID);
  code.get(bc).sat(SAT.i32TruncF64S).set(at).get(bc).get(bw).op(OP.f64Add).sat(SAT.i32TruncF64S).set(end);
  code.get(which).f64(0).op(OP.f64Eq, OP.if, VOID);
  code.op(OP.block, VOID, OP.loop, VOID).get(at).get(end).op(OP.i32GeS, OP.brIf, 1).get(sum).get(at);
  visByte(code, waveform, left).op(OP.i32Add).get(at);
  visByte(code, waveform, right).op(OP.i32Add).set(sum).get(at).i32(1).op(OP.i32Add).set(at).op(OP.br, 0, OP.end, OP.end);
  code.op(OP.else).get(which).f64(1).op(OP.f64Eq, OP.if, I32).i32(left).op(OP.else).i32(right).op(OP.end).set(base);
  code.op(OP.block, VOID, OP.loop, VOID).get(at).get(end).op(OP.i32GeS, OP.brIf, 1).get(sum).get(at).get(base).op(OP.i32Add);
  visByte(code, waveform, 0).op(OP.i32Add).set(sum).get(at).i32(1).op(OP.i32Add).set(at).op(OP.br, 0, OP.end, OP.end);
  code.op(OP.end, OP.end);
  // sum / (bw · 255) for both channels, sum / (bw · 127.5) for one; the spectrum's halved.
  code.get(sum).op(OP.f64ConvertI32S).get(bw).get(which).f64(0).op(OP.f64Eq, OP.if, F64).f64(255).op(OP.else).f64(127.5)
    .op(OP.end, OP.f64Mul, OP.f64Div);
  if (!waveform) code.f64(0.5).op(OP.f64Mul);
  return code.finish();
}

function helper(kind: HelperKind): number[] {
  if (kind === "osc" || kind === "spec") return visHelper(kind === "osc");
  const code = new Code(2);
  switch (kind) {
    case "mod": {
      // eelModulo: divisor = udw(right); divisor ? udw(left) % divisor : 0.
      unsignedDword(code, 1).set(1);
      code.get(1).f64(0).op(OP.f64Eq).op(OP.if, F64).f64(0).op(OP.else);
      unsignedDword(code, 0).sat(SAT.i64TruncF64U).get(1).sat(SAT.i64TruncF64U).op(OP.i64RemU, OP.f64ConvertI64U);
      code.op(OP.end);
      break;
    }
    case "and":
    case "or":
    case "xor":
      // eelBitwise/eelXor: within 32 bits as int32, else on 64-bit integers — the same numbers.
      qword(code, 0);
      qword(code, 1);
      code.op(kind === "and" ? OP.i64And : kind === "or" ? OP.i64Or : OP.i64Xor, OP.f64ConvertI64S);
      break;
    case "shl":
    case "shr":
      dword(code, 0);
      dword(code, 1);
      code.op(kind === "shl" ? OP.i32Shl : OP.i32ShrS, OP.f64ConvertI32S);
      break;
  }
  return code.finish();
}

// ---------------------------------------------------------------------------------------------
// Code generation

/** Where a variable lives: a slot of the instance's variables, or a property reached through JS. */
export type Slot = { memory: number } | { external: number };

class Generator {
  private readonly code: Code;
  private readonly slots: ReadonlyMap<string, Slot>;
  private readonly helpers: ReadonlyMap<HelperKind, number>;

  constructor(code: Code, slots: ReadonlyMap<string, Slot>, helpers: ReadonlyMap<HelperKind, number>) {
    this.code = code;
    this.slots = slots;
    this.helpers = helpers;
  }

  /** The function index of a helper (the module has the ones its code uses). */
  private helper(kind: HelperKind): number {
    const index = this.helpers.get(kind);
    if (index === undefined) throw new Unsupported(`helper ${kind}`);
    return index;
  }

  private slot(target: Ast.PrimaryExpr): Slot {
    const slot = this.slots.get(target.value);
    if (!slot) throw new Unsupported(`no slot for ${target.value}`);
    return slot;
  }

  /** Pushes the value of a variable or register. */
  private read(target: Ast.PrimaryExpr): void {
    if (target.type === Ast.PrimaryExprType.REG) {
      this.code.i32(0).load(registerIndex(target.value) * 8);
      return;
    }
    const slot = this.slot(target);
    if ("memory" in slot) this.code.op(OP.globalGet).index(VARS_BASE).load(slot.memory * 8);
    else this.code.i32(slot.external).call(FN.extGet);
  }

  /** Stores the f64 in `local` into a variable or register (nothing left on the stack). */
  private write(target: Ast.PrimaryExpr, local: number): void {
    if (target.type === Ast.PrimaryExprType.REG) {
      this.code.i32(0).get(local).store(registerIndex(target.value) * 8);
      return;
    }
    const slot = this.slot(target);
    if ("memory" in slot) this.code.op(OP.globalGet).index(VARS_BASE).get(local).store(slot.memory * 8);
    else this.code.i32(slot.external).get(local).call(FN.extSet);
  }

  /** eel.ts `finite` on the f64 on the stack. */
  private finite(): void {
    const t = this.code.temp(F64);
    this.code.set(t).get(t).f64(0).get(t).get(t).op(OP.f64Sub).f64(0).op(OP.f64Eq, OP.select);
    this.code.release(F64, t);
  }

  statement(node: Ast.Statement): void {
    this.expr(node);
    this.code.op(OP.drop);
  }

  /** Pushes the node's value (an f64), as compileNode's closure returns it. */
  expr(node: Ast.Statement): void {
    const code = this.code;
    if (node instanceof Ast.PrimaryExpr) {
      switch (node.type) {
        case Ast.PrimaryExprType.VALUE:
          code.f64(Number(node.value));
          return;
        case Ast.PrimaryExprType.CONST:
          code.f64(node.value === "pi" ? Math.PI : node.value === "e" ? Math.E : 1.6180339887);
          return;
        case Ast.PrimaryExprType.REG:
        case Ast.PrimaryExprType.ID:
          this.read(node);
          return;
      }
      throw new Unsupported("primary");
    }
    if (node instanceof Ast.Assignment) {
      this.assignment(node.lhs, node.expr);
      return;
    }
    if (node instanceof Ast.UnaryExpr) {
      this.expr(node.operand);
      if (node.operator === "-") code.op(OP.f64Neg);
      return;
    }
    if (node instanceof Ast.BinaryExpr) {
      switch (node.operator) {
        case "+":
        case "-":
        case "*":
          this.expr(node.leftOperand);
          this.expr(node.rightOperand);
          code.op(node.operator === "+" ? OP.f64Add : node.operator === "-" ? OP.f64Sub : OP.f64Mul);
          return;
        case "/": {
          // The divisor first; the dividend only when it is not 0.
          const divisor = code.temp(F64);
          this.expr(node.rightOperand);
          code.tee(divisor).f64(0).op(OP.f64Ne).op(OP.if, F64);
          this.expr(node.leftOperand);
          code.get(divisor).op(OP.f64Div, OP.else).f64(0).op(OP.end);
          code.release(F64, divisor);
          return;
        }
        case "%":
        case "&":
        case "|":
          this.expr(node.leftOperand);
          this.expr(node.rightOperand);
          code.call(this.helper(node.operator === "%" ? "mod" : node.operator === "&" ? "and" : "or"));
          return;
      }
      throw new Unsupported(`operator ${node.operator}`);
    }
    if (node instanceof Ast.FuncCall) {
      this.call(node);
      return;
    }
    throw new Unsupported("node");
  }

  /** Assignment to a variable or register (eel.ts compileNode): the value, made finite, stored and returned. */
  private assignment(target: Ast.PrimaryExpr, value: Ast.Expression): void {
    if (!(target instanceof Ast.PrimaryExpr) || (target.type !== Ast.PrimaryExprType.ID && target.type !== Ast.PrimaryExprType.REG)) {
      throw new Unsupported("assignment target");
    }
    const result = this.code.temp(F64);
    this.expr(value);
    this.finite();
    this.code.set(result);
    this.write(target, result);
    this.code.get(result);
    this.code.release(F64, result);
  }

  /** eel.ts assignTo. */
  private assignTo(target: Ast.Expression, value: Ast.Expression): void {
    const code = this.code;
    if (target instanceof Ast.PrimaryExpr && (target.type === Ast.PrimaryExprType.ID || target.type === Ast.PrimaryExprType.REG)) {
      this.assignment(target, value);
      return;
    }
    if (target instanceof Ast.FuncCall && target.funcName === "if" && target.args.length === 3) {
      this.expr(target.args[0]!);
      truth(code).op(OP.if, F64);
      this.assignTo(target.args[1]!, value);
      code.op(OP.else);
      this.assignTo(target.args[2]!, value);
      code.op(OP.end);
      return;
    }
    if (target instanceof Ast.FuncCall && (target.funcName === "megabuf" || target.funcName === "gmegabuf")) {
      this.bufferSet(target.funcName === "gmegabuf", target.args[0]!, value);
      return;
    }
    this.expr(value);
  }

  /** Pushes the local megabuf's base address, allocating it on first use. */
  private megabufBase(): void {
    this.code.op(OP.globalGet).index(MEGABUF_BASE).op(OP.i32Eqz, OP.if, VOID).call(FN.allocMb)
      .op(OP.globalSet).index(MEGABUF_BASE).op(OP.end).op(OP.globalGet).index(MEGABUF_BASE);
  }

  /** Pushes the address of slot `index` (an f64 local holding a valid position) of the local megabuf. */
  private megabufAddress(index: number): void {
    this.megabufBase();
    this.code.get(index).sat(SAT.i32TruncF64U).i32(3).op(OP.i32Shl, OP.i32Add);
  }

  /** eel.ts slot(): floor(index + 0.00001) into `local`, leaving "0 ≤ p < BUFFER" (i32) on the stack. */
  private position(index: Ast.Expression, local: number): void {
    this.expr(index);
    this.code.f64(CLOSE).op(OP.f64Add, OP.f64Floor).tee(local).f64(0).op(OP.f64Ge)
      .get(local).f64(BUFFER).op(OP.f64Lt).op(0x71); // i32.and
  }

  private bufferGet(global: boolean, index: Ast.Expression): void {
    const code = this.code;
    const position = code.temp(F64);
    this.position(index, position);
    code.op(OP.if, F64);
    if (global) code.get(position).sat(SAT.i32TruncF64U).call(FN.gmGet);
    else {
      this.megabufAddress(position);
      code.load(0);
    }
    code.op(OP.else).f64(0).op(OP.end);
    code.release(F64, position);
  }

  private bufferSet(global: boolean, index: Ast.Expression, value: Ast.Expression): void {
    const code = this.code;
    const position = code.temp(F64);
    const valid = code.temp(I32);
    const result = code.temp(F64);
    this.position(index, position);
    code.set(valid);
    this.expr(value);
    this.finite();
    code.set(result).get(valid).op(OP.if, VOID);
    if (global) code.get(position).sat(SAT.i32TruncF64U).get(result).call(FN.gmSet);
    else {
      this.megabufAddress(position);
      code.get(result).store(0);
    }
    code.op(OP.end).get(result);
    code.release(F64, position);
    code.release(I32, valid);
    code.release(F64, result);
  }

  /** compileCall. */
  private call(node: Ast.FuncCall): void {
    const code = this.code;
    const name = node.funcName;
    const args = node.args;
    const arg = (index: number): Ast.Expression => {
      const found = args[index];
      if (!found) throw new Unsupported(`${name}: argument ${index}`);
      return found;
    };
    switch (name) {
      case "if":
        this.expr(arg(0));
        truth(code).op(OP.if, F64);
        this.expr(arg(1));
        code.op(OP.else);
        this.expr(arg(2));
        code.op(OP.end);
        return;
      case "above":
      case "below":
        this.expr(arg(0));
        this.expr(arg(1));
        code.op(name === "above" ? OP.f64Gt : OP.f64Lt, OP.f64ConvertI32U);
        return;
      case "equal":
        this.expr(arg(0));
        this.expr(arg(1));
        code.op(OP.f64Sub, OP.f64Abs).f64(CLOSE).op(OP.f64Lt, OP.f64ConvertI32U);
        return;
      case "equal_exact":
        this.expr(arg(0));
        this.expr(arg(1));
        code.op(OP.f64Eq, OP.f64ConvertI32U);
        return;
      case "bxor":
      case "shl":
      case "shr":
        this.expr(arg(0));
        this.expr(arg(1));
        code.call(this.helper(name === "bxor" ? "xor" : name === "shl" ? "shl" : "shr"));
        return;
      case "band":
        this.expr(arg(0));
        truth(code).op(OP.if, F64);
        this.expr(arg(1));
        truth(code).op(OP.f64ConvertI32U, OP.else).f64(0).op(OP.end);
        return;
      case "bor":
        this.expr(arg(0));
        truth(code).op(OP.if, F64).f64(1).op(OP.else);
        this.expr(arg(1));
        truth(code).op(OP.f64ConvertI32U, OP.end);
        return;
      case "bnot":
        this.expr(arg(0));
        truth(code).op(OP.i32Eqz, OP.f64ConvertI32U);
        return;
      case "execn":
      case "exec2":
      case "exec3":
        if (args.length === 0) {
          code.f64(0);
          return;
        }
        args.forEach((each, index) => {
          this.expr(each);
          if (index < args.length - 1) code.op(OP.drop);
        });
        return;
      case "loop": {
        // count = min(BUFFER, max(0, floor(n))) — NaN runs no times; the last body's value, or 0.
        const result = code.temp(F64);
        const count = code.temp(I32);
        const index = code.temp(I32);
        code.f64(0).set(result);
        this.expr(arg(0));
        code.op(OP.f64Floor).f64(0).op(OP.f64Max).f64(BUFFER).op(OP.f64Min).sat(SAT.i32TruncF64S).set(count);
        code.i32(0).set(index).op(OP.block, VOID, OP.loop, VOID).get(index).get(count).op(OP.i32GeS, OP.brIf, 1);
        this.expr(arg(1));
        code.set(result).get(index).i32(1).op(OP.i32Add).set(index).op(OP.br, 0, OP.end, OP.end).get(result);
        code.release(F64, result);
        code.release(I32, count);
        code.release(I32, index);
        return;
      }
      case "while": {
        // The condition again while true, BUFFER times at most (it is evaluated once more then); 0.
        const guard = code.temp(I32);
        code.i32(0).set(guard).op(OP.block, VOID, OP.loop, VOID);
        this.expr(arg(0));
        truth(code).op(OP.i32Eqz, OP.brIf, 1).get(guard).i32(BUFFER).op(OP.i32GeS, OP.brIf, 1)
          .get(guard).i32(1).op(OP.i32Add).set(guard).op(OP.br, 0, OP.end, OP.end).f64(0);
        code.release(I32, guard);
        return;
      }
      case "assign":
        this.assignTo(arg(0), arg(1));
        return;
      case "megabuf":
      case "gmegabuf":
        this.bufferGet(name === "gmegabuf", arg(0));
        return;
      case "megabuf_set":
      case "gmegabuf_set":
        this.bufferSet(name === "gmegabuf_set", arg(0), arg(1));
        return;
      case "memset":
        this.memset(arg(0), arg(1), arg(2));
        return;
      case "memcpy":
        this.memcpy(arg(0), arg(1), arg(2));
        return;
      case "freembuf":
        this.freembuf(arg(0));
        return;
      case "rand": {
        const target = (node as Ast.FuncCall & { setsArgument?: boolean }).setsArgument ? args[0] : null;
        if (target instanceof Ast.PrimaryExpr && (target.type === Ast.PrimaryExprType.ID || target.type === Ast.PrimaryExprType.REG)) {
          // ns-eel: a variable below 1 is set to 1; rand gets the value it had.
          const value = code.temp(F64);
          const one = code.temp(F64);
          this.expr(arg(0));
          code.tee(value).f64(1).op(OP.f64Lt, OP.if, VOID).f64(1).set(one);
          this.write(target, one);
          code.op(OP.end).get(value).call(FN.rand);
          code.release(F64, value);
          code.release(F64, one);
          return;
        }
        this.expr(arg(0));
        code.call(FN.rand);
        return;
      }
      case "getkbmouse":
        this.expr(arg(0));
        code.op(OP.drop).f64(0);
        return;
      case "setmousepos":
        this.expr(arg(0));
        code.op(OP.drop);
        this.expr(arg(1));
        code.op(OP.drop).f64(0);
        return;
      case "gettime":
        this.expr(arg(0));
        code.call(FN.gettime);
        return;
      case "getosc":
      case "getspec": {
        this.expr(arg(0));
        this.expr(arg(1));
        if (args.length > 2) this.expr(arg(2));
        else code.f64(0);
        // On the visdata memory where the module has it (helpersOf), else the closures' function.
        const vis = this.helpers.get(name === "getosc" ? "osc" : "spec");
        code.call(vis ?? (name === "getosc" ? FN.getosc : FN.getspec));
        return;
      }
    }
    if (!own(MATH, name)) throw new Unsupported(`function ${name}`);
    if (args.length !== (BINARY_MATH.has(name) ? 2 : 1)) throw new Unsupported(`${name}: ${args.length} arguments`);
    for (const each of args) this.expr(each);
    this.math(name);
    this.finite();
  }

  /**
   * eel.ts's MATH on the operands on the stack. Math.sin and the other JavaScript functions are
   * imported themselves (not wrapped), what eel.ts and eel-math.ts do around them is done here:
   * the x87 range of sin, cos and tan, log and log10 of v ≤ 0 as 0, sigmoid's guard. The rest
   * WebAssembly has, with JavaScript's results.
   */
  private math(name: string): void {
    const code = this.code;
    switch (name) {
      case "sin":
      case "cos":
      case "tan": {
        // x87Sin/x87Cos give an operand at or beyond ±2^63 (not ±∞) back; x87Tan gives NaN.
        const t = code.temp(F64);
        code.tee(t).op(OP.f64Abs).f64(X87_RANGE).op(OP.f64Ge).get(t).op(OP.f64Abs).f64(Number.POSITIVE_INFINITY).op(OP.f64Ne)
          .op(0x71, OP.if, F64); // i32.and
        if (name === "tan") code.f64(Number.NaN);
        else code.get(t);
        code.op(OP.else).get(t).call(FN[name]).op(OP.end);
        code.release(F64, t);
        return;
      }
      case "asin":
      case "acos":
      case "atan":
      case "exp":
      case "atan2":
      case "pow":
        code.call(FN[name]);
        return;
      case "log":
      case "log10": {
        // value > 0 ? Math.log(value) : 0
        const t = code.temp(F64);
        code.tee(t).f64(0).op(OP.f64Gt, OP.if, F64).get(t).call(FN[name]).op(OP.else).f64(0).op(OP.end);
        code.release(F64, t);
        return;
      }
      case "sigmoid": {
        // denominator = 1 + Math.exp(-value * constraint); |denominator| > 0.00001 ? 1 / denominator : 0
        const constraint = code.temp(F64);
        const denominator = code.temp(F64);
        code.set(constraint).op(OP.f64Neg).get(constraint).op(OP.f64Mul).call(FN.exp).set(denominator)
          .f64(1).get(denominator).op(OP.f64Add).tee(denominator).op(OP.f64Abs).f64(CLOSE).op(OP.f64Gt, OP.if, F64)
          .f64(1).get(denominator).op(OP.f64Div, OP.else).f64(0).op(OP.end);
        code.release(F64, constraint);
        code.release(F64, denominator);
        return;
      }
      case "abs": code.op(OP.f64Abs); return;
      case "floor": code.op(OP.f64Floor); return;
      case "ceil": code.op(OP.f64Ceil); return;
      case "sqrt": code.op(OP.f64Abs, OP.f64Sqrt); return;
      case "sqr": {
        const t = code.temp(F64);
        code.tee(t).get(t).op(OP.f64Mul);
        code.release(F64, t);
        return;
      }
      case "invsqrt": {
        // v !== 0 ? 1 / sqrt(|v|) : 0 (NaN is not 0).
        const t = code.temp(F64);
        code.tee(t).f64(0).op(OP.f64Ne, OP.if, F64).f64(1).get(t).op(OP.f64Abs, OP.f64Sqrt, OP.f64Div, OP.else).f64(0).op(OP.end);
        code.release(F64, t);
        return;
      }
      case "sign": {
        // Math.sign: 1, −1, or the value itself (±0, NaN).
        const t = code.temp(F64);
        code.tee(t).f64(0).op(OP.f64Gt, OP.if, F64).f64(1).op(OP.else).get(t).f64(0).op(OP.f64Lt, OP.if, F64).f64(-1)
          .op(OP.else).get(t).op(OP.end, OP.end);
        code.release(F64, t);
        return;
      }
      case "min":
      case "max":
        code.op(name === "min" ? OP.f64Min : OP.f64Max);
        return;
    }
    throw new Unsupported(`function ${name}`);
  }

  /** nseel-ram.c memset as eel.ts has it: dest, then count, then value; fills, returns dest. */
  private memset(destination: Ast.Expression, value: Ast.Expression, count: Ast.Expression): void {
    const code = this.code;
    const dest = code.temp(F64);
    const offset = code.temp(F64);
    const length = code.temp(F64);
    const fill = code.temp(F64);
    const at = code.temp(I32);
    const end = code.temp(I32);
    this.expr(destination);
    code.tee(dest).f64(0.0001).op(OP.f64Add, OP.f64Trunc).set(offset);
    this.expr(count);
    code.f64(0.0001).op(OP.f64Add, OP.f64Trunc).set(length);
    this.expr(value);
    code.set(fill);
    // if (offset < 0) { count += offset; offset = 0; }
    code.get(offset).f64(0).op(OP.f64Lt, OP.if, VOID).get(length).get(offset).op(OP.f64Add).set(length).f64(0).set(offset).op(OP.end);
    // if (count > 0 && offset < BUFFER) fill(value, offset, min(BUFFER, offset + count))
    code.get(length).f64(0).op(OP.f64Gt).get(offset).f64(BUFFER).op(OP.f64Lt).op(0x71, OP.if, VOID);
    this.megabufBase();
    code.set(at);
    code.get(at).f64(BUFFER).get(offset).get(length).op(OP.f64Add, OP.f64Min).sat(SAT.i32TruncF64U).i32(3).op(OP.i32Shl, OP.i32Add).set(end);
    code.get(at).get(offset).sat(SAT.i32TruncF64U).i32(3).op(OP.i32Shl, OP.i32Add).set(at);
    code.op(OP.block, VOID, OP.loop, VOID).get(at).get(end).op(OP.i32GeU, OP.brIf, 1)
      .get(at).get(fill).store(0).get(at).i32(8).op(OP.i32Add).set(at).op(OP.br, 0, OP.end, OP.end);
    code.op(OP.end).get(dest);
    for (const local of [dest, offset, length, fill]) code.release(F64, local);
    code.release(I32, at);
    code.release(I32, end);
  }

  /** nseel-ram.c memcpy as eel.ts has it (memmove); returns dest. */
  private memcpy(destination: Ast.Expression, source: Ast.Expression, count: Ast.Expression): void {
    const code = this.code;
    const dest = code.temp(F64);
    const to = code.temp(F64);
    const from = code.temp(F64);
    const length = code.temp(F64);
    const base = code.temp(I32);
    this.expr(destination);
    code.tee(dest).f64(0.0001).op(OP.f64Add, OP.f64Trunc).set(to);
    this.expr(source);
    code.f64(0.0001).op(OP.f64Add, OP.f64Trunc).set(from);
    this.expr(count);
    code.f64(0.0001).op(OP.f64Add, OP.f64Trunc).set(length);
    // if (to < 0) { count += to; from -= to; to = 0; }
    code.get(to).f64(0).op(OP.f64Lt, OP.if, VOID).get(length).get(to).op(OP.f64Add).set(length)
      .get(from).get(to).op(OP.f64Sub).set(from).f64(0).set(to).op(OP.end);
    // if (from < 0) { count += from; to -= from; from = 0; }
    code.get(from).f64(0).op(OP.f64Lt, OP.if, VOID).get(length).get(from).op(OP.f64Add).set(length)
      .get(to).get(from).op(OP.f64Sub).set(to).f64(0).set(from).op(OP.end);
    // count = Math.min(count, BUFFER - to, BUFFER - from)
    code.get(length).f64(BUFFER).get(to).op(OP.f64Sub, OP.f64Min).f64(BUFFER).get(from).op(OP.f64Sub, OP.f64Min).set(length);
    code.get(length).f64(0).op(OP.f64Gt, OP.if, VOID);
    this.megabufBase();
    code.set(base);
    code.get(base).get(to).sat(SAT.i32TruncF64U).i32(3).op(OP.i32Shl, OP.i32Add)
      .get(base).get(from).sat(SAT.i32TruncF64U).i32(3).op(OP.i32Shl, OP.i32Add)
      .get(length).sat(SAT.i32TruncF64U).i32(3).op(OP.i32Shl)
      .sat(SAT.memoryCopy).op(0, 0);
    code.op(OP.end).get(dest);
    for (const local of [dest, to, from, length]) code.release(F64, local);
    code.release(I32, base);
  }

  /** EEL2's freembuf as eel.ts has it: zero from the 65536-slot block above `top`; returns top. */
  private freembuf(top: Ast.Expression): void {
    const code = this.code;
    const value = code.temp(F64);
    const start = code.temp(F64);
    const base = code.temp(I32);
    this.expr(top);
    code.tee(value).f64(0.0001).op(OP.f64Add, OP.f64Trunc).f64(65536).op(OP.f64Div, OP.f64Ceil).f64(65536).op(OP.f64Mul)
      .f64(0).op(OP.f64Max).tee(start).f64(BUFFER).op(OP.f64Lt, OP.if, VOID);
    this.megabufBase();
    code.set(base);
    code.get(base).get(start).sat(SAT.i32TruncF64U).i32(3).op(OP.i32Shl, OP.i32Add).i32(0)
      .i32(MEGABUF_BYTES).get(start).sat(SAT.i32TruncF64U).i32(3).op(OP.i32Shl).op(0x6b) // i32.sub
      .sat(SAT.memoryFill).op(0);
    code.op(OP.end).get(value);
    code.release(F64, value);
    code.release(F64, start);
    code.release(I32, base);
  }
}

const registerIndex = (name: string): number => Number(name.slice(3));

/**
 * Magic, version, the type and import sections and the helpers' bodies: the same in every module, but
 * for the visdata memory (imported as memory 1 by modules whose getosc/getspec read it).
 */
const fixedParts: ({ prefix: number[]; helpers: Map<HelperKind, number[]> } | null)[] = [null, null];

function fixed(vis: boolean): { prefix: number[]; helpers: Map<HelperKind, number[]> } {
  const known = fixedParts[vis ? 1 : 0];
  if (known) return known;
  const prefix: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const types: number[] = [];
  uleb(TYPES.length, types);
  for (const [params, results] of TYPES) {
    types.push(0x60);
    uleb(params.length, types);
    for (const type of params) types.push(type);
    uleb(results.length, types);
    for (const type of results) types.push(type);
  }
  section(1, types, prefix);
  const imports: number[] = [];
  uleb(IMPORTS.length + (vis ? 3 : 2), imports);
  for (const [field, type] of IMPORTS) {
    name("e", imports);
    name(field, imports);
    imports.push(0x00);
    uleb(type, imports);
  }
  name("e", imports);
  name("m", imports);
  imports.push(0x02, 0x00, 0x01); // memory, at least one page
  if (vis) {
    name("e", imports);
    name("vm", imports);
    imports.push(0x02, 0x00, 0x01); // memory 1: the analyser's visdata (VISDATA_OFFSETS)
  }
  name("e", imports);
  name("v", imports);
  imports.push(0x03, I32, 0x00); // immutable i32: the variables' base
  section(2, imports, prefix);
  return (fixedParts[vis ? 1 : 0] = { prefix, helpers: new Map(HELPERS.map((kind) => [kind, helper(kind)])) });
}

/** The helpers some code calls: `%`, `&`, `|`, bxor, shl, shr; getosc and getspec on the visdata memory (`vis`). */
function helpersOf(programs: readonly Ast.Program[], vis: boolean): Set<HelperKind> {
  const used = new Set<HelperKind>();
  const visit = (node: unknown): void => {
    if (node instanceof Ast.Assignment) {
      visit(node.expr);
    } else if (node instanceof Ast.BinaryExpr) {
      if (node.operator === "%") used.add("mod");
      else if (node.operator === "&") used.add("and");
      else if (node.operator === "|") used.add("or");
      visit(node.leftOperand);
      visit(node.rightOperand);
    } else if (node instanceof Ast.UnaryExpr) {
      visit(node.operand);
    } else if (node instanceof Ast.FuncCall) {
      if (node.funcName === "bxor") used.add("xor");
      else if (node.funcName === "shl" || node.funcName === "shr") used.add(node.funcName);
      else if (vis && node.funcName === "getosc") used.add("osc");
      else if (vis && node.funcName === "getspec") used.add("spec");
      node.args.forEach(visit);
    }
  };
  for (const program of programs) program.statements.forEach(visit);
  return used;
}

/**
 * The module for a code instance's sections: imports IMPORTS, a memory and the variables' base (with
 * `vis`, the visdata memory too, when the code calls getosc or getspec), exports s0, s1 … (one per
 * section, in order) and g, the megabuf's base. Throws Unsupported for anything eel.ts compiles that
 * is not followed here (the closures then run).
 */
export function generateModule(programs: readonly Ast.Program[], slots: ReadonlyMap<string, Slot>, vis = false): Uint8Array<ArrayBuffer> {
  const usedKinds = helpersOf(programs, vis);
  const { prefix, helpers } = fixed(usedKinds.has("osc") || usedKinds.has("spec"));
  const used = HELPERS.filter((kind) => usedKinds.has(kind));
  const helperIndex = new Map(used.map((kind, index) => [kind, IMPORTS.length + index]));
  const firstSection = IMPORTS.length + used.length;
  const bodies: number[] = [];
  uleb(used.length + programs.length, bodies);
  for (const kind of used) for (const byte of helpers.get(kind)!) bodies.push(byte);
  for (const program of programs) {
    const code = new Code(0);
    const generator = new Generator(code, slots, helperIndex);
    for (const statement of program.statements) generator.statement(statement);
    for (const byte of code.finish()) bodies.push(byte);
  }

  const out = prefix.slice();
  const functions: number[] = [];
  uleb(used.length + programs.length, functions);
  for (const kind of used) uleb(kind === "osc" || kind === "spec" ? TYPE_VIS : TYPE_HELPER, functions);
  for (let k = 0; k < programs.length; k += 1) uleb(TYPE_SECTION, functions);
  section(3, functions, out);

  const globals: number[] = [];
  uleb(1, globals);
  globals.push(I32, 0x01, OP.i32Const, 0x00, OP.end); // the megabuf's base, 0 until allocated
  section(6, globals, out);

  const exports: number[] = [];
  uleb(programs.length + 1, exports);
  programs.forEach((_, index) => {
    name(`s${index}`, exports);
    exports.push(0x00);
    uleb(firstSection + index, exports);
  });
  name("g", exports);
  exports.push(0x03);
  uleb(MEGABUF_BASE, exports);
  section(7, exports, out);

  section(10, bodies, out);
  return new Uint8Array(out);
}

/** The variables (ID names) and registers a set of programs reads or writes. */
export function namesOf(programs: readonly Ast.Program[]): { variables: Set<string>; registers: boolean } {
  const variables = new Set<string>();
  let registers = false;
  const visit = (node: unknown): void => {
    if (node instanceof Ast.PrimaryExpr) {
      if (node.type === Ast.PrimaryExprType.ID) variables.add(node.value);
      else if (node.type === Ast.PrimaryExprType.REG) registers = true;
    } else if (node instanceof Ast.Assignment) {
      visit(node.lhs);
      visit(node.expr);
    } else if (node instanceof Ast.BinaryExpr) {
      visit(node.leftOperand);
      visit(node.rightOperand);
    } else if (node instanceof Ast.UnaryExpr) {
      visit(node.operand);
    } else if (node instanceof Ast.FuncCall) {
      node.args.forEach(visit);
    }
  };
  for (const program of programs) program.statements.forEach(visit);
  return { variables, registers };
}

// ---------------------------------------------------------------------------------------------
// Runtime

type Bank = Record<string, number>;

/** One memory: a register bank's registers, then its code instances' variables and megabufs. */
class Heap {
  readonly memory = new WebAssembly.Memory({ initial: 1 });
  f64 = new Float64Array(this.memory.buffer);
  private top = REGISTER_BYTES;
  readonly instances = new Set<Instance>();
  /** A register held something other than a number: the closures run everything on this bank. */
  broken = false;
  readonly bank: Bank;

  constructor(bank: Bank) {
    this.bank = bank;
  }

  private reserve(bytes: number, align: number): number {
    const at = Math.ceil(this.top / align) * align;
    const end = at + bytes;
    const size = this.memory.buffer.byteLength;
    if (end > size) {
      this.memory.grow(Math.ceil((end - size) / PAGE));
      this.f64 = new Float64Array(this.memory.buffer);
    }
    this.top = end;
    return at;
  }

  variables(count: number): number {
    return this.reserve(Math.max(1, count) * 8, 8);
  }

  megabuf(): number {
    return this.reserve(MEGABUF_BYTES, 8);
  }
}

const heaps = new WeakMap<object, Heap>();

const REGISTER_NAMES = Array.from({ length: 100 }, (_, index) => `reg${String(index).padStart(2, "0")}`);

/** The memory of a register bank; its registers become accessors into it. Null when they cannot. */
function heapOf(bank: Bank): Heap | null {
  const known = heaps.get(bank);
  if (known) return known.broken ? null : known;
  for (const register of REGISTER_NAMES) {
    const descriptor = Object.getOwnPropertyDescriptor(bank, register);
    if (descriptor && !("value" in descriptor && typeof descriptor.value === "number" && descriptor.writable && descriptor.configurable)) return null;
    if (!descriptor && register in bank) return null;
  }
  if (!Object.isExtensible(bank)) return null;
  let heap: Heap;
  try {
    heap = new Heap(bank);
  } catch {
    // No memory to be had (a page that has used up its address space for wasm): the closures.
    return null;
  }
  const tracked = (globalThis as { __avsEelWasmHeaps?: unknown }).__avsEelWasmHeaps;
  if (Array.isArray(tracked)) tracked.push(new WeakRef(heap));
  REGISTER_NAMES.forEach((register, index) => {
    const value = own(bank, register) ? bank[register]! : 0;
    heap.f64[index] = value;
    Object.defineProperty(bank, register, {
      configurable: true,
      enumerable: true,
      get: () => heap.f64[index],
      set: (next: unknown) => {
        if (typeof next === "number") heap.f64[index] = next;
        else {
          breakHeap(heap);
          bank[register] = next as number;
        }
      }
    });
  });
  heaps.set(bank, heap);
  return heap;
}

/** Registers back to plain properties; every instance on the bank back to the closures. */
function breakHeap(heap: Heap): void {
  heap.broken = true;
  for (const instance of [...heap.instances]) instance.demote();
  REGISTER_NAMES.forEach((register, index) => {
    Object.defineProperty(heap.bank, register, { configurable: true, enumerable: true, writable: true, value: heap.f64[index] });
  });
}

/** Compiled modules by their bytes (presets repeat the same code), newest last. */
const compiledModules = new Map<string, WebAssembly.Module>();
const compiling = new Map<string, Promise<WebAssembly.Module>>();
const MODULE_CACHE = 256;

const keyOf = (bytes: Uint8Array<ArrayBuffer>): string => {
  let key = "";
  for (let k = 0; k < bytes.length; k += 4096) key += String.fromCharCode.apply(null, Array.from(bytes.subarray(k, k + 4096)));
  return key;
};

function remember(key: string, module: WebAssembly.Module): WebAssembly.Module {
  compiledModules.delete(key);
  if (compiledModules.size >= MODULE_CACHE) compiledModules.delete(compiledModules.keys().next().value!);
  compiledModules.set(key, module);
  return module;
}

function cachedModule(key: string): WebAssembly.Module | null {
  const module = compiledModules.get(key);
  return module ? remember(key, module) : null;
}

/** Compiled off the main thread; one compilation for equal bytes. */
function compileModule(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<WebAssembly.Module> {
  let pending = compiling.get(key);
  if (!pending) {
    pending = WebAssembly.compile(bytes).then((module) => remember(key, module));
    pending.then(() => compiling.delete(key), () => compiling.delete(key));
    compiling.set(key, pending);
  }
  return pending;
}

const gmGet = (position: number): number => globalBuffer[position]!;
const gmSet = (position: number, value: number): void => {
  globalBuffer[position] = value;
};

/** Counts of how instances went (wasm, or why not) into globalThis.__avsEelWasmStats when a page sets it. */
function note(outcome: string): void {
  const stats = (globalThis as { __avsEelWasmStats?: Record<string, number> }).__avsEelWasmStats;
  if (stats && typeof stats === "object") stats[outcome] = (stats[outcome] ?? 0) + 1;
}

/** Instances waiting for their bytes, made between frames a few milliseconds at a time. */
const waiting: Instance[] = [];
let draining = false;
const SLICE_MS = 6;

function schedule(instance: Instance): void {
  waiting.push(instance);
  if (!draining) {
    draining = true;
    setTimeout(drain, 0);
  }
}

function drain(): void {
  const until = performance.now() + SLICE_MS;
  let next = 0;
  try {
    // generate() leaves an instance with the closures before anything in it can throw.
    while (next < waiting.length && performance.now() < until) waiting[next++]!.generate();
  } finally {
    waiting.splice(0, next);
    draining = waiting.length > 0;
    if (draining) setTimeout(drain, 0);
  }
}

/** Whether this engine takes a module with two memories (WebAssembly multi-memory). */
const MULTI_MEMORY = (() => {
  try {
    // (module (import "e" "a" (memory 0)) (import "e" "b" (memory 0)))
    return WebAssembly.validate(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2, 15, 2, 1, 0x65, 1, 0x61, 2, 0, 0, 1, 0x65, 1, 0x62, 2, 0, 0]));
  } catch {
    return false;
  }
})();

/**
 * The memory an instance's getosc/getspec read in the module: its analyser's visdata memory
 * (createVisdata(true): the four arrays at VISDATA_OFFSETS), when the engine takes a second memory,
 * the `__avsEelWasmVis` switch is not false and `analyser` is a plain property; null otherwise
 * (then the closures' function is imported).
 */
function visdataMemory(owner: Scope): WebAssembly.Memory | null {
  if (!MULTI_MEMORY || (globalThis as { __avsEelWasmVis?: unknown }).__avsEelWasmVis === false) return null;
  const descriptor = Object.getOwnPropertyDescriptor(owner, "analyser");
  if (!descriptor || !("value" in descriptor) || !descriptor.writable || !descriptor.configurable) return null;
  let visdata: AvsVisdata | undefined;
  try {
    visdata = (descriptor.value as Scope["analyser"])?.getVisdata?.();
  } catch {
    return null;
  }
  const memory = visdata?.memory;
  if (!visdata || !(memory instanceof WebAssembly.Memory)) return null;
  const arrays = [visdata.spectrum[0], visdata.spectrum[1], visdata.waveform[0], visdata.waveform[1]];
  const kinds = [Uint8Array, Uint8Array, Int8Array, Int8Array];
  const exact = arrays.every((array, index) => array instanceof kinds[index]! && array.buffer === memory.buffer
    && array.byteOffset === VISDATA_OFFSETS[index] && array.length === AVS_SAMPLES);
  return exact ? memory : null;
}

/** Synchronous compilation (tests): `globalThis.__avsEelWasmSync = true`. */
const synchronous = (): boolean => (globalThis as { __avsEelWasmSync?: unknown }).__avsEelWasmSync === true;

const UNBUILT = 0;
const PENDING = 1;
const WASM = 2;
const CLOSURES = 3;

interface Layout {
  bank: Bank;
  bankEnumerable: boolean;
  slots: Map<string, Slot>;
  memoryNames: string[];
  externalNames: string[];
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * One code instance and its sections. At the first run its module is generated and compiled
 * (in the background; the closures run meanwhile); at a run after that the state moves into the
 * module's memory and the sections run as wasm. Any run boundary is a safe point: between runs
 * the closures' state is the instance's properties and its megabuf in eel.ts.
 */
class Instance {
  mode = UNBUILT;
  heap: Heap | null = null;
  /** Per section: its wasm function while the instance runs as wasm, else null (the wrappers read it). */
  readonly live: ((() => void) | null)[];
  private module: WebAssembly.Module | null = null;
  private memoryNames: string[] = [];
  private externalNames: string[] = [];
  private base = 0;
  private megabufAt = 0;
  /** The visdata memory the module was made for (its getosc/getspec read it), or null. */
  private vis: WebAssembly.Memory | null = null;
  /** The owner's `analyser` as it was at the switch, while it is an accessor (see build). */
  private analyser: { value: unknown; enumerable: boolean } | null = null;
  readonly owner: Scope;
  private readonly programs: Ast.Program[];
  readonly sections: readonly string[];

  constructor(owner: Scope, sections: readonly string[], programs: Ast.Program[]) {
    this.owner = owner;
    this.sections = sections;
    this.programs = programs;
    this.live = programs.map(() => null);
  }

  /** Index into heap.f64 of a variable kept in memory, or −1. */
  slotOf(variable: string): number {
    const index = this.mode === WASM ? this.memoryNames.indexOf(variable) : -1;
    return index < 0 ? -1 : (this.base >> 3) + index;
  }

  /**
   * Where each variable can live, as the instance is now: a plain number property goes to memory,
   * an accessor (mscopes' audio variables, bindAudioVariables) is reached through it; anything else
   * (a member such as init or analyser, a value that is no number) keeps the closures: null then.
   */
  private layout(): Layout | null {
    const owner = this.owner;
    const bankDescriptor = Object.getOwnPropertyDescriptor(owner, "registerBank");
    const bank = bankDescriptor && "value" in bankDescriptor && bankDescriptor.writable && bankDescriptor.configurable ? bankDescriptor.value : null;
    if (!bank || typeof bank !== "object") {
      note("no register bank");
      return null;
    }
    const slots = new Map<string, Slot>();
    const memoryNames: string[] = [];
    const externalNames: string[] = [];
    for (const variable of namesOf(this.programs).variables) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, variable);
      if (descriptor && "value" in descriptor && typeof descriptor.value === "number" && descriptor.writable && descriptor.configurable) {
        slots.set(variable, { memory: memoryNames.length });
        memoryNames.push(variable);
      } else if (descriptor && descriptor.get && descriptor.set) {
        slots.set(variable, { external: externalNames.length });
        externalNames.push(variable);
      } else {
        note(`variable ${variable} is not a number`);
        return null;
      }
    }
    return { bank: bank as Bank, bankEnumerable: bankDescriptor!.enumerable === true, slots, memoryNames, externalNames };
  }

  /**
   * The first run. In tests (synchronous) the module is made and the instance switches now; on a
   * page the bytes are made between frames (generate) and compiled in the background, and the
   * closures run until the module is there: nothing is added to the frame that loads a preset.
   */
  start(): void {
    this.mode = PENDING;
    if (synchronous()) {
      this.generate();
      if (this.module) this.build();
    } else schedule(this);
  }

  /** The module's bytes for the instance as it is now, then the module (cached, compiled now, or in the background). */
  generate(): void {
    if (this.mode !== PENDING) return;
    this.mode = CLOSURES;
    const layout = this.layout();
    if (!layout) return;
    let bytes: Uint8Array<ArrayBuffer>;
    const vis = visdataMemory(this.owner);
    try {
      bytes = generateModule(this.programs, layout.slots, vis !== null);
    } catch (error) {
      note(error instanceof Unsupported ? `unsupported: ${error.message}` : `codegen: ${String(error)}`);
      return;
    }
    this.memoryNames = layout.memoryNames;
    this.externalNames = layout.externalNames;
    this.vis = vis;
    const key = keyOf(bytes);
    const cached = cachedModule(key);
    if (cached || synchronous()) {
      try {
        this.module = cached ?? remember(key, new WebAssembly.Module(bytes));
      } catch (error) {
        note(`compile: ${String(error)}`);
        return;
      }
      this.mode = PENDING;
      return;
    }
    this.mode = PENDING;
    compileModule(key, bytes).then(
      (module) => {
        if (this.mode === PENDING) this.module = module;
      },
      (error: unknown) => {
        if (this.mode === PENDING) this.mode = CLOSURES;
        note(`compile: ${String(error)}`);
      }
    );
  }

  /** Whether the module has come (a pending instance switches at this run). */
  ready(): boolean {
    return this.module !== null;
  }

  /** Instantiates the module and moves the instance's state into its memory; runs between two runs. */
  build(): void {
    const module = this.module;
    this.module = null;
    this.mode = CLOSURES;
    if (!module) return;
    const owner = this.owner;
    // The layout the module was made for must still hold (an effect may have written something else since).
    const layout = this.layout();
    if (!layout || !sameList(layout.memoryNames, this.memoryNames) || !sameList(layout.externalNames, this.externalNames)) {
      note("layout changed");
      return;
    }
    if (this.vis && visdataMemory(owner) !== this.vis) {
      note("visdata changed");
      return;
    }
    const { bank, memoryNames } = layout;
    const heap = heapOf(bank);
    if (!heap) {
      note("register bank");
      return;
    }
    let base: number;
    let instance: WebAssembly.Instance;
    try {
      base = heap.variables(memoryNames.length);
      instance = new WebAssembly.Instance(module, { e: this.imports(heap, layout.externalNames, base) });
    } catch (error) {
      note(`instantiate: ${String(error)}`);
      return;
    }
    const at = base >> 3;
    memoryNames.forEach((variable, index) => {
      heap.f64[at + index] = owner[variable] as number;
    });
    // The megabuf the closures made so far goes into the memory.
    const megabuf = localBuffers.get(owner);
    if (megabuf) {
      let start: number;
      try {
        start = heap.megabuf();
      } catch (error) {
        note(`megabuf: ${String(error)}`);
        return;
      }
      heap.f64.set(megabuf, start >> 3);
      (instance.exports.g as WebAssembly.Global).value = start;
      this.megabufAt = start;
      localBuffers.delete(owner);
    }
    memoryNames.forEach((variable, index) => {
      Object.defineProperty(owner, variable, {
        configurable: true,
        enumerable: true,
        get: () => heap.f64[at + index],
        set: (next: unknown) => {
          if (typeof next === "number") heap.f64[at + index] = next;
          else {
            this.demote();
            owner[variable] = next;
          }
        }
      });
    });
    // An analyser other than the one whose visdata the module reads: the closures, with it.
    if (this.vis) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, "analyser")!;
      const analyser = descriptor.value;
      this.analyser = { value: analyser, enumerable: descriptor.enumerable === true };
      Object.defineProperty(owner, "analyser", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => analyser,
        set: (next: unknown) => {
          if (next === analyser) return;
          this.demote();
          owner.analyser = next as Scope["analyser"];
        }
      });
    }
    // setup() with another main (another bank): the closures, on the new bank.
    Object.defineProperty(owner, "registerBank", {
      configurable: true,
      enumerable: layout.bankEnumerable,
      get: () => bank,
      set: (next: unknown) => {
        if (next === bank) return;
        this.demote();
        owner.registerBank = next as Bank;
      }
    });
    this.heap = heap;
    this.base = base;
    this.programs.forEach((_, index) => {
      this.live[index] = instance.exports[`s${index}`] as () => void;
    });
    heap.instances.add(this);
    this.mode = WASM;
    note("wasm");
  }

  private imports(heap: Heap, externalNames: string[], base: number): WebAssembly.ModuleImports {
    const owner = this.owner;
    const visdataBand = (waveform: boolean) => (centre: number, width: number, channel: number): number => {
      const analyser = owner.analyser;
      const visdata = analyser?.getVisdata?.();
      if (visdata) return avsGetvis(visdata, waveform, centre, width, channel);
      const values = waveform ? analyser?.getWaveform() : analyser?.getSpectrum();
      return values ? band(values, centre, width, channel) : 0;
    };
    return {
      // The functions eel.ts's MATH calls, themselves: an engine may call them from wasm directly.
      sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
      atan2: Math.atan2, pow: Math.pow, exp: Math.exp, log: Math.log, log10: Math.log10,
      rand: eelRand,
      // Whole milliseconds over 1000, as eel.ts's gettime.
      gettime: (start: number) => eelGettime(start, (Date.now() - (owner.bootTime ?? 0)) / 1000, owner.playback?.()),
      getosc: visdataBand(true),
      getspec: visdataBand(false),
      gmGet,
      gmSet,
      extGet: (index: number) => (owner[externalNames[index]!] as number | undefined) ?? 0,
      extSet: (index: number, value: number) => {
        owner[externalNames[index]!] = value;
      },
      allocMb: () => (this.megabufAt = heap.megabuf()),
      m: heap.memory,
      ...(this.vis ? { vm: this.vis } : {}),
      v: base
    };
  }

  /** Back to the closures: variables as plain properties again, the megabuf where eel.ts keeps it. */
  demote(): void {
    if (this.mode !== WASM || !this.heap) return;
    this.mode = CLOSURES;
    this.live.fill(null);
    const heap = this.heap;
    const bank = Object.getOwnPropertyDescriptor(this.owner, "registerBank");
    if (bank && bank.get) {
      Object.defineProperty(this.owner, "registerBank", { configurable: true, enumerable: bank.enumerable, writable: true, value: heap.bank });
    }
    if (this.analyser) {
      Object.defineProperty(this.owner, "analyser", { configurable: true, enumerable: this.analyser.enumerable, writable: true, value: this.analyser.value });
      this.analyser = null;
    }
    const at = this.base >> 3;
    this.memoryNames.forEach((variable, index) => {
      Object.defineProperty(this.owner, variable, { configurable: true, enumerable: true, writable: true, value: heap.f64[at + index] });
    });
    if (this.megabufAt) localBuffers.set(this.owner, heap.f64.slice(this.megabufAt >> 3, (this.megabufAt >> 3) + BUFFER));
    heap.instances.delete(this);
  }
}

const instances = new WeakMap<object, Instance>();

/**
 * An effect's view of the variables it sets and reads around each run of a per-point section (i, v,
 * skip, x, y …): while the instance runs as wasm, slots of its memory and the section's function
 * itself — no property lookups (code instances are dictionary objects in V8) and no accessor calls;
 * otherwise the properties and the section as before. bind() once a frame, after the frame's first
 * section ran (that builds the instance); between bind() and the end of the points nothing may give
 * the instance back to the closures, which holds as the effects write numbers only.
 */
export class EelPort {
  private readonly section: string;
  private readonly names: readonly string[];
  private readonly slots: Int32Array;
  private scope: Scope | null = null;
  private heap: Heap | null = null;
  private wasm: (() => void) | null = null;

  constructor(section: string, names: readonly string[]) {
    this.section = section;
    this.names = names;
    this.slots = new Int32Array(names.length).fill(-1);
  }

  bind(scope: Scope): this {
    this.scope = scope;
    const state = instances.get(scope);
    const index = state && state.mode === WASM && state.owner === scope ? state.sections.indexOf(this.section) : -1;
    const wasm = index >= 0 ? state!.live[index] ?? null : null;
    this.wasm = wasm;
    this.heap = wasm ? state!.heap : null;
    this.names.forEach((variable, k) => {
      this.slots[k] = wasm ? state!.slotOf(variable) : -1;
    });
    return this;
  }

  /** The variable `names[k]` as the code instance has it (a number when it is one of the code's). */
  get(k: number): unknown {
    const slot = this.slots[k]!;
    return slot >= 0 ? this.heap!.f64[slot] : this.scope![this.names[k]!];
  }

  /** Sets `names[k]` to a number. */
  set(k: number, value: number): void {
    const slot = this.slots[k]!;
    if (slot >= 0) this.heap!.f64[slot] = value;
    else this.scope![this.names[k]!] = value;
  }

  run(): void {
    const wasm = this.wasm;
    if (wasm) wasm();
    else (this.scope![this.section] as (this: Scope) => void).call(this.scope!);
  }
}

/** Whether this page may build wasm at all (and the switch the test pages use: __avsEelWasm = false). */
function enabled(): boolean {
  return typeof WebAssembly === "object" && (globalThis as { __avsEelWasm?: unknown }).__avsEelWasm !== false;
}

/**
 * Lets a code instance's compiled sections run as WebAssembly: each `scope[name]` (a function from
 * eel.ts compileProgram) is wrapped; the first run of any of them builds the module for all of them.
 * Runs on another object (a clone) and everything wasm cannot mirror go to the closures.
 */
export function attachWasm(scope: Scope, programs: Record<string, Ast.Program | undefined>, sections: readonly string[]): void {
  if (!enabled()) return;
  const names = sections.filter((section) => programs[section] && typeof scope[section] === "function");
  if (names.length === 0) return;
  const state = new Instance(scope, names, names.map((section) => programs[section]!));
  instances.set(scope, state);
  const live = state.live;
  names.forEach((section, index) => {
    const closure = scope[section] as (this: Scope) => void;
    scope[section] = function run(this: Scope): void {
      if (this === scope) {
        const wasm = live[index];
        if (wasm) {
          wasm();
          return;
        }
        if (state.mode === UNBUILT) state.start();
        else if (state.mode === PENDING && state.ready()) state.build();
        const built = live[index];
        if (built) {
          built();
          return;
        }
      }
      closure.call(this);
    };
  });
}

/** For tests: the mode of a scope's sections ("wasm", "closures", "unbuilt"), from any section's run. */
export const WASM_MODES = { UNBUILT, PENDING, WASM, CLOSURES } as const;
