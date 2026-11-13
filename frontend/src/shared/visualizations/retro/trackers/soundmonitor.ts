import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { C64_HEIGHT, C64_WIDTH, c64Font, cellX, cellY, hexLower, PALETTE, TextScreen } from "./c64";
import { likeness, type BarShape } from "./eightbit";
import { printable, Surface, Target } from "./raster";
import { emptyCell, ROWS, Song, type SongSpec } from "./song";

/**
 * SoundMonitor 1.1 (Chris Hülsbeck, Commodore 64, 1986) playing along: its TRACK/STEP TABLE, the
 * screen the program shows while a song plays — the song as a list of steps, each a bar for
 * each of the SID's three voices (TRK1–3, the address of the bar in memory) with its transpose
 * (TR) and sound transpose (ST), and the bar of arpeggios and settings (AR/S); under it the
 * player's settings in black, the steps in light blue and yellow, the keys in green, the file
 * name and the sound options; the sprite cursor a white square.
 *
 * The song is song.ts's on three voices: the bass, the lead (or a chord), and the drums (or a
 * chord). A step is a bar of the module, and its bars are kept as SoundMonitor's composers kept
 * them: a bar with mostly the rhythm of an earlier one on the same instruments is that bar again,
 * moved up or down by its transpose; a new one is stored at the next $40 bytes from $B000, and a
 * bar without notes is $BE00, the empty bar (eightbit.ts compares them). The table follows the
 * song: the cursor goes down with the step playing, then stays while the steps scroll under it.
 */

const { black, white, cyan, green, yellow, darkGrey, grey, lightBlue } = PALETTE;

const VOICES = 3;
const SPEC: SongSpec = {
  channels: [{ parts: ["bass"] }, { parts: ["lead", "chord"] }, { parts: ["kick", "snare", "hats", "chord"] }],
  low: 0,
  high: 95,
  drums: { kick: 24, snare: 40, hats: 66 },
  floors: { bass: 12, lead: 36, chord: 36 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 256,
  noteOff: true,
  seed: 86
};

/** Rows of the module a step covers: a bar of 4/4, SoundMonitor's 32 notes. */
const BAR = 16;
const BARS_A_PATTERN = ROWS / BAR;
/** The table on screen: its first text row, its rows, the row the cursor stays on once it scrolls. */
const TABLE_TOP = 2;
const TABLE_ROWS = 9;
const CURSOR_LINE = 4;
/**
 * Memory as the program's listing (64'er 10/1986) lays it out: bars of $40 bytes from $B000 to
 * $BDFF, the empty bars at $BE00, the arpeggios (and the song's settings) at $BF00.
 */
const FIRST_BAR = 0xb000;
const LAST_BAR = 0xbdc0;
const EMPTY_BAR = 0xbe00;
const SETTINGS = 0xbf00;

/** One step of the table: each voice's bar and its transpose. */
interface Step {
  bars: number[];
  transposes: number[];
}

/** A step whose bars are all the empty one (what Initialize writes into every step). */
const EMPTY_STEP: Step = { bars: [EMPTY_BAR, EMPTY_BAR, EMPTY_BAR], transposes: [0, 0, 0] };

/** A bar kept in memory at its address. */
interface Stored {
  address: number;
  notes: BarShape;
}

/** How alike two bars must be to be the same bar written again (moved up or down, maybe). */
const SAME_BAR = 0.6;

/** The parts of the screen that stand. */
function drawChrome(): Surface {
  const s = new Surface(C64_WIDTH, C64_HEIGHT);
  const t = new TextScreen(s, darkGrey);
  t.clear(black);
  t.put(0, 0, "SOUNDMONITOR V1.1", cyan);
  t.put(19, 0, "TRACK/STEP TABLE", lightBlue);
  t.put(0, 1, "SP TRK1 TR ST TRK2 TR ST TRK3 TR ST AR/S", green);
  // The player's settings, a key's letter reversed.
  t.put(0, 11, "r", black, true);
  t.put(1, 11, "ecord track :    0", black);
  t.put(21, 11, "o", black, true);
  t.put(22, 11, "ctave", black);
  t.put(36, 11, ":C-0", black);
  t.put(0, 12, "p", black, true);
  t.put(1, 12, "lay:", black);
  t.put(7, 12, "voice :1 2 3", black);
  t.put(21, 12, "k", black, true);
  t.put(22, 12, "eytranspose", black);
  t.put(36, 12, ":↑↑↑", black);
  t.put(0, 13, "q", black, true);
  t.put(1, 13, "uantize", black);
  t.put(13, 13, ":    0", black);
  t.put(21, 13, "arpeggio", black);
  t.put(33, 13, "*", black, true);
  t.put(36, 13, ": 00", black);
  t.put(0, 14, "sound", black);
  t.put(7, 14, "£", black, true);
  t.put(8, 14, "/", black);
  t.put(9, 14, "clr", black, true);
  t.put(13, 14, ":  0/0", black);
  t.put(21, 14, "begin/stop", black);
  t.put(33, 14, "f7", black, true);
  // The rules: across under the settings, down between the halves, across on the right.
  t.horizontal(15, 0, 39, black, true, true);
  t.vertical(20, 15, 24, black, false, true);
  t.horizontal(19, 20, 39, black, false, true);
  // The steps.
  t.put(0, 16, "current step :", lightBlue);
  t.put(18, 16, "f1", lightBlue, true);
  t.put(0, 17, "first   step :", lightBlue);
  t.put(14, 17, "00", yellow);
  t.put(18, 17, "f3", lightBlue, true);
  t.put(0, 18, "last    step :", lightBlue);
  t.put(18, 18, "f5", lightBlue, true);
  t.put(0, 19, "copy    steps:", lightBlue);
  t.put(14, 19, "00", yellow);
  t.put(16, 19, "-", lightBlue);
  t.put(17, 19, "00", yellow);
  t.put(19, 19, "=", lightBlue, true);
  // Loading and saving.
  t.put(21, 17, "t", grey, true);
  t.put(22, 17, "yp : complete song", grey);
  t.put(21, 18, "L", grey, true);
  t.put(22, 18, "oad/", grey);
  t.put(26, 18, "S", grey, true);
  t.put(27, 18, "ave", grey);
  // The keys and the sound options.
  const keys: readonly (readonly [string, string])[] = [["@", "delete notes"], ["z", "edit sound"], ["ret", "edit notes/arp"], ["ins", "insert step"], ["del", "delete step"]];
  keys.forEach(([key, what], index) => {
    t.put(0, 20 + index, key, green, true);
    t.put(5, 20 + index, what, green);
  });
  t.put(21, 20, "sound options 0", lightBlue);
  const options: readonly (readonly [string, string])[] = [[".portamento", "off"], [".transpose", "on"], [".arpeggio", "off"], [".soundtranspose", "on"]];
  options.forEach(([option, state], index) => {
    t.put(21, 21 + index, option, lightBlue);
    t.put(37, 21 + index, state, lightBlue);
  });
  return s;
}

/** The track's name as a file name on the disk: lower case, sixteen characters, dots for the rest. */
function fileName(title: string): string {
  const name = printable(title.split(/\s[—–-]\s/)[0] ?? "", c64Font).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 16);
  return name.padEnd(16, ".");
}

export function createSoundMonitor(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  let screen: Surface | null = null;
  let text: TextScreen | null = null;

  /** The bars stored so far and where the next one goes. */
  const stored: Stored[] = [];
  let nextBar = FIRST_BAR;
  /** Steps played, as they were heard, by their number since the song began. */
  const played = new Map<number, Step>();
  /** The steps of the pattern playing as it stands, worked out again when the song moves. */
  const coming = new Map<number, Step>();
  let comingAt = -1;
  let lastStep = -1;
  let title: string | null = null;

  /** The absolute row the song is at: its position's first row and the row in it. */
  const rowNow = (): number => song.position * ROWS + song.row;

  /** A voice's bar from an absolute row on, or null when it has no notes. */
  const hear = (voice: number, start: number): BarShape | null => {
    const patternStart = song.position * ROWS;
    const notes: BarShape = new Map();
    for (let index = 0; index < BAR; index += 1) {
      song.cell(voice, start + index - patternStart, cell);
      if (cell.note >= 0 && cell.note < 120) notes.set(index * 32 + (cell.instrument & 31), cell.note);
    }
    return notes.size ? notes : null;
  };

  /**
   * Where a bar is and its transpose: the empty bar, a stored one it mostly sounds like (as it
   * is, or moved up or down), or else a new one at the next free place — stored there only for a
   * bar that has played.
   */
  const place = (bar: BarShape | null, keep: boolean): { address: number; transpose: number } => {
    if (!bar) return { address: EMPTY_BAR, transpose: 0 };
    let best: Stored | null = null;
    let bestScore = SAME_BAR;
    let transpose = 0;
    for (const known of stored) {
      const found = likeness(bar, known.notes);
      if (found.score < bestScore || (found.score === bestScore && best)) continue;
      best = known;
      bestScore = found.score;
      transpose = found.transpose & 0xff;
    }
    if (best) return { address: best.address, transpose };
    if (!keep) return { address: nextBar, transpose: 0 };
    const address = nextBar;
    // Memory runs out at $BDC0: the oldest bars are written over.
    const old = stored.findIndex((known) => known.address === address);
    if (old >= 0) stored.splice(old, 1);
    stored.push({ address, notes: bar });
    nextBar = nextBar >= LAST_BAR ? FIRST_BAR : nextBar + 0x40;
    return { address, transpose: 0 };
  };

  /** A step from the song's rows: kept (a bar that has played) or only looked at (one to come). */
  const stepAt = (step: number, keep: boolean): Step => {
    const result: Step = { bars: [], transposes: [] };
    for (let voice = 0; voice < VOICES; voice += 1) {
      const { address, transpose } = place(hear(voice, step * BAR), keep);
      result.bars.push(address);
      result.transposes.push(transpose);
    }
    return result;
  };

  /** Any step: as it played, as the pattern playing has it, or further on as four steps before. */
  const stepOf = (step: number, current: number): Step => {
    const kept = played.get(step);
    if (kept) return kept;
    if (step < current) return EMPTY_STEP;
    return coming.get(step) ?? stepOf(step - BARS_A_PATTERN, current);
  };

  /** The steps from the one playing to the pattern's end, when the song has moved. */
  const lookAhead = (current: number): void => {
    if (song.changes === comingAt) return;
    comingAt = song.changes;
    coming.clear();
    const end = Math.floor(rowNow() / ROWS) * BARS_A_PATTERN + BARS_A_PATTERN;
    for (let step = current; step < end; step += 1) coming.set(step, stepAt(step, false));
  };

  const restart = (): void => {
    stored.length = 0;
    played.clear();
    coming.clear();
    comingAt = -1;
    lastStep = -1;
    nextBar = FIRST_BAR;
  };

  /**
   * A step is written into the table for good once it has played, while the song still holds its
   * rows. Where the song jumps (the track was wound on or back), the steps heard before are no
   * longer this part's; the bars stored stay, so a bar heard again is still known.
   */
  const keepPlayed = (current: number): void => {
    if (current < lastStep || current > lastStep + 2) {
      played.clear();
      coming.clear();
      comingAt = -1;
    }
    lastStep = current;
    for (let step = current - BARS_A_PATTERN; step < current; step += 1) {
      if (step >= 0 && !played.has(step)) played.set(step, stepAt(step, true));
    }
    for (const step of played.keys()) if (step < current - 256) played.delete(step);
  };

  /** The table round the step playing; returns the line the cursor is on. */
  const drawTable = (t: TextScreen, current: number, last: number): number => {
    const line = Math.min(CURSOR_LINE, current);
    const first = current - line;
    lookAhead(current);
    for (let index = 0; index < TABLE_ROWS; index += 1) {
      const number = first + index;
      const row = TABLE_TOP + index;
      // Past the song's last step the steps hold what Initialize left in them: the empty bar.
      const step = number > last ? EMPTY_STEP : stepOf(number, current);
      t.put(0, row, hexLower(number & 0xff, 2), grey, true);
      for (let voice = 0; voice < VOICES; voice += 1) {
        t.put(3 + voice * 11, row, `${hexLower(step.bars[voice]!, 4)} ${hexLower(step.transposes[voice]!, 2)} 00`, grey, true);
      }
      t.put(36, row, hexLower(SETTINGS, 4), grey, true);
    }
    return line;
  };

  return {
    width: C64_WIDTH,
    height: C64_HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      if (frame.track.title !== title) {
        title = frame.track.title;
        restart();
      }
      song.update(frame.audio, frame.track, frame.dt);
      const pixels = target.open(image);
      if (!screen || screen.pixels !== pixels) {
        screen = new Surface(C64_WIDTH, C64_HEIGHT, pixels);
        text = new TextScreen(screen, darkGrey);
      }
      const t = text!;
      pixels.set(chrome.pixels);
      const current = Math.floor(rowNow() / BAR);
      keepPlayed(current);
      const last = Math.min(0xff, song.length(frame.track.duration) * BARS_A_PATTERN - 1);
      const line = drawTable(t, current, Math.max(last, current));
      t.put(5, 12, song.playing ? "*" : ".", black);
      t.put(14, 16, hexLower(current & 0xff, 2), yellow);
      t.put(14, 18, hexLower(Math.max(last, current) & 0xff, 2), yellow);
      t.put(21, 16, `"${fileName(frame.track.title)}"`, grey);
      // The sprite cursor: a white square round the first digit of the step's first bar.
      screen.bevel(cellX(3) - 1, cellY(TABLE_TOP + line) - 1, 10, 10, white, white, white);
      target.close(image);
    }
  };
}
