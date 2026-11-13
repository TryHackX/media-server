/**
 * A small QR Code encoder (ISO/IEC 18004), enough for an otpauth:// address.
 *
 * Byte mode only (the text as UTF-8), error correction level M, versions 1–15
 * (up to 412 bytes). The 2FA setup draws the secret with it, so the secret
 * never leaves the page for a QR service. Written for this project from the
 * standard; `qr.test.ts` compares its matrices with a reference encoder's
 * (segno) for several versions and masks.
 *
 * Plain functions with no imports, so Node's test runner can load it as-is.
 */

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** `modules[y][x]`, true for a dark module; no quiet zone. */
  modules: boolean[][];
}

const MAX_VERSION = 15;
/** Level M: error-correction codewords per block, and the number of blocks, by version. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
/** Level M's two format bits. */
const FORMAT_LEVEL_M = 0;

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`index ${index}`);
  return value;
}

/** Modules left for data and error correction once the function patterns are drawn. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - at(ECC_PER_BLOCK, version) * at(BLOCKS, version);
}

/** GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The Reed–Solomon generator of the given degree, its leading 1 left out. */
export function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(at(result, j), root);
      if (j + 1 < degree) result[j] = at(result, j) ^ at(result, j + 1);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords for one block of data. */
export function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] = at(result, i) ^ gfMultiply(at(divisor, i), factor);
  }
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

class Matrix {
  public readonly size: number;
  public readonly modules: boolean[][];
  private readonly reserved: boolean[][];

  // A plain parameter: Node's type stripping (npm run test:ui) does not handle parameter properties.
  public constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  public setFunction(x: number, y: number, dark: boolean): void {
    at(this.modules, y)[x] = dark;
    at(this.reserved, y)[x] = true;
  }

  public isFunction(x: number, y: number): boolean {
    return at(at(this.reserved, y), x);
  }

  public get(x: number, y: number): boolean {
    return at(at(this.modules, y), x);
  }

  public set(x: number, y: number, dark: boolean): void {
    at(this.modules, y)[x] = dark;
  }
}

function drawFinder(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      matrix.setFunction(x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawFormat(matrix: Matrix, mask: number): void {
  const data = (FORMAT_LEVEL_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
  const size = matrix.size;
  for (let i = 0; i <= 5; i++) matrix.setFunction(8, i, bit(i));
  matrix.setFunction(8, 7, bit(6));
  matrix.setFunction(8, 8, bit(7));
  matrix.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) matrix.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) matrix.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) matrix.setFunction(8, size - 15 + i, bit(i));
  matrix.setFunction(8, size - 8, true);
}

function drawVersion(matrix: Matrix, version: number): void {
  if (version < 7) return;
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const bits = (version << 12) | remainder;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = matrix.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    matrix.setFunction(a, b, dark);
    matrix.setFunction(b, a, dark);
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  const size = matrix.size;
  for (let i = 0; i < size; i++) {
    matrix.setFunction(6, i, i % 2 === 0);
    matrix.setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(matrix, 3, 3);
  drawFinder(matrix, size - 4, 3);
  drawFinder(matrix, 3, size - 4);
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((cy, i) => {
    positions.forEach((cx, j) => {
      // Not over the three finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) matrix.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  drawFormat(matrix, 0);
  drawVersion(matrix, version);
}

function drawCodewords(matrix: Matrix, codewords: readonly number[]): void {
  const size = matrix.size;
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!matrix.isFunction(x, y) && index < codewords.length * 8) {
          matrix.set(x, y, ((at(codewords, index >>> 3) >>> (7 - (index & 7))) & 1) !== 0);
          index++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(matrix: Matrix, mask: number): void {
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.isFunction(x, y) && maskBit(mask, x, y)) matrix.set(x, y, !matrix.get(x, y));
    }
  }
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

/**
 * Rule 3 for one row or column: a dark–light–dark×3–light–dark run (1:1:3:1:1)
 * with four light modules before or after it, the edge of the symbol counting
 * as light (the quiet zone is). A counted run is skipped whole, an uncounted one
 * from its first possible restart.
 */
function finderLikePenalty(line: readonly boolean[]): number {
  const size = line.length;
  const light = (from: number, to: number): boolean => {
    for (let i = Math.max(0, from); i < Math.min(size, to); i++) if (line[i]) return false;
    return true;
  };
  let score = 0;
  for (let start = 0; start + 7 <= size;) {
    if (!FINDER_LIKE.every((dark, k) => line[start + k] === dark)) {
      start++;
      continue;
    }
    if (light(start - 4, start) || light(start + 7, start + 11)) {
      score += 40;
      start += 7;
    } else {
      start += 4;
    }
  }
  return score;
}

/** The standard's four penalty rules (ISO/IEC 18004:2015, 7.8.3); the mask with the lowest score is used. */
export function penaltyScore(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  const cell = (x: number, y: number): boolean => at(at(modules, y), x);
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      const line = Array.from({ length: size }, (_, b) => (pass === 0 ? cell(b, a) : cell(a, b)));
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && line[b] === line[b - 1]) {
          run++;
          continue;
        }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
      score += finderLikePenalty(line);
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (cell(x, y)) dark++;
      if (x + 1 < size && y + 1 < size) {
        const colour = cell(x, y);
        if (cell(x + 1, y) === colour && cell(x, y + 1) === colour && cell(x + 1, y + 1) === colour) score += 3;
      }
    }
  }
  // Ten points for every full 5 % the dark share is away from half.
  score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
  return score;
}

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Encode text; `mask` forces one of the eight masks (otherwise the best one is chosen). */
export function encodeQr(text: string, options: { mask?: number } = {}): QrCode {
  const bytes = utf8(text);
  let version = 1;
  for (; version <= MAX_VERSION; version++) {
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break;
  }
  if (version > MAX_VERSION) throw new RangeError("Text too long for this QR encoder.");

  // Mode indicator (byte), length, data, terminator, padding to whole bytes and then to capacity.
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const append = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity * 8 - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks (the short ones first), add each block's error correction, interleave.
  const blockCount = at(BLOCKS, version);
  const eccLength = at(ECC_PER_BLOCK, version);
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortLength = Math.floor(rawCodewords / blockCount);
  const divisor = reedSolomonDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (i < shortBlocks) block.push(0); // a placeholder, skipped when interleaving
    blocks.push([...block, ...ecc]);
  }
  const codewords: number[] = [];
  for (let i = 0; i < at(blocks, 0).length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(at(block, i));
    });
  }

  const size = version * 4 + 17;
  const build = (mask: number): Matrix => {
    const matrix = new Matrix(size);
    drawFunctionPatterns(matrix, version);
    drawCodewords(matrix, codewords);
    applyMask(matrix, mask);
    drawFormat(matrix, mask);
    return matrix;
  };
  let best = options.mask ?? 0;
  if (options.mask === undefined) {
    let lowest = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask++) {
      const score = penaltyScore(build(mask).modules);
      if (score < lowest) {
        lowest = score;
        best = mask;
      }
    }
  }
  return { version, size, mask: best, modules: build(best).modules };
}

/** The code as an SVG element: dark modules on white, with the standard four-module quiet zone. */
export function qrSvg(code: QrCode, label: string): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const margin = 4;
  const extent = code.size + margin * 2;
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", `0 0 ${extent} ${extent}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const background = document.createElementNS(namespace, "rect");
  background.setAttribute("width", String(extent));
  background.setAttribute("height", String(extent));
  background.setAttribute("fill", "#ffffff");
  const path = document.createElementNS(namespace, "path");
  let d = "";
  code.modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  }));
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.append(background, path);
  return svg;
}
