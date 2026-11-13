import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { MPT, WIN } from "./fonts-gui";
import { clock, decimal, letterEffect, noteText } from "./notation";
import { measure, mix, printable, rgb, sheet, Surface, Target, type Font } from "./raster";
import { emptyCell, NOTE_CUT, NOTE_NONE, NOTE_OFF, ROWS, Song, type Cell, type SongSpec } from "./song";

/**
 * ModPlug Tracker 1.16 (Windows, 2004; Olivier Lapicque) playing along: its window maximized on
 * an 800 × 600 Windows 98 desktop — the title bar with the module's name, the menu, the toolbar
 * (files, clipboard, playback, octave, tempo and speed), the tree of the module and the file
 * browser beside it, and the module's window on its Patterns tab: the pattern toolbar, the
 * instrument, spacing and Follow Song, the pattern's name, the order list, and the pattern
 * itself in the black of ModPlug's colours — every fourth row shaded, every sixteenth more,
 * the row playing in grey under the edit cursor, the channels' meters lit in their headers —
 * and the status bar.
 *
 * The module is song.ts's, an .it of ten channels: kick, snare, hi-hats, bass, the lead on the
 * left and on the right by where it is heard, a chord's three voices and the lead's echo. Drawn
 * from this project's own fonts (fonts-gui.ts), pictures and coordinates, after screenshots of
 * the program; the Windows parts are drawn here too.
 */

const WIDTH = 800;
const HEIGHT = 600;

/** Windows 98's colours. */
const FACE = rgb(0xc0c0c0);
const LIGHT = rgb(0xdfdfdf);
const WHITE = rgb(0xffffff);
const SHADOW = rgb(0x808080);
const BLACK = rgb(0x000000);
const NAVY = rgb(0x000080);
/** ModPlug's pattern colours. */
const DOTS = rgb(0xe0e040);
const NOTES = rgb(0xe0e040);
const INSTRUMENT = rgb(0xffff00);
const VOLUME = rgb(0x00ff00);
const PANNING = rgb(0x00ffff);
const GLOBAL = rgb(0xff6060);
const BEAT = rgb(0x2e2e58);
const BAR = rgb(0x404080);
const PLAYING = rgb(0x707070);
const PLAY_DOTS = rgb(0xf0f050);
const CURSOR = rgb(0x4040a0);

const ui = narrowSpace(sheet(WIN.sheet, WIN.cell, WIN.height, WIN.fixed, 1), 3);
const bold = embolden(ui);
const pattern = sheet(MPT.sheet, MPT.cell, MPT.height, MPT.fixed);

/** The face with a space as narrow as Windows sets it. */
function narrowSpace(font: Font, width: number): Font {
  const glyphs = new Map(font.glyphs);
  glyphs.set(" ", { width, rows: new Array<number>(font.height).fill(0) });
  return { ...font, glyphs };
}

/** Windows' bold: each glyph drawn again a pixel to the right. */
function embolden(font: Font): Font {
  const glyphs = new Map<string, { width: number; rows: readonly number[] }>();
  for (const [char, glyph] of font.glyphs) {
    glyphs.set(char, { width: glyph.width + 1, rows: glyph.rows.map((bits) => (bits << 1) | bits) });
  }
  return { ...font, glyphs };
}

const CHANNELS = 10;
const SPEC: SongSpec = {
  channels: [
    { parts: ["kick"] }, { parts: ["snare"] }, { parts: ["hats"] }, { parts: ["bass"] },
    { parts: ["lead"], side: -1 }, { parts: ["lead"], side: 1 }, { parts: ["chord"] }, { parts: ["chord"] },
    { parts: ["chord"] }, { parts: ["echo"] }
  ],
  low: 0,
  high: 119,
  drums: { kick: 48, snare: 50, hats: 54 },
  floors: { bass: 24, lead: 60, chord: 48 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 256,
  noteOff: true,
  chordVoices: true,
  seed: 2004
};

const INSTRUMENTS = ["Bassdrum", "Snare", "Closed Hihat", "Open Hihat", "Fat Bass", "Square Lead", "Strings", "Lead Echo"];

/** The window's parts: the tree, the module's window, its Patterns tab, the pattern view. */
const MENU_TOP = 18;
const TOOLBAR_TOP = 37;
const CLIENT_TOP = 65;
const STATUS_TOP = 580;
const TREE_WIDTH = 152;
const CHILD_LEFT = 156;
const VIEW_TOP = 262;
const HEADER_HEIGHT = 28;
const ROW_LEFT = 159;
const ROW_WIDTH = 28;
const CHANNEL_LEFT = 187;
const CHANNEL_STEP = 70;
const LINE = 11;
const VISIBLE = 24;
const PLAY_LINE = 12;
const GRID_TOP = VIEW_TOP + 2 + HEADER_HEIGHT;
const SCROLL_RIGHT = 782;
const HSCROLL_TOP = 561;
/** The Patterns tab: its toolbar, the instrument's row, the order list. */
const TAB_TOOLS_TOP = CLIENT_TOP + 31;
const FIELDS_TOP = TAB_TOOLS_TOP + 33;
const ORDERS_TOP = FIELDS_TOP + 70;
const ORDER_LEFT = 222;
const ORDER_CELL = 24;
const ORDER_CELLS = 23;

/**
 * Pictures, a character a pixel: k black, w white, l light grey, g grey, y yellow, o olive,
 * n navy, b blue, r red, m maroon, e green, L lime, t teal, c cyan; anything else is see-through.
 */
const PALETTE: Record<string, number> = {
  k: 0x000000, w: 0xffffff, l: 0xc0c0c0, g: 0x808080, y: 0xffff00, o: 0x808000, n: 0x000080,
  b: 0x0000ff, r: 0xff0000, m: 0x800000, e: 0x008000, L: 0x00ff00, t: 0x008080, c: 0x00ffff
};
const INK = Object.fromEntries(Object.entries(PALETTE).map(([key, value]) => [key, rgb(value)]));

const APP = [
  "..kkkkkkkkkkkk..", ".kggggggggggggk.", ".kgkkkkkkkkkkgk.", ".kgkwgggggwgkgk.", ".kgkggrrrrggkgk.",
  ".kgkgrrrrrrgkgk.", ".kgkrrkrrkrrkgk.", ".kgkrrrrrrrrkgk.", ".kgkrrkrrkrrkgk.", ".kgkgrrrrrrgkgk.",
  ".kgkggrrrrggkgk.", ".kgkwgggggwgkgk.", ".kgkkkkkkkkkkgk.", ".kggggggggggggk.", "..kkkkkkkkkkkk.."
];
const NEW = [
  "..kkkkkkk.......", "..kwwwwwkk......", "..kwwwwwkwk.....", "..kwwwwwkkkk....", "..kwwwwwwwwk....",
  "..kwwwwwwwwk....", "..kwwwwwwwwk....", "..kwwwwwwwwk....", "..kwwwwwwwwk....", "..kwwwwwwwwk....",
  "..kwwwwwwwwk....", "..kwwwwwwwwk....", "..kwwwwwwwwk....", "..kkkkkkkkkk...."
];
const OPEN = [
  ".........kkk....", "........k...k.k.", ".............kk.", ".kkk........kkk.", "kyywk...........",
  "kywywkkkkkkk....", "kwywywywywyk....", "kywywykkkkkkkkk.", "kwywykooooooook.", "kywykooooooook..",
  "kwykooooooook...", "kykooooooook....", "kkkkkkkkkkk....."
];
const SAVE = [
  "kkkkkkkkkkkkkk", "kokwwwwwwwwkok", "kokwwwwwwwwkok", "kokwwwwwwwwkok", "kokwwwwwwwwkok",
  "kookkkkkkkkook", "kooooooooooook", "kooooooooooook", "kookkkkkkkkook", "kookkwwkkkkook",
  "kookkwwkkkkook", "kookkwwkkkkook", ".kkkkkkkkkkkkk"
];
const CUT = [
  "....k.....k.....", "....k.....k.....", "....k.....k.....", "....kk...kk.....", ".....k...k......",
  ".....kk.kk......", "......kkk.......", ".......k........", "......n.n.......", "....nnn.nnn.....",
  "...n..n.n..n....", "...n..n.n..n....", "...n..n.n..n....", "....nn...nn....."
];
const COPY = [
  "kkkkkkk.........", "kwwwwwkk........", "kwkkkwkwk.......", "kwwwwwkkkk......", "kwkkkknnnnnnn...",
  "kwwwwwnwwwwwnn..", "kwkkkknwkkkwnwn.", "kwwwwwnwwwwwnnnn", "kkkkkknwkkkkkwwn", "......nwwwwwwwwn",
  "......nwkkkkkkwn", "......nwwwwwwwwn", "......nwkkkkkkwn", "......nwwwwwwwwn", "......nnnnnnnnnn"
];
const PASTE = [
  "....kkkk........", ".kkk.yy.kkk.....", "koo.kkkk.ook....", "kookkkkkkook....", "koooooooooook...",
  "kooooonnnnnnnn..", "kooooonwwwwwnnn.", "kooooonwkkkwnwn.", "kooooonwwwwwnnnn", "kooooonwkkkkkwwn",
  "kooooonwwwwwwwwn", "kooooonwkkkkkkwn", "kkkkkknwwwwwwwwn", "......nnnnnnnnnn"
];
const MIDI = [
  "..........rr....", ".........rrrr...", ".........rrrr...", "..........rr....", "kkkkkkkkkkkkkkk.",
  "kwkkwkwkkwkkwkk.", "kwkkwkwkkwkkwkk.", "kwkkwkwkkwkkwkk.", "kwwkwwwwkwwkwwk.", "kwwkwwwwkwwkwwk.",
  "kkkkkkkkkkkkkkk."
];
const STOP = ["kkkkkkk", "kkkkkkk", "kkkkkkk", "kkkkkkk", "kkkkkkk", "kkkkkkk", "kkkkkkk"];
const PLAY = ["k....", "kk...", "kkk..", "kkkk.", "kkkkk", "kkkk.", "kkk..", "kk...", "k...."];
const PLAY_FROM = ["kk.k....", "kk.kk...", "kk.kkk..", "kk.kkkk.", "kk.kkkkk", "kk.kkkk.", "kk.kkk..", "kk.kk...", "kk.k...."];
const SETUP = [
  "..k....k....k...", ".kkk...k....k...", ".krk...k....k...", ".kkk...k...kkk..", "..k...kkk..kbk..",
  "..k...kek..kkk..", "..k...kkk...k...", "..k....k....k...", "..k....k....k...", "..k....k....k...",
  "gggggggggggggg.."
];
const HELP = [
  "....kkkkk.......", "...kyyyyyk......", "..kyykkkyyk.....", "..kyk...kyyk....", "...k....kyyk....",
  ".......kyyk.....", "......kyyk......", ".....kyyk.......", ".....kyyk.......", "......kk........",
  ".....kyyk.......", ".....kyyk.......", "......kk........"
];
const CONTEXT = [
  "k...............", "kk.......nnnn...", "kwk.....nn..nn..", "kwwk....nn..nn..", "kwwwk.......nn..",
  "kwwwwk.....nn...", "kwwwwwk...nn....", "kwwwwwwk..nn....", "kwwwwkkkk.......", "kwwkwk....nn....",
  "kwk.kwk...nn....", "kk..kwk.........", "k....kwk........", ".....kwk........", "......k........."
];
const TAB_GENERAL = ["kkkkkkkkkkkkk", "knnnnnnnnnnnk", "kwwwwwwwwwwwk", "kwkkkkkkkkkwk", "kwwwwwwwwwwwk", "kwkkkkkwwwwwk", "kwwwwwwwwwwwk", "kkkkkkkkkkkkk"];
const TAB_PATTERNS = ["....kkkkkkk", "....kkkkkkk", "....k.....k", "....k.....k", "....k.....k", "....k.....k", "..kkk...kkk", ".kkkk..kkkk", "..kk....kk."];
const TAB_SAMPLES = ["..r.....r.......", "..r.r...r..r....", "r.r.r.r.r.rr.r..", "rrrrrrrrrrrrrrr.", "r.r.r.r.r.rr.r..", "..r.r...r..r....", "..r.....r......."];
const TAB_INSTRUMENTS = ["kkkkkkkkkkkkkkk", "kwkkwkkwkwkkwkk", "kwkkwkkwkwkkwkk", "kwwkwwkwwkwkwwk", "kwwkwwkwwkwkwwk", "kkkkkkkkkkkkkkk"];
const TAB_COMMENTS = ["kkkkkkkk...", "kwwwwwwkk..", "kwkkkkwkwk.", "kwwwwwwkkkk", "kwkkkkkkkwk", "kwwwwwwwwwk", "kwkkkkkkkwk", "kwwwwwwwwwk", "kwkkkkkkkwk", "kwwwwwwwwwk", "kkkkkkkkkkk"];
const P_NEW = ["kkkkkk...", "kwwwwkk..", "kwwwwkwk.", "kwwwwkkkk", "kwwwwwwwk", "kwwwwwwwk", "kwwwwwwwk", "kwwwwwwwk", "kwwwwwwwk", "kkkkkkkkk"];
const P_PLAY = ["kkkkkkk", ".kkkkk.", "..kkk..", "...k..."];
const P_PLAY_ROW = ["kkkkkkk", ".......", "kkkkkkk", ".kkkkk.", "..kkk..", "...k...", ".......", "kkkkkkk"];
const P_STOP = ["kkkkk", "kkkkk", "kkkkk", "kkkkk", "kkkkk"];
const P_INSERT = ["kkkkkkk", "...k...", "...k...", "kkkkkkk", ".kkkkk.", "..kkk..", "...k...", "kkkkkkk"];
const P_RECORD = ["..rrrrr..", ".rrrrrrr.", "rrrrrrrrr", "rrrrrrrrr", "rrrrrrrrr", "rrrrrrrrr", "rrrrrrrrr", ".rrrrrrr.", "..rrrrr.."];
const P_VU = ["......rr.....", "..rr..rr..rr.", "..yy..yy..yy.", "..yy..yy..yy.", "..LL..LL..LL.", "..LL..LL..LL.", "..LL..LL..LL.", "..LL..LL..LL."];
const P_ZXX = ["kkkkkk.....", "....kk.....", "...kk......", "..kk.......", ".kk........", "kkkkkk.....", ".......k.k.", "........k..", ".......k.k."];
const P_KEYS = ["kkkkkkkkkkk", "kwkrkwkrkwk", "kwkrkwkrkwk", "kwkrkwkrkwk", "kwwkwwwkwwk", "kwwkwwwkwwk", "kkkkkkkkkkk"];
const P_UNDO = ["...gggg....", "..g....g...", ".g......g..", "ggg......g.", ".g.......g.", "..........g", ".........g.", "........g.."];
const P_FIND = ["kkkkkkkkkk", "kyyyyyyyyk", "kyykkkkyyk", "kyyyyykyyk", "kyyykkkyyk", "kyyykyyyyk", "kyyyyyyyyk", "kyyykyyyyk", "kkkkkkkkkk"];
const P_TRANSPOSE = ["kkkkkkkkkk", "kwwwrrwwwk", "kwwrrrrwwk", "kwrrrrrrwk", "kwwwwwwwwk", "kwrrrrrrwk", "kwwrrrrwwk", "kwwwrrwwwk", "kkkkkkkkkk"];
const P_AMPLIFY = ["kkkkkkkkkk", "krrwwwwrrk", "kwrrwwrrwk", "kwwrrrrwwk", "kwwwrrwwwk", "kwwrrrrwwk", "kwrrwwrrwk", "krrwwwwrrk", "kkkkkkkkkk"];
const P_SPLIT = ["...kkkk...", "..kkkkkk..", ".kkkrrkkk.", ".kkrrrrkk.", ".kkrrrrkk.", ".kkkrrkkk.", "..kkkkkk..", "...kkkk..."];
const FOLDER = [
  "..kkkkk........", ".kyywyyk.......", "kyyyyyyykkkkkk.", "kwwwwwwwwwwwwk.", "kwyyyyyyyyyyyok", "kwyyyyyyyyyyyok",
  "kwyyyyyyyyyyyok", "kwyyyyyyyyyyyok", "kwyyyyyyyyyyyok", "kwyyyyyyyyyyyok", "kooooooooooooook", ".kkkkkkkkkkkkk."
];
const DOCUMENT = ["kkkkkkkk...", "kwwwwwwkk..", "kwwwwwwkwk.", "kwwwwwwkkkk", "kwwwwwwwwwk", "kwkkkkkkkwk", "kwwwwwwwwwk", "kwkkkkkkkwk", "kwwwwwwwwwk", "kwkkkkkkkwk", "kwwwwwwwwwk", "kkkkkkkkkkk"];
const OPEN_FOLDER = [
  "..kkkkk.........", ".kyywyyk........", "kyyyyyyykkkkkk..", "kyyyyyyyyyyyyk..", "kyyykkkkkkkkkkkk", "kyykwwwwwwwwwwwk",
  "kyykwyyyyyyyyyk.", "kykwyyyyyyyyyk..", "kykwyyyyyyyyyk..", "kkwyyyyyyyyyk...", "kkkkkkkkkkkkk..."
];
/** Windows' small pictures: the caption's buttons, arrows, a tick. */
const MINIMIZE = ["......", "......", "......", "......", "......", "......", "######", "######"];
const RESTORE = ["...######", "...######", "...#....#", "######..#", "######..#", "#....####", "#....#...", "#....#...", "######..."];
const CLOSE = ["##....##", ".##..##.", "..####..", "...##...", "..####..", ".##..##.", "##....##"];
const ARROW_DOWN = ["#######", ".#####.", "..###..", "...#..."];
const ARROW_UP = ARROW_DOWN.slice().reverse();
const ARROW_LEFT = ["...#", "..##", ".###", "####", ".###", "..##", "...#"];
const ARROW_RIGHT = ["#...", "##..", "###.", "####", "###.", "##..", "#..."];
const SMALL_UP = ["..#..", ".###.", "#####"];
const SMALL_DOWN = ["#####", ".###.", "..#.."];
const TICK = ["......#", ".....##", "#...###", "##.###.", "#####..", ".###...", "..#...."];

/** A picture drawn as text in the palette above (or all in one colour, `#` lit). */
function art(s: Surface, x: number, y: number, rows: readonly string[], color?: number): void {
  rows.forEach((row, line) => {
    for (let column = 0; column < row.length; column += 1) {
      const char = row[column]!;
      if (color !== undefined) {
        if (char === "#") s.pixel(x + column, y + line, color);
      } else {
        const ink = INK[char];
        if (ink !== undefined) s.pixel(x + column, y + line, ink);
      }
    }
  });
}

/** A Windows button: white and light inside it above and left, black and grey below and right. */
function raised(s: Surface, x: number, y: number, width: number, height: number, face = FACE): void {
  s.fill(x, y, width, height, face);
  s.fill(x, y, width - 1, 1, WHITE);
  s.fill(x, y, 1, height - 1, WHITE);
  s.fill(x, y + height - 1, width, 1, BLACK);
  s.fill(x + width - 1, y, 1, height, BLACK);
  s.fill(x + 1, y + 1, width - 3, 1, LIGHT);
  s.fill(x + 1, y + 1, 1, height - 3, LIGHT);
  s.fill(x + 1, y + height - 2, width - 2, 1, SHADOW);
  s.fill(x + width - 2, y + 1, 1, height - 2, SHADOW);
}

/** A field sunk into the window (an edit box, a list), white inside unless told otherwise. */
function sunken(s: Surface, x: number, y: number, width: number, height: number, face = WHITE): void {
  s.fill(x, y, width, height, face);
  s.fill(x, y, width - 1, 1, SHADOW);
  s.fill(x, y, 1, height - 1, SHADOW);
  s.fill(x, y + height - 1, width, 1, WHITE);
  s.fill(x + width - 1, y, 1, height, WHITE);
  s.fill(x + 1, y + 1, width - 3, 1, BLACK);
  s.fill(x + 1, y + 1, 1, height - 3, BLACK);
  s.fill(x + 1, y + height - 2, width - 2, 1, LIGHT);
  s.fill(x + width - 2, y + 1, 1, height - 2, LIGHT);
}

/** A thin edge: one pixel, light or shadowed (panels, status panes). */
function thin(s: Surface, x: number, y: number, width: number, height: number, sunk: boolean): void {
  const top = sunk ? SHADOW : WHITE;
  const bottom = sunk ? WHITE : SHADOW;
  s.fill(x, y, width, 1, top);
  s.fill(x, y, 1, height, top);
  s.fill(x, y + height - 1, width, 1, bottom);
  s.fill(x + width - 1, y, 1, height, bottom);
}

/** An etched line: grey with white beside it. */
function etched(s: Surface, x: number, y: number, length: number, vertical: boolean): void {
  if (vertical) {
    s.fill(x, y, 1, length, SHADOW);
    s.fill(x + 1, y, 1, length, WHITE);
  } else {
    s.fill(x, y, length, 1, SHADOW);
    s.fill(x, y + 1, length, 1, WHITE);
  }
}

/** A button of a scroll bar or a spin box with its arrow. */
function arrowButton(s: Surface, x: number, y: number, width: number, height: number, arrow: readonly string[]): void {
  raised(s, x, y, width, height);
  art(s, x + Math.floor((width - arrow[0]!.length) / 2), y + Math.floor((height - arrow.length) / 2), arrow, BLACK);
}

/** A spin box's two buttons, one above the other. */
function spin(s: Surface, x: number, y: number, height: number): void {
  const half = Math.floor(height / 2);
  arrowButton(s, x, y, 15, half, SMALL_UP);
  arrowButton(s, x, y + half, 15, height - half, SMALL_DOWN);
}

/** A scroll bar's track: Windows' dither of white and light grey. */
function track(s: Surface, x: number, y: number, width: number, height: number): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) s.pixel(column, row, (row + column) & 1 ? WHITE : FACE);
  }
}

/** A dotted line of a tree view. */
function dotted(s: Surface, x: number, y: number, length: number, vertical: boolean): void {
  for (let step = 0; step < length; step += 2) s.pixel(vertical ? x : x + step, vertical ? y + step : y, SHADOW);
}

/** A tree view's box to fold or unfold an item. */
function expander(s: Surface, x: number, y: number, open: boolean): void {
  s.fill(x, y, 9, 9, WHITE);
  thin(s, x, y, 9, 9, false);
  s.fill(x, y, 9, 1, SHADOW);
  s.fill(x, y, 1, 9, SHADOW);
  s.fill(x + 2, y + 4, 5, 1, BLACK);
  if (!open) s.fill(x + 4, y + 2, 1, 5, BLACK);
}

/** Text of the dialog face; its width. */
function label(s: Surface, x: number, y: number, text: string, color = BLACK, face = ui): number {
  return s.text(face, x, y, text, color) - x;
}

/** A menu's item: its name with its access key underlined. */
function menuItem(s: Surface, x: number, y: number, text: string): number {
  const end = s.text(ui, x, y, text, BLACK);
  const first = ui.glyphs.get(text[0]!);
  s.fill(x, y + 10, first ? first.width : 5, 1, BLACK);
  return end;
}

/** A toolbar button with its picture: raised, or held down (its face dithered). */
function tool(s: Surface, x: number, y: number, picture: readonly string[], down = false, width = 23, height = 22): void {
  if (down) {
    s.fill(x, y, width, height, FACE);
    track(s, x + 2, y + 2, width - 3, height - 3);
    s.fill(x, y, width - 1, 1, BLACK);
    s.fill(x, y, 1, height - 1, BLACK);
    s.fill(x + 1, y + 1, width - 2, 1, SHADOW);
    s.fill(x + 1, y + 1, 1, height - 2, SHADOW);
    s.fill(x, y + height - 1, width, 1, WHITE);
    s.fill(x + width - 1, y, 1, height, WHITE);
  } else {
    raised(s, x, y, width, height);
  }
  if (!picture.length) return;
  const pictureWidth = Math.max(...picture.map((row) => row.length));
  art(s, x + Math.floor((width - pictureWidth) / 2) + (down ? 1 : 0), y + Math.floor((height - picture.length) / 2) + (down ? 1 : 0), picture);
}

/** The caption's three buttons, or a maximized child's in the menu bar. */
function captionButtons(s: Surface, y: number): void {
  raised(s, 748, y, 16, 14);
  art(s, 752, y + 3, MINIMIZE, BLACK);
  raised(s, 764, y, 16, 14);
  art(s, 767, y + 2, RESTORE, BLACK);
  raised(s, 782, y, 16, 14);
  art(s, 786, y + 3, CLOSE, BLACK);
}

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, FACE);
  // The title bar: Windows 98's blue running lighter to the right, the program's picture, the buttons.
  for (let x = 0; x < WIDTH; x += 1) s.fill(x, 0, 1, MENU_TOP, rgb(mix(0x000080, 0x1084d0, x / (WIDTH - 1))));
  art(s, 1, 1, APP);
  captionButtons(s, 2);
  // The menu: the child's picture, the menus, the child's buttons.
  art(s, 2, MENU_TOP + 2, APP);
  let x = 24;
  for (const item of ["File", "Player", "Edit", "View", "Window", "Help"]) x = menuItem(s, x, MENU_TOP + 3, item) + 13;
  captionButtons(s, MENU_TOP + 2);
  // The toolbar.
  etched(s, 0, TOOLBAR_TOP, WIDTH, false);
  const top = TOOLBAR_TOP + 4;
  tool(s, 4, top, NEW);
  tool(s, 27, top, OPEN);
  tool(s, 50, top, SAVE);
  etched(s, 77, top + 1, 20, true);
  tool(s, 82, top, CUT);
  tool(s, 105, top, COPY);
  tool(s, 128, top, PASTE);
  etched(s, 155, top + 1, 20, true);
  tool(s, 160, top, MIDI);
  tool(s, 183, top, STOP);
  tool(s, 206, top, PLAY);
  tool(s, 229, top, PLAY_FROM);
  etched(s, 256, top + 1, 20, true);
  sunken(s, 261, top, 60, 22);
  spin(s, 321, top, 22);
  etched(s, 342, top + 1, 20, true);
  label(s, 348, top + 5, "Tempo:");
  sunken(s, 392, top, 40, 22);
  spin(s, 432, top, 22);
  etched(s, 453, top + 1, 20, true);
  label(s, 459, top + 5, "Speed:");
  sunken(s, 499, top, 34, 22);
  spin(s, 533, top, 22);
  etched(s, 554, top + 1, 20, true);
  tool(s, 559, top, SETUP);
  tool(s, 582, top, HELP);
  tool(s, 605, top, CONTEXT);
  etched(s, 0, CLIENT_TOP - 1, WIDTH, false);
  // The tree: the module and the libraries above, the file browser below.
  sunken(s, 0, CLIENT_TOP + 1, TREE_WIDTH, 289);
  sunken(s, 0, CLIENT_TOP + 294, TREE_WIDTH, STATUS_TOP - CLIENT_TOP - 296);
  drawTree(s);
  // The module's window: its tabs and the Patterns tab.
  drawTabs(s);
  drawPatternTab(s);
  // The pattern view: its frame, the corner, the scroll bars.
  sunken(s, CHILD_LEFT, VIEW_TOP, WIDTH - CHILD_LEFT, STATUS_TOP - VIEW_TOP - 1, BLACK);
  raised(s, ROW_LEFT - 1, VIEW_TOP + 2, ROW_WIDTH + 1, HEADER_HEIGHT);
  s.fill(SCROLL_RIGHT, VIEW_TOP + 2, 16, HEADER_HEIGHT, FACE);
  arrowButton(s, SCROLL_RIGHT, GRID_TOP, 16, 16, ARROW_UP);
  track(s, SCROLL_RIGHT, GRID_TOP + 16, 16, HSCROLL_TOP - GRID_TOP - 32);
  arrowButton(s, SCROLL_RIGHT, HSCROLL_TOP - 16, 16, 16, ARROW_DOWN);
  arrowButton(s, ROW_LEFT - 1, HSCROLL_TOP, 16, 16, ARROW_LEFT);
  track(s, ROW_LEFT + 15, HSCROLL_TOP, SCROLL_RIGHT - ROW_LEFT - 31, 16);
  raised(s, ROW_LEFT + 15, HSCROLL_TOP, 410, 16);
  arrowButton(s, SCROLL_RIGHT - 16, HSCROLL_TOP, 16, 16, ARROW_RIGHT);
  s.fill(SCROLL_RIGHT, HSCROLL_TOP, 16, 16, FACE);
  // The status bar.
  label(s, 4, STATUS_TOP + 4, "Ready");
  thin(s, 470, STATUS_TOP + 2, 150, 17, true);
  thin(s, 622, STATUS_TOP + 2, 100, 17, true);
  thin(s, 724, STATUS_TOP + 2, 74, 17, true);
  return s;
}

/** The tree of the module and the libraries, and the file browser. */
function drawTree(s: Surface): void {
  const left = 4;
  const top = CLIENT_TOP + 5;
  const items: [number, readonly string[], string, boolean | null][] = [
    [0, OPEN_FOLDER, "", true],
    [1, FOLDER, "Sequence", false],
    [1, FOLDER, "Patterns", false],
    [1, FOLDER, "Samples", false],
    [1, FOLDER, "Instruments", false],
    [1, DOCUMENT, "Comments", null],
    [0, FOLDER, "MIDI Library", false],
    [0, FOLDER, "Instrument Library", false]
  ];
  // The lines first: from the root down its children, and between the roots.
  dotted(s, left + 4, top + 12, 16 * 6, true);
  dotted(s, left + 23, top + 24, 16 * 4 + 1, true);
  items.forEach(([depth, , , open], index) => {
    const y = top + index * 16;
    const x = left + depth * 19;
    dotted(s, x + 4 + (open === null ? 0 : 6), y + 8, open === null ? 12 : 6, false);
    if (open !== null) expander(s, x, y + 4, open);
  });
  items.forEach(([depth, picture, text], index) => {
    const y = top + index * 16;
    const x = left + depth * 19 + 13;
    art(s, x, y + 2, picture);
    if (text) label(s, x + 18, y + 3, text);
  });
  // The browser's folder.
  const y = CLIENT_TOP + 300;
  art(s, 6, y + 2, FOLDER);
  label(s, 24, y + 3, "C:\\Modplug\\Samples");
}

/** The tabs of the module's window, Patterns in front. */
function drawTabs(s: Surface): void {
  const top = CLIENT_TOP + 3;
  const tabs: [string, readonly string[]][] = [["General", TAB_GENERAL], ["Patterns", TAB_PATTERNS], ["Samples", TAB_SAMPLES], ["Instruments", TAB_INSTRUMENTS], ["Comments", TAB_COMMENTS]];
  let x = CHILD_LEFT + 4;
  const page = top + 20;
  // The page under them.
  s.fill(CHILD_LEFT + 2, page, WIDTH - CHILD_LEFT - 4, VIEW_TOP - page - 4, FACE);
  thin(s, CHILD_LEFT + 2, page, WIDTH - CHILD_LEFT - 4, VIEW_TOP - page - 4, false);
  s.fill(CHILD_LEFT + 3, VIEW_TOP - 6, WIDTH - CHILD_LEFT - 6, 1, BLACK);
  tabs.forEach(([name, picture], index) => {
    const width = measure(ui, name) + 32;
    const selected = index === 1;
    const y = selected ? top - 2 : top;
    const height = selected ? 23 : 20;
    const left = selected ? x - 2 : x;
    const right = selected ? width + 4 : width;
    s.fill(left, y, right, height, FACE);
    s.fill(left + 2, y, right - 4, 1, WHITE);
    s.pixel(left + 1, y + 1, WHITE);
    s.fill(left, y + 2, 1, height - 2, WHITE);
    s.fill(left + right - 2, y + 2, 1, height - 2, SHADOW);
    s.fill(left + right - 1, y + 2, 1, height - 3, BLACK);
    s.pixel(left + right - 2, y + 1, BLACK);
    if (!selected) s.fill(left, page, right, 1, WHITE);
    art(s, x + 6, y + 3 + (selected ? 0 : 1), picture);
    label(s, x + 24, y + 4 + (selected ? 0 : 1), name);
    x += width;
  });
}

/** The Patterns tab: its toolbar, the instrument, spacing and Follow Song, the name, the order list. */
function drawPatternTab(s: Surface): void {
  const top = TAB_TOOLS_TOP;
  const tools: [readonly string[] | string, boolean][] = [
    [P_NEW, false], [P_PLAY, false], [P_PLAY_ROW, false], [P_STOP, false], [P_INSERT, false], [P_RECORD, true], [P_VU, true],
    [P_ZXX, false], [P_KEYS, false], ["|", false], [P_UNDO, false], [P_FIND, false], [P_TRANSPOSE, false], [P_AMPLIFY, false],
    [P_SPLIT, false], ["|", false], ["lo", false], ["med", false], ["hi", true]
  ];
  let x = CHILD_LEFT + 10;
  for (const [picture, down] of tools) {
    if (picture === "|") {
      etched(s, x + 3, top + 2, 18, true);
      x += 8;
      continue;
    }
    if (typeof picture === "string") {
      tool(s, x, top, [], down, 26);
      label(s, x + Math.round((26 - measure(ui, picture)) / 2) + (down ? 1 : 0), top + 5 + (down ? 1 : 0), picture);
      x += 26;
      continue;
    }
    tool(s, x, top, picture, down);
    x += 24;
  }
  // The instrument, spacing, Follow Song.
  const fields = FIELDS_TOP;
  label(s, CHILD_LEFT + 10, fields, "Instrument:");
  spin(s, CHILD_LEFT + 10, fields + 13, 21);
  sunken(s, CHILD_LEFT + 26, fields + 13, 210, 21);
  arrowButton(s, CHILD_LEFT + 218, fields + 15, 16, 17, ARROW_DOWN);
  label(s, CHILD_LEFT + 252, fields, "Spacing:");
  sunken(s, CHILD_LEFT + 252, fields + 13, 30, 21);
  label(s, CHILD_LEFT + 256, fields + 18, "1");
  spin(s, CHILD_LEFT + 282, fields + 13, 21);
  sunken(s, CHILD_LEFT + 310, fields + 17, 13, 13);
  art(s, CHILD_LEFT + 313, fields + 20, TICK, BLACK);
  label(s, CHILD_LEFT + 328, fields + 18, "Follow Song");
  // The pattern's name.
  label(s, CHILD_LEFT + 10, fields + 45, "Pattern name:");
  sunken(s, CHILD_LEFT + 96, fields + 40, 224, 21);
  // The order list: its buttons, its cells (drawn as the song moves), its scroll bar.
  const orders = ORDERS_TOP;
  raised(s, CHILD_LEFT + 10, orders, 26, 24);
  label(s, CHILD_LEFT + 17, orders + 6, "<<");
  raised(s, CHILD_LEFT + 38, orders, 26, 24);
  label(s, CHILD_LEFT + 45, orders + 6, ">>");
  sunken(s, ORDER_LEFT - 2, orders, ORDER_CELLS * ORDER_CELL + 4, 40);
  arrowButton(s, ORDER_LEFT, orders + 22, 16, 16, ARROW_LEFT);
  track(s, ORDER_LEFT + 16, orders + 22, ORDER_CELLS * ORDER_CELL - 32, 16);
  raised(s, ORDER_LEFT + 16, orders + 22, ORDER_CELLS * ORDER_CELL - 120, 16);
  arrowButton(s, ORDER_LEFT + ORDER_CELLS * ORDER_CELL - 16, orders + 22, 16, 16, ARROW_RIGHT);
}

/** The colour of an effect as ModPlug sorts them: volume, panning, pitch, or the song's. */
function effectColor(cell: Cell): number {
  switch (cell.effect) {
    case "volumeSlide":
    case "volume":
    case "retrigger":
    case "cut":
      return VOLUME;
    case "panning":
      return PANNING;
    case "speed":
    case "tempo":
      return GLOBAL;
    default:
      return INSTRUMENT;
  }
}

export function createModPlug(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const meters = new Float32Array(CHANNELS);
  const seen = new Float64Array(CHANNELS);
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;
  let length = 1;
  let title = "\u0000";

  /** The title bar: the program and, in brackets, the module's file. */
  const drawTitle = (s: Surface, name: string): void => {
    for (let x = 20; x < 744; x += 1) s.fill(x, 2, 1, 14, rgb(mix(0x000080, 0x1084d0, x / (WIDTH - 1))));
    let file = printable(name.replace(/[\u2012-\u2015]/g, "-"), ui).replace(/\s+/g, " ").trim() || "untitled";
    const room = 720 - 22 - measure(bold, "Modplug Tracker - [.it]");
    while (file.length > 1 && measure(bold, file) > room) file = file.slice(0, -1);
    s.text(bold, 22, 4, `Modplug Tracker - [${file}.it]`, WHITE);
    // The module's name at the top of the tree.
    s.fill(34, CLIENT_TOP + 6, 116, 14, WHITE);
    let root = file;
    while (root.length > 1 && measure(ui, root) > 110) root = root.slice(0, -1);
    const width = measure(ui, root) + 4;
    s.fill(35, CLIENT_TOP + 7, width, 13, NAVY);
    s.text(ui, 37, CLIENT_TOP + 8, root, WHITE);
  };

  /** One channel's cell: note, instrument, volume column, effect; dots where they are empty. */
  const drawCell = (s: Surface, x: number, y: number, playing: boolean): void => {
    const dots = playing ? PLAY_DOTS : DOTS;
    const dot = (at: number): void => s.fill(at + 1, y + 7, 2, 1, dots);
    if (cell.note === NOTE_NONE) for (let index = 0; index < 3; index += 1) dot(x + 2 + index * 5);
    else {
      const text = cell.note === NOTE_OFF ? "===" : cell.note === NOTE_CUT ? "^^^" : noteText(cell.note);
      s.text(pattern, x + 2, y + 1, text, NOTES);
    }
    if (cell.instrument > 0) s.text(pattern, x + 21, y + 1, decimal(cell.instrument, 2), INSTRUMENT);
    else for (let index = 0; index < 2; index += 1) dot(x + 21 + index * 5);
    const pitched = cell.note >= 0 && cell.note < 120;
    if (cell.volume >= 0 && pitched) {
      s.text(pattern, x + 32, y + 1, "v", VOLUME);
      s.text(pattern, x + 38, y + 1, decimal(Math.min(64, cell.volume), 2), VOLUME);
    } else for (let index = 0; index < 2; index += 1) dot(x + 38 + index * 5);
    const effect = letterEffect(cell.effect, cell.param);
    if (effect) s.text(pattern, x + 52, y + 1, effect, effectColor(cell));
    else for (let index = 0; index < 3; index += 1) dot(x + 52 + index * 5);
  };

  const drawPattern = (s: Surface): void => {
    const current = song.row;
    // The header: the pattern's number, each channel's button.
    raised(s, ROW_LEFT - 1, VIEW_TOP + 2, ROW_WIDTH + 1, HEADER_HEIGHT);
    const number = `#${song.pattern}`;
    label(s, ROW_LEFT + Math.round((ROW_WIDTH - measure(ui, number)) / 2), VIEW_TOP + 10, number);
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const x = CHANNEL_LEFT + channel * CHANNEL_STEP;
      if (x >= SCROLL_RIGHT) break;
      raised(s, x, VIEW_TOP + 2, CHANNEL_STEP, HEADER_HEIGHT);
      const name = `Channel ${channel + 1}`;
      label(s, x + Math.round((CHANNEL_STEP - measure(ui, name)) / 2), VIEW_TOP + 3, name);
    }
    s.fill(SCROLL_RIGHT, VIEW_TOP + 2, 16, HEADER_HEIGHT, FACE);
    // The rows, the one playing in the middle.
    for (let line = 0; line < VISIBLE; line += 1) {
      const row = current + line - PLAY_LINE;
      const y = GRID_TOP + line * LINE;
      const playing = line === PLAY_LINE;
      const inside = row >= 0 && row < ROWS;
      const shade = !inside ? BLACK : playing ? PLAYING : row % 16 === 0 ? BAR : row % 4 === 0 ? BEAT : BLACK;
      // The row's number on its button.
      s.fill(ROW_LEFT - 1, y, ROW_WIDTH + 1, LINE, FACE);
      if (inside) {
        s.fill(ROW_LEFT - 1, y, ROW_WIDTH, 1, WHITE);
        s.fill(ROW_LEFT - 1, y + LINE - 1, ROW_WIDTH + 1, 1, SHADOW);
        const text = String(row);
        label(s, ROW_LEFT + Math.round((ROW_WIDTH - 1 - measure(ui, text)) / 2), y + 1, text);
      }
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        const x = CHANNEL_LEFT + channel * CHANNEL_STEP;
        if (x >= SCROLL_RIGHT) break;
        const width = Math.min(CHANNEL_STEP, SCROLL_RIGHT - x);
        s.fill(x, y, Math.min(width, 67), LINE, shade);
        // The channel's edge: a dark line before it, a raised bar after it.
        s.fill(x, y, 1, LINE, SHADOW);
        if (width > 67) s.fill(x + 67, y, 1, LINE, WHITE);
        if (width > 68) s.fill(x + 68, y, Math.min(2, width - 68), LINE, FACE);
        if (!inside) continue;
        song.cell(channel, row, cell);
        if (playing && channel === 0) {
          // The edit cursor over the first channel's note.
          s.fill(x + 1, y, 16, LINE, CURSOR);
        }
        drawCell(s, x, y, playing);
      }
    }
    // The last channel runs on under the scroll bar.
    s.copy(chrome, SCROLL_RIGHT, GRID_TOP, WIDTH - SCROLL_RIGHT, HSCROLL_TOP - GRID_TOP, SCROLL_RIGHT, GRID_TOP);
  };

  /** The order list's cells around the position playing, and the fields that follow the song. */
  const drawOrders = (s: Surface): void => {
    const position = song.position;
    const first = Math.max(0, Math.min(position - 4, length - ORDER_CELLS + 1));
    const top = ORDERS_TOP + 2;
    s.fill(ORDER_LEFT, top, ORDER_CELLS * ORDER_CELL, 20, WHITE);
    for (let index = 0; index < ORDER_CELLS; index += 1) {
      const at = first + index;
      const x = ORDER_LEFT + index * ORDER_CELL;
      s.fill(x + ORDER_CELL - 1, top, 1, 20, FACE);
      // The patterns in order, "---" after the last.
      const text = at < length ? String(song.patternAt(at)) : at === length ? "---" : "";
      if (!text) continue;
      label(s, x + Math.round((ORDER_CELL - 1 - measure(ui, text)) / 2), top + 4, text);
      if (at === position) {
        // The focus rectangle, dotted.
        for (let step = 0; step < ORDER_CELL - 4; step += 2) {
          s.pixel(x + 1 + step, top + 2, BLACK);
          s.pixel(x + 1 + step, top + 17, BLACK);
        }
        for (let step = 0; step < 16; step += 2) {
          s.pixel(x + 1, top + 2 + step, BLACK);
          s.pixel(x + ORDER_CELL - 4, top + 2 + step, BLACK);
        }
      }
    }
    // The instrument the lead plays, and the toolbar's octave, tempo and speed.
    const instrument = Math.max(1, song.instrumentOf(4) || 6);
    s.fill(CHILD_LEFT + 28, FIELDS_TOP + 15, 189, 17, WHITE);
    label(s, CHILD_LEFT + 31, FIELDS_TOP + 18, `${decimal(instrument, 2)}: ${INSTRUMENTS[(instrument - 1) % INSTRUMENTS.length]}`);
    s.fill(263, TOOLBAR_TOP + 6, 56, 18, WHITE);
    label(s, 266, TOOLBAR_TOP + 9, "Octave 4");
    s.fill(394, TOOLBAR_TOP + 6, 36, 18, WHITE);
    label(s, 397, TOOLBAR_TOP + 9, String(song.bpm));
    s.fill(501, TOOLBAR_TOP + 6, 30, 18, WHITE);
    label(s, 504, TOOLBAR_TOP + 9, "6");
  };

  /** Each channel's meter in its header, lit from the left: green, then yellow, then red. */
  const drawMeters = (s: Surface, dt: number): void => {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const hits = song.hits(channel);
      let value = meters[channel]! - dt * 2.2;
      if (hits !== seen[channel]) {
        seen[channel] = hits;
        value = Math.max(value, song.hitVolume(channel));
      }
      value = Math.max(value, song.level(channel) * 0.9);
      meters[channel] = Math.max(0, Math.min(1, value));
      const x = CHANNEL_LEFT + channel * CHANNEL_STEP + 11;
      if (x + 48 >= SCROLL_RIGHT) break;
      const lit = Math.round(meters[channel]! * 12);
      for (let step = 0; step < 12; step += 1) {
        const color = step < lit ? (step >= 10 ? rgb(0xff0000) : step >= 7 ? rgb(0xffff00) : rgb(0x00ff00)) : rgb(0x404040);
        s.fill(x + step * 4, VIEW_TOP + 17, 3, 8, color);
      }
    }
  };

  /** The status bar's panes: the row and channel of the cursor, and the time. */
  const drawStatus = (s: Surface): void => {
    label(s, 626, STATUS_TOP + 5, `Row ${song.row}, Col 1`);
    label(s, 728, STATUS_TOP + 5, clock(song.time, true));
  };

  return {
    width: WIDTH,
    height: HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      song.update(frame.audio, frame.track, frame.dt);
      const pixels = target.open(image);
      if (!screen || screen.pixels !== pixels) screen = new Surface(WIDTH, HEIGHT, pixels);
      const nextLength = song.length(frame.track.duration);
      if (song.changes !== drawn || nextLength !== length) {
        drawn = song.changes;
        length = nextLength;
        drawPattern(base);
        drawOrders(base);
      }
      if (frame.track.title !== title) {
        title = frame.track.title;
        drawTitle(base, title);
      }
      pixels.set(base.pixels);
      drawMeters(screen, frame.dt);
      drawStatus(screen);
      target.close(image);
    }
  };
}
