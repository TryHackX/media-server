import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { STK_BIG, STK_SMALL } from "./fonts-cpc";
import { hex, noteText } from "./notation";
import { printable, rgb, sheet, Surface, Target } from "./raster";
import { emptyCell, NOTE_NONE, NOTE_OFF, ROWS, Song, type Cell, type SongSpec } from "./song";

/**
 * Soundtracker DMA 2.0 (Zik / Futurs', Amstrad CPC Plus, 2021) playing a song: its one screen in
 * mode 1, four inks of the Plus's 4096 colours, the 336 × 192 picture its CRTC sets up framed by
 * the border as a monitor shows it — the menu with PLAY SONG chosen, the logo and the song's
 * fields, the channels' switches (ABC), the song list's length and positions, the four lists
 * (arpeggio and pitch sequences, samples, instruments) and the pattern under them: the "special"
 * column with its tempo, the three AY channels, the play row lit in the middle as it scrolls.
 *
 * The program has no level meters; playing, it shows what is here and nothing more.
 *
 * The module is song.ts's in the program's way of writing: the drums are samples, which the Plus
 * plays through its DMA, one at a time, so they share channel A as "Smp" notes; the bass plays
 * on B; the lead on C, and a chord there as a three-note arpeggio when the lead rests. A held note
 * ends with "Res". Everything is drawn from fonts-cpc.ts and these coordinates.
 */

const WIDTH = 384;
const HEIGHT = 272;
/** Where the screen sits in the frame a monitor shows (as an emulator frames it). */
const SCREEN_X = 21;
const SCREEN_Y = 36;

const BORDER = rgb(0x000000);
const PAPER = rgb(0x111111);
const BLUE = rgb(0x6666ee);
const LIGHT = rgb(0xaaddff);
const PURPLE = rgb(0x4433aa);
/** The logo's sprite inks. */
const SPRITE = {
  deep: rgb(0x3333dd),
  navy: rgb(0x4444dd),
  slate: rgb(0x5566ee),
  steel: rgb(0x6688ee),
  sky: rgb(0x7799ee),
  ice: rgb(0x99ccff),
  yellow: rgb(0xddcc33),
  orange: rgb(0xdd7766)
};

const big = sheet(STK_BIG.sheet, STK_BIG.cell, STK_BIG.height, STK_BIG.fixed);
const small = sheet(STK_SMALL.sheet, STK_SMALL.cell, STK_SMALL.height, STK_SMALL.fixed);

const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare", "hats"] }, { parts: ["bass"] }, { parts: ["lead", "chord"] }],
  low: 12,
  high: 95,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 24, lead: 48, chord: 48 },
  // Channel A plays samples (01 kick … 04 open hi-hat), B and C instruments.
  instruments: { kick: 1, snare: 2, hats: 3, bass: 2, lead: 4, chord: 6, echo: 4 },
  positions: 128,
  noteOff: true,
  seed: 2021
};

const MENU: readonly (readonly [string, number])[][] = [
  [["Discop", 4], ["PATN-Ed", 60], ["PLAY SONG", 124]],
  [["Infos", 8], ["SEQ-Ed", 64], ["PLAY PATN", 124]],
  [["COPY", 12], ["INS-Ed", 64], ["Others", 136]],
  [["CLEAR", 8], ["SMP-Ed", 64], ["-about-", 132]]
];

/** The lists: box, title, what each entry holds (null an unnamed one, "" one not in use), the one chosen. */
const LISTS: readonly { x: number; title: string; items: readonly (string | null)[]; first: number; chosen: number }[] = [
  { x: 65, title: "ArpS:", items: ["Res", "Minor", "Major", "Min7", "Octave", "Oct fast", "Fifths"], first: 0, chosen: 0 },
  { x: 133, title: "PitchS:", items: ["Res", "Vib", "Vib wide", null, "Slide up", "", ""], first: 0, chosen: 1 },
  { x: 201, title: "Sample:", items: ["Kick DMA", "Snare 2", "Hats cl", "Hats op", "", "", ""], first: 1, chosen: 1 },
  { x: 269, title: "Instr.:", items: ["SW bass", "SW SID bass", "SW HW buzz", "SW lead", "SW SID lead", "SW arp", "Noise hat"], first: 1, chosen: 2 }
];
/** The list whose title is lit: the one the arrows move in. */
const ACTIVE_LIST = 3;

/** The pattern: ten rows from y 112, the play row the fifth; the channels' columns. */
const PATTERN_TOP = 112;
const PLAY_LINE = 4;
const LINES = 10;
const CHANNEL_X = [64, 156, 248];
const ROW_LEFT = 4;
const SPECIAL_X = 32;

/** The notification area's frame, the corners of a rounded square. */
const CORNERS: readonly (readonly [number, number])[] = [
  [10, 37], [11, 37], [21, 37], [22, 37], [9, 38], [9, 39], [23, 38], [23, 39],
  [9, 48], [9, 49], [23, 48], [23, 49], [10, 50], [11, 50], [21, 50], [22, 50]
];

/**
 * The logo, drawn here after the program's: the group's name small and dark, a field of binary
 * digits, "DMA" in outline and "soundtracker" across it on a dark band, in the sprites' inks.
 */
const FUTURS = [
  "..##.....#.............",
  ".#......###............",
  "###.#.#..#..#.#.##..##.",
  ".#..#.#..#..#.#.#..#...",
  ".#..#.#..#..#.#.#...#..",
  ".#...##...#..##.#..##..",
  ".......................",
  ".ooooooooooooooooooooo."
];
const DMA = [
  "bbbbbbba......bb........bb.....abbba...",
  "bbaaaabba.....bbb......bbb....abbabba..",
  "bb....abb.....bbbb....bbbb....bba.abb..",
  "bb.....abb....bbabb..bbabb...abb...bba.",
  "bb......bb....bb.abbbba.bb...bb.....bb.",
  "bb......bb....bb..abba..bb..abb.....bba",
  "bb......bb....bb........bb..bb.......bb",
  "bb......bb....bb........bb..bb.......bb",
  "bb......bb....bb........bb..bb.......bb",
  "bb......bb....bb........bb..bbbbbbbbbbb",
  "bb......bb....bb........bb..bbaaaaaaabb",
  "bb.....abb....bb........bb..bb.......bb",
  "bb....abb.....bb........bb..bb.......bb",
  "bbaaaabba.....bb........bb..bb.......bb",
  "bbbbbbba......bb........bb..bb.......bb"
];
const LETTERS: Record<string, readonly string[]> = {
  s: ["....", ".###", "##..", "..##", "###."],
  o: ["....", ".##.", "#..#", "#..#", ".##."],
  u: ["....", "#..#", "#..#", "#..#", ".###"],
  n: ["....", "###.", "#..#", "#..#", "#..#"],
  d: ["...#", ".###", "#..#", "#..#", ".###"],
  t: [".#..", "###.", ".#..", ".#..", "..##"],
  r: ["....", "#.##", "##..", "#...", "#..."],
  a: ["....", ".###", "#..#", "#..#", ".###"],
  c: ["....", ".###", "#...", "#...", ".###"],
  k: ["#...", "#..#", "###.", "#.#.", "#..#"],
  e: ["....", ".##.", "####", "#...", ".###"]
};
const BITS = ["0110101", "1011011", "1101100", "0111010"];

function drawLogo(s: Surface, x0: number, y0: number): void {
  // The group's name, dark on the blue, its underline in purple.
  FUTURS.forEach((line, row) => {
    for (let column = 0; column < line.length; column += 1) {
      const c = line[column];
      if (c === "#") s.pixel(x0 + 6 + column, y0 + 3 + row, PAPER);
      else if (c === "o") s.pixel(x0 + 6 + column, y0 + 3 + row, PURPLE);
    }
  });
  // Binary digits in four blues, brighter towards the bottom right.
  const shades = [SPRITE.slate, SPRITE.steel, SPRITE.sky, SPRITE.ice];
  BITS.forEach((bits, row) => {
    for (let column = 0; column < bits.length; column += 1) {
      const color = shades[Math.min(3, (row + column) >> 1)]!;
      const x = x0 + 2 + column * 4;
      const y = y0 + 19 + row * 4;
      if (bits[column] === "1") s.fill(x + 1, y, 1, 3, color);
      else {
        s.fill(x, y, 3, 1, color);
        s.fill(x, y + 2, 3, 1, color);
        s.pixel(x, y + 1, color);
        s.pixel(x + 2, y + 1, color);
      }
    }
  });
  // "DMA" in outline: the strokes light, their edges a darker blue.
  DMA.forEach((line, row) => {
    for (let column = 0; column < line.length; column += 1) {
      const c = line[column];
      if (c === "a") s.pixel(x0 + 30 + column, y0 + 19 + row, SPRITE.ice);
      else if (c === "b") s.pixel(x0 + 30 + column, y0 + 19 + row, LIGHT);
    }
  });
  // "soundtracker" across it on a dark band: "sound" yellow, "tracker" orange.
  const word = "soundtracker";
  const left = x0 + 7;
  const width = word.length * 5 - 1;
  s.fill(left - 2, y0 + 22, width + 4, 6, SPRITE.navy);
  s.fill(left - 1, y0 + 23, width + 2, 4, SPRITE.deep);
  [...word].forEach((letter, index) => {
    const color = index < 5 ? SPRITE.yellow : SPRITE.orange;
    LETTERS[letter]!.forEach((line, row) => {
      for (let column = 0; column < 4; column += 1) if (line[column] === "#") s.pixel(left + index * 5 + column, y0 + 22 + row, color);
    });
  });
}

/**
 * A box as the program frames its areas: paper inside, purple along the top and left, light along
 * the bottom and right (each corner where they meet goes to the side it ends).
 */
function box(s: Surface, x0: number, y0: number, x1: number, y1: number): void {
  s.fill(x0 + 1, y0 + 1, x1 - x0 - 1, y1 - y0 - 1, PAPER);
  s.fill(x0, y0, x1 - x0, 1, PURPLE);
  s.fill(x0, y0, 1, y1 - y0 + 1, PURPLE);
  s.fill(x0 + 1, y1, x1 - x0, 1, LIGHT);
  s.fill(x1, y0, 1, y1 - y0 + 1, LIGHT);
}

/** The screen as it stands, without what the song changes, drawn into the frame at (SCREEN_X, SCREEN_Y). */
function drawChrome(): Surface {
  const frame = new Surface(WIDTH, HEIGHT);
  frame.fill(0, 0, WIDTH, HEIGHT, BORDER);
  const s = new Surface(336, 192);
  s.fill(0, 0, 336, 192, BLUE);
  // The menu, PLAY SONG chosen.
  s.fill(2, 0, 196, 34, PAPER);
  s.fill(1, 0, 1, 35, PURPLE);
  s.fill(2, 34, 197, 1, LIGHT);
  s.fill(198, 0, 1, 35, LIGHT);
  MENU.forEach((row, line) => {
    for (const [label, x] of row) {
      const chosen = label === "PLAY SONG";
      if (chosen) s.fill(x, line * 8, label.length * 8, 8, LIGHT);
      s.text(big, x, line * 8, label, chosen ? BLUE : LIGHT);
    }
  });
  drawLogo(s, 199, 0);
  s.text(small, 232, 2, "Song name:", LIGHT);
  s.text(small, 232, 10, "Smp/Song mem:", LIGHT);
  s.fill(287, 10, 45, 5, PAPER);
  s.text(small, 276, 18, "Octave:", LIGHT);
  s.fill(304, 16, 8, 8, PAPER);
  s.text(big, 304, 16, "3", LIGHT);
  s.text(small, 276, 26, "Clipboard:", LIGHT);
  s.fill(316, 24, 16, 8, PAPER);
  s.text(big, 316, 24, "00", LIGHT);
  // The notification area (nothing to report), the channels all on.
  for (const [x, y] of CORNERS) s.pixel(x, y, PURPLE);
  s.text(big, 36, 40, "ABC", LIGHT);
  // The song list's length and positions, the object edited, the skip.
  box(s, 1, 53, 62, 90);
  s.text(big, 4, 56, "Len:", LIGHT);
  box(s, 1, 93, 22, 106);
  s.text(small, 28, 98, "Skip:", LIGHT);
  s.fill(48, 96, 8, 8, PAPER);
  s.text(big, 48, 96, "1", LIGHT);
  // The lists.
  LISTS.forEach((list, index) => {
    box(s, list.x, 37, list.x + 65, 106);
    if (index === ACTIVE_LIST) {
      s.fill(list.x + 3, 40, 60, 8, PURPLE);
      s.text(big, list.x + 3, 40, list.title, BLUE);
    } else {
      s.text(big, list.x + 3, 40, list.title, LIGHT);
    }
    list.items.forEach((name, row) => {
      const y = 50 + row * 8;
      const number = hex(list.first + row, 2);
      if (list.first + row === list.chosen) {
        s.fill(list.x + 3, y - 1, 8, 7, LIGHT);
        s.text(small, list.x + 3, y, number, PAPER);
      } else {
        s.text(small, list.x + 3, y, number, LIGHT);
      }
      s.text(small, list.x + 15, y, name === "" ? "------------" : name ?? "", LIGHT);
    });
  });
  // The pattern: row numbers, the special column, the three channels between dotted rules.
  box(s, 1, 109, 22, 200);
  box(s, 29, 109, 58, 200);
  box(s, 61, 109, 334, 200);
  for (let y = 115; y < 192; y += 2) {
    s.pixel(152, y, PURPLE);
    s.pixel(244, y, PURPLE);
  }
  frame.copy(s, 0, 0, 336, 192, SCREEN_X, SCREEN_Y);
  return frame;
}

/** The song's name as the field holds it: the title without the artist, fourteen characters. */
function songName(title: string): string {
  const name = (title.split(/\s[—–-]\s/)[0] ?? "").replace(/\s+/g, " ").trim();
  return printable(name, small).slice(0, 14);
}

export function createSoundtrackerDma(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const earlier = emptyCell();
  // The screen with the song's state drawn, redrawn only when the song moves or the track changes.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let shownTitle: string | null = null;
  let shownLength = -1;

  const put = (s: Surface, font: typeof big, x: number, y: number, text: string, color: number): void => {
    s.text(font, SCREEN_X + x, SCREEN_Y + y, text, color);
  };
  const clear = (s: Surface, x: number, y: number, width: number, height: number): void => {
    s.copy(chrome, SCREEN_X + x, SCREEN_Y + y, width, height, SCREEN_X + x, SCREEN_Y + y);
  };

  /** The volume a channel's last note before `row` in this pattern was given (−1: none). */
  const volumeBefore = (channel: number, row: number): number => {
    for (let back = row - 1; back >= 0; back -= 1) {
      song.cell(channel, back, earlier);
      if (earlier.note >= 0 && earlier.note !== NOTE_OFF) return earlier.volume;
    }
    return -1;
  };

  /** A tempo command anywhere on the row, as the special column writes it (frames a row at 50 Hz). */
  const special = (row: number): string => {
    for (let channel = 0; channel < SPEC.channels.length; channel += 1) {
      song.cell(channel, row, cell);
      if (cell.effect === "speed") return `T${hex(Math.max(1, Math.min(31, cell.param)), 2)}`;
      if (cell.effect === "tempo") return `T${hex(Math.max(1, Math.min(31, Math.round(750 / cell.param))), 2)}`;
    }
    return "~~~";
  };

  /** An effect in the program's letters, or the empty column. */
  const effectText = (c: Cell): string => {
    const p = c.param & 255;
    switch (c.effect) {
      case "arpeggio": return `A${hex(p, 2)}`;
      case "slideUp": case "tonePorta": return `U${hex(p, 2)}`;
      case "slideDown": return `D${hex(p, 2)}`;
      case "vibrato": return `V${hex(Math.max(1, p >> 4), 1)}${hex(Math.min(7, p & 15), 1)}`;
      case "volumeSlide": return `O0${hex(Math.max(1, p & 15), 1)}`;
      default: return "~~~";
    }
  };

  /** One channel's cell: note (or Smp, Res), instrument or sample, volume, effect. */
  const drawCell = (s: Surface, channel: number, row: number, y: number, color: number): void => {
    song.cell(channel, row, cell);
    const x = CHANNEL_X[channel]!;
    let note = "~~~";
    let number = "~~";
    let volume = "~";
    if (cell.note === NOTE_OFF) {
      note = "Res";
    } else if (cell.note !== NOTE_NONE) {
      const digit = Math.max(0, Math.min(15, Math.round((cell.volume * 15) / 64)));
      if (channel === 0) {
        // A sample: full volume, or dimmed (a digit under 8) for a soft hit.
        note = "Smp";
        number = hex(cell.instrument, 2);
        if (cell.volume >= 0 && cell.volume < 32) volume = hex(Math.min(7, digit), 1);
      } else {
        note = noteText(cell.note);
        number = hex(cell.instrument, 2);
        // The volume stays until changed: written where it changes.
        if (cell.volume >= 0 && cell.volume !== volumeBefore(channel, row)) volume = hex(digit, 1);
      }
    }
    const effect = cell.effect === "speed" || cell.effect === "tempo" ? "~~~" : effectText(cell);
    put(s, big, x, y, note, color);
    put(s, big, x + 28, y, number, color);
    put(s, big, x + 48, y, volume, color);
    put(s, big, x + 60, y, effect, color);
  };

  const drawPattern = (s: Surface): void => {
    clear(s, 2, 110, 20, 82);
    clear(s, 30, 110, 28, 82);
    clear(s, 62, 110, 272, 82);
    const current = song.row;
    for (let line = 0; line < LINES; line += 1) {
      const row = current - PLAY_LINE + line;
      if (row < 0 || row >= ROWS) continue;
      const y = PATTERN_TOP + line * 8;
      const color = line === PLAY_LINE ? LIGHT : PURPLE;
      put(s, big, ROW_LEFT, y, hex(row, 2), color);
      put(s, big, SPECIAL_X, y, special(row), color);
      for (let channel = 0; channel < 3; channel += 1) drawCell(s, channel, row, y, color);
    }
  };

  /** The song list's corner: its length, the positions around the one playing, the pattern shown. */
  const drawSongList = (s: Surface, length: number): void => {
    clear(s, 36, 56, 24, 8);
    clear(s, 2, 64, 60, 24);
    clear(s, 2, 94, 20, 12);
    put(s, big, 44, 56, hex(length, 2), LIGHT);
    const first = Math.max(0, Math.min(song.position - 1, length - 3));
    for (let line = 0; line < 3; line += 1) {
      const position = first + line;
      if (position >= length) break;
      const y = 64 + line * 8;
      put(s, big, 4, y, hex(position, 2), PURPLE);
      put(s, big, 24, y, hex(song.patternAt(position), 2), PURPLE);
      put(s, big, 52, y, "0", PURPLE);
    }
    put(s, big, 4, 96, hex(song.pattern, 2), LIGHT);
  };

  /** The fields beside the logo: the song's name and the memory left for samples and the song. */
  const drawInfo = (s: Surface, title: string): void => {
    clear(s, 276, 2, 58, 5);
    put(s, small, 276, 2, songName(title), LIGHT);
    s.fill(SCREEN_X + 287, SCREEN_Y + 10, 45, 5, PAPER);
    const samples = 0x4000 - 0x0a74 - 0x0c12 - 0x05e0 - 0x0b10;
    const free = Math.max(0, 0xbf00 - 0x0c40 - (song.pattern + 1) * 0x1a6);
    put(s, small, 288, 10, `${hex(samples, 4)} / ${hex(free, 4)}`, LIGHT);
  };

  return {
    width: WIDTH,
    height: HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      song.update(frame.audio, frame.track, frame.dt);
      const pixels = target.open(image);
      const length = song.length(frame.track.duration);
      if (song.changes !== drawn || frame.track.title !== shownTitle || length !== shownLength) {
        drawn = song.changes;
        shownTitle = frame.track.title;
        shownLength = length;
        drawPattern(base);
        drawSongList(base, length);
        drawInfo(base, frame.track.title);
      }
      pixels.set(base.pixels);
      target.close(image);
    }
  };
}
