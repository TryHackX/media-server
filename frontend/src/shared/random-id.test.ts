import assert from "node:assert/strict";
import test from "node:test";

import { randomId } from "./random-id.ts";

test("an identifier is 32 lowercase hex characters by default — what a shuffle seed and a stream id may be", () => {
  const id = randomId();
  assert.match(id, /^[0-9a-f]{32}$/);
  // The transfer service's own rule for a stream id.
  assert.match(id, /^[A-Za-z0-9_-]{8,80}$/);
});

test("the length follows the number of bytes asked for, and never drops to nothing", () => {
  assert.equal(randomId(12).length, 24);
  assert.equal(randomId(1).length, 2);
  assert.equal(randomId(0).length, 2);
  assert.equal(randomId(2.9).length, 4);
});

test("two identifiers differ", () => {
  const seen = new Set(Array.from({ length: 200 }, () => randomId()));
  assert.equal(seen.size, 200);
});

test("it does not need crypto.randomUUID (absent outside a secure context)", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID")
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), "randomUUID");
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  try {
    assert.match(randomId(), /^[0-9a-f]{32}$/);
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, "randomUUID", original);
    else delete (globalThis.crypto as unknown as { randomUUID?: unknown }).randomUUID;
  }
});
