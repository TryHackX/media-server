import assert from "node:assert/strict";
import test from "node:test";

import { type Eel2Node, parseEel2, presetEelDialect, usesEel2Syntax } from "./eel2-parser.ts";

/** The tree of the code, bracketed fully. */
function show(node: Eel2Node | undefined): string {
  if (!node) return "∅";
  switch (node.type) {
    case "SCRIPT": return (node.body ?? []).map(show).join("; ");
    case "NUMBER_LITERAL": return String(node.value);
    case "IDENTIFIER": return String(node.value);
    case "EXPRESSION_BLOCK": return `{${(node.body ?? []).map(show).join("; ")}}`;
    case "UNARY_EXPRESSION": return `(${node.operator}${show(node.value as Eel2Node)})`;
    case "BINARY_EXPRESSION":
    case "LOGICAL_EXPRESSION":
    case "ASSIGNMENT_EXPRESSION": return `(${show(node.left)}${node.operator}${show(node.right)})`;
    case "CALL_EXPRESSION": return `${node.callee!.value}(${(node.arguments ?? []).map(show).join(", ")})`;
    case "CONDITIONAL_EXPRESSION": return `(${show(node.test)} ? ${show(node.consequent)} : ${show(node.alternate)})`;
    case "MEMORY_EXPRESSION": return `${node.global ? "gmem" : "mem"}[${show(node.address)}]`;
    default: return `?${node.type}`;
  }
}

const tree = (code: string): string => show(parseEel2(code));

test("EEL2's levels: % and the shifts over /, / over *, - over +", () => {
  assert.equal(tree("y = a / b % c * d;"), "(y=((a/(b%c))*d))");
  assert.equal(tree("y = a * b / c;"), "(y=(a*(b/c)))");
  assert.equal(tree("y = a % b / c;"), "(y=((a%b)/c))");
  assert.equal(tree("y = a + b - c;"), "(y=(a+(b-c)))");
  assert.equal(tree("y = a - b + c;"), "(y=((a-b)+c))");
  assert.equal(tree("y = a << 2 * b;"), "(y=((a<<2)*b))");
});

test("unary minus binds before ^, bit operators share a level, comparisons above them", () => {
  assert.equal(tree("y = -a^2;"), "(y=((-a)^2))");
  assert.equal(tree("y = a & b | c ~ d;"), "(y=(((a&b)|c)~d))");
  assert.equal(tree("y = a + 1 < b & 3;"), "(y=((a+1)<(b&3)))");
  assert.equal(tree("y = a < b == c;"), "(y=((a<b)==c))");
  assert.equal(tree("y = a && b || c;"), "(y=(a&&(b||c)))");
});

test("? : binds looser than assignment inside it, tighter than the assignment around it", () => {
  assert.equal(tree("x = a ? b : c;"), "(x=(a ? b : c))");
  assert.equal(tree("a ? b = 1 : c = 2;"), "(a ? (b=1) : (c=2))");
  assert.equal(tree("x = a ? b;"), "(x=(a ? b : ∅))");
  assert.equal(tree("x = a ? : c;"), "(x=(a ? ∅ : c))");
  assert.equal(tree("x = a ? b ? 1 : 2 : 3;"), "(x=(a ? (b ? 1 : 2) : 3))");
});

test("memory: x[y] is at x + y, x[] at x, gmem[y] global", () => {
  assert.equal(tree("x[y] = 3; z = x[];"), "(mem[(x+y)]=3); (z=mem[x])");
  assert.equal(tree("gmem[i + 1] += 2;"), "(gmem[(i+1)]+=2)");
  assert.equal(tree("v = buf[i][1];"), "(v=mem[(mem[(buf+i)]+1)])");
});

test("numbers: $x hex, $'c', 0x, constants; blocks and sequences", () => {
  assert.equal(tree("x = $x1F + $'A' + 0x10;"), "(x=((31+65)+16))");
  assert.equal(tree("a = (b = 2; b * 3);"), "(a={(b=2); (b*3)})");
  assert.equal(tree("f(a; b, c);"), "f({a; b}, c)");
  assert.equal(tree("while (x < 3) (x += 1);"), "while(((x<3) ? {(x+=1); 1} : ∅))");
});

test("functions are inlined: arguments first, then parameters, then the body", () => {
  assert.equal(tree("function sq(v) ( v*v ); y = sq(3);"), "(y={(__a0_0=3); (__f0p0=__a0_0); (__f0p0*__f0p0)})");
  // A call inside an argument cannot overwrite the outer call's first argument.
  const nested = tree("function f(a b) (a - b); z = f(1, f(2, 3));");
  assert.ok(nested.startsWith("(z={(__a1_0=1); (__a1_1={(__a0_0=2); (__a0_1=3);"), nested);
  assert.equal(tree("function f(x) local(t) (t = x; t); y = f(1);"), "(y={(__a0_0=1); (__f0p0=__a0_0); {(__f0l0=__f0p0); __f0l0}})");
  // Names a function does not own are the preset's.
  assert.equal(tree("function g() (k + 1); y = g();"), "(y={(k+1)})");
  assert.throws(() => parseEel2("function f(a) (a); f(1, 2);"));
  assert.throws(() => parseEel2("function f(a) (f(a)); f(1);"));
});

test("instance() and this. take the namespace of the call", () => {
  assert.equal(tree("function inc() instance(n) ( n += 1 ); a.inc(); inc();"), "{(a.n+=1)}; {(n+=1)}");
  assert.equal(tree("function get() ( this.v ); y = obj.get();"), "(y={obj.v})");
});

test("EEL2 is told by its own syntax, and only by syntax that reads as EEL2", () => {
  assert.equal(usesEel2Syntax("x = a ? b : c;"), true);
  assert.equal(usesEel2Syntax("x[1] = 2;"), true);
  assert.equal(usesEel2Syntax("function f(a) (a*2); y = f(2);"), true);
  assert.equal(usesEel2Syntax("while (i < 3) (i += 1);"), true);
  assert.equal(usesEel2Syntax("x = a*b%c; y = if(a, b, c);"), false);
  // A sequence inside brackets: 2.81 cut it at the `;` (the section did nothing), EEL2 runs it.
  assert.equal(usesEel2Syntax("loop(3, a = a + 1; b = b * a);"), true);
  assert.equal(usesEel2Syntax("x = sin(a; y = 2"), false);
  assert.equal(usesEel2Syntax("loop(3, exec2(assign(a, a + 1), assign(b, b * a)));"), false);
  // A note between statements (Let Me Paint My Way Out) is no EEL2.
  assert.equal(usesEel2Syntax("x=i; what shape? (length)"), false);
  // Comments are not code.
  assert.equal(usesEel2Syntax("x = 1; // a ? b : c"), false);
});

test("a preset is EEL2 when any of its code is; comments, text and AVS Trans are not code", () => {
  const preset = (perFrame: string, extra: object = {}) => ({
    components: [
      { type: "Comment", text: "really? [yes]" },
      { type: "EffectList", code: { init: "", perFrame: "" }, components: [{ type: "SuperScope", code: { perFrame, perPoint: "x=i*2-1;" } }] },
      extra
    ]
  });
  assert.equal(presetEelDialect(preset("t = t + 0.1;")), "ns-eel");
  assert.equal(presetEelDialect(preset("t = b ? 0 : t + 0.1;")), "eel2");
  assert.equal(presetEelDialect(preset("t = 1;", { type: "Movement", code: "d = d ? d : 1" })), "eel2");
  assert.equal(presetEelDialect(preset("t = 1;", { type: "AVSTransAutomation", code: "#define a(x) (x ? 1 : 0)" })), "ns-eel");
});

test("a byte from 0x80 up: nothing more is read up to the next `;` (authors' notes)", () => {
  assert.equal(tree("x = 1; ©; y = 2;"), "(x=1); (y=2)");
  assert.equal(tree("red = 0   + 1; green = 1"), "(red=0); (green=1)");
  // Past line breaks, as the reference reads it.
  assert.equal(tree("£ note\r\ngreen = 1; blue = 0"), "(blue=0)");
  // A note does not hide the EEL2 syntax around it, nor is a `?` in it EEL2.
  assert.equal(usesEel2Syntax("x = a ? b : c; · a note (really?)"), true);
  assert.equal(usesEel2Syntax("x = 1; · a note (really?)"), false);
});
