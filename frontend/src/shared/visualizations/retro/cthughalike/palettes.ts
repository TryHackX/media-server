import type { Random } from "./random";

/**
 * The 256-colour palettes of the Cthugha-like scenes: our own gradients in the spirit of the
 * originals' colour maps (a black floor that the flames burn down to, then a run of hues up to a
 * hot top), plus generated ones for variety. Nothing here comes from Cthugha's map files.
 *
 * A palette is 768 bytes, RGB for each of the 256 values a pixel of the 8-bit picture can hold;
 * `toWords` turns it into the 32-bit words an RGBA canvas takes.
 */

export interface Palette {
  readonly name: string;
  readonly rgb: Uint8Array;
}

/** A gradient through stops: [value 0–255, 0xRRGGBB], in rising order. */
export function ramp(stops: readonly (readonly [number, number])[]): Uint8Array {
  const rgb = new Uint8Array(768);
  for (let index = 0; index < 256; index += 1) {
    let upper = stops.findIndex(([at]) => at >= index);
    if (upper < 0) upper = stops.length - 1;
    const lower = Math.max(0, upper - 1);
    const [fromAt, from] = stops[lower]!;
    const [toAt, to] = stops[upper]!;
    const t = toAt > fromAt ? Math.min(1, Math.max(0, (index - fromAt) / (toAt - fromAt))) : 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const shift = 16 - channel * 8;
      const a = (from >> shift) & 255;
      const b = (to >> shift) & 255;
      rgb[index * 3 + channel] = Math.round(a + (b - a) * t);
    }
  }
  return rgb;
}

/** HSL (hue in degrees, saturation and lightness 0–1) as 0xRRGGBB. */
export function hsl(hue: number, saturation: number, lightness: number): number {
  const h = (((hue % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = lightness - c / 2;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const byte = (value: number): number => Math.max(0, Math.min(255, Math.round((value + m) * 255)));
  return (byte(r) << 16) | (byte(g) << 8) | byte(b);
}

/** Hues cycling `cycles` times over the values, rising out of black; cyclic ones loop seamlessly. */
export function hueCycles(start: number, cycles: number, saturation: number, cyclic: boolean): Uint8Array {
  const rgb = new Uint8Array(768);
  for (let index = 0; index < 256; index += 1) {
    const t = index / 255;
    const hue = start + 360 * cycles * t;
    // Out of black at the bottom; a cyclic one breathes with each cycle instead.
    const lightness = cyclic ? 0.42 + 0.16 * Math.sin(2 * Math.PI * cycles * t) : Math.min(0.62, 0.05 + t * 0.85);
    const colour = hsl(hue, saturation, cyclic ? lightness : lightness * (index < 6 ? index / 6 : 1));
    rgb[index * 3] = colour >> 16;
    rgb[index * 3 + 1] = (colour >> 8) & 255;
    rgb[index * 3 + 2] = colour & 255;
  }
  return rgb;
}

function named(name: string, stops: readonly (readonly [number, number])[]): Palette {
  return { name, rgb: ramp(stops) };
}

/** Our own colour maps. The first value is black in all but a few, so the burnt-out picture is. */
export const PALETTES: readonly Palette[] = [
  named("Fire", [[0, 0x000000], [40, 0x2a0000], [90, 0xa00800], [140, 0xf04000], [190, 0xffa000], [230, 0xffe060], [255, 0xffffff]]),
  named("Solar Flare", [[0, 0x000000], [50, 0x300010], [100, 0xb00020], [150, 0xff5000], [200, 0xffe000], [235, 0xffffa0], [255, 0xa0ffff]]),
  named("Ember", [[0, 0x000000], [80, 0x400000], [150, 0xa01000], [210, 0xff6020], [255, 0xffd090]]),
  named("Lava Bands", [[0, 0x000000], [60, 0x600000], [110, 0xff4000], [150, 0xffd000], [168, 0x400000], [212, 0xff8000], [255, 0xfff0c0]]),
  named("Copper", [[0, 0x000000], [70, 0x3a1a0a], [140, 0xb06030], [200, 0xffa060], [255, 0xfff0e0]]),
  named("Blue Fire", [[0, 0x000000], [60, 0x000830], [120, 0x0030a0], [170, 0x1080ff], [215, 0x80e0ff], [255, 0xffffff]]),
  named("Ice", [[0, 0x000000], [70, 0x001428], [130, 0x105080], [190, 0x60c0e0], [235, 0xd0f8ff], [255, 0xffffff]]),
  named("Deep Sea", [[0, 0x000000], [80, 0x000c20], [150, 0x003c60], [200, 0x00a0a0], [240, 0xa0fff0], [255, 0xffffff]]),
  named("Violet Storm", [[0, 0x000000], [60, 0x0a0030], [120, 0x2828b0], [180, 0x6070ff], [225, 0xc0b0ff], [255, 0xffffff]]),
  named("Metallic Lightning", [[0, 0x000000], [60, 0x0c1018], [120, 0x404c64], [180, 0x9aa8c8], [225, 0xe0e8ff], [255, 0xffffff]]),
  named("Toxic", [[0, 0x000000], [60, 0x001400], [120, 0x007010], [180, 0x60e000], [225, 0xe0ff60], [255, 0xffffff]]),
  named("Scope Green", [[0, 0x000000], [80, 0x001808], [150, 0x008030], [210, 0x30ff80], [255, 0xd0ffe0]]),
  named("Aurora", [[0, 0x000000], [60, 0x001820], [110, 0x007060], [160, 0x20e080], [200, 0xc0ff40], [235, 0xffffa0], [255, 0xffffff]]),
  named("Acid", [[0, 0x000000], [50, 0x200000], [100, 0xc02000], [150, 0xf0a000], [200, 0xc0f000], [240, 0xf0ff80], [255, 0xffffff]]),
  named("Magenta", [[0, 0x000000], [60, 0x200020], [120, 0x800080], [180, 0xff30c0], [225, 0xffb0f0], [255, 0xffffff]]),
  named("Neon", [[0, 0x000000], [40, 0x200040], [90, 0x8020a0], [140, 0xf040f0], [180, 0xff90ff], [210, 0xa0ffd0], [235, 0x60ffb0], [255, 0xf0fff0]]),
  named("Candy", [[0, 0x000000], [50, 0x400020], [100, 0xff4060], [140, 0xffd040], [180, 0x60ff90], [220, 0xa0ffe0], [245, 0xff60ff], [255, 0xffffff]]),
  named("Lilac Smoke", [[0, 0x000000], [80, 0x180828], [150, 0x604080], [210, 0xc0a0e0], [255, 0xffffff]]),
  named("Oil Shimmer", [[0, 0x000000], [35, 0x200838], [70, 0x5020a0], [105, 0x2080c0], [140, 0x20c080], [175, 0xc0e040], [210, 0xffa040], [240, 0xff40a0], [255, 0xffffff]]),
  named("Prism", [[0, 0x000000], [40, 0x3000a0], [80, 0xe00060], [120, 0xff8000], [160, 0xffff00], [195, 0x40ff20], [225, 0x40ffd0], [255, 0xffffff]]),
  named("Thermal", [[0, 0x000000], [50, 0x100060], [100, 0x8000a0], [150, 0xe01040], [200, 0xffa000], [240, 0xffff80], [255, 0xffffff]]),
  named("Sunset", [[0, 0x000000], [60, 0x200030], [120, 0xa01060], [170, 0xff5030], [215, 0xffc060], [255, 0xfff0d0]]),
  named("Blue Yellow", [[0, 0x000000], [40, 0x400030], [80, 0xc00040], [120, 0x2020e0], [170, 0x1830ff], [210, 0xc8c820], [240, 0xffff60], [255, 0xffffff]]),
  named("Sepia", [[0, 0x000000], [50, 0x301810], [110, 0x905838], [170, 0xe0a070], [215, 0xf0d8a0], [255, 0xfff8e0]]),
  named("Gold", [[0, 0x000000], [70, 0x302000], [140, 0xa07000], [200, 0xffc030], [240, 0xfff0a0], [255, 0xffffff]]),
  named("Emerald Ice", [[0, 0x000000], [60, 0x002010], [120, 0x00805a], [180, 0x40e0c0], [230, 0xc0fff8], [255, 0xffffff]]),
  named("Plasma", [[0, 0x000000], [40, 0x100030], [90, 0x6000c0], [140, 0xff00a0], [190, 0xff8000], [230, 0xffff40], [255, 0xffffff]]),
  named("Cyan Magenta", [[0, 0x000000], [70, 0x002030], [130, 0x00a0c0], [170, 0xff40ff], [220, 0xffc0ff], [255, 0xffffff]]),
  named("Grey Ghost", [[0, 0x000000], [128, 0x707070], [255, 0xffffff]]),
  named("Green Gold", [[0, 0x000000], [70, 0x102808], [140, 0x507020], [200, 0xc0c040], [255, 0xfffff0]]),
  named("Red Blue", [[0, 0x000000], [60, 0x000080], [110, 0x4040ff], [150, 0xff2020], [200, 0xff6060], [255, 0xffe0e0]]),
  named("Electric", [[0, 0x000000], [60, 0x10002a], [120, 0x4000a0], [170, 0x00a0ff], [215, 0xa0ffff], [255, 0xffffff]]),
  named("Burnt", [[0, 0x000000], [70, 0x700000], [130, 0xff6000], [175, 0xffff80], [205, 0x804000], [235, 0x200000], [255, 0x000000]]),
  named("Peacock", [[0, 0x000000], [60, 0x001840], [110, 0x0060a0], [150, 0x00a080], [190, 0xa0c020], [225, 0xffd040], [255, 0xffffff]]),
  named("Blood", [[0, 0x000000], [70, 0x200000], [140, 0x800000], [200, 0xd00000], [240, 0xff5040], [255, 0xffd0c0]]),
  named("Mint", [[0, 0x000000], [80, 0x002018], [150, 0x00a080], [210, 0x80ffd0], [255, 0xffffff]]),
  named("Rose Gold", [[0, 0x000000], [60, 0x200810], [120, 0x803040], [180, 0xe08070], [225, 0xffd0a0], [255, 0xffffff]]),
  named("Night Sky", [[0, 0x000000], [90, 0x080830], [150, 0x302880], [200, 0x8060e0], [235, 0xffd0ff], [255, 0xffffff]]),
  named("Rainbow", hueCycleStops(270, 1)),
  named("Rainbow Twice", hueCycleStops(0, 2)),
  { name: "Spectrum Bands", rgb: bands(6, 200) },
  { name: "Contour", rgb: bands(10, 30) },
  { name: "Boil", rgb: hueCycles(30, 3, 0.95, true) },
  { name: "Boil Pastel", rgb: hueCycles(200, 2, 0.6, true) }
];

/** A rainbow as stops: black, then the hues `cycles` times round, then white. */
function hueCycleStops(start: number, cycles: number): [number, number][] {
  const stops: [number, number][] = [[0, 0x000000]];
  const count = 6 * cycles;
  for (let step = 0; step <= count; step += 1) {
    const at = Math.round(24 + (step / count) * 216);
    stops.push([at, hsl(start - (360 * cycles * step) / count, 1, 0.5)]);
  }
  stops.push([255, 0xffffff]);
  return stops;
}

/** Bands of hues with dark seams between them: flames drawn through it show contour lines. */
function bands(count: number, hue: number): Uint8Array {
  const rgb = new Uint8Array(768);
  for (let index = 0; index < 256; index += 1) {
    const t = index / 256;
    const within = (t * count) % 1;
    const band = Math.floor(t * count);
    const seam = Math.min(1, Math.min(within, 1 - within) * 7);
    const colour = hsl(hue + band * (300 / count), 0.9, (0.08 + 0.55 * t) * seam + 0.02);
    rgb[index * 3] = colour >> 16;
    rgb[index * 3 + 1] = (colour >> 8) & 255;
    rgb[index * 3 + 2] = colour & 255;
  }
  for (let channel = 0; channel < 3; channel += 1) rgb[channel] = 0;
  return rgb;
}

/**
 * A palette made up on the spot: two to four hues climbing out of black, now and then to white,
 * now and then with a dark band; or hues round the wheel. Each one different, as the originals'
 * dozens of colour maps were. `cyclic`: hues round the wheel that come back to where they began,
 * for a flame that boils round through them.
 */
export function inventPalette(random: Random, cyclic = false): Palette {
  const kind = random();
  const base = random() * 360;
  if (cyclic) return { name: "Cycle", rgb: hueCycles(base, 1 + Math.floor(random() * 3), 0.6 + random() * 0.4, true) };
  if (kind < 0.18) {
    return { name: "Cycle", rgb: hueCycles(base, 1 + Math.floor(random() * 3), 0.7 + random() * 0.3, false) };
  }
  const count = 2 + Math.floor(random() * 3);
  const step = (random() < 0.5 ? 1 : -1) * (25 + random() * 70);
  const stops: [number, number][] = [[0, 0x000000]];
  for (let k = 0; k < count; k += 1) {
    const at = Math.round(40 + ((k + 0.5) / count) * 170);
    stops.push([at, hsl(base + step * k, 0.75 + random() * 0.25, 0.25 + 0.4 * ((k + 1) / count))]);
  }
  const top = random();
  stops.push([255, top < 0.55 ? 0xffffff : top < 0.8 ? hsl(base + step * count, 1, 0.8) : 0x000000]);
  const rgb = ramp(stops);
  if (random() < 0.25) {
    // A dark band through the middle: the flames' bright cores come out ringed.
    const centre = 120 + Math.floor(random() * 80);
    for (let index = centre - 10; index <= centre + 10; index += 1) {
      const keep = Math.abs(index - centre) / 10;
      for (let channel = 0; channel < 3; channel += 1) rgb[index * 3 + channel] = Math.round(rgb[index * 3 + channel]! * keep);
    }
  }
  return { name: "Invented", rgb };
}

/** True where the platform stores the lowest byte of a word first (every browser in practice). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * One colour as the word an RGBA canvas holds, opaque, as a signed 32-bit number (an Int32Array
 * over the canvas's bytes): opaque colours are then small negative integers, which the engines
 * keep as integers where words above 2³¹ would turn into floating point.
 */
export function word(r: number, g: number, b: number): number {
  return LITTLE_ENDIAN
    ? (255 << 24) | (b << 16) | (g << 8) | r
    : (r << 24) | (g << 16) | (b << 8) | 255;
}

/** The palette as 256 words of an RGBA canvas. */
export function toWords(rgb: Uint8Array, out: Int32Array): void {
  for (let index = 0; index < 256; index += 1) out[index] = word(rgb[index * 3]!, rgb[index * 3 + 1]!, rgb[index * 3 + 2]!);
}

/** `from` on the way to `to`: t 0 is `from`, 1 is `to`. */
export function mix(from: Uint8Array, to: Uint8Array, t: number, out: Uint8Array): void {
  const k = Math.max(0, Math.min(1, t));
  for (let index = 0; index < 768; index += 1) out[index] = Math.round(from[index]! + (to[index]! - from[index]!) * k);
}

/**
 * True when value 0 is black (or nearly): what a fading flame burns down to. A palette without
 * one (the cyclic ones) only suits a flame that boils round through it.
 */
export function blackFloor(palette: Palette): boolean {
  return brightness(palette.rgb, 0) < 8;
}

/** How bright a value comes out (0–255, Rec. 601 weights): to find a palette's hot end. */
export function brightness(rgb: Uint8Array, index: number): number {
  return 0.299 * rgb[index * 3]! + 0.587 * rgb[index * 3 + 1]! + 0.114 * rgb[index * 3 + 2]!;
}
