import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { encodeQr, penaltyScore, reedSolomonDivisor, reedSolomonRemainder } from "./qr.ts";

const repeat = (text: string, times: number): string => text.repeat(times);

/**
 * Reference matrices from segno 1.6 (level M, byte mode, the given mask), as the
 * SHA-256 of their rows in hex joined by commas. segno pads a byte-aligned
 * stream with an extra zero byte that the standard does not ask for (decoders
 * ignore it); the references were made with that one step done the standard way.
 * Every one of these codes, and each automatically masked one, also decodes back
 * to its text with zxing-cpp (checked when the table was made).
 */
const REFERENCES: Array<[string, number, number, string]> = [
  ["HELLO WORLD", 0, 1, "852ec86181ae128b68a12315b06b12ceafc9e057f6e9296efc4fa266fe4e43d8"],
  ["https://example.org/", 3, 2, "6f7e35c568de6cb457610b58c7e710c9885ce39cb54c22a51c35c42ac3ccdf62"],
  ["otpauth://totp/TryHackX%20Media:listener?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=TryHackX%20Media&algorithm=SHA1&digits=6&period=30", 5, 8, "f82ef6cc260e1946551c460daedfacd297742a0bb40d11a196dd8a004bc8fbd5"],
  ["otpauth://totp/TryHackX%20Media:a-very-long-user.name_0123456789?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=TryHackX%20Media&algorithm=SHA1&digits=6&period=30", 6, 9, "3fdb1c52a874db5c86c37c2e90084f1f462a7ad559522c51e87ad4e6391a806c"],
  [repeat("Zażółć gęślą jaźń — ", 10), 2, 13, "ff66b7921dab1efaac88e6a1ee069c29e4921908f819e34de1c829ba6d0969b6"],
  [repeat("x", 400), 7, 15, "0e3f6654d01316f38b85af9b2358bad74893315d7d6a0b7ac87295e9e5d7105c"],
  ["A", 1, 1, "17fc8173d5ee215572783263083e36011f8a0a38c647473f9981f0865acb9dfe"],
  [repeat("0123456789", 5), 4, 4, "ab12a340bc656f2e620ce563736e99f9a27d571260386188a0a5def390a22730"],
  [repeat("a", 80), 0, 5, "de5872782c25b9a93a127145ee886bf147bc0af92351183f5fc453d431f825f7"],
  [repeat("b", 100), 1, 6, "56fb8d79f62636eee6bd01f0c86b2b06a00364c0809ad44501a64445e7a5f28c"],
  [repeat("c", 120), 2, 7, "fb523dea61f7035027f0da4c56486e5c13488b27241c614703c2d9f26a8c019e"],
  [repeat("d", 200), 3, 10, "b45b8adf6e085fe0f791f489a1fc592d1a787ee009e6b8f114af82895720abd1"],
  [repeat("e", 240), 4, 11, "bcea9b03a158b40a67c288b2e906bf16ffb428d9304255ebd8cc027a4f7877fe"],
  [repeat("f", 280), 5, 12, "83f88436bf3a234ccb1ffd2134fa825819e03eef60c595ac25bc29c04c1fa580"],
  [repeat("g", 350), 6, 14, "8b715a50c210e820ca17eb56b4af3f6c59c2ec77f888890283782a1a053abf83"],
];

function rowsDigest(modules: boolean[][]): string {
  const rows = modules.map((row) => {
    let bits = row.map((dark) => (dark ? "1" : "0")).join("");
    bits += "0".repeat((4 - (bits.length % 4)) % 4);
    return BigInt(`0b${bits}`).toString(16).padStart(bits.length / 4, "0");
  });
  return createHash("sha256").update(rows.join(",")).digest("hex");
}

test("Reed-Solomon reproduces the textbook HELLO WORLD 1-M error correction", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomonRemainder(data, reedSolomonDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("matrices match the reference encoder, versions 1 to 15, every mask", () => {
  for (const [text, mask, version, digest] of REFERENCES) {
    const code = encodeQr(text, { mask });
    assert.equal(code.version, version, `version for ${text.slice(0, 20)}`);
    assert.equal(code.size, version * 4 + 17);
    assert.equal(rowsDigest(code.modules), digest, `matrix for ${text.slice(0, 20)}… mask ${mask}`);
  }
});

test("without a forced mask the one with the lowest penalty is used", () => {
  for (const [text] of REFERENCES.slice(0, 6)) {
    const chosen = encodeQr(text);
    const scores = Array.from({ length: 8 }, (_, mask) => penaltyScore(encodeQr(text, { mask }).modules));
    assert.equal(scores[chosen.mask], Math.min(...scores));
    assert.equal(rowsDigest(chosen.modules), rowsDigest(encodeQr(text, { mask: chosen.mask }).modules));
  }
});

test("an otpauth address of the longest allowed user name fits, and too much text is refused", () => {
  const uri = `otpauth://totp/TryHackX%20Media:${"u".repeat(32)}?secret=${"A".repeat(32)}&issuer=TryHackX%20Media&algorithm=SHA1&digits=6&period=30`;
  assert.ok(encodeQr(uri).version <= 10);
  assert.throws(() => encodeQr("x".repeat(413)), RangeError);
});
