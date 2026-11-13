/**
 * The circuit of the Atari Video Music C240 (1977) as US patent 4,081,829 (Robert J. Brown)
 * describes it, as arithmetic: no imports, so the tests run it as it is (retro.test.ts).
 *
 * - Two V-shaped ramps from 4-bit counters — 15 down to 0 and up to 15 again — one along each TV
 *   line, one down each field. Their sum is compared with each channel's ENERGY (the rectified,
 *   integrated audio): where the energy is the higher, that channel's picture is lit. A sum of
 *   two V-ramps against a level is a diamond, stepped as the counters step.
 * - The horizontal buttons (1, 2, 3, 5) and the vertical ones (1, 2, 4, 8) multiply the ramps'
 *   frequencies: as many diamonds across and down.
 * - SOLID lights where either channel is lit (OR), HOLE where exactly one is (XOR: the quieter
 *   channel's diamond cuts a hole into the louder one's), RING draws, from each edge of the HOLE
 *   signal, a pulse seven clocks of 228 per line wide.
 * - Colour: each channel's zero crossings are counted for a field (the counter serves the
 *   channels on alternate fields); the count — about the pitch — picks one of 16 taps of a delay
 *   line on the 3.58 MHz colour clock (TABLE I: zones of 120 Hz up to 960 Hz, 240 Hz up to
 *   1920 Hz, then 480 Hz up to 3840 Hz, where it rolls over). The COLOR knob sets how far apart
 *   the taps lie: one hue, or a whole rainbow. Where both channels are lit, the colour is that
 *   of the one that came on last along the line.
 */

export type AvmShape = "solid" | "hole" | "ring";

/*
 * The analogue front end, from the schematic (CA010270) and the owner's manual of the C240.
 *
 * - Energy detector: the GAIN pot's wiper, through a band-pass of two RC sections (poles at
 *   129 and 887 Hz: -3 dB from 103 to 1119 Hz), charges a hold capacitor (C23, 4.7 µF) on the
 *   negative half-cycles within a millisecond. It lets go through R60 and the CONTOUR rheostat
 *   (2.2 k + 0 … 100 k) and through R61 (100 k), towards an idle level about a volt below:
 *   10 ms with CONTOUR fully anticlockwise (a shape lives a couple of milliseconds after each
 *   peak: the manual's "soft shapes", streaks), 238 ms fully clockwise (steady diamonds: its
 *   "geometric shapes"). The rise above idle is what the comparators hold against the ramps,
 *   193 mV a ramp.
 * - Zero axis detector: the input itself, before GAIN (GAIN does not change the colours), through
 *   a high-pass at 362 Hz and halved, into a comparator with 24 mV of hysteresis.
 * - COLOR: the pot (0 to 4.3 V) sets the bias of the delay line, and so how far apart the taps'
 *   phases lie; the ramps reach the same pin through C18 (AC-coupled), so the bias, and the hue,
 *   changes with the distance from the middle of each diamond: rings of colour. Anticlockwise the
 *   manual has "less color", in the middle a "rainbow of colors", clockwise a "solid color".
 */

/** The band-pass before the hold capacitor: its two poles, Hz. */
export const ENERGY_POLES: readonly [number, number] = [129, 887];
/** Volts the hold node rises per volt of peak at the GAIN wiper, in the middle of the band (339 Hz). */
export const ENERGY_PER_VOLT = 0.709;
/** One step of a ramp at the comparators. */
export const STEP_VOLTS = 0.193 / 15;
/** The zero axis detector: its high-pass (Hz), the divider after it, the comparator's hysteresis (V). */
export const ZERO_AXIS_HIGH_PASS = 362;
export const ZERO_AXIS_DIVIDER = 0.5;
export const ZERO_AXIS_HYSTERESIS = 0.0244;
/** The input level the manual names (volts RMS into 47 kΩ). */
export const NOMINAL_INPUT = 0.25;

/**
 * CONTOUR (0 fully anticlockwise … 1 fully clockwise): the hold node's release time (s) and the
 * level below idle it heads for (V), C23 discharging through R60 + CONTOUR and through R61.
 */
export function contourRelease(position: number): { tau: number; idle: number } {
  const contour = 2.2e3 + 100e3 * Math.max(0, Math.min(1, position));
  const r61 = 100e3;
  return { tau: (4.7e-6 * contour * r61) / (contour + r61), idle: r61 / (r61 + contour) };
}

/** The COLOR pot's wiper (V) at `position` (0 … 1), and the ramps' share of the bias per step. */
export const COLOR_VOLTS = 4.32;
export const RAMP_COLOR_VOLTS = (0.909 * 1.48) / 15;
/** The delay line's stages before the first tap. */
const LEAD_STAGES = 2;

/**
 * Degrees of the colour clock a stage of the delay line takes at bias `volts`: long delays with
 * little bias, short ones with much; steepest in the middle of the pot's travel.
 */
export function stageDegrees(volts: number): number {
  return 3 + 39 / (1 + Math.exp((volts - 2) / 0.4));
}

/**
 * The chroma (I, Q) of tap `index` (16 … 1) where the two ramps add up to `rampSum` (0 … 30),
 * with the COLOR pot at `position` and the set's tint `tint` (degrees), `chroma` long at most.
 * Slow stages pass the colour clock weaker: little bias, less colour.
 */
export function tapChromaAt(index: number, rampSum: number, position: number, tint: number, chroma: number): [number, number] {
  const volts = COLOR_VOLTS * Math.max(0, Math.min(1, position)) + RAMP_COLOR_VOLTS * (rampSum - 15);
  const step = stageDegrees(volts);
  const stages = 16 - index + LEAD_STAGES;
  const phase = ((tint + stages * step) * Math.PI) / 180;
  const length = chroma * Math.exp(-(stages * step) / 1500);
  return [length * Math.cos(phase), length * Math.sin(phase)];
}

/** Clocks of the colour clock per TV line (63.84 µs), and how many of them the picture shows. */
export const CLOCKS_PER_LINE = 228;
export const VISIBLE_CLOCKS = 192;
/** Lines per field (non-interlaced, 60 a second) and how many of them the picture shows. */
export const LINES_PER_FIELD = 262;
export const VISIBLE_LINES = 240;
/** The width of a RING pulse, in clocks. */
export const RING_CLOCKS = 7;

export const ACROSS: readonly number[] = [1, 2, 3, 5];
export const DOWN: readonly number[] = [1, 2, 4, 8];

/**
 * A V-ramp's 4-bit value at `position` (0–1) across a span holding `multiplier` periods: 15 at
 * either end of each period, 0 in its middle.
 */
export function ramp(position: number, multiplier: number): number {
  const within = (position * multiplier) % 1;
  return Math.min(15, Math.floor(Math.abs(within - 0.5) * 32));
}

/**
 * TABLE I: the delay-line tap (16 … 1) a zero-crossing count selects. The bits X2–X6 of the
 * count are used, X1 disregarded: counts 0–15 step a tap every two counts (DL16 … DL9), 16–31
 * every four (DL8 … DL5), 32–63 every eight (DL4 … DL1); then the count rolls over.
 */
export function tapOfCount(count: number): number {
  const c = Math.max(0, Math.floor(count)) % 64;
  if (c < 16) return 16 - (c >> 1);
  if (c < 32) return 8 - ((c - 16) >> 2);
  return 4 - ((c - 32) >> 3);
}

/**
 * The colour TABLE I gives a frequency (a count over a field of 1/60 s): 16 for the lowest,
 * 1 for 3360–3840 Hz, then round again.
 */
export function colourIndex(frequency: number): number {
  return tapOfCount(Math.max(0, frequency) / 60);
}

/**
 * A tap's chroma: the colour clock delayed by tap `index` (1–16), `spread` degrees of phase
 * between neighbouring taps (the COLOR knob moves the delays: VGG of the delay inverters),
 * `offset` the phase of tap 16. As I and Q of YIQ, `chroma` long.
 */
export function tapChroma(index: number, spread: number, offset: number, chroma: number): [number, number] {
  const phase = ((offset + (16 - index) * spread) * Math.PI) / 180;
  return [chroma * Math.cos(phase), chroma * Math.sin(phase)];
}

/** YIQ (0–1, I and Q about ±0.6) to RGB bytes, clipped as a set clips. */
export function yiqToRgb(y: number, i: number, q: number, out: Uint8ClampedArray | number[], at: number): void {
  out[at] = (y + 0.956 * i + 0.621 * q) * 255;
  out[at + 1] = (y - 0.272 * i - 0.647 * q) * 255;
  out[at + 2] = (y - 1.106 * i + 1.703 * q) * 255;
}

/**
 * The NTSC colour of a lit pixel of tap `index` (see tapChroma), RGB 0–255, with the set's
 * luminance and saturation.
 */
export function tapColour(index: number, spread: number, offset: number, luma = 0.66, chroma = 0.32): [number, number, number] {
  const [i, q] = tapChroma(index, spread, offset, chroma);
  const rgb = [0, 0, 0];
  yiqToRgb(luma, i, q, rgb, 0);
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  return [clamp(rgb[0]!), clamp(rgb[1]!), clamp(rgb[2]!)];
}

/**
 * One TV line through the shape logic. `left` and `right` are the two channels' energies on this
 * line, in ramp steps (0 – about 40; the sum of the ramps reaches 30); `vertical` this line's
 * vertical ramp; `horizontal` the horizontal ramp of each clock. Writes, per clock, 0 for dark
 * or the colour register lit there: 1 for the left channel's, 2 for the right's.
 */
export function shapeLine(
  shape: AvmShape,
  left: number,
  right: number,
  vertical: number,
  horizontal: Uint8Array,
  out: Uint8Array
): void {
  let lastOn = 0;
  let wasLeft = false;
  let wasRight = false;
  let wasHole = false;
  let risePulse = 0;
  let fallPulse = 0;
  let held = 1;
  for (let clock = 0; clock < horizontal.length; clock += 1) {
    const reference = horizontal[clock]! + vertical;
    const onLeft = left > reference;
    const onRight = right > reference;
    // The colour select: one channel on, its colour; both on, the one that came on last.
    if (onLeft && !wasLeft) lastOn = 1;
    if (onRight && !wasRight) lastOn = 2;
    const select = onLeft && onRight ? lastOn || 1 : onLeft ? 1 : onRight ? 2 : 0;
    if (select) held = select;
    wasLeft = onLeft;
    wasRight = onRight;
    const hole = onLeft !== onRight;
    if (shape === "solid") {
      out[clock] = onLeft || onRight ? select : 0;
    } else if (shape === "hole") {
      out[clock] = hole ? select : 0;
    } else {
      // Two counters started by the HOLE signal's rising and falling edges, each on for seven clocks.
      if (hole && !wasHole) risePulse = RING_CLOCKS;
      if (!hole && wasHole) fallPulse = RING_CLOCKS;
      out[clock] = risePulse > 0 || fallPulse > 0 ? held : 0;
      if (risePulse > 0) risePulse -= 1;
      if (fallPulse > 0) fallPulse -= 1;
    }
    wasHole = hole;
  }
}
