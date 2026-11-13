/**
 * Mirror's fades, as r_mirror.cpp (AVS 2.81d) counts them: the arithmetic without the pixels.
 *
 * The mode's bits: 1 top to bottom, 2 bottom to top, 4 left to right, 8 right to left. AVS keeps
 * the last mode, a divisor and a step per direction in statics: one state for every Mirror in
 * the preset (AVS kept it over preset changes as well; here a preset starts as a fresh AVS did).
 * Each frame a Mirror compares the mode it uses (its own, or with "on beat random" the last pick,
 * 0 before the first beat) with the last one. A direction whose bit changed gets a step of +1
 * (turning on) or −1 (turning off) and, when it has no divisor, a divisor of 1 or 16.
 *
 * Then the directions are drawn in r_mirror.cpp's order: left to right, right to left, top to
 * bottom, bottom to top — those whose bit is set and, with "smooth" on, also those whose divisor
 * is not 0. With smooth on and a divisor, a pixel becomes (16 − d)/16 of itself and d/16 of its
 * mirror image, high nibbles only; otherwise the mirror image is copied. With smooth on, every
 * `slower`-th frame of a Mirror's own count every divisor takes its step, modulo 16: a fade in goes
 * 1…15 and ends at 0 with the bit set (a plain copy), a fade out goes 16, 15…1 and ends at 0
 * with the bit cleared (nothing drawn).
 *
 * Pure (no imports): the tests load it with plain Node.
 */

/** The state r_mirror.cpp keeps in statics (lastMode; divisors and inc, a byte per direction). */
export interface MirrorStatics {
  lastMode: number;
  /** Per bit index (0 top to bottom, 1 bottom to top, 2 left to right, 3 right to left). */
  divisors: number[];
  steps: number[];
}

/** One direction drawn this frame: its bit, and its divisor (0 copies). */
export interface MirrorPass {
  bit: number;
  divisor: number;
}

export function newMirrorStatics(): MirrorStatics {
  return { lastMode: 0, divisors: [0, 0, 0, 0], steps: [0, 0, 0, 0] };
}

/** Left to right, right to left, top to bottom, bottom to top: the bit indexes in drawing order. */
const DRAW_ORDER = [2, 3, 0, 1];

/** The directions one frame draws, after taking note of a changed mode. */
export function mirrorPasses(statics: MirrorStatics, mode: number, smooth: boolean): MirrorPass[] {
  if (mode !== statics.lastMode) {
    const changed = mode ^ statics.lastMode;
    for (let index = 0; index < 4; index += 1) {
      const bit = 1 << index;
      if (changed & bit) {
        const wasOn = (statics.lastMode & bit) !== 0;
        statics.steps[index] = wasOn ? 0xff : 1;
        if (!statics.divisors[index]) statics.divisors[index] = wasOn ? 16 : 1;
      }
    }
    statics.lastMode = mode;
  }
  const passes: MirrorPass[] = [];
  for (const index of DRAW_ORDER) {
    const bit = 1 << index;
    const divisor = statics.divisors[index]!;
    if (mode & bit || (smooth && divisor)) passes.push({ bit, divisor: smooth ? divisor : 0 });
  }
  return passes;
}

/** Every divisor a step further (a byte added, modulo 16): with smooth on, every `slower`-th frame. */
export function mirrorAdvance(statics: MirrorStatics): void {
  for (let index = 0; index < 4; index += 1) {
    const divisor = statics.divisors[index]!;
    if (divisor) statics.divisors[index] = (divisor + statics.steps[index]!) % 16;
  }
}
