/**
 * The frames of an animated GIF, as MilkDrop 3 animates a GIF sprite.
 *
 * MilkDrop 3.37 loads a `.gif` sprite through GDI+: every frame as GDI+ composes it (whole,
 * 32-bit ARGB, the GIF's own transparency, no colour key), each with its delay — the GIF's
 * hundredths of a second, a frame without one (or of 0) a tenth of a second. Drawing, it shows
 * the frame the sprite's time falls in, looped over the total. A browser hands WebGL only one
 * frame of an animated image, so the file is decoded here (LZW, interlacing, the disposal
 * methods), small enough not to need a library.
 */

export interface GifFrames {
  width: number;
  height: number;
  /** Each frame whole, RGBA, rows top first. */
  frames: Uint8Array[];
  /** Seconds each frame shows. */
  delays: number[];
}

const NO_CODE = -1;

/** The colour indices of one image's LZW data (`pixels` many; what the data lacks stays 0). */
function lzw(data: Uint8Array, minimum: number, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  if (minimum < 2 || minimum > 11) return out;
  const clear = 1 << minimum;
  const end = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let code = 0; code < clear; code += 1) suffix[code] = code;
  let size = minimum + 1;
  let mask = (1 << size) - 1;
  let available = clear + 2;
  let old = NO_CODE;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let read = 0;
  let top = 0;
  let written = 0;
  while (written < pixels) {
    if (top === 0) {
      if (bits < size) {
        if (read >= data.length) break;
        datum |= data[read++]! << bits;
        bits += 8;
        continue;
      }
      let code = datum & mask;
      datum >>>= size;
      bits -= size;
      if (code === clear) {
        size = minimum + 1;
        mask = (1 << size) - 1;
        available = clear + 2;
        old = NO_CODE;
        continue;
      }
      if (code === end || code > available) break;
      if (old === NO_CODE) {
        if (code >= clear) break;
        stack[top++] = suffix[code]!;
        old = code;
        first = code;
        continue;
      }
      const current = code;
      if (code === available) {
        stack[top++] = first;
        code = old;
      }
      while (code > clear) {
        stack[top++] = suffix[code]!;
        code = prefix[code]!;
      }
      first = suffix[code]!;
      stack[top++] = first;
      // A full table takes no more entries (until a clear code), but decoding goes on.
      if (available < 4096) {
        prefix[available] = old;
        suffix[available] = first;
        available += 1;
        if ((available & mask) === 0 && available < 4096) {
          size += 1;
          mask += available;
        }
      }
      old = current;
    }
    top -= 1;
    out[written++] = stack[top]!;
  }
  return out;
}

/** Where row `row` of an interlaced image goes (rows 0, 8, 16 … first, then 4, 12 …, 2, 6 …, 1, 3 …). */
function interlacedRows(height: number): Int32Array {
  const rows = new Int32Array(height);
  let next = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) {
    for (let row = start; row < height; row += step) rows[next++] = row;
  }
  return rows;
}

/** The frames of a GIF file; null when it is none (or has no image). */
export function decodeGif(bytes: Uint8Array): GifFrames | null {
  if (bytes.length < 13) return null;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  const word = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
  const width = word(6);
  const height = word(8);
  if (!(width > 0) || !(height > 0)) return null;
  let at = 13;
  let global: Uint8Array | null = null;
  if (bytes[10]! & 0x80) {
    const size = 3 * (2 << (bytes[10]! & 7));
    global = bytes.subarray(at, at + size);
    at += size;
  }
  const skipBlocks = (): void => {
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1;
    at += 1;
  };
  const canvas = new Uint8Array(width * height * 4);
  const frames: Uint8Array[] = [];
  const delays: number[] = [];
  let control = { disposal: 0, transparent: -1, delay: 0 };
  let dispose: (() => void) | null = null;
  while (at < bytes.length) {
    const block = bytes[at++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[at++];
      if (label === 0xf9 && bytes[at]! >= 4) {
        const packed = bytes[at + 1]!;
        control = { disposal: (packed >> 2) & 7, transparent: packed & 1 ? bytes[at + 4]! : -1, delay: word(at + 2) };
      }
      skipBlocks();
      continue;
    }
    if (block !== 0x2c || at + 9 > bytes.length) break;
    const left = word(at);
    const top = word(at + 2);
    const w = word(at + 4);
    const h = word(at + 6);
    const packed = bytes[at + 8]!;
    at += 9;
    let table = global;
    if (packed & 0x80) {
      const size = 3 * (2 << (packed & 7));
      table = bytes.subarray(at, at + size);
      at += size;
    }
    const minimum = bytes[at++]!;
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (at < bytes.length && bytes[at] !== 0) {
      const chunk = bytes.subarray(at + 1, at + 1 + bytes[at]!);
      chunks.push(chunk);
      length += chunk.length;
      at += bytes[at]! + 1;
    }
    at += 1;
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    // What the frame before asked to be done with its area once shown.
    dispose?.();
    dispose = null;
    const saved = control.disposal === 3 ? canvas.slice() : null;
    const indices = lzw(data, minimum, w * h);
    const rows = packed & 0x40 ? interlacedRows(h) : null;
    for (let row = 0; row < h; row += 1) {
      const y = top + (rows ? rows[row]! : row);
      if (y >= height) continue;
      for (let column = 0; column < w; column += 1) {
        const x = left + column;
        if (x >= width) break;
        const index = indices[row * w + column]!;
        if (index === control.transparent || !table || index * 3 + 2 >= table.length) continue;
        const pixel = (y * width + x) * 4;
        canvas[pixel] = table[index * 3]!;
        canvas[pixel + 1] = table[index * 3 + 1]!;
        canvas[pixel + 2] = table[index * 3 + 2]!;
        canvas[pixel + 3] = 255;
      }
    }
    frames.push(canvas.slice());
    delays.push(control.delay > 0 ? control.delay / 100 : 0.1);
    if (control.disposal === 2) {
      dispose = () => {
        for (let y = top; y < Math.min(height, top + h); y += 1) canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + w)) * 4);
      };
    } else if (saved) {
      dispose = () => canvas.set(saved);
    }
    control = { disposal: 0, transparent: -1, delay: 0 };
  }
  return frames.length ? { width, height, frames, delays } : null;
}

/** The frame shown `seconds` after the sprite was loaded: its time looped over the total. */
export function gifFrameAt(delays: readonly number[], seconds: number): number {
  const total = delays.reduce((sum, delay) => sum + delay, 0);
  if (delays.length < 2 || !(total > 0)) return 0;
  const time = ((seconds % total) + total) % total;
  let sum = 0;
  for (let index = 0; index < delays.length; index += 1) {
    sum += delays[index]!;
    if (sum > time) return index;
  }
  return delays.length - 1;
}
