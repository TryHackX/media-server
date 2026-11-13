import assert from "node:assert/strict";
import test from "node:test";

import { nsEelAccepts, nsEelCompiles, nsEelNormalize, nsEelPreprocess, nsEelSegments, plainNumber } from "./ns-eel-syntax.ts";

test("pieces are cut at every semicolon, brackets or not, and empty ones are skipped", () => {
  assert.deepEqual(nsEelSegments(nsEelPreprocess("a=1;; b=2 ;\r\n;c=(1;2)")), ["a=1", "b=2", "c=(1", "2)"]);
  // Comments and $pi go before the cut, as preprocessCode does them.
  assert.deepEqual(nsEelSegments(nsEelPreprocess("x=$pi; // y=1;\r\nz=2 /* ; */")), ["x=3.141592653589793", "z=2"]);
});

test("cal.y's statements: an assignment to a name, or an expression", () => {
  for (const piece of ["x=dirx*w%w/w*2-1", "x=-sin(-y)", "assign(megabuf(i),v)", "x=if(above(a,b),1,-1)",
    "reg01=reg02*2", "loop(3,exec2(assign(a,a+1),a))", "x=.5+1.", "n=w/2", "a&b|c", "getosc(0.5,0,0)"]) {
    assert.ok(nsEelAccepts(piece), piece);
  }
});

test("what AVS 2.81 could not compile", () => {
  for (const piece of [
    "x=log13(x+y*z)", // an unknown name before a bracket
    "pow(x)", // a function with the wrong count of arguments
    "x=x/2=30-5+y", // two assignments
    "exec2(a=1,b=2)", // an assignment inside an expression (AVS wrote assign())
    ": r=r+d*d", // a character the lexer does not know
    "y=y*t  v=v/5", // two statements without a semicolon
    "a==b", "a<b", "!a", "a?b:c", "x[1]", "a^2", "t=t-0.05,b1=0", "x=1e5", "x=a.b" // EEL2 syntax, stray tokens
  ]) {
    assert.equal(nsEelAccepts(piece), false, piece);
  }
});

test("numbers as nseel-lextab.c's DFA reads them", () => {
  // `.` alone is a number (atof gives 0): VisKey's `z4*.7+.` compiled in AVS.
  assert.equal(nsEelNormalize("blue=z4*.7+."), "blue = z4 * 0.7 + 0");
  assert.equal(nsEelNormalize("x=3d+1.e2+.5"), "x = 3 + 100 + 0.5");
  // Hex with h, read by nseel_translate: each digit added, then shifted (0FFh is 0xFF0).
  assert.equal(nsEelNormalize("x=0FFh"), "x = 4080");
});

test("a section compiles only when every piece does (NSEEL_code_compile)", () => {
  assert.equal(nsEelCompiles("x=1; y=2"), true);
  assert.equal(nsEelCompiles("x=1; : r=r+d*d; y=2"), false);
  assert.equal(nsEelCompiles(""), true);
  assert.equal(nsEelCompiles("// only a note"), true);
});

test("a byte from 0x80 up ends the piece for the lexer: what follows it is not read", () => {
  // ALT+0160 (a no-break space) after the code: AVS read the code and left the note.
  assert.equal(nsEelNormalize("x=x+1 \u00a0  slow it down"), "x = x + 1");
  assert.equal(nsEelNormalize("y=2 \u00b0 + 3"), "y = 2");
  assert.equal(nsEelCompiles("x=1;\r\ny=x*2 \u00a0  the y axis;\r\nz=3"), true);
  // A piece that is only such a note is skipped: the sources say cal.y would fail the section,
  // but authors wrote whole sections around such notes, and they ran.
  assert.equal(nsEelAccepts("\u00a03D rotation (no z axis rotation)"), true);
  assert.equal(nsEelNormalize("\u00a03D rotation (no z axis rotation)"), "");
  assert.equal(nsEelCompiles("cx=cos(rx);\u00a9;px=1;py=0;\u00a9;x1=px*cz"), true);
  assert.equal(nsEelCompiles("x=1;\r\n\u00b7hyperboloid 1;\r\n\u00a3 Phase 2: Slow down\r\ny=2"), true);
  // Spaces alone are no note: such a piece never reaches the parser (nsEelSegments).
  assert.equal(nsEelAccepts("   "), false);
  // A no-break space is not white space to ns-eel: the piece keeps it, and is a note.
  assert.deepEqual(nsEelSegments("x=1; \u00a0note ;y=2"), ["x=1", "\u00a0note", "y=2"]);
  assert.equal(nsEelCompiles("z1=1 ;\r\n\r\n\u00a03D rotation (no z axis rotation) ;\r\n\r\nx2=x1"), true);
});

test("numbers are written back with digits and a point only, never in exponent form", () => {
  // Effekthasch — Theory Of Pretty Much Everything: `size = osize/(prspctv+0.0000001)` came back as
  // `1e-7`, which the EEL reader after this does not take, and the Texer II's whole frame code was lost.
  assert.equal(nsEelNormalize("size = osize/(prspctv+0.0000001)"), "size = osize / ( prspctv + 0.0000001 )");
  assert.equal(nsEelNormalize("x=.00000005"), "x = 0.00000005");
  assert.equal(nsEelNormalize("x=1234567890123456789012.5"), "x = 1234567890123456800000");
  assert.equal(nsEelNormalize("x=1.e-9"), "x = 0.000000001");
  for (const value of [1e-7, 1.2345678901234567e-12, 5e-324, 1e21, 1.7976931348623157e308, 0.1, 42, 3.25e-7]) {
    const text = plainNumber(value);
    assert.match(text, /^[0-9]+(\.[0-9]+)?$/, text);
    assert.equal(Number(text), value, text);
  }
});
