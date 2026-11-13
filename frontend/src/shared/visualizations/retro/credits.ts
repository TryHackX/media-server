import { t } from "../../i18n";
import { CREDITS } from "./credits-list";
import { VGA } from "./trackers/fonts";
import { type Font, rgb, sheet, Surface, Target } from "./trackers/raster";
import type { PixelImage, RetroFrame, RetroScene } from "./types";

/**
 * "Autorzy" (Credits): who made the originals "Klasyka retro" recreates or ports, rolled up a
 * 320 × 256 screen as an Amiga demo or a DOS intro rolled its greetings — the title in copper
 * colours, a starfield behind, two raster bars, the names in an 8 × 8 font fading in at the
 * bottom and out at the top, a strip of the spectrum below. The music moves it gently: the stars
 * hurry with its level, the bars and the title brighten on a beat, the strip follows the sound;
 * the names keep their pace, to be read. The list is credits-list.ts; names are never translated,
 * headings and notes go through t().
 */

const WIDTH = 320;
const HEIGHT = 256;
const BLACK = rgb(0x000000);
const WHITE = rgb(0xf0f0f0);
const GREY = rgb(0x9098a8);

const font: Font = sheet(VGA.sheet, VGA.cell, VGA.height, VGA.fixed);

/** The copper's colours: blue, violet, red, orange, yellow, white, round again. */
const COPPER: readonly (readonly [number, number, number])[] = [
  [0x20, 0x40, 0xc0], [0x80, 0x30, 0xc0], [0xd0, 0x30, 0x60], [0xf0, 0x70, 0x20], [0xf0, 0xd0, 0x40], [0xf8, 0xf8, 0xf0], [0x40, 0xa0, 0xf0]
];

function copper(position: number, brightness = 1): number {
  const n = COPPER.length;
  const p = ((position % n) + n) % n;
  const i = Math.floor(p);
  const f = p - i;
  const a = COPPER[i]!;
  const b = COPPER[(i + 1) % n]!;
  const channel = (k: number): number => Math.max(0, Math.min(255, Math.round((a[k]! + (b[k]! - a[k]!) * f) * brightness)));
  return rgb((channel(0) << 16) | (channel(1) << 8) | channel(2));
}

function scale(colour: number, by: number): number {
  const r = colour & 0xff;
  const g = (colour >>> 8) & 0xff;
  const b = (colour >>> 16) & 0xff;
  const k = (v: number): number => Math.max(0, Math.min(255, Math.round(v * by)));
  return rgb((k(r) << 16) | (k(g) << 8) | k(b));
}

/** A line of the roll: its text and how it is drawn. */
interface Line {
  text: string;
  kind: "heading" | "program" | "name" | "note" | "space";
}

/** The roll, its headings and notes in the interface's language, the names as they are. */
function roll(): Line[] {
  const lines: Line[] = [{ text: "", kind: "space" }];
  for (const section of CREDITS) {
    if (section.heading) {
      lines.push({ text: t(section.heading).toUpperCase(), kind: "heading" }, { text: "", kind: "space" });
    }
    for (const entry of section.entries) {
      lines.push({ text: entry.program, kind: "program" });
      for (const line of entry.lines) lines.push({ text: line, kind: "name" });
      for (const note of entry.notes ?? []) lines.push({ text: t(note), kind: "note" });
      lines.push({ text: "", kind: "space" });
    }
    lines.push({ text: "", kind: "space" });
  }
  lines.push({ text: t("Dziękujemy!").toUpperCase(), kind: "heading" });
  return lines;
}

/**
 * Text in the 8 × 8 font with its accents: the base letter, then a mark of a pixel or two above
 * it (or a hook below), as a PC's code page drew č, é, ü or ę.
 */
function write(s: Surface, x: number, y: number, text: string, colour: number, scaleBy = 1): void {
  for (const char of text) {
    const parts = char.normalize("NFD");
    let base = parts[0] ?? " ";
    if (char === "ł" || char === "Ł") base = char === "ł" ? "l" : "L";
    if (char === "·") base = "·";
    // The PC's font has no dashes of its own: a hyphen for the year ranges.
    if (char === "–" || char === "—") base = "-";
    const glyph = font.glyphs.get(base) ?? font.glyphs.get(base.toUpperCase());
    if (glyph) s.bits(x, y, glyph.rows, glyph.width, colour, scaleBy, scaleBy);
    const mark = (dx: number, dy: number): void => s.fill(x + dx * scaleBy, y + dy * scaleBy, scaleBy, scaleBy, colour);
    for (const accent of parts.slice(1)) {
      if (accent === "́") { mark(4, 0); mark(3, 1); }
      else if (accent === "̌") { mark(2, 0); mark(4, 0); mark(3, 1); }
      else if (accent === "̈") { mark(2, 0); mark(5, 0); }
      else if (accent === "̇") mark(3, 0);
      else if (accent === "̨") { mark(4, 7); mark(5, 8); }
    }
    if (char === "ł" || char === "Ł") { mark(2, 4); mark(4, 2); }
    x += 8 * scaleBy;
  }
}

function centred(s: Surface, y: number, text: string, colour: number, scaleBy = 1): void {
  write(s, Math.round((WIDTH - [...text].length * 8 * scaleBy) / 2), y, text, colour, scaleBy);
}

const WINDOW_TOP = 58;
const WINDOW_BOTTOM = 222;
const LINE = 10;
const SPEED = 22;
const FADE = 18;
const STARS = 90;
const BANDS = 40;

export function createCredits(): RetroScene {
  const target = new Target();
  let screen: Surface | null = null;
  let lines = roll();
  let language = t("Autorzy");
  /** The title's pixels at twice the font's size, made again when the language changes. */
  const titleMask = (): Uint8Array => {
    const title = t("Klasyka retro").toUpperCase();
    const surface = new Surface(WIDTH, 16);
    write(surface, Math.round((WIDTH - [...title].length * 16) / 2), 0, title, WHITE, 2);
    return Uint8Array.from(surface.pixels, (pixel) => (pixel ? 1 : 0));
  };
  let mask = titleMask();
  /** The stars: x, y, layer. */
  const stars = Array.from({ length: STARS }, (_, i) => ({ x: (i * 97.13) % WIDTH, y: 8 + ((i * 53.71) % (HEIGHT - 16)), layer: i % 3 }));
  let level = 0;
  let pulse = 0;
  let travel = 0;
  const bands = new Float32Array(BANDS);

  return {
    width: WIDTH,
    height: HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      const audio = frame.audio;
      const pixels = target.open(image);
      if (!screen || screen.pixels !== pixels) screen = new Surface(WIDTH, HEIGHT, pixels);
      const s = screen;
      // The words follow the interface's language; the names stay as they are.
      if (t("Autorzy") !== language) {
        language = t("Autorzy");
        lines = roll();
        mask = titleMask();
      }
      const loud = Math.max(audio.rmsLeft, audio.rmsRight);
      level += (Math.min(1, loud * 3) - level) * (1 - Math.exp(-frame.dt / 0.4));
      pulse = Math.max(pulse * Math.exp(-frame.dt / 0.25), audio.beat);
      s.fill(0, 0, WIDTH, HEIGHT, BLACK);

      // The stars, slower the further away; the music hurries them a little.
      travel += frame.dt * (1 + 1.5 * level);
      for (const star of stars) {
        const speed = [6, 14, 28][star.layer]!;
        const x = Math.floor((star.x + travel * speed) % WIDTH);
        s.pixel(x, Math.floor(star.y), [rgb(0x404858), rgb(0x8890a0), WHITE][star.layer]!);
      }

      // Two raster bars behind the names, brighter on a beat.
      const time = frame.time;
      for (let bar = 0; bar < 2; bar += 1) {
        const middle = (WINDOW_TOP + WINDOW_BOTTOM) / 2 + Math.sin(time * (0.7 + bar * 0.45) + bar * 2.1) * 58;
        for (let dy = -8; dy <= 8; dy += 1) {
          const y = Math.round(middle + dy);
          if (y < WINDOW_TOP || y > WINDOW_BOTTOM) continue;
          const shade = (1 - Math.abs(dy) / 9) * (0.22 + 0.18 * pulse);
          s.fill(0, y, WIDTH, 1, copper(bar * 3 + 1.2 + dy / 12, shade));
        }
      }

      // The title in the copper's colours, rolling through them; a line of the copper below.
      const shine = 0.8 + 0.2 * pulse;
      for (let row = 0; row < 16; row += 1) {
        // Each row of the doubled letters in its own colour, as a copper list changed it.
        const colour = copper(time * 0.6 + row / 6, shine);
        for (let x = 0; x < WIDTH; x += 1) if (mask[row * WIDTH + x]) s.pixel(x, 10 + row, colour);
      }
      centred(s, 32, language.toUpperCase(), GREY);
      for (let x = 0; x < WIDTH; x += 1) s.pixel(x, 46, copper(time * 1.2 + x / 40, 0.9));

      // The roll: from below the window to above it, again and again.
      const total = lines.length * LINE + (WINDOW_BOTTOM - WINDOW_TOP);
      const offset = (time * SPEED) % total;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.kind === "space") continue;
        const y = Math.round(WINDOW_BOTTOM - offset + index * LINE);
        if (y < WINDOW_TOP - 8 || y > WINDOW_BOTTOM) continue;
        const edge = Math.min(y - WINDOW_TOP, WINDOW_BOTTOM - 8 - y);
        const fade = Math.max(0, Math.min(1, edge / FADE));
        if (fade <= 0) continue;
        const colour = line.kind === "heading" ? copper(time * 0.8 + index * 0.3, fade)
          : line.kind === "program" ? copper(4.2 + Math.sin(index) * 0.5, fade)
            : line.kind === "note" ? scale(GREY, fade) : scale(WHITE, fade);
        centred(s, y, line.text, colour);
      }

      // The strip of the spectrum, quietly at the bottom.
      const spectrum = audio.spectrum;
      for (let band = 0; band < BANDS; band += 1) {
        const from = Math.floor(Math.pow(spectrum.length, band / BANDS));
        const to = Math.max(from + 1, Math.floor(Math.pow(spectrum.length, (band + 1) / BANDS)));
        let peak = 0;
        for (let i = from; i < to && i < spectrum.length; i += 1) peak = Math.max(peak, spectrum[i]!);
        bands[band] = Math.max(peak, bands[band]! - frame.dt * 0.9);
        const height = Math.round(bands[band]! * 14);
        for (let dy = 0; dy < height; dy += 1) s.fill(band * 8 + 1, 248 - dy, 6, 1, copper(1.5 + dy / 5, 0.55));
      }
      target.close(image);
    }
  };
}
