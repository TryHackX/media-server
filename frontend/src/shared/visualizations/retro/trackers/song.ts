import type { RetroAudio, RetroTrack } from "../types";

/**
 * The module the tracker screens play (protracker.ts and the others), made live from the music:
 * no module file exists, so the music is listened to as a tracker's channels would carry it.
 * Without imports, so the tests run it as it is (trackers.test.ts).
 *
 * - Detectors listen to bands of the music: the kick under 110 Hz, the bass, a snare's crack,
 *   the hi-hats' hiss, a lead line, a pad. A drum is heard where its band's envelope leaps above
 *   its recent level, and keeps one note, as drum samples did. A pitched part starts a note on
 *   such a leap too, or where its pitch moves (read from its waveform with McLeod's normalised
 *   square difference function, as a tuner reads a string); a pad's chord is the major or minor
 *   triad its spectrum fits best, written as a tracker wrote chords: the root with an arpeggio.
 * - The rows run at four a beat (speed 6), the tempo the median spacing of the kicks folded into
 *   80–180 BPM (125 until it is known), and the clock leans towards putting the kicks on every
 *   fourth row. In silence the rows stop, as a stopped player's do.
 * - Notes are written into 64-row patterns at the row they fell on; rows played stay as they
 *   were written. The rows still to come show what the channel played a bar or two earlier, as
 *   a module that repeats itself would, until the music says otherwise.
 */

export const ROWS = 64;
/** A note: 0 is C-0 (16.35 Hz), 57 A-4 (440 Hz); NOTE_NONE an empty note column. */
export const NOTE_NONE = -1;
/** A note off (Fasttracker's and Impulse Tracker's) and a note cut (Scream Tracker's "^^"). */
export const NOTE_OFF = 254;
export const NOTE_CUT = 253;

export type Role = "kick" | "snare" | "hats" | "bass" | "lead" | "chord";
/** What a channel plays: a detector's notes, or the lead's echo three rows later. */
export type Part = Role | "echo";

/** The effects the module writes, in no program's notation yet (notation.ts spells them). */
export const EFFECTS = [
  "none", "arpeggio", "slideUp", "slideDown", "tonePorta", "vibrato", "volumeSlide", "volume",
  "speed", "tempo", "offset", "retrigger", "cut", "panning"
] as const;
export type Effect = (typeof EFFECTS)[number];

/** One cell of a pattern, read with Song.cell. */
export interface Cell {
  /** NOTE_NONE, 0–119, NOTE_OFF or NOTE_CUT. */
  note: number;
  /** 0 for none. */
  instrument: number;
  /** −1 for none, else 0–64. */
  volume: number;
  effect: Effect;
  /** 0–255. */
  param: number;
}

export function emptyCell(): Cell {
  return { note: NOTE_NONE, instrument: 0, volume: -1, effect: "none", param: 0 };
}

/** The 12-tone note of a frequency (0 is C-0, 57 A-4), as a fraction; NaN below 1 Hz. */
export function noteFromFrequency(frequency: number): number {
  return frequency >= 1 ? 12 * Math.log2(frequency / 440) + 57 : Number.NaN;
}

/** A hash of a few integers, 0 – 2³²−1: the module's "random" choices, the same every time. */
export function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** A second-order filter (the Audio EQ Cookbook's), stepped one sample at a time. */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  z1 = 0;
  z2 = 0;

  constructor(kind: "lowpass" | "highpass" | "pass", frequency = 1000, rate = 48000, q = Math.SQRT1_2) {
    this.set(kind, frequency, rate, q);
  }

  set(kind: "lowpass" | "highpass" | "pass", frequency: number, rate: number, q = Math.SQRT1_2): void {
    if (kind === "pass" || frequency <= 0 || frequency >= rate / 2) {
      this.b0 = 1;
      this.b1 = this.b2 = this.a1 = this.a2 = 0;
      return;
    }
    const w = (2 * Math.PI * frequency) / rate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    const low = kind === "lowpass";
    this.b0 = (low ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
    this.b1 = (low ? 1 - cos : -(1 + cos)) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  step(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = this.z2 = 0;
  }
}

/**
 * The pitch of `samples` (oldest first) at `rate`, looked for between `low` and `high` Hz:
 * McLeod's normalised square difference function, its first peak that comes close to the
 * highest. `clarity` is that peak's height (1 for a pure tone); frequency 0 when nothing is
 * periodic enough. `scratch` holds the function (at least as long as `samples`).
 */
export function pitchOf(samples: Float32Array, rate: number, low: number, high: number, scratch: Float32Array): { frequency: number; clarity: number } {
  const size = samples.length;
  const minLag = Math.max(2, Math.floor(rate / high));
  const maxLag = Math.min(Math.floor(size / 2), Math.ceil(rate / low) + 1);
  if (maxLag <= minLag + 2) return { frequency: 0, clarity: 0 };
  let energy = 0;
  for (let j = 0; j < size; j += 1) energy += samples[j]! * samples[j]!;
  if (energy < 1e-9) return { frequency: 0, clarity: 0 };
  // m(τ) shrinks by the two samples that leave the overlap at each lag.
  let m = 2 * energy;
  for (let lag = 0; lag <= maxLag; lag += 1) {
    if (lag > 0) m -= samples[lag - 1]! * samples[lag - 1]! + samples[size - lag]! * samples[size - lag]!;
    let acf = 0;
    for (let j = 0; j < size - lag; j += 1) acf += samples[j]! * samples[j + lag]!;
    scratch[lag] = m > 1e-12 ? (2 * acf) / m : 0;
  }
  // The peaks of the positive lobes after the function first goes negative.
  let best = 0;
  let lag = 1;
  while (lag <= maxLag && scratch[lag]! > 0) lag += 1;
  const peaks: number[] = [];
  while (lag <= maxLag) {
    while (lag <= maxLag && scratch[lag]! <= 0) lag += 1;
    let top = -1;
    while (lag <= maxLag && scratch[lag]! > 0) {
      if (top < 0 || scratch[lag]! > scratch[top]!) top = lag;
      lag += 1;
    }
    if (top >= minLag && top < maxLag) {
      peaks.push(top);
      if (scratch[top]! > best) best = scratch[top]!;
    }
  }
  if (best < 0.5) return { frequency: 0, clarity: best };
  for (const top of peaks) {
    const value = scratch[top]!;
    if (value < best * 0.88) continue;
    const before = scratch[top - 1]!;
    const after = scratch[top + 1]!;
    const curve = before - 2 * value + after;
    const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (before - after)) / curve)) : 0;
    return { frequency: rate / (top + shift), clarity: value };
  }
  return { frequency: 0, clarity: best };
}

/**
 * The note of the strongest peak of a spectrum (0–1 per bin of `binHz`) between `low` and
 * `high` Hz, favouring what is new against `before` (the spectrum a row ago): where a waveform
 * is too mixed to read its pitch, the loudest new partial is most often the new note's. NaN
 * when the range has no peak.
 */
export function peakNote(spectrum: ArrayLike<number>, binHz: number, low: number, high: number, before?: ArrayLike<number>): number {
  const first = Math.max(1, Math.ceil(low / binHz));
  const last = Math.min(spectrum.length - 2, Math.floor(high / binHz));
  let best = -1;
  let bestScore = 0.3;
  for (let bin = first; bin <= last; bin += 1) {
    const value = spectrum[bin]!;
    if (value < spectrum[bin - 1]! || value < spectrum[bin + 1]!) continue;
    const score = value + 2 * Math.max(0, value - (before?.[bin] ?? value));
    if (score > bestScore) {
      bestScore = score;
      best = bin;
    }
  }
  if (best < 0) return Number.NaN;
  const before0 = spectrum[best - 1]!;
  const value = spectrum[best]!;
  const after = spectrum[best + 1]!;
  const curve = before0 - 2 * value + after;
  const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (before0 - after)) / curve)) : 0;
  return noteFromFrequency((best + shift) * binHz);
}

/** The 12 pitch classes' weights, kept between calls of chordOf. */
const chroma = new Float64Array(12);

/**
 * The triad a spectrum (0–1 per bin of `binHz`) fits best between 180 and 1200 Hz: its peaks
 * folded into the twelve pitch classes, matched against every major and minor chord. `root` is
 * a pitch class (0 is C); `strength` how much of the weight the chord's three notes hold.
 */
export function chordOf(spectrum: ArrayLike<number>, binHz: number): { root: number; minor: boolean; strength: number } | null {
  chroma.fill(0);
  const first = Math.max(1, Math.ceil(180 / binHz));
  const last = Math.min(spectrum.length - 2, Math.floor(1200 / binHz));
  let total = 0;
  for (let bin = first; bin <= last; bin += 1) {
    const value = spectrum[bin]!;
    // The peaks only: a bin above both neighbours, above the floor.
    if (value < 0.35 || value < spectrum[bin - 1]! || value < spectrum[bin + 1]!) continue;
    const weight = (value - 0.3) * (value - 0.3);
    const pitchClass = ((Math.round(noteFromFrequency(bin * binHz)) % 12) + 12) % 12;
    chroma[pitchClass] = chroma[pitchClass]! + weight;
    total += weight;
  }
  if (total < 1e-3) return null;
  let best: { root: number; minor: boolean; strength: number } | null = null;
  for (let root = 0; root < 12; root += 1) {
    for (const minor of [false, true]) {
      const third = chroma[(root + (minor ? 3 : 4)) % 12]!;
      const score = chroma[root]! + third + chroma[(root + 7) % 12]! - 0.5 * chroma[(root + (minor ? 4 : 3)) % 12]!;
      // A chord needs its root and its third or fifth.
      if (chroma[root]! <= 0 || third + chroma[(root + 7) % 12]! <= 0) continue;
      const strength = score / total;
      if (!best || strength > best.strength) best = { root, minor, strength };
    }
  }
  return best && best.strength > 0.45 ? best : null;
}

/**
 * The tempo from the kicks: the median of their recent spacings, each halved or doubled into
 * 80–180 BPM (a kick on every other beat, or on the off-beats too, reads as the beat), moved
 * towards quickly while the spacings agree and gently while they scatter, so one stray kick
 * does not shake it.
 */
export class TempoTracker {
  bpm: number;
  readonly fallback: number;
  readonly low: number;
  readonly high: number;
  private readonly spacings: number[] = [];
  private last = -1;

  constructor(fallback = 125, low = 80, high = 180) {
    this.fallback = fallback;
    this.low = low;
    this.high = high;
    this.bpm = fallback;
  }

  /** A kick heard at `time` seconds. */
  beat(time: number): void {
    const last = this.last;
    this.last = time;
    if (last < 0) return;
    let spacing = time - last;
    if (spacing < 0.15 || spacing > 2.4) return;
    while (spacing > 60 / this.low) spacing /= 2;
    while (spacing < 60 / this.high) spacing *= 2;
    this.spacings.push(spacing);
    if (this.spacings.length > 12) this.spacings.shift();
    if (this.spacings.length < 3) return;
    const median = middleOf(this.spacings);
    const spread = middleOf(this.spacings.map((value) => Math.abs(value - median))) / median;
    const target = Math.max(this.low, Math.min(this.high, 60 / median));
    this.bpm += (target - this.bpm) * (spread < 0.03 || Math.abs(target - this.bpm) > 12 ? 0.6 : 0.25);
  }

  reset(): void {
    this.bpm = this.fallback;
    this.spacings.length = 0;
    this.last = -1;
  }
}

/** The median of some numbers. */
function middleOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** How a detector listens: its band, how fast its envelope moves, what counts as a note. */
interface DetectorSpec {
  /** High-pass and low-pass corners, Hz (0: none). */
  low: number;
  high: number;
  /** Envelope attack and release, and how fast its recent level rises, s. */
  attack: number;
  release: number;
  settle: number;
  /** A note: the envelope this many times its recent level, at least `gap` s after the last. */
  rise: number;
  gap: number;
  /** How long after the start the note is read (its loudness, its pitch), s. */
  read: number;
  /** The softest note it writes, against the band's loudest lately (0–1). */
  softest: number;
  /** Where a pitched part's pitch is looked for, Hz, the rate it is read at and over how long. */
  pitch?: { low: number; high: number; rate: number; window: number };
}

const DETECTORS: Record<Role, DetectorSpec> = {
  kick: { low: 25, high: 110, attack: 0.004, release: 0.07, settle: 0.12, rise: 1.7, gap: 0.2, read: 0.03, softest: 0.3 },
  bass: { low: 40, high: 260, attack: 0.008, release: 0.06, settle: 0.12, rise: 1.45, gap: 0.1, read: 0.06, softest: 0.3, pitch: { low: 38, high: 300, rate: 3000, window: 0.05 } },
  snare: { low: 1600, high: 6000, attack: 0.002, release: 0.05, settle: 0.12, rise: 2.1, gap: 0.2, read: 0.03, softest: 0.3 },
  hats: { low: 7500, high: 0, attack: 0.001, release: 0.03, settle: 0.09, rise: 1.8, gap: 0.08, read: 0.05, softest: 0.3 },
  lead: { low: 500, high: 4000, attack: 0.003, release: 0.05, settle: 0.1, rise: 1.22, gap: 0.08, read: 0.022, softest: 0.25, pitch: { low: 180, high: 1800, rate: 16000, window: 0.02 } },
  chord: { low: 140, high: 1200, attack: 0.03, release: 0.25, settle: 0.6, rise: 99, gap: 1, read: 0, softest: 0.2 }
};

/** The full-rate band signal a detector keeps for the scopes: some 85 ms at 48 kHz. */
const SCOPE_RING = 4096;
/** How long a detector's automatic level takes to forget a loud passage, s. */
const LEVEL_MEMORY = 5;
/** Below this the band is too quiet to play a note. */
const BAND_FLOOR = 0.0025;

/** One band of the music, listened to sample by sample. */
export class Detector {
  readonly role: Role;
  readonly spec: DetectorSpec;
  private readonly hpLeft = new Biquad("pass");
  private readonly lpLeft = new Biquad("pass");
  private readonly hpRight = new Biquad("pass");
  private readonly lpRight = new Biquad("pass");
  private rate = 0;
  private attack = 0;
  private release = 0;
  private settleUp = 0;
  private settleDown = 0;
  /** The band's power envelope (mono, each side) and its recent level. */
  power = 0;
  powerLeft = 0;
  powerRight = 0;
  recent = 0;
  /** The loudest envelope lately: the band's automatic level. */
  loudest = BAND_FLOOR;
  /** Seconds since the last note. */
  since = 10;
  /** The band signal, full rate (for the scopes), and slower (for the pitch). */
  readonly ring = new Float32Array(SCOPE_RING);
  at = 0;
  private readonly slow: Float32Array;
  private slowAt = 0;
  private step = 1;
  private count = 0;
  private readonly window: Float32Array;
  private readonly scratch: Float32Array;

  constructor(role: Role) {
    this.role = role;
    this.spec = DETECTORS[role];
    const pitch = this.spec.pitch;
    // Enough for the window at any rate up to 48 kHz read down to the pitch's rate.
    const windowLength = pitch ? Math.ceil(pitch.window * pitch.rate * 1.5) : 0;
    this.slow = new Float32Array(pitch ? 2048 : 1);
    this.window = new Float32Array(windowLength);
    this.scratch = new Float32Array(windowLength + 2);
  }

  private configure(rate: number): void {
    this.rate = rate;
    const spec = this.spec;
    this.hpLeft.set(spec.low > 0 ? "highpass" : "pass", spec.low, rate);
    this.hpRight.set(spec.low > 0 ? "highpass" : "pass", spec.low, rate);
    this.lpLeft.set(spec.high > 0 ? "lowpass" : "pass", spec.high, rate);
    this.lpRight.set(spec.high > 0 ? "lowpass" : "pass", spec.high, rate);
    const per = (seconds: number): number => 1 - Math.exp(-1 / (rate * seconds));
    this.attack = per(spec.attack);
    this.release = per(spec.release);
    this.settleUp = per(spec.settle);
    this.settleDown = per(spec.settle * 0.35);
    this.step = spec.pitch ? Math.max(1, Math.round(rate / spec.pitch.rate)) : 1;
  }

  /**
   * Samples `from` … `to` − 1 of both channels through the band. `onset` is called with the
   * index of each sample a note starts at.
   */
  listen(left: Float32Array, right: Float32Array, from: number, to: number, rate: number, onset: (index: number) => void): void {
    if (rate !== this.rate) this.configure(rate);
    const spec = this.spec;
    const attack = this.attack;
    const release = this.release;
    const gapSamples = spec.gap * rate;
    let sinceSamples = this.since * rate;
    let power = this.power;
    let powerLeft = this.powerLeft;
    let powerRight = this.powerRight;
    let recent = this.recent;
    const rise = spec.rise * spec.rise;
    const quietest = Math.max(BAND_FLOOR * BAND_FLOOR, this.loudest * this.loudest * 0.03);
    const ring = this.ring;
    const pitched = spec.pitch !== undefined;
    for (let index = from; index < to; index += 1) {
      const l = this.lpLeft.step(this.hpLeft.step(left[index]!));
      const r = this.lpRight.step(this.hpRight.step(right[index]!));
      const mono = (l + r) * 0.5;
      ring[this.at] = mono;
      this.at = (this.at + 1) & (SCOPE_RING - 1);
      if (pitched && ++this.count >= this.step) {
        this.count = 0;
        this.slow[this.slowAt] = mono;
        this.slowAt = (this.slowAt + 1) & (this.slow.length - 1);
      }
      const p = mono * mono;
      power += (p - power) * (p > power ? attack : release);
      powerLeft += (l * l - powerLeft) * (l * l > powerLeft ? attack : release);
      powerRight += (r * r - powerRight) * (r * r > powerRight ? attack : release);
      recent += (power - recent) * (power > recent ? this.settleUp : this.settleDown);
      sinceSamples += 1;
      // A note: the envelope leaps above the recent level, loud enough for this band lately.
      if (sinceSamples > gapSamples && power > recent * rise && power > quietest) {
        sinceSamples = 0;
        onset(index);
      }
    }
    this.power = power;
    this.powerLeft = powerLeft;
    this.powerRight = powerRight;
    this.recent = recent;
    this.since = sinceSamples / rate;
  }

  /** The automatic level follows the loudest envelope, forgetting it over some seconds. */
  settle(dt: number): void {
    const amplitude = Math.sqrt(this.power);
    this.loudest = Math.max(BAND_FLOOR, amplitude, this.loudest * Math.exp(-dt / LEVEL_MEMORY));
  }

  /** The band's level now, 0–1 of its loudest lately. */
  get level(): number {
    return Math.min(1, Math.sqrt(this.power) / this.loudest);
  }

  /** Left (−1) to right (1). */
  get balance(): number {
    const l = Math.sqrt(this.powerLeft);
    const r = Math.sqrt(this.powerRight);
    return l + r > 1e-6 ? (r - l) / (r + l) : 0;
  }

  /** The band's pitch now, as a fractional note; NaN when it has none. */
  pitch(): number {
    const pitch = this.spec.pitch;
    if (!pitch) return Number.NaN;
    const rate = this.rate / this.step;
    const length = Math.min(this.window.length, Math.round(pitch.window * rate));
    if (length < 16) return Number.NaN;
    const mask = this.slow.length - 1;
    const samples = this.window.subarray(0, length);
    for (let index = 0; index < length; index += 1) samples[index] = this.slow[(this.slowAt - length + index + this.slow.length) & mask]!;
    const found = pitchOf(samples, rate, pitch.low, pitch.high, this.scratch);
    return found.frequency > 0 && found.clarity > 0.6 ? noteFromFrequency(found.frequency) : Number.NaN;
  }

  reset(): void {
    for (const filter of [this.hpLeft, this.lpLeft, this.hpRight, this.lpRight]) filter.reset();
    this.power = this.powerLeft = this.powerRight = this.recent = 0;
    this.loudest = BAND_FLOOR;
    this.since = 10;
    this.ring.fill(0);
    this.slow.fill(0);
  }
}

/**
 * A channel of the screen: the parts it plays, in order of precedence (a part's note may push a
 * later part's waiting note out), and its side. A part goes to the first channel that has room.
 */
export interface ChannelSpec {
  parts: readonly Part[];
  /** −1 a left channel, 1 a right one: a part heard on that side goes there first. */
  side?: number;
}

/** What a program's module looks like. */
export interface SongSpec {
  channels: readonly ChannelSpec[];
  /** The lowest and highest note the program writes. */
  low: number;
  high: number;
  /** The note each drum is written at. */
  drums: { kick: number; snare: number; hats: number };
  /** Where each pitched part is written: its notes are moved by octaves to start from here. */
  floors: { bass: number; lead: number; chord: number };
  /** The instrument each part plays (hats: the closed one; the open one is the next). */
  instruments: Record<Part, number>;
  /** The most positions a song may have. */
  positions: number;
  /** Does the program write a note off where a held note ends? */
  noteOff?: boolean;
  /** Chords as their three notes in channels side by side (else the root with an arpeggio). */
  chordVoices?: boolean;
  /** A per-program seed for the order list and the effects. */
  seed?: number;
}

/** What a channel is playing. */
interface ChannelState {
  /** The detector whose band it plays now (its last note's), or −1 before its first note. */
  source: number;
  /** Its last note, instrument, volume (0–64) and the part that played it. */
  note: number;
  instrument: number;
  volume: number;
  part: Part | null;
  /** Counts the notes it has started; how loud the last one began (0–1). */
  hits: number;
  hitVolume: number;
  /** The rows its prediction repeats from: a bar, two or half of one. */
  period: number;
  /** The arpeggio a chord holds; the level at the last row, for slides. */
  arpeggio: number;
  lastLevel: number;
  /** Its note still sounds (not ended, and its part has not moved on to another channel). */
  sounding: boolean;
  /** Seconds since its note began. */
  age: number;
}

/** A note heard by a detector, waiting to be written. */
interface Heard {
  role: Role;
  detector: number;
  /** The row position it began at, its loudness so far (0–1), its balance (−1 left … 1 right). */
  at: number;
  peak: number;
  balance: number;
  /** Seconds left before it is read, how often the reading was put off, the channel it goes to. */
  wait: number;
  deferred?: number;
  channel: number;
  /** Its pitch when already known (a note heard by its pitch moving). */
  pitch?: number;
}

/** How much of a channel's band its note still carries: a drum dies away as its sample did, an echo is quieter. */
function fade(state: ChannelState): number {
  switch (state.part) {
    case "kick": return Math.exp(-state.age * 6);
    case "snare": return Math.exp(-state.age * 8);
    case "hats": return Math.exp(-state.age * 14);
    case "echo": return Math.exp(-state.age * 3) * 0.5;
    default: return 1;
  }
}

/** Rows kept: the pattern on screen, the one before for the predictions, and room ahead. */
const RING = 256;
/** Rows a bar has at four rows a beat. */
const BAR = 16;
/** How far into a row a lead is looked at (early: a plucked note fades fast), and the bass and chords. */
const EARLY = 0.2;
const LATE = 0.5;

export class Song {
  readonly spec: SongSpec;
  readonly channels: number;
  readonly tempo = new TempoTracker();
  /** The row clock: rows since the song began (fractional), and the row playing. */
  rowPosition = 0;
  current = 0;
  /** The row clock runs (the music sounds). */
  playing = false;
  /** Seconds the song has played, by the track when it is known. */
  time = 0;
  /** Counts the changes to what the patterns show: a screen redraws its rows when it moves. */
  changes = 0;
  /** The position the song began at (a visualizer opened mid-track starts mid-song). */
  private firstPosition = 0;
  private readonly detectors: Detector[] = [];
  private readonly detectorOf = new Map<Role, number>();
  private readonly states: ChannelState[] = [];
  private readonly heard: Heard[] = [];
  private readonly notes: Int16Array;
  private readonly instruments: Uint8Array;
  private readonly volumes: Int8Array;
  private readonly effects: Uint8Array;
  private readonly params: Uint8Array;
  private readonly written: Uint8Array;
  private readonly stamps = new Int32Array(RING).fill(-1);
  /** Seconds of music heard, for the tempo. */
  private clock = 0;
  /** Rows the clock still has to gain (or lose) to put the kicks on the beat rows. */
  private nudge = 0;
  /** The track the song follows (null before the first frame), and where it was last frame. */
  private title: string | null = null;
  private lastTrackPosition = -1;
  private writtenTempo = 0;
  private wantSpeed = true;
  /** The rows looked at last, early and late. */
  private lookedEarly = -1;
  private lookedLate = -1;
  /** Each pitched part's pitch at the last look, and the last row it started a note on. */
  private readonly pitches: Record<Role, number> = { kick: Number.NaN, snare: Number.NaN, hats: Number.NaN, bass: Number.NaN, lead: Number.NaN, chord: Number.NaN };
  private readonly lastRow: Record<Role, number> = { kick: -1, snare: -1, hats: -1, bass: -1, lead: -1, chord: -1 };
  /** The chord written last and the one the spectrum shows (heard on how many looks running). */
  private chord = -1;
  private candidate = -1;
  private candidateLooks = 0;
  /** The frame's spectrum (for the chords and the pitches), and a copy from the row before. */
  private spectrum: ArrayLike<number> = [];
  private binHz = 1;
  private before = new Float32Array(0);

  constructor(spec: SongSpec) {
    this.spec = spec;
    this.channels = spec.channels.length;
    const roles = new Set<Role>(["kick"]);
    for (const channel of spec.channels) for (const part of channel.parts) roles.add(part === "echo" ? "lead" : part);
    for (const role of ["kick", "bass", "snare", "hats", "lead", "chord"] as const) {
      if (!roles.has(role)) continue;
      this.detectorOf.set(role, this.detectors.length);
      this.detectors.push(new Detector(role));
    }
    const size = RING * this.channels;
    this.notes = new Int16Array(size).fill(NOTE_NONE);
    this.instruments = new Uint8Array(size);
    this.volumes = new Int8Array(size).fill(-1);
    this.effects = new Uint8Array(size);
    this.params = new Uint8Array(size);
    this.written = new Uint8Array(size);
    for (let channel = 0; channel < this.channels; channel += 1) this.states.push(this.freshState());
  }

  private freshState(): ChannelState {
    return { source: -1, note: NOTE_NONE, instrument: 0, volume: 0, part: null, hits: 0, hitVolume: 0, period: BAR, arpeggio: 0, lastLevel: 0, sounding: false, age: 10 };
  }

  /** The row playing within its pattern (0–63). */
  get row(): number {
    return this.current & (ROWS - 1);
  }

  /** The song position playing, and the pattern it plays. */
  get position(): number {
    return Math.min(this.spec.positions - 1, this.firstPosition + Math.floor(this.current / ROWS));
  }

  get pattern(): number {
    return this.patternAt(this.position);
  }

  /** The pattern at a song position: in order, now and then one played again. */
  patternAt(position: number): number {
    const seed = this.spec.seed ?? 0;
    return Math.max(0, position - Math.floor((position + (seed % 3)) / 4) + (seed % 2));
  }

  /** The song's length in positions: by the track's length, at least to the one playing. */
  length(duration: number): number {
    const byTrack = duration > 0 ? Math.ceil((duration * this.tempo.bpm) / 15 / ROWS) : 0;
    return Math.min(this.spec.positions, Math.max(this.position + 1, byTrack || this.position + 12));
  }

  /** The tempo shown: whole beats a minute. */
  get bpm(): number {
    return Math.round(this.tempo.bpm);
  }

  /** The cell of `channel` at `row` of the pattern playing, into `out`. */
  cell(channel: number, row: number, out: Cell): Cell {
    const absolute = this.current - this.row + row;
    if (!this.known(absolute)) {
      out.note = NOTE_NONE;
      out.instrument = 0;
      out.volume = -1;
      out.effect = "none";
      out.param = 0;
      return out;
    }
    const at = (absolute & (RING - 1)) * this.channels + channel;
    out.note = this.notes[at]!;
    out.instrument = this.instruments[at]!;
    out.volume = this.volumes[at]!;
    out.effect = EFFECTS[this.effects[at]!] ?? "none";
    out.param = this.params[at]!;
    return out;
  }

  /** The channel's level now (its band's, while its note lasts), 0–1. */
  level(channel: number): number {
    const state = this.states[channel]!;
    if (state.source < 0 || !state.sounding) return 0;
    return this.detectors[state.source]!.level * (state.volume / 64) * fade(state);
  }

  /** Notes the channel has started, and how loud the last one began (0–1). */
  hits(channel: number): number {
    return this.states[channel]!.hits;
  }

  hitVolume(channel: number): number {
    return this.states[channel]!.hitVolume;
  }

  /** The note and instrument the channel plays now (NOTE_NONE and 0 before its first). */
  noteOf(channel: number): number {
    return this.states[channel]!.note;
  }

  instrumentOf(channel: number): number {
    return this.states[channel]!.instrument;
  }

  /** The part the channel plays now, or null before its first note. */
  partOf(channel: number): Part | null {
    return this.states[channel]!.part;
  }

  /**
   * The channel's waveform: `out.length` points over the newest `seconds` of its band, scaled
   * by the band's automatic level to about −1…1. Flat before its first note and in silence.
   */
  scope(channel: number, out: Float32Array, seconds: number, rate: number): void {
    const state = this.states[channel]!;
    if (state.source < 0) {
      out.fill(0);
      return;
    }
    const detector = this.detectors[state.source]!;
    const span = Math.min(SCOPE_RING - 1, Math.max(out.length, Math.round(seconds * rate)));
    const gain = (0.9 * fade(state)) / detector.loudest;
    const step = span / out.length;
    const start = detector.at - span;
    for (let index = 0; index < out.length; index += 1) {
      const value = detector.ring[(start + Math.floor(index * step) + SCOPE_RING) & (SCOPE_RING - 1)]! * gain;
      out[index] = Math.max(-1, Math.min(1, value));
    }
  }

  /** One frame of the music: listen, move the rows on, write what was heard. */
  update(audio: RetroAudio, track: RetroTrack, dt: number): void {
    this.follow(track);
    this.spectrum = audio.spectrum;
    this.binHz = audio.binHz;
    const rate = audio.rate;
    const length = audio.left.length;
    const fresh = Math.min(audio.fresh, length);
    this.playing = audio.silence < 0.35 && (audio.sounding || this.playing);
    if (!this.playing) {
      this.heard.length = 0;
      this.nudge = 0;
    }
    // The rows this frame moves on by, spread over its samples.
    let advance = 0;
    if (this.playing) {
      advance = (this.tempo.bpm / 15) * dt;
      const correction = Math.max(-advance * 0.4, Math.min(advance * 0.4, this.nudge * Math.min(1, dt * 3)));
      advance += correction;
      this.nudge -= correction;
      if (track.position <= 0) this.time += dt;
    }
    const start = this.rowPosition;
    const from = length - fresh;
    const frameSeconds = fresh / rate;
    for (let index = 0; index < this.detectors.length; index += 1) {
      const detector = this.detectors[index]!;
      detector.listen(audio.left, audio.right, from, length, rate, (sample) => {
        if (!this.playing) return;
        const part = (sample - from + 1) / Math.max(1, fresh);
        this.onset(index, start + advance * part, this.clock + part * frameSeconds);
      });
      detector.settle(dt);
    }
    this.clock += frameSeconds;
    for (const state of this.states) state.age += dt;

    // Move the rows on: each row left is settled, each row entered is foreseen.
    this.rowPosition += advance;
    while (Math.floor(this.rowPosition) > this.current) {
      this.leave(this.current);
      this.current += 1;
      this.enter(this.current);
    }
    const into = this.rowPosition - this.current;
    if (this.playing && into >= EARLY && this.lookedEarly !== this.current) {
      this.lookedEarly = this.current;
      this.look(this.current, ["lead"]);
    }
    if (this.playing && into >= LATE && this.lookedLate !== this.current) {
      this.lookedLate = this.current;
      this.look(this.current, ["bass"]);
      this.lookChord(this.current);
    }

    // Notes whose time to be read has come are written.
    for (let index = this.heard.length - 1; index >= 0; index -= 1) {
      const heard = this.heard[index]!;
      heard.wait -= dt;
      const detector = this.detectors[heard.detector]!;
      heard.peak = Math.max(heard.peak, detector.level);
      if (heard.wait > 0) continue;
      // A bass note struck with a kick is read once the kick has died down.
      const kick = this.detectors[this.detectorOf.get("kick")!]!;
      if (heard.role === "bass" && kick.level > 0.45 && (heard.deferred ?? 0) < 3) {
        heard.wait = 0.03;
        heard.deferred = (heard.deferred ?? 0) + 1;
        continue;
      }
      this.heard.splice(index, 1);
      this.write(heard);
    }
  }

  /** A new track, or a jump within one: the song begins again where the track is. */
  private follow(track: RetroTrack): void {
    const jumped = this.lastTrackPosition >= 0 && track.position > 0 && Math.abs(track.position - this.lastTrackPosition) > 4;
    if (track.title !== this.title || jumped) {
      this.title = track.title;
      this.restart(track.position);
    }
    if (track.position > 0) {
      this.lastTrackPosition = track.position;
      this.time = track.position;
    }
  }

  private restart(position: number): void {
    this.tempo.reset();
    for (const detector of this.detectors) detector.reset();
    this.stamps.fill(-1);
    this.heard.length = 0;
    for (let channel = 0; channel < this.channels; channel += 1) this.states[channel] = this.freshState();
    for (const role of Object.keys(this.pitches) as Role[]) {
      this.pitches[role] = Number.NaN;
      this.lastRow[role] = -1;
    }
    this.chord = this.candidate = -1;
    this.candidateLooks = 0;
    // Mid-track: the position and row the track has got to at the default tempo.
    const rows = Math.max(0, Math.floor((position * this.tempo.bpm) / 15));
    this.firstPosition = Math.min(this.spec.positions - 1, Math.floor(rows / ROWS));
    this.current = rows % ROWS;
    this.rowPosition = this.current;
    this.lookedEarly = this.lookedLate = -1;
    this.nudge = 0;
    this.writtenTempo = 0;
    this.wantSpeed = position < 1;
    this.time = Math.max(0, position);
    this.lastTrackPosition = -1;
    this.enter(this.current);
  }

  /** The slot of an absolute row in the ring, emptied when it last held another row. */
  private slot(absolute: number): number {
    const index = absolute & (RING - 1);
    if (this.stamps[index] !== absolute) {
      this.stamps[index] = absolute;
      const base = index * this.channels;
      this.notes.fill(NOTE_NONE, base, base + this.channels);
      this.instruments.fill(0, base, base + this.channels);
      this.volumes.fill(-1, base, base + this.channels);
      this.effects.fill(0, base, base + this.channels);
      this.params.fill(0, base, base + this.channels);
      this.written.fill(0, base, base + this.channels);
    }
    return index * this.channels;
  }

  private known(absolute: number): boolean {
    return absolute >= 0 && this.stamps[absolute & (RING - 1)] === absolute;
  }

  private put(absolute: number, channel: number, note: number, instrument: number, volume: number, effect: Effect, param: number): void {
    this.changes += 1;
    const at = this.slot(absolute) + channel;
    this.notes[at] = note;
    this.instruments[at] = instrument;
    this.volumes[at] = volume;
    this.effects[at] = EFFECTS.indexOf(effect);
    this.params[at] = param;
    this.written[at] = 1;
  }

  /** A row comes up: it and the rest of its pattern show what came a period earlier. */
  private enter(row: number): void {
    this.changes += 1;
    if (this.before.length !== this.spectrum.length) this.before = new Float32Array(this.spectrum.length);
    for (let bin = 0; bin < this.before.length; bin += 1) this.before[bin] = this.spectrum[bin]!;
    const end = row - (row & (ROWS - 1)) + ROWS - 1;
    for (let channel = 0; channel < this.channels; channel += 1) {
      const period = this.states[channel]!.period;
      for (let ahead = row; ahead <= end; ahead += 1) {
        const at = this.slot(ahead) + channel;
        if (this.written[at]) continue;
        const from = ahead - period;
        const source = (from & (RING - 1)) * this.channels + channel;
        const known = this.known(from);
        this.notes[at] = known ? this.notes[source]! : NOTE_NONE;
        this.instruments[at] = known ? this.instruments[source]! : 0;
        this.volumes[at] = known ? this.volumes[source]! : -1;
        this.effects[at] = known ? this.effects[source]! : 0;
        this.params[at] = known ? this.params[source]! : 0;
      }
    }
    // The echo of a lead three rows back sounds now.
    const lead = this.detectorOf.get("lead");
    if (lead === undefined) return;
    for (let channel = 0; channel < this.channels; channel += 1) {
      if (!this.spec.channels[channel]!.parts.includes("echo")) continue;
      const at = this.slot(row) + channel;
      if (!this.written[at] || this.notes[at] === NOTE_NONE || this.notes[at] === NOTE_OFF) continue;
      const state = this.states[channel]!;
      state.source = lead;
      state.part = "echo";
      state.sounding = true;
      state.note = this.notes[at]!;
      state.instrument = this.instruments[at]!;
      state.volume = Math.max(0, this.volumes[at]!);
      state.age = 0;
      state.hits += 1;
      state.hitVolume = state.volume / 64;
    }
  }

  /** A row is left: what was not heard in it goes, held notes leave their effects. */
  private leave(row: number): void {
    this.changes += 1;
    const base = this.slot(row);
    for (let channel = 0; channel < this.channels; channel += 1) {
      const at = base + channel;
      if (this.written[at]) continue;
      this.notes[at] = NOTE_NONE;
      this.instruments[at] = 0;
      this.volumes[at] = -1;
      this.effects[at] = 0;
      this.params[at] = 0;
      this.sustain(at, this.states[channel]!);
      this.written[at] = 1;
    }
    // Speed 6 on the song's first row; a new tempo where the tempo has moved.
    if (this.wantSpeed) {
      this.wantSpeed = false;
      this.command(row, "speed", 6);
    }
    const bpm = this.bpm;
    if (this.writtenTempo === 0) {
      this.writtenTempo = bpm;
    } else if (Math.abs(bpm - this.writtenTempo) >= 3 && (row & 3) === 0) {
      this.writtenTempo = bpm;
      this.command(row, "tempo", Math.max(32, Math.min(255, bpm)));
    }
    // Every bar, each channel picks the period its last bars repeat best at.
    if ((row & (BAR - 1)) === BAR - 1) for (let channel = 0; channel < this.channels; channel += 1) this.choosePeriod(row, channel);
  }

  /** A command for the whole song, in the last channel whose effect column is free on the row. */
  private command(row: number, effect: Effect, param: number): void {
    const base = this.slot(row);
    for (let channel = this.channels - 1; channel >= 0; channel -= 1) {
      if (this.effects[base + channel] !== 0) continue;
      this.effects[base + channel] = EFFECTS.indexOf(effect);
      this.params[base + channel] = param;
      return;
    }
  }

  /** What a held note leaves on a row without a new one: a chord's arpeggio, a lead's fading. */
  private sustain(at: number, state: ChannelState): void {
    if (!state.sounding || state.source < 0 || state.part === null || state.part === "echo") return;
    const level = this.detectors[state.source]!.level;
    if (level < 0.18 || state.age > 3) {
      // The note has ended: a note off where the program has one, for a part that holds notes.
      state.sounding = false;
      if (this.spec.noteOff && (state.part === "lead" || state.part === "chord")) this.notes[at] = NOTE_OFF;
      return;
    }
    if (state.part === "chord" && state.arpeggio) {
      this.effects[at] = EFFECTS.indexOf("arpeggio");
      this.params[at] = state.arpeggio;
    } else if ((state.part === "lead" || state.part === "bass") && state.lastLevel > 0 && level < state.lastLevel * 0.8) {
      this.effects[at] = EFFECTS.indexOf("volumeSlide");
      this.params[at] = Math.min(0x0f, Math.max(1, Math.round((1 - level / state.lastLevel) * 10)));
    }
    state.lastLevel = level;
  }

  /** The period (half a bar, a bar, two) whose repeat the channel's last two bars match best. */
  private choosePeriod(row: number, channel: number): void {
    let best = this.states[channel]!.period;
    let bestScore = -1;
    for (const period of [BAR, BAR * 2, BAR / 2]) {
      let score = 0;
      let counted = 0;
      for (let back = 0; back < BAR * 2; back += 1) {
        const a = row - back;
        const b = a - period;
        if (!this.known(a) || !this.known(b)) continue;
        const noteA = this.notes[(a & (RING - 1)) * this.channels + channel]!;
        const noteB = this.notes[(b & (RING - 1)) * this.channels + channel]!;
        counted += 1;
        if ((noteA === NOTE_NONE) === (noteB === NOTE_NONE) && (noteA === NOTE_NONE || noteA === noteB)) score += 1;
      }
      if (!counted) continue;
      // A period other than a bar has to do clearly better to be taken.
      const value = score / counted - (period === BAR ? 0 : 0.05);
      if (value > bestScore) {
        bestScore = value;
        best = period;
      }
    }
    this.states[channel]!.period = best;
  }

  /** A detector heard a note start at row position `at`, `time` seconds into the music. */
  private onset(index: number, at: number, time: number): void {
    const detector = this.detectors[index]!;
    const role = detector.role;
    if (role === "kick") this.beat(at, time);
    const heard: Heard = { role, detector: index, at, peak: detector.level, balance: detector.balance, wait: detector.spec.read, channel: -1 };
    this.heard.push(heard);
    this.place(heard);
  }

  /** The row a waiting note goes to. */
  private rowOf(heard: Heard): number {
    return Math.max(this.current - 1, Math.round(heard.at));
  }

  /**
   * A waiting note into a channel; a waiting note of a part that comes after it there moves on
   * to its next channel in turn, or goes.
   */
  private place(heard: Heard, depth = 0): void {
    const row = this.rowOf(heard);
    const channel = this.route(heard.role, heard.balance, row, heard);
    if (channel < 0) {
      this.heard.splice(this.heard.indexOf(heard), 1);
      return;
    }
    const bumped = this.waiting(channel, row, heard);
    heard.channel = channel;
    if (bumped) {
      bumped.channel = -1;
      if (depth < 3) this.place(bumped, depth + 1);
      else this.heard.splice(this.heard.indexOf(bumped), 1);
    }
  }

  /** The note waiting to be written into the channel on that row, if one is (but `except`). */
  private waiting(channel: number, row: number, except?: Heard): Heard | undefined {
    return this.heard.find((heard) => heard !== except && heard.channel === channel && this.rowOf(heard) === row);
  }

  /** A kick: the tempo learns from it, and the clock leans towards it falling on a beat row. */
  private beat(at: number, time: number): void {
    this.tempo.beat(time);
    const error = at - Math.round(at / 4) * 4;
    if (Math.abs(error) < 1.4) this.nudge = -error * 0.5;
  }

  /** Is the channel's cell on that row taken by a written note? */
  private taken(channel: number, row: number): boolean {
    if (!this.known(row)) return false;
    const at = (row & (RING - 1)) * this.channels + channel;
    return this.written[at] === 1 && this.notes[at] !== NOTE_NONE;
  }

  /**
   * The channel a part's note goes to: the first that plays the part and is free on the row
   * (or held only by a waiting note of a part that comes after it there), its side first.
   */
  private route(role: Role, balance: number, at: number, self?: Heard): number {
    const row = Math.max(this.current - 1, at);
    let best = -1;
    let bestScore = -Infinity;
    for (let channel = 0; channel < this.channels; channel += 1) {
      const spec = this.spec.channels[channel]!;
      const rank = spec.parts.indexOf(role);
      if (rank < 0 || this.taken(channel, row)) continue;
      const waiting = this.waiting(channel, row, self);
      if (waiting && spec.parts.indexOf(waiting.role) <= rank) continue;
      const score = (spec.side ? spec.side * balance : 0) - channel * 0.001;
      if (score > bestScore) {
        bestScore = score;
        best = channel;
      }
    }
    return best;
  }

  /** A pitched part's note, moved by octaves into the two above its floor (a chord's: one). */
  private fit(part: "bass" | "lead" | "chord", pitch: number): number {
    const spec = this.spec;
    const floor = spec.floors[part];
    let note = Math.round(pitch);
    while (note < floor) note += 12;
    while (note >= floor + (part === "chord" ? 12 : 24)) note -= 12;
    while (note > spec.high) note -= 12;
    while (note < spec.low) note += 12;
    return note;
  }

  /** Into a row: a pitched part whose pitch has moved without a new attack starts a note here. */
  private look(row: number, roles: readonly ("bass" | "lead")[]): void {
    for (const role of roles) {
      const index = this.detectorOf.get(role);
      if (index === undefined) continue;
      const detector = this.detectors[index]!;
      if (detector.level < 0.25) continue;
      // A kick's sweep through the bass band is no bass note.
      const kick = this.detectors[this.detectorOf.get("kick")!]!;
      if (role === "bass" && kick.level > 0.35) continue;
      const pitch = detector.pitch();
      if (!Number.isFinite(pitch)) continue;
      const previous = this.pitches[role];
      this.pitches[role] = pitch;
      if (this.lastRow[role] === row || this.heard.some((heard) => heard.role === role)) continue;
      if (Number.isFinite(previous) && Math.abs(pitch - previous) < 0.7) continue;
      const channel = this.route(role, detector.balance, row);
      if (channel >= 0) this.write({ role, detector: index, at: row, peak: detector.level, balance: detector.balance, wait: 0, channel, pitch });
    }
  }

  /** Halfway through a row: a pad whose chord has changed is written anew. */
  private lookChord(row: number): void {
    const index = this.detectorOf.get("chord");
    if (index === undefined) return;
    const detector = this.detectors[index]!;
    const found = detector.level > 0.2 ? chordOf(this.spectrum, this.binHz) : null;
    const name = found ? found.root + (found.minor ? 12 : 0) : -1;
    this.candidateLooks = name === this.candidate ? this.candidateLooks + 1 : 1;
    this.candidate = name;
    if (name < 0 || this.candidateLooks < 2 || this.lastRow.chord === row) return;
    // A new chord once it has held for two rows; the same one again at a bar's start.
    const again = (row & (BAR - 1)) === 0 && row - this.lastRow.chord >= BAR;
    if (name === this.chord && !again) return;
    if (this.route("chord", 0, row) < 0) return;
    this.chord = name;
    const voices = this.spec.chordVoices ? [0, found!.minor ? 3 : 4, 7] : [0];
    for (const step of voices) {
      // Each voice in the next chord channel free on the row.
      const channel = this.route("chord", 0, row);
      if (channel < 0) break;
      this.states[channel]!.arpeggio = this.spec.chordVoices ? 0 : found!.minor ? 0x37 : 0x47;
      this.write({ role: "chord", detector: index, at: row, peak: detector.level, balance: 0, wait: 0, channel, pitch: found!.root + 48 + step });
    }
  }

  /** A note heard and read: into its row, as the program writes it. */
  private write(heard: Heard): void {
    const row = Math.max(this.current - 1, Math.round(heard.at));
    if (row > this.current + 1) return;
    const detector = this.detectors[heard.detector]!;
    const channel = heard.channel;
    const state = this.states[channel]!;
    const spec = this.spec;
    const role = heard.role;
    if (heard.peak < detector.spec.softest) return;
    const volume = Math.max(8, Math.min(64, Math.round(64 * Math.pow(Math.min(1, heard.peak), 0.7))));
    let note: number;
    let instrument = spec.instruments[role];
    let effect: Effect = "none";
    let param = 0;
    if (role === "kick" || role === "snare" || role === "hats") {
      note = spec.drums[role];
      // A hi-hat still ringing when it is read is the open one.
      if (role === "hats" && detector.level > heard.peak * 0.6) instrument += 1;
    } else {
      let pitch = heard.pitch ?? detector.pitch();
      if (!Number.isFinite(pitch) && role === "lead") pitch = peakNote(this.spectrum, this.binHz, 200, 2000, this.before);
      if (!Number.isFinite(pitch)) {
        // No pitch to read: the part's last note again, if it has one.
        if (state.part !== role || state.note === NOTE_NONE || state.note === NOTE_OFF) return;
        note = state.note;
      } else {
        note = this.fit(role, pitch);
        this.pitches[role] = pitch;
      }
      // A chord is its root and an arpeggio; now and then a lead note picks up a vibrato, or
      // glides in from the last one.
      const dice = hash(row, note, spec.seed ?? 0);
      if (role === "chord") {
        effect = state.arpeggio ? "arpeggio" : "none";
        param = state.arpeggio;
      } else if (role === "lead" && (dice & 15) === 0) {
        effect = "vibrato";
        param = 0x40 + 2 + ((dice >>> 4) & 3);
      } else if (role === "lead" && (dice & 15) === 1 && state.note !== NOTE_NONE && Math.abs(state.note - note) <= 7) {
        effect = "tonePorta";
        param = 0x10 + (((dice >>> 4) & 3) << 4);
      }
    }
    this.lastRow[role] = row;
    // A part plays one note at a time (a chord's voices aside): where it sounded in another
    // channel, it has moved on.
    if (role !== "chord") {
      for (const other of this.states) if (other !== state && other.source === heard.detector && other.part === role) other.sounding = false;
    }
    // The channel takes the part's band: its meter leaps, its scope shows it.
    state.sounding = true;
    state.source = heard.detector;
    state.part = role;
    state.note = note;
    state.instrument = instrument;
    state.volume = volume;
    state.age = 0;
    state.hits += 1;
    state.hitVolume = volume / 64;
    state.lastLevel = detector.level;
    this.put(row, channel, note, instrument, volume, effect, param);
    // The lead is echoed three rows later, quieter, where a channel plays its echo.
    if (role !== "lead") return;
    for (let echo = 0; echo < this.channels; echo += 1) {
      if (!spec.channels[echo]!.parts.includes("echo") || this.taken(echo, row + 3)) continue;
      this.put(row + 3, echo, note, spec.instruments.echo, Math.max(8, volume >> 1), "none", 0);
    }
  }
}
