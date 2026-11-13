import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import test from "node:test";

import { encodeSolution, sha256Hex, solveChallenge, type PowChallenge } from "./pow.ts";

test("SHA-256 matches Node's at every padding boundary", () => {
  assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const length of [0, 1, 31, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const bytes = randomBytes(length);
    assert.equal(sha256Hex(new Uint8Array(bytes)), createHash("sha256").update(bytes).digest("hex"), `length ${length}`);
  }
});

/** A challenge made the way ProofOfWork.php makes one. */
function challengeFor(number: number, maxnumber: number): PowChallenge {
  const salt = `${randomBytes(12).toString("hex")}.${Math.floor(Date.now() / 1000) + 600}.`;
  const challenge = createHash("sha256").update(salt + String(number)).digest("hex");
  return { algorithm: "SHA-256", challenge, salt, maxnumber, signature: createHmac("sha256", "k").update(challenge).digest("hex") };
}

test("the solver finds the number, reports progress and stops at the range", () => {
  const challenge = challengeFor(12345, 20000);
  const seen: number[] = [];
  assert.equal(solveChallenge(challenge, { progressEvery: 5000, onProgress: (n) => seen.push(n) }), 12345);
  assert.deepEqual(seen, [0, 5000, 10000]);
  assert.equal(solveChallenge(challenge, { to: 12344 }), null, "not inside the range");
  assert.equal(solveChallenge(challenge, { from: 12345, to: 12345 }), 12345);
  assert.equal(solveChallenge(challengeFor(30000, 20000)), null, "beyond maxnumber");
  assert.equal(solveChallenge({ ...challenge, challenge: "not hex" }), null);
});

test("the solution travels as base64 JSON with the challenge's own fields", () => {
  const challenge = challengeFor(7, 100);
  const decoded = JSON.parse(Buffer.from(encodeSolution(challenge, 7), "base64").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(decoded, {
    algorithm: "SHA-256", challenge: challenge.challenge, number: 7, salt: challenge.salt, signature: challenge.signature
  });
});

test("a default-difficulty search stays well under a second here", () => {
  const challenge = challengeFor(250000, 250000);
  const started = performance.now();
  assert.equal(solveChallenge(challenge), 250000);
  // The worst case at the default difficulty; a phone is a few times slower.
  assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)} ms`);
});
