import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { C64_HEIGHT, C64_WIDTH, PALETTE, SCREEN_LEFT, TextScreen } from "./c64";
import { jchColumns, type JchColumns } from "./eightbit";
import { clock, hex, noteText } from "./notation";
import { Surface, Target } from "./raster";
import { emptyCell, hash, NOTE_OFF, ROWS, Song, type Cell, type SongSpec } from "./song";

/**
 * JCH Editor 3.04 (Jens-Christian Huus, Commodore 64, 1991) playing along: its editor in green
 * lines on black — the status line, the three voices' sequences side by side under one column
 * of row numbers, each voice's track entry (its transpose and sequence, in grey) on the row its
 * sequence begins, an instrument column ("I02", "---") and a note column (a note, "+++" while it
 * is held, "---" for a rest), and under them the instrument table, a second table and the status
 * column. In follow-play the sequences scroll up under the cursor on the row playing, and the
 * player's time each frame shows as a grey raster bar in the border: taller on a frame that
 * reads new notes.
 *
 * The song is song.ts's on three voices: the bass, the lead (or a chord), the drums (or a chord).
 * A note is held until the next one with a rest just before it (the gate-off a SID player wants
 * before a new note); a chord is its root played by the major or the minor arpeggio instrument.
 */

const { black, green, lightGrey } = PALETTE;

const VOICES = 3;
const SPEC: SongSpec = {
  channels: [{ parts: ["bass"] }, { parts: ["lead", "chord"] }, { parts: ["kick", "snare", "hats", "chord"] }],
  low: 0,
  high: 95,
  drums: { kick: 36, snare: 64, hats: 81 },
  floors: { bass: 12, lead: 48, chord: 48 },
  instruments: { kick: 5, snare: 6, hats: 7, bass: 1, lead: 2, chord: 3, echo: 2 },
  positions: 256,
  noteOff: true,
  seed: 304
};
/** The minor chord's instrument: the major one's arpeggio a semitone lower in its third. */
const MINOR_CHORD = 4;

/** The sequences' rows on screen, how many, the one playing; a bar of rows. */
const VIEW_TOP = 3;
const VIEW_ROWS = 16;
const PLAY_LINE = 3;
const BAR = 16;
/** The first column of each voice: its track entry, then the instrument and the note. */
const VOICE_LEFT = [4, 16, 28];
/** The raster bars: the player's interrupt and the editor's, from these lines down. */
const PLAYER_LINE = 43;
const EDITOR_LINE = 136;

/** The editor's tables as they stand (instruments 00–03, the second table, the status column). */
const INSTRUMENT_TABLE = ["00:09 A8 11 40 00 00 02 00", "01:0A 6B 41 30 01 00 04 00", "02:00 F8 81 00 00 00 00 10", "03:0C 59 41 20 02 00 06 00"];
const SECOND_TABLE = ["00:21 00", "01:41 01", "02:80 00", "03:00 7F"];
const STATUS = ["O4", "0+", "S2"];

function drawChrome(): Surface {
  const s = new Surface(C64_WIDTH, C64_HEIGHT);
  const t = new TextScreen(s, black);
  t.clear(black);
  // The frame and its rules.
  t.horizontal(0, 0, 39, green);
  t.horizontal(2, 0, 39, green);
  t.horizontal(19, 0, 39, green);
  t.horizontal(24, 0, 39, green);
  t.vertical(0, 0, 24, green);
  t.vertical(39, 0, 24, green);
  t.vertical(3, 0, 19, green);
  t.vertical(9, 0, 2, green);
  t.vertical(15, 0, 19, green);
  t.vertical(27, 2, 24, green);
  t.vertical(37, 0, 2, green);
  t.vertical(36, 19, 24, green);
  t.put(1, 1, "ST", green);
  t.put(4, 1, "00:00", green);
  t.put(38, 1, "2", green);
  INSTRUMENT_TABLE.forEach((line, index) => t.put(1, 20 + index, line, green));
  SECOND_TABLE.forEach((line, index) => t.put(28, 20 + index, line, green));
  STATUS.forEach((line, index) => t.put(37, 20 + index, line, green));
  t.put(37, 23, "SP", lightGrey);
  return s;
}

/** A command in the instrument column: the slides of the super table. */
function command(cell: Cell): string | null {
  switch (cell.effect) {
    case "tonePorta": return `S${hex(1 + ((cell.param >> 4) & 3), 2)}`;
    case "slideUp": return "S10";
    case "slideDown": return "S11";
    default: return null;
  }
}

export function createJch(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  // A bar before the rows on screen (for what is held when they begin), and one after.
  const cells: Cell[] = Array.from({ length: BAR + VIEW_ROWS + 1 }, () => emptyCell());
  const columns: JchColumns = { instruments: new Array<string>(VIEW_ROWS).fill(""), notes: new Array<string>(VIEW_ROWS).fill("") };
  const work = emptyCell();
  let screen: Surface | null = null;
  let text: TextScreen | null = null;
  /** What the first voice's instrument column shows on the row playing (the cursor's cell). */
  let cursor = "-";
  /** The C64's frame (50 a second) the raster bars were worked out for, the row it read, their lines. */
  let palFrame = -1;
  let lastRow = -1;
  let playerLines = 0;
  let editorLines = 0;

  const rowNow = (): number => song.position * ROWS + song.row;

  /** A voice's cell on an absolute row; past the pattern playing, the bar before it again. */
  const cellAt = (voice: number, absolute: number, out: Cell): Cell => {
    let row = absolute - song.position * ROWS;
    while (row >= ROWS) row -= BAR;
    return song.cell(voice, row, out);
  };

  const instrumentOf = (cell: Cell): number => (cell.instrument === SPEC.instruments.chord && cell.effect === "arpeggio" && cell.param === 0x37 ? MINOR_CHORD : cell.instrument);

  /** One voice's instrument and note columns for the rows on screen. */
  const describe = (voice: number, first: number): void => {
    const start = first - BAR;
    for (let index = 0; index < cells.length; index += 1) cellAt(voice, start + index, cells[index]!);
    jchColumns(cells, start, BAR, ROWS, instrumentOf, noteText, command, columns);
  };

  const drawView = (t: TextScreen): void => {
    const now = rowNow();
    const first = now - PLAY_LINE;
    for (let line = 0; line < VIEW_ROWS; line += 1) {
      const absolute = first + line;
      if (absolute < 0) continue;
      t.put(1, VIEW_TOP + line, hex(absolute % ROWS, 2), green);
    }
    for (let voice = 0; voice < VOICES; voice += 1) {
      describe(voice, first);
      if (voice === 0) cursor = columns.instruments[PLAY_LINE]!.slice(0, 1);
      const left = VOICE_LEFT[voice]!;
      for (let line = 0; line < VIEW_ROWS; line += 1) {
        const absolute = first + line;
        if (absolute < 0) continue;
        const row = VIEW_TOP + line;
        if (absolute % ROWS === 0) {
          // The track entry: no transpose ($80) and the sequence the voice plays from here.
          const sequence = (song.patternAt(Math.floor(absolute / ROWS)) * VOICES + voice + 1) & 0xff;
          t.put(left, row, `80${hex(sequence, 2)}`, lightGrey);
        }
        t.put(left + 4, row, columns.instruments[line]!, green);
        t.put(left + 8, row, columns.notes[line]!, green);
      }
    }
  };

  /** The raster bars in the side borders: the colour switched on at a line, off partway through the last. */
  const rasterBar = (s: Surface, top: number, lines: number): void => {
    s.fill(0, top, SCREEN_LEFT, lines, lightGrey);
    s.fill(C64_WIDTH - SCREEN_LEFT, top, SCREEN_LEFT, lines - 1, lightGrey);
  };

  /**
   * How long the player and the editor take in a PAL frame, in raster lines: the player longer
   * on a frame that reads a row — more for each note it starts, more again where a sequence
   * begins and the track is read — and a line more for each voice still sounding otherwise.
   */
  const measure = (frame: number): void => {
    const row = rowNow();
    const tick = row !== lastRow;
    lastRow = row;
    let lines = 11 + (hash(frame, 7) & 1);
    if (tick) {
      lines += 3;
      for (let voice = 0; voice < VOICES; voice += 1) {
        cellAt(voice, row, work);
        if (work.note >= 0 && work.note < 120) lines += 3;
        else if (work.note === NOTE_OFF) lines += 1;
      }
      if (row % ROWS === 0) lines += 4;
    } else {
      for (let voice = 0; voice < VOICES; voice += 1) if (song.level(voice) > 0.2) lines += 1;
    }
    playerLines = lines;
    editorLines = 12 + (tick ? 1 : 0) + (hash(frame, 11) & 1);
  };

  return {
    width: C64_WIDTH,
    height: C64_HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      song.update(frame.audio, frame.track, frame.dt);
      const pixels = target.open(image);
      if (!screen || screen.pixels !== pixels) {
        screen = new Surface(C64_WIDTH, C64_HEIGHT, pixels);
        text = new TextScreen(screen, black);
      }
      const t = text!;
      pixels.set(chrome.pixels);
      t.put(10, 1, clock(song.time), green);
      drawView(t);
      // The cursor on the row playing, blinking as the C64's does.
      if (Math.floor(frame.time / 0.32) % 2 === 0) t.put(VOICE_LEFT[0]! + 4, VIEW_TOP + PLAY_LINE, cursor, green, true);
      // The bars change with the C64's frames, whatever the display's rate.
      const pal = Math.floor(frame.time * 50);
      if (pal !== palFrame) {
        palFrame = pal;
        measure(pal);
      }
      if (song.playing) {
        rasterBar(screen, PLAYER_LINE, playerLines);
        rasterBar(screen, EDITOR_LINE, editorLines);
      }
      target.close(image);
    }
  };
}
