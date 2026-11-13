import type { Song } from "./song";

/**
 * What the D.O.C SoundTracker and NoiseTracker screens share (docsoundtracker.ts,
 * noisetracker.ts): the "spectrum analyzer" of the SoundTracker family, which was no spectrum at
 * all but a bar per pitch, set by every note a channel strikes and falling back; the meters over
 * the tracks; and the copper gradients that coloured NoiseTracker's bars line by line. Without
 * runtime imports, so the tests run it as it is.
 */

/** The analyzer's bars, low notes on the left. */
export const BARS = 23;

/** A 12-bit Amiga colour (0xRGB) as 0xRRGGBB. */
export function amiga(rgb12: number): number {
  return ((rgb12 >> 8) & 15) * 0x110000 + ((rgb12 >> 4) & 15) * 0x1100 + (rgb12 & 15) * 0x11;
}

/**
 * A copper gradient: `rows` colours from the first stop to the last, each channel moved in the
 * Amiga's sixteen steps. Stops are [row, 0xRGB] pairs in order of row.
 */
export function copper(rows: number, stops: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    let index = 0;
    while (index < stops.length - 2 && stops[index + 1]![0] <= row) index += 1;
    const [fromRow, from] = stops[index]!;
    const [toRow, to] = stops[Math.min(stops.length - 1, index + 1)]!;
    const t = toRow > fromRow ? Math.max(0, Math.min(1, (row - fromRow) / (toRow - fromRow))) : 0;
    let value = 0;
    for (const shift of [8, 4, 0]) {
      const a = (from >> shift) & 15;
      const b = (to >> shift) & 15;
      value |= Math.round(a + (b - a) * t) << shift;
    }
    out.push(amiga(value));
  }
  return out;
}

/** The bar a note lights: the program's three octaves spread over the analyzer. */
export function barOf(note: number, low: number, high: number): number {
  const span = Math.max(1, high - low);
  return Math.max(0, Math.min(BARS - 1, Math.round(((note - low) / span) * (BARS - 1))));
}

/**
 * The analyzer: each note struck lifts its pitch's bar to its volume (its square root: the notes
 * heard in the music are quieter than a module's, which mostly struck at full volume), and the
 * bars sink at `fall` a second.
 */
export class NoteBars {
  readonly levels = new Float32Array(BARS);
  private readonly seen: Float64Array;
  private readonly low: number;
  private readonly high: number;
  private readonly fall: number;

  constructor(channels: number, low: number, high: number, fall: number) {
    this.seen = new Float64Array(channels);
    this.low = low;
    this.high = high;
    this.fall = fall;
  }

  update(song: Song, dt: number): void {
    for (let bar = 0; bar < BARS; bar += 1) this.levels[bar] = Math.max(0, this.levels[bar]! - dt * this.fall);
    for (let channel = 0; channel < this.seen.length; channel += 1) {
      const hits = song.hits(channel);
      if (hits === this.seen[channel]) continue;
      this.seen[channel] = hits;
      const note = song.noteOf(channel);
      if (note < 0 || note > 119) continue;
      const bar = barOf(note, this.low, this.high);
      this.levels[bar] = Math.max(this.levels[bar]!, Math.sqrt(song.hitVolume(channel)));
    }
  }
}

/** The meters over the tracks: a note's volume when struck, sinking at `fall` a second, held up by the sound. */
export class Meters {
  readonly values: Float32Array;
  private readonly seen: Float64Array;
  private readonly fall: number;

  constructor(channels: number, fall: number) {
    this.values = new Float32Array(channels);
    this.seen = new Float64Array(channels);
    this.fall = fall;
  }

  update(song: Song, dt: number): void {
    for (let channel = 0; channel < this.values.length; channel += 1) {
      let value = this.values[channel]! - dt * this.fall;
      const hits = song.hits(channel);
      if (hits !== this.seen[channel]) {
        this.seen[channel] = hits;
        value = Math.max(value, song.hitVolume(channel));
      }
      value = Math.max(value, song.level(channel) * 0.9);
      this.values[channel] = Math.max(0, Math.min(1, value));
    }
  }
}

/** A scrolling line of text: where it stands after `seconds` at `speed` pixels a second. */
export function scrollOffset(seconds: number, speed: number, textWidth: number, windowWidth: number): number {
  const loop = Math.max(1, textWidth + windowWidth);
  return Math.floor((seconds * speed) % loop);
}
