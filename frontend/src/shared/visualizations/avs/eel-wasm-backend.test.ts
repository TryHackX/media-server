import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

// eel.ts and the backend import their neighbours without extensions, and webvs's Ast.ts has an
// enum and parameter properties, which Node's own type stripping refuses: resolved and
// transformed here (tests only), then loaded.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.endsWith(".test.ts")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", source: stripTypeScriptTypes(source, { mode: "transform" }), shortCircuit: true };
    }
    return next(url, context);
  }
});

// Modules compiled at once here (the page compiles them in the background; see the test for that).
(globalThis as { __avsEelWasmSync?: boolean }).__avsEelWasmSync = true;

const eel = await import("./eel.ts");
const backend = await import("./eel-wasm-backend.ts");
const random = await import("./webvs/avsRandom.ts");
const visdata = await import("./winamp-visdata.ts");

type Scope = Record<string, unknown> & { registerBank?: Record<string, number> };
type Dialect = "ns-eel" | "eel2";

/** A seeded generator (mulberry32), so a failure names its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Values that find the edges: ±0, halves (fistp), 2^31 and 2^63 limits, huge, tiny, NaN, infinity. */
const EDGE_VALUES = [
  0, -0, 1, -1, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, 0.00001, -0.00001, 0.000009, 3, 7, 10, 65536,
  2147483647, 2147483647.5, 2147483648, -2147483648, -2147483648.5, -2147483649, 4294967296, 2 ** 52 + 0.5, 2 ** 53, 2 ** 53 + 2,
  2 ** 62, 1.5 * 2 ** 62, 2 ** 63 - 1024, -(2 ** 63 - 1024), 2 ** 63, -(2 ** 63), 2 ** 64, 1e300, -1e300, 5e-324, Math.PI, -Math.E, 1048575.99999, 1048576, Number.NaN,
  Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY
];

const VARIABLES = ["a", "b", "c", "d", "x", "y", "i", "v", "n", "k", "q1", "q2"];
const REGISTERS = ["reg00", "reg05", "reg99"];
const LITERALS = ["0", "1", "2", "3", "0.5", "1.5", "2.5", ".5", "10", "100", "0.00001", "65536", "2147483648", "4294967296",
  "9007199254740993", "123456789012345678901", "1048575", "1048576", "3.14159", "0.1", "7", "255", "31", "32", "33"];

/** Random EEL source (both dialects' syntax; EEL2 adds ~ << >> === ?: and x[i]). */
function program(rand: () => number, dialect: Dialect, statements: number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const variable = (): string => (rand() < 0.15 ? pick(REGISTERS) : pick(VARIABLES));
  const unary = ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "log10", "abs", "floor", "ceil", "sign", "sqrt",
    "invsqrt", "sqr", "bnot", "rand", "megabuf", "gmegabuf", "gettime", "getkbmouse"];
  const binary = ["atan2", "pow", "min", "max", "sigmoid", "above", "below", "equal", "band", "bor", "exec2", "setmousepos"];
  const operators = ["+", "-", "*", "/", "%", "&", "|", "^", "==", "!=", "<", ">", "<=", ">=", "&&", "||"];
  const eel2Operators = ["~", "<<", ">>", "===", "!=="];
  const expression = (depth: number): string => {
    const roll = rand();
    if (depth <= 0 || roll < 0.18) return rand() < 0.5 ? variable() : rand() < 0.2 ? `-${pick(LITERALS)}` : pick(LITERALS);
    if (roll < 0.38) {
      const operator = dialect === "eel2" && rand() < 0.25 ? pick(eel2Operators) : pick(operators);
      return `(${expression(depth - 1)} ${operator} ${expression(depth - 1)})`;
    }
    if (roll < 0.52) return `${pick(unary)}(${expression(depth - 1)})`;
    if (roll < 0.62) return `${pick(binary)}(${expression(depth - 1)}, ${expression(depth - 1)})`;
    if (roll < 0.68) return `if(${expression(depth - 1)}, ${expression(depth - 1)}, ${expression(depth - 1)})`;
    if (roll < 0.72) return `exec3(${expression(depth - 1)}, ${expression(depth - 1)}, ${expression(depth - 1)})`;
    if (roll < 0.75) return `-${expression(depth - 1)}`;
    if (roll < 0.78) return `!${expression(depth - 1)}`;
    if (roll < 0.81) return `${pick(["getosc", "getspec"])}(${expression(depth - 1)}, ${expression(depth - 1)}, ${pick(["0", "1", "2", "3", "0.4", "1.6"])})`;
    if (roll < 0.84) return `loop(${pick(["0", "1", "3", "-2", "2.7", "k"])}, ${assignment(depth - 1)})`;
    if (roll < 0.87) return `assign(${rand() < 0.5 ? variable() : `if(${expression(0)}, ${variable()}, ${variable()})`}, ${expression(depth - 1)})`;
    if (roll < 0.9) return `${pick(["megabuf", "gmegabuf"])}(${expression(depth - 1)})`;
    if (roll < 0.92) return `rand(${variable()})`;
    if (roll < 0.94 && dialect === "eel2") return `(${expression(depth - 1)} ? ${expression(depth - 1)} : ${expression(depth - 1)})`;
    // memset takes its count before its value, memcpy its arguments in order: side effects in them tell.
    if (roll < 0.95) return `memset(${expression(0)}, ${expression(depth - 1)}, ${pick(["3", "0", "-2", "100", "2000000"])})`;
    if (roll < 0.96) return `memset(${pick(["0", "k", "(k += 1)"])}, ${pick(["(k += 2)", "rand(50)", "k"])}, ${pick(["(k += 1)", "rand(9)", "k"])})`;
    if (roll < 0.97) return `memcpy(${expression(0)}, ${expression(0)}, ${pick(["4", "0", "-3", "70000"])})`;
    if (roll < 0.98) return `memcpy(${pick(["(k += 3)", "rand(40)"])}, ${pick(["(k += 1)", "rand(40)", "k"])}, ${pick(["(k += 2)", "rand(30)", "k"])})`;
    return `freembuf(${expression(0)})`;
  };
  const assignment = (depth: number): string => {
    const roll = rand();
    if (roll < 0.55) return `${variable()} ${pick(["=", "=", "+=", "-=", "*=", "/=", "%="])} ${expression(depth)}`;
    if (roll < 0.75) return `${pick(["megabuf", "gmegabuf"])}(${expression(1)}) = ${expression(depth)}`;
    if (roll < 0.8 && dialect === "eel2") return `${rand() < 0.5 ? "x" : "gmem"}[${expression(1)}] ${pick(["=", "+="])} ${expression(depth)}`;
    if (roll < 0.85) return `k = 0; while(exec2(assign(k, k + 1), below(k, ${pick(["3", "10", "0"])})))`;
    return expression(depth);
  };
  const out: string[] = [];
  for (let k = 0; k < statements; k += 1) out.push(assignment(1 + Math.floor(rand() * 4)));
  return out.join(";\n");
}

/**
 * An analyser as the engine's: AVS's bytes when `bytes` (in a WebAssembly memory of their own when
 * `shared`, as the engine's analyser keeps them: then wasm reads getosc/getspec there), else wave and
 * spectrum arrays.
 */
function analyser(rand: () => number, bytes: boolean, shared = false): Scope["analyser"] {
  const wave = Float32Array.from({ length: 576 }, () => rand() * 2 - 1);
  const spectrum = Float32Array.from({ length: 576 }, () => rand());
  const data = visdata.createVisdata(shared);
  if (shared) assert.ok(data.memory instanceof WebAssembly.Memory);
  for (const channel of [0, 1]) {
    data.waveform[channel]!.forEach((_: number, index: number, array: Uint8Array) => (array[index] = Math.floor(rand() * 256)));
    data.spectrum[channel]!.forEach((_: number, index: number, array: Uint8Array) => (array[index] = Math.floor(rand() * 256)));
  }
  return { getWaveform: () => wave, getSpectrum: () => spectrum, ...(bytes ? { getVisdata: () => data } : {}) };
}

interface Case {
  sections: Record<string, string>;
  dialect: Dialect;
  /** Variables and registers before the first run. */
  values: Record<string, number>;
  /** Calls, in order: a section name, with values the effect sets before it. */
  calls: { section: string; set?: Record<string, number> }[];
  analyser: Scope["analyser"];
  gmegabuf: Float64Array;
}

interface Outcome {
  error: string | null;
  after: Record<string, number>[];
  registers: Record<string, number>;
  megabuf: Float64Array | undefined;
  gmegabuf: Float64Array;
  wasm: boolean;
}

const REGISTER_NAMES = Array.from({ length: 100 }, (_, index) => `reg${String(index).padStart(2, "0")}`);

/** A case set up on one backend: the closures alone, or attachWasm on top of them. */
function prepare(testCase: Case, useWasm: boolean) {
  const programs: Record<string, ReturnType<typeof eel.parse>> = {};
  for (const [section, source] of Object.entries(testCase.sections)) programs[section] = eel.parse(source, { dialect: testCase.dialect });
  const names = new Set<string>();
  for (const program of Object.values(programs)) for (const name of backend.namesOf([program]).variables) names.add(name);
  const bank: Record<string, number> = {};
  const scope: Scope = { registerBank: bank, analyser: testCase.analyser, bootTime: 1000, playback: () => ({ position: 61.2345, duration: 200.9 }) };
  for (const name of names) scope[name] = 0;
  for (const [name, value] of Object.entries(testCase.values)) {
    if (/^reg\d\d$/.test(name)) bank[name] = value;
    else if (names.has(name)) scope[name] = value;
  }
  for (const [section, program] of Object.entries(programs)) scope[section] = eel.compileProgram(program);
  if (useWasm) backend.attachWasm(scope, programs, Object.keys(programs));
  eel.globalBuffer.set(testCase.gmegabuf);
  random.restartRandom();
  const after: Record<string, number>[] = [];
  let error: string | null = null;
  return {
    /** One call: the effect's values, the section, every variable afterwards. */
    step(call: Case["calls"][number]): void {
      if (error !== null) return;
      const realNow = Date.now;
      Date.now = () => 1767225600000;
      try {
        for (const [name, value] of Object.entries(call.set ?? {})) scope[name] = value;
        (scope[call.section] as () => void).call(scope);
        after.push(Object.fromEntries([...names].map((name) => [name, scope[name] as number])));
      } catch (caught) {
        error = String(caught);
      } finally {
        Date.now = realNow;
      }
    },
    finish(): Outcome {
      const registers = Object.fromEntries(REGISTER_NAMES.filter((name) => name in bank).map((name) => [name, bank[name]!]));
      // Writing something other than a number gives the instance back to the closures, with its megabuf.
      const wasm = names.size > 0 && Object.getOwnPropertyDescriptor(scope, [...names][0]!)?.get !== undefined;
      if (wasm) scope[[...names][0]!] = "back to the closures";
      return { error, after, registers, megabuf: eel.localBuffers.get(scope), gmegabuf: eel.globalBuffer.slice(), wasm };
    }
  };
}

/** Runs a case on one backend (compiled at once: the first run is already wasm). */
function run(testCase: Case, useWasm: boolean): Outcome {
  const prepared = prepare(testCase, useWasm);
  for (const call of testCase.calls) prepared.step(call);
  return prepared.finish();
}

/** Same numbers, bit for bit: Object.is (NaN is NaN, −0 is not 0). */
function same(a: number | undefined, b: number | undefined): boolean {
  return Object.is(a, b);
}

function compare(testCase: Case, label: string, wasmRun?: Outcome): boolean {
  const closures = run(testCase, false);
  const wasm = wasmRun ?? run(testCase, true);
  const where = `${label}\n${Object.entries(testCase.sections).map(([name, source]) => `[${name}] ${source}`).join("\n")}`;
  assert.equal(wasm.error, closures.error, `error differs: ${where}`);
  closures.after.forEach((values, call) => {
    for (const [name, value] of Object.entries(values)) {
      assert.ok(same(wasm.after[call]![name], value), `${name} after call ${call}: closures ${value}, wasm ${wasm.after[call]![name]}\n${where}`);
    }
  });
  for (const name of new Set([...Object.keys(closures.registers), ...Object.keys(wasm.registers)])) {
    // A register the closures never created reads 0 in both (the bank lists all 100 once wasm runs).
    assert.ok(same(wasm.registers[name] ?? 0, closures.registers[name] ?? 0), `${name}: closures ${closures.registers[name]}, wasm ${wasm.registers[name]}\n${where}`);
  }
  const megabufA = closures.megabuf ?? ZERO;
  const megabufB = wasm.megabuf ?? ZERO;
  const megabufAt = firstDifference(megabufA, megabufB);
  if (megabufAt >= 0) assert.fail(`megabuf[${megabufAt}]: closures ${megabufA[megabufAt]}, wasm ${megabufB[megabufAt]}\n${where}`);
  const globalAt = firstDifference(closures.gmegabuf, wasm.gmegabuf);
  if (globalAt >= 0) assert.fail(`gmegabuf[${globalAt}]: closures ${closures.gmegabuf[globalAt]}, wasm ${wasm.gmegabuf[globalAt]}\n${where}`);
  return wasm.wasm;
}

const ZERO = new Float64Array(eel.BUFFER);

/** The first slot whose numbers differ (Object.is), or −1; equal bytes are the fast case. */
function firstDifference(a: Float64Array, b: Float64Array): number {
  if (Buffer.compare(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) === 0) return -1;
  for (let k = 0; k < a.length; k += 1) if (!same(a[k], b[k])) return k;
  return -1;
}

function randomCase(seed: number, dialect: Dialect): Case {
  const rand = generator(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const value = (): number => (rand() < 0.6 ? pick(EDGE_VALUES) : (rand() - 0.5) * 10 ** Math.floor(rand() * 12 - 4));
  const values: Record<string, number> = {};
  for (const name of [...VARIABLES, ...REGISTERS]) if (rand() < 0.7) values[name] = value();
  const gmegabuf = new Float64Array(eel.BUFFER);
  for (let k = 0; k < 300; k += 1) gmegabuf[Math.floor(rand() * 40)] = value();
  const sections = { init: program(rand, dialect, 2), perFrame: program(rand, dialect, 3), perPoint: program(rand, dialect, 4) };
  const calls: Case["calls"] = [{ section: "init" }, { section: "perFrame" }];
  for (let point = 0; point < 4; point += 1) calls.push({ section: "perPoint", set: { i: point / 3, v: value(), x: value() } });
  calls.push({ section: "perFrame", set: { b: 1 } });
  return { sections, dialect, values, calls, analyser: analyser(rand, rand() < 0.7, seed % 2 === 0), gmegabuf };
}

test("generated programs: every variable, register, megabuf and gmegabuf slot as the closures leave them", () => {
  (globalThis as { __avsTestRandom?: boolean }).__avsTestRandom = true;
  let built = 0;
  const count = Number(process.env.EEL_WASM_CASES ?? 300);
  for (let seed = 1; seed <= count; seed += 1) {
    for (const dialect of ["ns-eel", "eel2"] as const) {
      if (compare(randomCase(seed, dialect), `seed ${seed} ${dialect}`)) built += 1;
    }
  }
  // Nearly all of them run as wasm (a few have no variables at all).
  assert.ok(built > count * 1.8, `only ${built} of ${count * 2} ran as wasm`);
});

test("edge values through every operator and function", () => {
  (globalThis as { __avsTestRandom?: boolean }).__avsTestRandom = true;
  const unary = ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "log10", "abs", "floor", "ceil", "sign", "sqrt",
    "invsqrt", "sqr", "bnot", "megabuf", "gmegabuf", "rand", "getkbmouse", "gettime"];
  const binary = ["atan2", "pow", "min", "max", "sigmoid", "above", "below", "equal", "band", "bor"];
  const lines: string[] = [];
  for (const fn of unary) lines.push(`r_${fn} = ${fn}(a)`);
  for (const fn of binary) lines.push(`r_${fn} = ${fn}(a, b)`);
  for (const [k, operator] of ["+", "-", "*", "/", "%", "&", "|", "~", "<<", ">>", "==", "===", "!=", "<", ">", "<=", ">=", "&&", "||"].entries()) {
    lines.push(`o${k} = a ${operator} b`);
  }
  lines.push("m1 = megabuf(a) = b", "m2 = gmegabuf(b) = a", "w = getosc(a, b, 0) + getspec(b, a, 1) + getspec(a, 0.1, 2)");
  const source = lines.join(";\n");
  for (const a of EDGE_VALUES) {
    for (const b of EDGE_VALUES) {
      const rand = generator(1);
      compare({
        sections: { perFrame: source }, dialect: "eel2", values: { a, b }, calls: [{ section: "perFrame" }],
        analyser: analyser(rand, true), gmegabuf: ZERO
      }, `a=${a} b=${b}`);
    }
  }
});

/** Bands, widths and channels for getosc/getspec: the edges of avsGetvis's integer steps. */
const VIS_POSITIONS = [...EDGE_VALUES, 1 / 576, 0.5 / 576, 1.5 / 576, 2 / 576, -1 / 576, -2 / 576, 575 / 576, 575.5 / 576, 0.999, 1.001,
  1 / 3, 0.25, 0.75, -0.25, 1e-9, 576, -576, 3.7e9,
  // (int) at its edges once multiplied by 576
  2147483647.5 / 576, 2147483648 / 576, 2147483646.5 / 576, -2147483648.5 / 576, -2147483649 / 576, -2147483647.5 / 576];
const VIS_CHANNELS = [0, -0, 1, 2, 3, -1, 0.4999, 0.5, -0.5, -0.5000001, 1.4999, 1.5, 2.4999, 2.5, 1e300, -1e300, 2147483647.4, -2147483648.4,
  2147483648, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

test("getosc and getspec read the analyser's visdata memory in wasm: avsGetvis's numbers at every edge", () => {
  let reads = 0;
  const base = analyser(generator(5), true, true)!;
  const counting = { ...base, getVisdata: () => (reads += 1, base.getVisdata!()) };
  const source = "w = getosc(a, b, c); s = getspec(a, b, c); w2 = getosc(b, a); s2 = getspec(b, a); t = getosc(a, a, c) * 1000 + getspec(b, b, c)";
  for (const c of VIS_CHANNELS) {
    const calls: Case["calls"] = [];
    for (const a of VIS_POSITIONS) for (const b of VIS_POSITIONS) calls.push({ section: "perFrame", set: { a, b, c } });
    const testCase: Case = { sections: { perFrame: source }, dialect: "ns-eel", values: {}, calls, analyser: counting, gmegabuf: ZERO };
    reads = 0;
    const wasm = run(testCase, true);
    assert.ok(wasm.wasm, "runs as wasm");
    // The closures ask for the visdata at every call; the module read it in place (one look at the switch).
    assert.ok(reads <= 2, `channel ${c}: visdata asked for ${reads} times by the wasm run`);
    compare(testCase, `channel ${c}`, wasm);
  }
});

test("getosc and getspec in wasm follow the visdata as it changes, and a new analyser goes back to the closures", () => {
  const rand = generator(11);
  const first = analyser(rand, true, true)!;
  const second = analyser(rand, true, true)!;
  const program = eel.parse("w = getosc(a, b, c) + getspec(b, a, c) * 1000; n = n + 1");
  const make = (wasm: boolean): Scope => {
    const scope: Scope = { registerBank: {}, analyser: first, a: 0, b: 0, c: 0, w: 0, n: 0 };
    scope.perFrame = eel.compileProgram(program);
    if (wasm) backend.attachWasm(scope, { perFrame: program }, ["perFrame"]);
    return scope;
  };
  const closures = make(false);
  const wasm = make(true);
  const refill = (target: Scope["analyser"]) => {
    const data = target!.getVisdata!();
    for (const kind of [data.waveform, data.spectrum]) for (const channel of kind) for (let k = 0; k < 576; k += 1) channel[k] = Math.floor(rand() * 256);
  };
  for (let frame = 0; frame < 400; frame += 1) {
    // a new frame's bytes (analyser.update), then the code with this frame's positions
    refill(first);
    refill(second);
    for (const scope of [closures, wasm]) {
      scope.a = VIS_POSITIONS[(frame * 7) % VIS_POSITIONS.length]!;
      scope.b = VIS_POSITIONS[(frame * 13 + 5) % VIS_POSITIONS.length]!;
      scope.c = VIS_CHANNELS[frame % VIS_CHANNELS.length]!;
      if (frame === 250) scope.analyser = second; // setup() with another main's analyser
      (scope.perFrame as () => void).call(scope);
    }
    assert.ok(same(wasm.w as number, closures.w as number), `frame ${frame}: closures ${closures.w}, wasm ${wasm.w}`);
    const isWasm = Object.getOwnPropertyDescriptor(wasm, "w")?.get !== undefined;
    assert.equal(isWasm, frame < 250, `frame ${frame}: ${isWasm ? "wasm" : "closures"}`);
  }
  assert.equal(wasm.analyser, second);
  assert.equal(wasm.n, 400);
});

test("loops at their limits: loop counts, a while that never ends, memset/memcpy/freembuf at the edges", () => {
  (globalThis as { __avsTestRandom?: boolean }).__avsTestRandom = true;
  const sources = [
    "n = 0; loop(2000000, n += 1); m = loop(0.9, 5); q = loop(-3, 5)",
    "k = 0; while(k += 1)",
    "k = 0; w = while(below(k += 1, 5000))",
    "memset(-5, 7.5, 20); memset(1048570, 3, 100); memset(10, 2, 1e300); r = memset(0.99995, -1, 3)",
    "memset(0, 1, 50); i = 0; loop(50, megabuf(i) = i; i += 1); memcpy(10, 0, 30); memcpy(-4, 20, 10); memcpy(5, -2, 10); memcpy(1048570, 0, 100)",
    "memset(0, 9, 1048576); f = freembuf(70000.5); g = freembuf(-1); h = freembuf(2e6); s = megabuf(65535) + megabuf(65536) + megabuf(131072)",
    "megabuf(-0.000001) = 5; megabuf(-0.00002) = 6; megabuf(1048575.99999) = 7; t = megabuf(1048575) + megabuf(-0.000004)",
    // Argument order where side effects show it: memset's count before its value, memcpy's in order.
    "k = 5; memset(0, k += 1, k); a = megabuf(5) + megabuf(6); memset(20, rand(100), rand(5) + 1); b = megabuf(20) + megabuf(25)",
    "k = 1; i = 0; loop(30, megabuf(i) = i; i += 1); memcpy(k += 2, k += 3, k); c = megabuf(3) + megabuf(8) + megabuf(12)"
  ];
  for (const source of sources) {
    compare({
      sections: { perFrame: source }, dialect: "eel2", values: {}, calls: [{ section: "perFrame" }, { section: "perFrame" }],
      analyser: analyser(generator(2), false), gmegabuf: ZERO
    }, source);
  }
});

test("AVS idioms: assign through if, megabuf targets, ns-eel's rand(x) on its variable, $pi and long names", () => {
  (globalThis as { __avsTestRandom?: boolean }).__avsTestRandom = true;
  const sources: [Dialect, string][] = [
    ["ns-eel", "assign(if(above(a, 0), b, c), 5); assign(if(a, if(b, x, y), megabuf(3)), 7); assign(5, 9); z = megabuf(3)"],
    ["ns-eel", "a = 0.5; q = rand(a); reg05 = -2; r = rand(reg05); s = rand(3.7); t = rand(a + 1)"],
    ["ns-eel", "abcdefgh1 = 3; abcdefgh2 += 4; p = $pi + $e + $phi; longname_xyz = 1"],
    ["eel2", "abcdefghijklmnop1 = 3; abcdefghijklmnop2 += 4; p = $pi + $e + $phi; (a ? b : c) = 4; (a ? b : c) += 2"],
    ["eel2", "x[3] = 4; gmem[2] += x[3]; y = x[3] + gmem[2]; i = 0; loop(10, x[i] = i * i; i += 1); memcpy(20, 0, 10)"]
  ];
  for (const [dialect, source] of sources) {
    for (const values of [{}, { a: 1, b: 0 }, { a: -1, b: 1, c: 0 }]) {
      compare({
        sections: { perFrame: source }, dialect, values, calls: [{ section: "perFrame" }, { section: "perFrame" }],
        analyser: analyser(generator(3), false), gmegabuf: ZERO
      }, source);
    }
  }
});

test("instances share their preset's registers, and the effect's writes reach the code", () => {
  const bank: Record<string, number> = { reg01: 2 };
  const make = (source: string): Scope => {
    const program = eel.parse(source);
    const scope: Scope = { registerBank: bank, x: 0, y: 0 };
    scope.perFrame = eel.compileProgram(program);
    backend.attachWasm(scope, { perFrame: program }, ["perFrame"]);
    return scope;
  };
  const writer = make("reg01 = reg01 * 3 + x; y = reg02");
  const reader = make("x = reg01; reg02 = x + 1");
  writer.x = 1;
  (writer.perFrame as () => void).call(writer);
  (reader.perFrame as () => void).call(reader);
  assert.equal(bank.reg01, 7);
  assert.equal(reader.x, 7);
  assert.equal(bank.reg02, 8);
  (writer.perFrame as () => void).call(writer);
  assert.equal(writer.y, 8);
  assert.equal(bank.reg01, 22);
  assert.ok(Object.getOwnPropertyDescriptor(writer, "x")?.get, "runs as wasm");
  // A clone (CodeInstance.clone copies the properties) runs the closures on its own copy.
  const clone: Scope = { ...writer };
  (clone.perFrame as () => void).call(clone);
  assert.equal(bank.reg01, 67);
  assert.equal(writer.y, 8);
  assert.equal(clone.y, 8);
});

test("what wasm cannot mirror stays with the closures: member names, values that are no numbers, a new bank", () => {
  const bank: Record<string, number> = {};
  const program = eel.parse("x = init + 1; y = analyser");
  const scope: Scope = { registerBank: bank, x: 0, y: 0, analyser: { getWaveform: () => [], getSpectrum: () => [] } };
  scope.perFrame = eel.compileProgram(program);
  scope.init = scope.perFrame;
  backend.attachWasm(scope, { perFrame: program }, ["perFrame"]);
  (scope.perFrame as () => void).call(scope);
  assert.equal(Object.getOwnPropertyDescriptor(scope, "x")?.get, undefined, "closures");
  assert.equal(scope.x, 0);

  const other = eel.parse("x = x + 1; megabuf(2) = x");
  const plain: Scope = { registerBank: bank, x: 0 };
  plain.perFrame = eel.compileProgram(other);
  backend.attachWasm(plain, { perFrame: other }, ["perFrame"]);
  (plain.perFrame as () => void).call(plain);
  assert.ok(Object.getOwnPropertyDescriptor(plain, "x")?.get, "wasm");
  plain.x = true as unknown as number; // an effect writing a boolean: back to the closures, as before
  assert.equal(Object.getOwnPropertyDescriptor(plain, "x")?.get, undefined);
  assert.equal(eel.localBuffers.get(plain)?.[2], 1, "the megabuf goes along");
  (plain.perFrame as () => void).call(plain);
  assert.equal(plain.x, 2, "true + 1, as the closures compute it");
  assert.equal(eel.localBuffers.get(plain)?.[2], 2);

  // setup() with another main: the instance follows the new bank with the closures.
  const swapped: Scope = { registerBank: bank, x: 0 };
  const counting = eel.parse("reg10 = reg10 + 1; x = reg10");
  swapped.perFrame = eel.compileProgram(counting);
  backend.attachWasm(swapped, { perFrame: counting }, ["perFrame"]);
  (swapped.perFrame as () => void).call(swapped);
  assert.ok(Object.getOwnPropertyDescriptor(swapped, "x")?.get, "wasm");
  swapped.registerBank = bank; // setup() with the same main again: still wasm
  assert.ok(Object.getOwnPropertyDescriptor(swapped, "x")?.get, "still wasm");
  const fresh: Record<string, number> = {};
  swapped.registerBank = fresh;
  (swapped.perFrame as () => void).call(swapped);
  assert.equal(fresh.reg10, 1);
  assert.equal(bank.reg10, 1);
  assert.equal(swapped.x, 1);
  assert.equal(Object.getOwnPropertyDescriptor(swapped, "x")?.get, undefined);
});

test("compiled in the background: the closures run until the module comes, then everything moves across", async () => {
  (globalThis as { __avsTestRandom?: boolean }).__avsTestRandom = true;
  const sync = globalThis as { __avsEelWasmSync?: boolean };
  sync.__avsEelWasmSync = false;
  try {
    let switched = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      for (const dialect of ["ns-eel", "eel2"] as const) {
        const testCase = randomCase(seed, dialect);
        // megabuf filled by the closures first, so the move into the memory is tested too.
        testCase.sections.init += "; k = 0; loop(20, megabuf(k) = k * 1.5 - reg05; k += 1)";
        testCase.calls = [...testCase.calls, ...testCase.calls.slice(1)];
        const prepared = prepare(testCase, true);
        for (const call of testCase.calls) {
          prepared.step(call);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        const outcome = prepared.finish();
        if (outcome.wasm) switched += 1;
        compare(testCase, `background seed ${seed} ${dialect}`, outcome);
      }
    }
    assert.ok(switched > 30, `only ${switched} of 40 switched to wasm`);
  } finally {
    sync.__avsEelWasmSync = true;
  }
});

test("gettime(0) is whole milliseconds since the start over 1000, in the closures and in wasm", () => {
  // AVS's clock is whole milliseconds; now / 1000 − start / 1000 at today's epoch (1.7·10^9 s) is off by
  // up to 2.4·10^-7 s (0.12299990653991699 here), and presets that add up frame times drifted with it.
  const realNow = Date.now;
  const start = 1731264000000;
  Date.now = () => start + 123;
  try {
    for (const wasm of [false, true]) {
      const program = eel.parse("t = gettime(0); d = gettime(t - 0.023)");
      const scope: Scope = { registerBank: {}, bootTime: start, t: 0, d: 0 };
      scope.perFrame = eel.compileProgram(program);
      if (wasm) backend.attachWasm(scope, { perFrame: program }, ["perFrame"]);
      (scope.perFrame as () => void).call(scope);
      (scope.perFrame as () => void).call(scope);
      assert.equal(scope.t, 0.123, wasm ? "wasm" : "closures");
      assert.equal(scope.d, 0.123 - (0.123 - 0.023), wasm ? "wasm" : "closures");
      if (wasm) assert.ok(Object.getOwnPropertyDescriptor(scope, "t")?.get, "runs as wasm");
    }
  } finally {
    Date.now = realNow;
  }
});
