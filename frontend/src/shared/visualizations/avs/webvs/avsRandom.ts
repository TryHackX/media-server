// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * AVS's random numbers.
 *
 * Presets roll dice in their code (rand(x)) and some effects do on beats (where a
 * Moving Particle heads, which channels Channel Shift swaps …). Normally any good
 * generator does. To compare frames with a reference build of AVS
 * (grandchild/vis_avs) the test page sets `globalThis.__avsTestRandom`, and then
 * both draw the same numbers in the same order from Microsoft's C rand() (seed 1,
 * holdrand · 214013 + 2531011, bits 16…30), as AVS 2.81 did:
 *
 * - rand(x) in code is ns-eel's (nseel-cfunc.c): rand() % (int)max(x, 1), from the
 *   same generator the effects draw from (the reference's EEL2 rand is patched to
 *   that; it had a Mersenne Twister);
 * - the effects call rand() where AVS's did.
 *
 * Main.loadPreset starts it afresh, as a new AVS process does.
 */

/** Whether the comparison harness asked for AVS's own generators. */
export function testRandom(): boolean {
    return Boolean(globalThis.__avsTestRandom);
}

/** rand(x) in preset code: a whole number 0 … floor(x) − 1 (0 below 1). */
export function eelRand(value: number): number {
    if (!testRandom()) {
        let limit = Math.floor(value);
        if (!(limit >= 1)) {
            limit = 1;
        }
        return Number.isFinite(limit) ? Math.floor(Math.random() * limit) : 0;
    }
    // C: rand() % (int)max(x, 1.0); max(NaN, 1) is 1, and (int) out of range is 0x80000000,
    // which leaves rand() as it is.
    const limit = value > 1 ? value : 1;
    const divisor = limit < 2147483648 ? Math.trunc(limit) : -2147483648;
    const r = cRand();
    return divisor === -2147483648 ? r : r % divisor;
}

let holdrand = 1;

/** C's rand(): 0 … 32767. */
export function cRand(): number {
    if (!testRandom()) {
        return Math.floor(Math.random() * 32768);
    }
    holdrand = (Math.imul(holdrand, 214013) + 2531011) >>> 0;
    return (holdrand >>> 16) & 0x7fff;
}

/** Microsoft's LCG moved on by `count` steps at once. */
function lcgSkip(state: number, count: number): number {
    let multiply = 1;
    let add = 0;
    let stepMultiply = 214013;
    let stepAdd = 2531011;
    let left = Math.floor(count);
    while (left > 0) {
        if (left & 1) {
            add = (Math.imul(add, stepMultiply) + stepAdd) >>> 0;
            multiply = Math.imul(multiply, stepMultiply) >>> 0;
        }
        stepAdd = (Math.imul(stepAdd, stepMultiply) + stepAdd) >>> 0;
        stepMultiply = Math.imul(stepMultiply, stepMultiply) >>> 0;
        left = Math.floor(left / 2);
    }
    return (Math.imul(state, multiply) + add) >>> 0;
}

/** Moves C's rand() on by `count` draws (what AVS spent where this port draws nothing). */
export function skipCRand(count: number) {
    if (!testRandom() || count <= 0) {
        return;
    }
    holdrand = lcgSkip(holdrand, count);
}

// Grain's state: as a word in a typed array, not a number that a draw boxes again (moving Grain
// draws ~10^5 a frame at 1280×720).
const grainHold = new Uint32Array([1]);

/**
 * Grain's dice. AVS's Grain drew them from C's rand() as well: 492 when it is made, two per
 * pixel when it first sees the frame's size, one per frame, and while the grain moves more that
 * depend on how much of the picture is lit (grainDice.ts). The reference build gives Grain a
 * generator of its own (the same one, from seed 1) so that the other draws stay comparable; in
 * test mode this is that generator, otherwise any dice do.
 */
export function grainRand(): number {
    if (!testRandom()) {
        return Math.floor(Math.random() * 32768);
    }
    const hold = (Math.imul(grainHold[0], 214013) + 2531011) | 0;
    grainHold[0] = hold;
    return (hold >>> 16) & 0x7fff;
}

/**
 * Grain's generator state, for code that steps the generator itself (grainDice.ts in
 * WebAssembly), and back: null and ignored outside test mode, where any dice do.
 */
export function grainRandState(): number | null {
    return testRandom() ? grainHold[0] : null;
}

export function setGrainRandState(state: number) {
    if (testRandom()) {
        grainHold[0] = state;
    }
}

/** Moves Grain's generator on by `count` draws. */
export function skipGrainRand(count: number) {
    if (testRandom() && count > 0) {
        grainHold[0] = lcgSkip(grainHold[0], count);
    }
}

/**
 * A preset is loading: the generator starts over, and is moved past
 * what AVS's own start spends: three root effect lists name themselves with ten
 * draws each — the instance's two, and the one a preset load makes
 * (clear_secondary). Measured on Water Bump's random drops and Moving Particle:
 * with 20 every beat's position was off, with 30 they land where the reference's do.
 * Grain's own generator starts over as well.
 */
export function restartRandom() {
    holdrand = 1;
    skipCRand(30);
    grainHold[0] = 1;
}
