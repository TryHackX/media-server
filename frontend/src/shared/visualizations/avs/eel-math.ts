/**
 * EEL's integer and truth rules, as WDL EEL2's x86 code (the compiler AVS presets were written
 * against) computes them. Kept free of imports so the tests can load it with plain Node.
 */

/**
 * EEL's truth (nseel_asm_fptobool): |value| < 0.00001 (NSEEL_CLOSEFACTOR), and NaN, is false —
 * for if(), band(), bor(), bnot(), &&, || and while().
 */
export const eelTrue = (value: number): boolean => Math.abs(value) >= 0.00001;

/** The x87's fistp in its default mode: to the nearest integer, halves to the even one. */
export const fistp = (value: number): number => {
  const rounded = Math.round(value);
  return rounded - value === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
};

/** A 32-bit fistp of |value| as EEL's `%` reads it: out of range (and NaN) is 0x80000000. */
const unsignedDword = (value: number): number => {
  const rounded = fistp(Math.abs(value));
  return Number.isFinite(rounded) && rounded < 2 ** 31 ? rounded : 2 ** 31;
};

/** A 64-bit fistp: out of range (and NaN) is the "integer indefinite" 0x8000000000000000. */
const qword = (value: number): bigint => {
  const rounded = fistp(value);
  return Number.isFinite(rounded) && Math.abs(rounded) < 2 ** 63 ? BigInt(rounded) : -(2n ** 63n);
};

/**
 * EEL's `%` (nseel_asm_mod): both sides made positive and rounded, an unsigned remainder; by
 * zero it is 0. So -5.5 % 3 is 0 (6 mod 3) — JavaScript's sign-keeping, truncating `%` sent
 * particles that wrap with it (Orifice's x = dirx*w%w/w*2-1) off the left and top edges.
 */
export const eelModulo = (left: number, right: number): number => {
  const divisor = unsignedDword(right);
  return divisor !== 0 ? unsignedDword(left) % divisor : 0;
};

/** EEL's `|` and `&` (nseel_asm_or/and): both sides rounded to 64-bit integers. */
export const eelBitwise = (left: number, right: number, or: boolean): number => {
  const a = fistp(left);
  const b = fistp(right);
  if (Math.abs(a) < 2 ** 31 && Math.abs(b) < 2 ** 31) return or ? a | b : a & b;
  return Number(BigInt.asIntN(64, or ? qword(left) | qword(right) : qword(left) & qword(right)));
};

/** EEL2's `~` (xor), on the same 64-bit roundings as `|` and `&`. */
export const eelXor = (left: number, right: number): number => {
  const a = fistp(left);
  const b = fistp(right);
  if (Math.abs(a) < 2 ** 31 && Math.abs(b) < 2 ** 31) return a ^ b;
  return Number(BigInt.asIntN(64, qword(left) ^ qword(right)));
};

/** EEL2's `<<` and `>>` (nseel_asm_shl/shr): 32-bit fistp of both, the count taken mod 32 as x86 does. */
export const eelShift = (left: number, right: number, toLeft: boolean): number => {
  const int32 = (value: number): number => {
    const rounded = fistp(value);
    return Number.isFinite(rounded) && Math.abs(rounded) < 2 ** 31 ? rounded : -(2 ** 31);
  };
  const a = int32(left);
  const count = int32(right) & 31;
  return toLeft ? a << count : a >> count;
};

/**
 * sin, cos and tan as the x87 computes them for ns-eel 2.81 (fsin, fcos, fsincos + fdiv) and for
 * EEL2 on x86 (fsin, fcos, fptan): an operand at or beyond ±2^63 is out of the instructions' range,
 * they set C2 and leave it unchanged, so sin and cos give the operand back. tan gets nothing pushed
 * and divides an empty register: NaN. Infinities and NaN are invalid operands: NaN. (Within the
 * range the x87 reduces with its own 66-bit pi; that is not followed.) Presets whose values grow
 * without bound (S_KuPeRS' Broken Mirror) settle on this instead of running into Infinity.
 */
const X87_TRIG_RANGE = 2 ** 63;
const outOfRange = (value: number): boolean => Math.abs(value) >= X87_TRIG_RANGE && Math.abs(value) !== Infinity;
export const x87Sin = (value: number): number => (outOfRange(value) ? value : Math.sin(value));
export const x87Cos = (value: number): number => (outOfRange(value) ? value : Math.cos(value));
export const x87Tan = (value: number): number => (outOfRange(value) ? Number.NaN : Math.tan(value));

/**
 * gettime(s) as avs_eelif.cpp computes it: -1 (±0.001) is the track's position in seconds, to the
 * millisecond, and -2 its length in whole seconds, both asked of Winamp — 0 when nothing answers;
 * any other s gives GetTickCount()/1000 − s, one clock for every s, so `start = gettime(0)` and
 * later `gettime(start)` is the time since. `clock` is that clock in seconds (here: since the
 * engine started); `track` the player's position and length in seconds, if there is a player.
 */
export const eelGettime = (start: number, clock: number, track?: { position: number; duration: number } | null): number => {
  const asksPosition = start > -1.001 && start < -0.999;
  const asksLength = start > -2.001 && start < -1.999;
  if (asksPosition || asksLength) {
    if (!track) return 0;
    if (asksPosition) return Number.isFinite(track.position) ? Math.floor(track.position * 1000) / 1000 : 0;
    return Number.isFinite(track.duration) ? Math.floor(track.duration) : 0;
  }
  return clock - start;
};
