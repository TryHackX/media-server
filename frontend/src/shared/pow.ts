/**
 * Proof of work, the page's half (the server's is integrations/php/ProofOfWork.php).
 *
 * The server publishes `challenge = SHA-256(salt + number)` for a secret number
 * no larger than `maxnumber`; the page tries numbers from 0 until the digest
 * matches and sends back the challenge's fields with the number it found. The
 * scheme is ALTCHA's.
 *
 * SHA-256 is written out here rather than taken from `crypto.subtle`: the
 * search hashes a 40-byte message a hundred thousand times, and the promise per
 * call that `subtle.digest` costs is slower than the hash itself. Plain
 * functions with no imports, so `npm run test:ui` checks them against Node's
 * crypto and the worker (pow-worker.ts) and the main thread share them.
 */

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  maxnumber: number;
  signature: string;
}

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const INITIAL = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);
const schedule = new Uint32Array(64);

// Indices below are always in range (fixed-size arrays, fixed loops); the
// assertions only tell the compiler, which checks every index for undefined.
function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  const w = schedule;
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] = (block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!;
  }
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15]!;
    const b = w[i - 2]!;
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
  }
  let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
  let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  state[0] = state[0]! + a; state[1] = state[1]! + b; state[2] = state[2]! + c; state[3] = state[3]! + d;
  state[4] = state[4]! + e; state[5] = state[5]! + f; state[6] = state[6]! + g; state[7] = state[7]! + h;
}

/** Hash `length` bytes of `buffer`, which must have room for the padding (up to 72 more bytes). */
function digestInto(state: Uint32Array, buffer: Uint8Array, length: number): void {
  state.set(INITIAL);
  const total = ((length + 9 + 63) >> 6) << 6;
  buffer[length] = 0x80;
  buffer.fill(0, length + 1, total);
  const bits = length * 8;
  buffer[total - 5] = (bits / 0x100000000) & 0xff;
  buffer[total - 4] = (bits >>> 24) & 0xff;
  buffer[total - 3] = (bits >>> 16) & 0xff;
  buffer[total - 2] = (bits >>> 8) & 0xff;
  buffer[total - 1] = bits & 0xff;
  for (let offset = 0; offset < total; offset += 64) compress(state, buffer, offset);
}

/** SHA-256 of a byte string, as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  const buffer = new Uint8Array(bytes.length + 72);
  buffer.set(bytes);
  const state = new Uint32Array(8);
  digestInto(state, buffer, bytes.length);
  let out = "";
  for (const word of state) out += word.toString(16).padStart(8, "0");
  return out;
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0x7f;
  return bytes;
}

export interface SolveOptions {
  /** Called every `progressEvery` numbers with the number reached. */
  onProgress?: (reached: number) => void;
  progressEvery?: number;
  /** Where to start and stop (inclusive); the defaults cover the whole range. */
  from?: number;
  to?: number;
}

/**
 * The number behind the challenge, or null when it is not in the searched range
 * (a challenge that is not ours, or a range that holds no answer).
 */
export function solveChallenge(challenge: PowChallenge, options: SolveOptions = {}): number | null {
  if (!/^[0-9a-f]{64}$/.test(challenge.challenge) || /[^\x20-\x7e]/.test(challenge.salt)) return null;
  const target = new Uint32Array(8);
  for (let i = 0; i < 8; i++) target[i] = Number.parseInt(challenge.challenge.slice(i * 8, i * 8 + 8), 16);
  const prefix = asciiBytes(challenge.salt);
  const buffer = new Uint8Array(prefix.length + 16 + 72);
  buffer.set(prefix);
  const state = new Uint32Array(8);
  const last = Math.min(options.to ?? challenge.maxnumber, challenge.maxnumber);
  const every = Math.max(1, options.progressEvery ?? 5000);
  for (let number = Math.max(0, options.from ?? 0); number <= last; number++) {
    let length = prefix.length;
    const digits = String(number);
    for (let i = 0; i < digits.length; i++) buffer[length++] = digits.charCodeAt(i);
    digestInto(state, buffer, length);
    if (state[0] === target[0] && state[1] === target[1] && state[2] === target[2] && state[3] === target[3]
      && state[4] === target[4] && state[5] === target[5] && state[6] === target[6] && state[7] === target[7]) {
      return number;
    }
    if (options.onProgress && number % every === 0) options.onProgress(number);
  }
  return null;
}

/** What the page sends back: the challenge's fields and the number, as base64 JSON. */
export function encodeSolution(challenge: PowChallenge, number: number): string {
  return btoa(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number,
    salt: challenge.salt,
    signature: challenge.signature
  }));
}
