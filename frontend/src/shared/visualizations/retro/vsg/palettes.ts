/**
 * The palettes of VSG+ (DOS), "press P": sixteen colours each, as 0xRRGGBB, written from each
 * machine's own colour values. No imports, so the tests run it as it is (vsg.test.ts).
 *
 * The effects draw with the sixteen colour numbers of the VGA's text and EGA modes: 0 black,
 * 1–6 the dark colours (blue, green, cyan, red, magenta, brown), 7 light grey, 8 dark grey, 9–14
 * their bright counterparts, 15 white. Another machine's palette gives each of those numbers the
 * colour of its own that plays the same part — its dark blue for 1, its yellow for 14 — so an
 * effect keeps its design (green, yellow and red segments, a dim grid, a white spark) in the
 * machine's colours. Where the machine has fewer colours, two numbers share one.
 */

export interface VsgPalette {
  readonly id: string;
  /** Shown by the harness; a proper name. */
  readonly name: string;
  /** Sixteen 0xRRGGBB values, colour number 0 (always black) first. */
  readonly colors: readonly number[];
}

function rgb(red: number, green: number, blue: number): number {
  return (red << 16) | (green << 8) | blue;
}

/** Amiga OCS: 12-bit 0xRGB, four bits a channel (0x5 is 0x55). */
function amiga(value: number): number {
  return rgb(((value >> 8) & 15) * 17, ((value >> 4) & 15) * 17, (value & 15) * 17);
}

/** Amstrad CPC: a firmware colour number 0–26, 9 × green + 3 × red + blue at 0, 50 and 100 %. */
function cpc(number: number): number {
  const level = [0x00, 0x80, 0xff];
  return rgb(level[Math.floor(number / 3) % 3]!, level[Math.floor(number / 9)]!, level[number % 3]!);
}

/** Sega Master System: a 6-bit CRAM value --BBGGRR, two bits a channel. */
function sms(value: number): number {
  return rgb((value & 3) * 85, ((value >> 2) & 3) * 85, ((value >> 4) & 3) * 85);
}

/** NES RGB PPU (2C03): three digits 0–7, red, green, blue, as the NESdev wiki tabulates them. */
function nes(digits: string): number {
  const level = (digit: string): number => Math.round((Number(digit) * 255) / 7);
  return rgb(level(digits[0]!), level(digits[1]!), level(digits[2]!));
}

/** The VGA BIOS's grey-scale summing for a monochrome monitor: 30 % red, 59 % green, 11 % blue. */
function grey(color: number): number {
  const value = Math.round(0.3 * ((color >> 16) & 255) + 0.59 * ((color >> 8) & 255) + 0.11 * (color & 255));
  return rgb(value, value, value);
}

/** IBM EGA, the VGA's sixteen colours in mode 12h at their power-on settings. */
const EGA = [
  0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
  0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff
];

export const PALETTES: readonly VsgPalette[] = [
  { id: "ega", name: "EGA", colors: EGA },
  // VSG's own effects had one colour before fomalhaut coloured them: white on black.
  { id: "bw", name: "Black & white", colors: [0x000000, ...new Array<number>(15).fill(0xffffff)] },
  {
    // The CPC's 27 colours (firmware numbers): 50 % ones for the dark numbers and its pure ones
    // for the bright; bright blue for blue, as its 50 % blue is the dim grey; orange for brown.
    id: "cpc",
    name: "Amstrad CPC",
    colors: [0, 2, 9, 10, 3, 4, 15, 13, 1, 11, 18, 20, 6, 8, 24, 26].map(cpc)
  },
  {
    // Commodore 64: Philip "Pepto" Timmermann's measured VIC-II colours, each of the sixteen once.
    id: "c64",
    name: "Commodore 64",
    colors: [
      0x000000, 0x352879, 0x588d43, 0x6c6c6c, 0x68372b, 0x6f4f25, 0x433900, 0x959595,
      0x444444, 0x6c5eb5, 0x9ad284, 0x70a4b2, 0x9a6759, 0x6f3d86, 0xb8c76f, 0xffffff
    ]
  },
  {
    // Amiga: sixteen of the 32 colours Deluxe Paint opens with (DPaint IV's default palette).
    id: "amiga",
    name: "Amiga",
    colors: [0x000, 0x00f, 0x080, 0x0b6, 0xa00, 0xc08, 0xa52, 0xaaa, 0x555, 0x0af, 0x8f0, 0x0dd, 0xe00, 0xc0e, 0xfe0, 0xfff].map(amiga)
  },
  {
    // Sega Master System: the fixed palette its VDP shows in the TMS9918 (SG-1000) modes, as CRAM
    // values — fifteen colours, its white standing in for light grey too.
    id: "sms",
    name: "Sega Master System",
    colors: [0x00, 0x10, 0x08, 0x04, 0x02, 0x01, 0x05, 0x3f, 0x15, 0x30, 0x0c, 0x3c, 0x03, 0x33, 0x0f, 0x3f].map(sms)
  },
  {
    // NES: Nintendo's RGB PPU (2C03, PlayChoice-10), whose palette is digital.
    id: "nes",
    name: "NES",
    colors: ["000", "006", "040", "044", "510", "403", "420", "555", "333", "447", "360", "077", "700", "737", "773", "777"].map(nes)
  },
  {
    // ZX Spectrum: the ULA's eight colours, normal and BRIGHT; blue stands in for dark grey.
    id: "zx",
    name: "ZX Spectrum",
    colors: [
      0x000000, 0x0000d7, 0x00d700, 0x00d7d7, 0xd70000, 0xd700d7, 0xd7d700, 0xd7d7d7,
      0x0000d7, 0x0000ff, 0x00ff00, 0x00ffff, 0xff0000, 0xff00ff, 0xffff00, 0xffffff
    ]
  },
  {
    // CGA, 320 × 200 palette 1 in high intensity: black, cyan, magenta and white.
    id: "cga",
    name: "CGA",
    colors: [
      0x000000, 0x55ffff, 0x55ffff, 0x55ffff, 0xff55ff, 0xff55ff, 0xff55ff, 0xffffff,
      0x55ffff, 0x55ffff, 0x55ffff, 0x55ffff, 0xff55ff, 0xff55ff, 0xffffff, 0xffffff
    ]
  },
  // A VGA on a monochrome monitor: the BIOS sums the colours to greys.
  { id: "mono", name: "Monochrome VGA", colors: EGA.map(grey) }
];

/** The default and the one the original drew with. */
export const DEFAULT_PALETTE = 0;

/** A palette as RGBA words for a Uint32Array over canvas pixels (byte order of this machine). */
export function packPalette(colors: readonly number[], littleEndian = true): Uint32Array {
  const words = new Uint32Array(16);
  for (let index = 0; index < 16; index += 1) {
    const color = colors[index] ?? 0;
    const red = (color >> 16) & 255;
    const green = (color >> 8) & 255;
    const blue = color & 255;
    words[index] = littleEndian
      ? ((255 << 24) | (blue << 16) | (green << 8) | red) >>> 0
      : ((red << 24) | (green << 16) | (blue << 8) | 255) >>> 0;
  }
  return words;
}
