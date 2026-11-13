/**
 * The song positions of trackers that build a song from patterns of one voice each (Future
 * Composer, SidMon II): every step of the song names, for each voice, a pattern, a note
 * transpose and an instrument transpose. Patterns come back, moved to the chord of the moment,
 * so a voice's rows are numbered as patterns by their shape: where its notes fall (a beat or so
 * at a time: what was heard is never quite on the row it was played on) and with which of its
 * instruments; the note it plays most says how far the pattern is transposed. Rows that share
 * most of their shape with a pattern heard before are taken for it.
 * Without imports, so the tests run it as it is (trackers-amiga2.test.ts); futurecomposer.ts and
 * sidmon.ts feed it song.ts's cells.
 */

/** One voice at one step: its pattern (0 is the empty one), note transpose and instrument transpose. */
export interface StepEntry {
  pattern: number;
  transpose: number;
  sound: number;
}

export const EMPTY_ENTRY: StepEntry = { pattern: 0, transpose: 0, sound: 0 };

/** A voice's rows at a step: notes (any negative is none) and instruments, row by row. */
export interface StepRows {
  notes: ArrayLike<number>;
  instruments: ArrayLike<number>;
}

/** A shape heard before: its notes as stretch of rows and instrument offset, its base note, the voice that played it. */
interface Shape {
  tokens: Set<string>;
  base: number;
  pattern: number;
  voice: number;
}

/** How alike two shapes must be (shared notes over all their notes) to be one pattern. */
export const ALIKE = 0.6;

/** The share of notes two shapes have in common: 1 the same, 0 nothing alike. */
export function likeness(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * A voice's rows reduced to their shape: the base note (the one it plays most, the lowest of
 * those), its lowest instrument, and its notes as the stretch of `grain` rows each falls in and
 * its instrument's offset from the lowest. Null when the rows play nothing.
 */
export function shapeOf(rows: StepRows, grain = 1): { base: number; sound: number; tokens: Set<string> } | null {
  const { notes, instruments } = rows;
  const counts = new Map<number, number>();
  let sound = 0;
  for (let row = 0; row < notes.length; row += 1) {
    const note = notes[row]!;
    if (note < 0) continue;
    counts.set(note, (counts.get(note) ?? 0) + 1);
    const instrument = instruments[row] ?? 0;
    if (instrument > 0 && (sound === 0 || instrument < sound)) sound = instrument;
  }
  if (!counts.size) return null;
  let base = -1;
  let most = 0;
  for (const [note, count] of counts) {
    if (count > most || (count === most && note < base)) {
      base = note;
      most = count;
    }
  }
  const tokens = new Set<string>();
  for (let row = 0; row < notes.length; row += 1) {
    const note = notes[row]!;
    if (note >= 0) tokens.add(`${Math.floor(row / grain)}:${Math.max(0, (instruments[row] ?? 0) - sound)}`);
  }
  return { base, sound, tokens };
}

export class StepSequence {
  readonly voices: number;
  /** The shapes heard, the newest last, and the next pattern number free. */
  private readonly shapes: Shape[] = [];
  private next = 1;
  private readonly limit: number;
  /** Rows a note may move and still be heard on the same beat of a pattern. */
  readonly grain: number;
  /** Steps played to their end, as they were heard. */
  private readonly played = new Map<number, StepEntry[]>();

  constructor(voices: number, grain = 1, limit = 255) {
    this.voices = voices;
    this.grain = Math.max(1, grain);
    this.limit = limit;
  }

  /**
   * The voices' rows at one step as its entries. A pattern is the number of the shape the same
   * voice played before that the rows are most alike (at least ALIKE, and within an octave of
   * its base), transposed by how far their base lies from its; the step's new shapes take the
   * next free numbers in turn, kept only when `keep` (a step played to its end), so the rows of
   * a step still being heard use none up. The instrument transpose is the lowest instrument the
   * rows play.
   */
  entries(voices: readonly StepRows[], keep: boolean): StepEntry[] {
    let next = this.next;
    return voices.map((rows, voice) => {
      const shape = shapeOf(rows, this.grain);
      if (!shape) return { pattern: 0, transpose: 0, sound: 0 };
      let best: Shape | null = null;
      let bestLikeness = ALIKE - 1e-9;
      // The newest shapes first: a song moves on, and its last patterns are the likeliest.
      for (let index = this.shapes.length - 1, looked = 0; index >= 0 && looked < 96; index -= 1) {
        const known = this.shapes[index]!;
        if (known.voice !== voice || Math.abs(shape.base - known.base) > 12) continue;
        looked += 1;
        const alike = likeness(shape.tokens, known.tokens);
        if (alike > bestLikeness) {
          best = known;
          bestLikeness = alike;
          if (alike === 1) break;
        }
      }
      if (best) return { pattern: best.pattern, transpose: shape.base - best.base, sound: shape.sound };
      const made: Shape = { tokens: shape.tokens, base: shape.base, pattern: next, voice };
      next = next >= this.limit ? 1 : next + 1;
      if (keep) {
        this.shapes.push(made);
        if (this.shapes.length > 512) this.shapes.shift();
        this.next = next;
      }
      return { pattern: made.pattern, transpose: 0, sound: shape.sound };
    });
  }

  /** A step played to its end. */
  keep(step: number, entries: readonly StepEntry[]): void {
    this.played.set(step, entries.map((entry) => ({ ...entry })));
  }

  /**
   * What a step shows: as played, the step being heard as it stands (`live`), and any other as
   * the nearest heard step an even number of steps away shows it (a song that repeats itself
   * every two steps), else empty.
   */
  at(step: number, current: number, live: readonly StepEntry[]): readonly StepEntry[] {
    if (step === current) return live;
    const played = this.played.get(step);
    if (played) return played;
    for (let distance = 2; distance <= 64; distance += 2) {
      for (const candidate of step < current ? [step + distance, step - distance] : [step - distance, step + distance]) {
        if (candidate === current) return live;
        const found = this.played.get(candidate);
        if (found) return found;
      }
    }
    return new Array<StepEntry>(this.voices).fill(EMPTY_ENTRY);
  }

  /** Everything forgotten: a new song. */
  clear(): void {
    this.shapes.length = 0;
    this.played.clear();
    this.next = 1;
  }
}

/** A signed byte as two hex digits, as the sequence editors show a transpose ("f9" is −7). */
export function signedHex(value: number, upper = false): string {
  const text = ((Math.round(value) % 256 + 256) % 256).toString(16).padStart(2, "0");
  return upper ? text.toUpperCase() : text;
}
