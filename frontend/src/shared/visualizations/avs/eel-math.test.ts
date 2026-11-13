import assert from "node:assert/strict";
import test from "node:test";

import { eelBitwise, eelGettime, eelModulo, eelShift, eelTrue, eelXor, fistp, x87Cos, x87Sin, x87Tan } from "./eel-math.ts";

test("fistp rounds to the nearest integer, halves to the even one", () => {
  assert.deepEqual([2.4, 2.5, 3.5, -2.5, -3.5, -0.4].map(fistp), [2, 2, 4, -2, -4, -0]);
});

test("% makes both sides positive and rounds them, by zero it is 0", () => {
  assert.equal(eelModulo(7, 3), 1);
  assert.equal(eelModulo(-7, 3), 1);
  assert.equal(eelModulo(7, -3), 1);
  assert.equal(eelModulo(-5.5, 3), 0); // 6 mod 3
  assert.equal(eelModulo(2.6, 2), 1); // 3 mod 2
  assert.equal(eelModulo(5, 0), 0);
  assert.equal(eelModulo(5, 0.4), 0); // the divisor rounds to 0
  assert.equal(eelModulo(Number.NaN, 7), 2 ** 31 % 7);
});

test("| and & round both sides to 64-bit integers", () => {
  assert.equal(eelBitwise(2.7, 0, true), 3);
  assert.equal(eelBitwise(5, 3, false), 1);
  assert.equal(eelBitwise(-1, 255, false), 255);
  assert.equal(eelBitwise(2 ** 40, 1, true), 2 ** 40 + 1);
  assert.equal(eelBitwise(-(2 ** 40), 2 ** 40, false), 2 ** 40);
});

test("truth is |x| >= 0.00001; NaN is false", () => {
  assert.equal(eelTrue(0.00001), true);
  assert.equal(eelTrue(-0.00002), true);
  assert.equal(eelTrue(0.000009), false);
  assert.equal(eelTrue(0), false);
  assert.equal(eelTrue(Number.NaN), false);
});

test("EEL2's ~ is xor and << >> shift 32-bit integers, the count mod 32", () => {
  assert.equal(eelXor(6, 3), 5);
  assert.equal(eelXor(2.6, 1), 2); // 3 ^ 1
  assert.equal(eelXor(2 ** 40, 1), 2 ** 40 + 1);
  assert.equal(eelShift(1, 4, true), 16);
  assert.equal(eelShift(-16, 2, false), -4);
  assert.equal(eelShift(1, 33, true), 2);
  assert.equal(eelShift(2.5, 1, true), 4); // 2.5 rounds to 2
});

test("sin and cos give an operand beyond ±2^63 back unchanged, as fsin and fcos do; tan gives NaN", () => {
  assert.equal(x87Sin(1), Math.sin(1));
  assert.equal(x87Cos(-1e18), Math.cos(-1e18)); // still in range
  assert.equal(x87Cos(2 ** 63), 2 ** 63);
  assert.equal(x87Sin(-5e21), -5e21);
  assert.equal(x87Cos(1e300), 1e300);
  assert.ok(Number.isNaN(x87Tan(2 ** 64)));
  assert.equal(x87Tan(0.5), Math.tan(0.5));
  assert.ok(Number.isNaN(x87Cos(Infinity)));
  assert.ok(Number.isNaN(x87Sin(-Infinity)));
  assert.ok(Number.isNaN(x87Cos(Number.NaN)));
});

test("gettime: one clock for every start value; -1 and -2 ask the player, 0 without one", () => {
  assert.equal(eelGettime(0, 12.5), 12.5);
  const start = eelGettime(0, 12.5);
  assert.equal(eelGettime(start, 13), 0.5); // time since start
  assert.ok(Math.abs(eelGettime(13 - 1 / 60, 13) - 1 / 60) < 1e-12); // a frame's length, as presets build it
  assert.equal(eelGettime(-1, 99), 0);
  assert.equal(eelGettime(-2, 99, null), 0);
  const track = { position: 61.23456, duration: 200.7 };
  assert.equal(eelGettime(-1, 99, track), 61.234);
  assert.equal(eelGettime(-1.0005, 99, track), 61.234);
  assert.equal(eelGettime(-2, 99, track), 200);
  assert.equal(eelGettime(-1.5, 99, track), 100.5); // not a query: clock − s
});
