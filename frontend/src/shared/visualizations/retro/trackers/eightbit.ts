import type { Cell } from "./song";

/**
 * What the C64 editors (soundmonitor.ts, jch.ts) make of song.ts's cells, apart from drawing
 * them. Without runtime imports, so the tests run it as it is (trackers-8bit.test.ts).
 */

/**
 * A bar as SoundMonitor's step table compares bars: its notes by where they fall and what plays
 * them (the row times 32 plus the instrument), each with its pitch.
 */
export type BarShape = Map<number, number>;

/** A note a row early or late still counts, for this much. */
const NEAR = 0.75;

/**
 * How much of two bars is the same rhythm on the same instruments (0–1, of the busier bar), and
 * how far the first note they share is moved: a bar that sounds as a stored one moved up or down
 * is that bar with a transpose, as SoundMonitor's songs reused their bars.
 */
export function likeness(a: BarShape, b: BarShape): { score: number; transpose: number } {
  let shared = 0;
  let transpose: number | null = null;
  const used = new Set<number>();
  for (const [event, note] of a) {
    let matched = b.has(event) && !used.has(event) ? event : -1;
    let weight = 1;
    if (matched < 0) {
      for (const near of [event - 32, event + 32]) {
        if (a.has(near) || used.has(near) || !b.has(near)) continue;
        matched = near;
        weight = NEAR;
        break;
      }
    }
    if (matched < 0) continue;
    used.add(matched);
    shared += weight;
    transpose ??= note - b.get(matched)!;
  }
  return { score: shared / Math.max(1, a.size, b.size), transpose: transpose ?? 0 };
}

/** The columns of one JCH voice for the rows on screen. */
export interface JchColumns {
  instruments: string[];
  notes: string[];
}

/**
 * One JCH voice's instrument and note columns: a note with its instrument where it changes (and
 * at each sequence's first note), "+++" while a note is held, "---" for a rest, and the gate off
 * ("---") on the row before the next note, as a SID player wants it. A command (a slide) shows in
 * the instrument column of a row that names no instrument.
 *
 * `cells` are the voice's cells from absolute row `first` on: `lead` rows before those on screen
 * (to know what is held when they begin), `out`'s rows, and one row more.
 */
export function jchColumns(
  cells: readonly Cell[], first: number, lead: number, rowsPerSequence: number,
  instrumentOf: (cell: Cell) => number, spell: (note: number) => string, command: (cell: Cell) => string | null,
  out: JchColumns
): void {
  let sounding = false;
  let instrument = -1;
  const count = out.notes.length;
  for (let index = 0; index < lead + count; index += 1) {
    if ((first + index) % rowsPerSequence === 0) instrument = -1;
    const cell = cells[index]!;
    const next = cells[index + 1];
    let column = command(cell) ?? "---";
    let note: string;
    if (cell.note >= 0 && cell.note < 120) {
      const played = instrumentOf(cell);
      if (played !== instrument) column = `I${played.toString(16).toUpperCase().padStart(2, "0")}`;
      instrument = played;
      note = spell(cell.note);
      sounding = true;
    } else if (cell.note >= 120) {
      note = "---";
      sounding = false;
    } else {
      note = sounding ? "+++" : "---";
    }
    if (note === "+++" && next && next.note >= 0 && next.note < 120) note = "---";
    if (index >= lead) {
      out.instruments[index - lead] = column;
      out.notes[index - lead] = note;
    }
  }
}
