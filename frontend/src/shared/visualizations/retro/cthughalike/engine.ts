import type { RetroAudio } from "../types";
import { kaleidoMap, present, shownPart, type DisplayKind } from "./display";
import { burn, flameTable, speckleTable, tapCount, type FlameSpec } from "./flames";
import { Listener } from "./listen";
import { brightness, mix, toWords, type Palette } from "./palettes";
import { Particles, type ParticleScene } from "./particles";
import type { Random } from "./random";
import { makePicture, type Picture } from "./raster";
import { TableBuilder, translate, type TableSpec } from "./translate";
import { drawWave, WAVE_MEMORY, type WaveArea, type WaveKind } from "./waves";

/**
 * The machine both Cthugha-like scenes run on: an 8-bit picture that each step flows through a
 * translation table, burns in a flame, takes the particles and the newest wave, and reaches the
 * screen through a display and a palette that fades from one to the next. What runs when, and
 * what changes, is the scenes' business (cthugha98/, cthugha4winamp/).
 */

export interface Effect {
  flame: FlameSpec;
  wave: WaveKind | null;
  /** A second wave on top, now and then. */
  extraWave: WaveKind | null;
  table: TableSpec | null;
  particles: ParticleScene | null;
  display: DisplayKind;
  palette: Palette;
  /** Waves about the screen's middle (mirroring into one shape) or their area's. */
  centred: boolean;
  /** Wave scale. */
  scale: number;
  /** Waves from the smoothed samples (rounder) rather than the raw ones. */
  smooth?: boolean;
  /** How far up the palette the lines reach (1, the hot end; 0.7, coloured). */
  heat?: number;
}

/** Waves that fill an area (bars, lines from the middle): they want a flame that keeps them apart. */
export const FILLED_WAVES: readonly WaveKind[] = ["lightning", "analyzer", "analyzerMirror", "halo", "fan"];

/** Waves drawn as a compact shape about a point: a flame that hardly fades blurs them into a blob. */
export const COMPACT_WAVES: readonly WaveKind[] = ["starburst", "ring", "rings", "rose", "spiral", "halo", "lissajous", "sparks"];

/** Tables that carry everything outwards: with a flame that hardly fades they fill the screen. */
const SPREADING_TABLES: readonly string[] = ["zoom", "tunnel", "bubble", "fountain"];

/**
 * An effect made fit to look at. A wave that fills an area gets a flame that moves and fades
 * enough to keep it from setting into a slab; a compact one, a flame that fades enough not to
 * swell into a blob; a table that spreads everything outwards, enough fading not to flood the
 * screen. A boiling flame is left alone: filling the screen is what it is for.
 */
export function fitEffect(effect: Effect): Effect {
  if (effect.flame.rule === "boil") return effect;
  const has = (list: readonly WaveKind[]): boolean => Boolean((effect.wave && list.includes(effect.wave)) || (effect.extraWave && list.includes(effect.extraWave)));
  let { kernel, amount } = effect.flame;
  if (has(FILLED_WAVES)) {
    // Carried upwards it is a band of fire, the classic look, and may burn long; standing still
    // (or only blurred) it sets, so it fades fast.
    const standing = kernel === "still" || kernel === "glow" || kernel === "haze" || kernel === "streak";
    if (standing && !effect.table) kernel = "rise";
    const lightningOnly = effect.wave === "lightning" && (!effect.extraWave || effect.extraWave === "lightning");
    amount = Math.max(amount, kernel === "still" ? 8 : standing && effect.table ? 6 : lightningOnly ? 2 : 4);
  }
  if (has(COMPACT_WAVES) && kernel !== "still") amount = Math.max(amount, 2);
  if (effect.table && SPREADING_TABLES.includes(effect.table.kind)) amount = Math.max(amount, kernel === "still" ? 4 : 3);
  if (kernel === effect.flame.kernel && amount === effect.flame.amount) return effect;
  return { ...effect, flame: { ...effect.flame, kernel, amount } };
}

/** Seconds a palette takes to fade into the next. */
const PALETTE_FADE = 1.6;

export class CthughaEngine {
  readonly width: number;
  readonly height: number;
  readonly sound = new Listener();
  readonly random: Random;
  readonly particles: Particles;
  /** The picture being shown, and the one the next step is made in. */
  picture: Picture;
  private spare: Picture;
  effect: Effect | null = null;
  /** The palette on screen now (RGB and as words), and the hottest value to draw with. */
  readonly rgb = new Uint8Array(768);
  readonly words = new Int32Array(256);
  /** Counts the palette's changes, for whoever keeps something made from it. */
  paletteVersion = 0;
  hot = 255;
  private readonly fadeFrom = new Uint8Array(768);
  private fadeTo: Uint8Array = new Uint8Array(768);
  private fade = 1;
  private flameLut: Uint8Array = new Uint8Array(255 * 8 + 1);
  private readonly speckle: Uint8Array;
  private speckleMost = 0;
  private table: Int32Array | null = null;
  private builder: TableBuilder | null = null;
  private kaleido: Int32Array | null = null;
  private readonly memory = new Float32Array(WAVE_MEMORY);
  private readonly extraMemory = new Float32Array(WAVE_MEMORY);
  private steps = 0;

  constructor(width: number, height: number, random: Random) {
    this.width = width;
    this.height = height;
    this.random = random;
    this.picture = makePicture(width, height);
    this.spare = makePicture(width, height);
    this.particles = new Particles(width, height, random);
    this.speckle = speckleTable(random, 6);
  }

  hear(audio: RetroAudio, dt: number): void {
    this.sound.hear(audio, dt);
  }

  /** Puts an effect on; the palette fades in, a new table is made over the next steps. */
  apply(wanted: Effect, instantPalette = false): void {
    const effect = fitEffect(wanted);
    const before = this.effect;
    this.effect = effect;
    this.flameLut = flameTable(effect.flame, tapCount(effect.flame.kernel), this.flameLut);
    this.speckleMost = effect.flame.speckle ?? 0;
    if (!before || before.palette !== effect.palette) this.setPalette(effect.palette, instantPalette || !before);
    if (!sameTable(before?.table ?? null, effect.table)) {
      if (effect.table) this.builder = new TableBuilder(effect.table, this.width, this.height);
      else {
        this.builder = null;
        this.table = null;
      }
    }
    if (effect.particles && (!before || before.particles !== effect.particles)) this.particles.begin(effect.particles);
  }

  setPalette(palette: Palette, instant: boolean): void {
    this.fadeFrom.set(this.rgb);
    this.fadeTo = palette.rgb;
    this.fade = instant ? 1 : 0;
    if (instant) this.rgb.set(palette.rgb);
    toWords(this.rgb, this.words);
    this.paletteVersion += 1;
    // The hottest value: where the palette is brightest in its upper half.
    let best = 255;
    let bestLight = -1;
    for (let index = 255; index >= 128; index -= 1) {
      const light = brightness(palette.rgb, index);
      if (light > bestLight + 4) {
        best = index;
        bestLight = light;
      }
    }
    this.hot = best;
  }

  /** The part of the picture the display shows, where waves are drawn. */
  area(): WaveArea {
    const shown = shownPart(this.effect?.display ?? "normal");
    return { x0: 0, y0: 0, x1: shown.right ? this.width : Math.ceil(this.width / 2), y1: shown.bottom ? this.height : Math.ceil(this.height / 2) };
  }

  /**
   * The picture flows, burns, and takes the particles and the wave. `time` in seconds; `kicks`,
   * the kicks heard since the last step (the scene took them from the listener).
   */
  step(time: number, dt: number, options: { wave?: boolean; kicks?: number } = {}): void {
    const effect = this.effect;
    if (!effect) return;
    this.steps += 1;
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / PALETTE_FADE);
      mix(this.fadeFrom, this.fadeTo, this.fade * this.fade * (3 - 2 * this.fade), this.rgb);
      toWords(this.rgb, this.words);
      this.paletteVersion += 1;
    }
    if (this.builder) {
      // A new table, a slice of rows per step; it takes over when it is whole.
      if (this.builder.advance(Math.ceil(this.height / 8))) {
        this.table = this.builder.table;
        this.builder = null;
      }
    }
    if (this.table) {
      translate(this.picture.data, this.spare.data, this.table);
      this.swap();
    }
    burn(effect.flame.kernel, this.picture.data, this.spare.data, this.width, this.height, this.flameLut, this.speckleMost ? this.speckle : null, (this.random() * 65536) | 0, time);
    this.swap();
    if (effect.particles) {
      this.particles.step(this.sound, time, this.area(), (options.kicks ?? 0) > 0);
      this.particles.draw(this.picture, this.hot);
    }
    if (options.wave !== false) {
      const area = this.area();
      const context = {
        picture: this.picture, sound: this.sound, random: this.random, time, step: this.steps,
        hot: this.hot, scale: effect.scale, area, centred: effect.centred, memory: this.memory,
        smooth: effect.smooth ?? true, heat: effect.heat ?? 1
      };
      if (effect.wave) drawWave(effect.wave, context);
      if (effect.extraWave) drawWave(effect.extraWave, { ...context, memory: this.extraMemory, centred: !effect.centred });
    }
  }

  private swap(): void {
    const used = this.picture;
    this.picture = this.spare;
    this.spare = used;
  }

  /** Everything burnt out at once (a new song). */
  clear(): void {
    this.picture.data.fill(0);
    this.spare.data.fill(0);
  }

  /** The picture through the display, in colour (`palette` the words) or as values (IDENTITY). */
  show(out: Int32Array | Uint8Array, palette: ArrayLike<number> = this.words): void {
    const display = this.effect?.display ?? "normal";
    if (display === "kaleido" && !this.kaleido) this.kaleido = kaleidoMap(this.width, this.height);
    present(display, this.picture.data, this.width, this.height, palette, out, this.kaleido);
  }
}

function sameTable(a: TableSpec | null, b: TableSpec | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.strength === b.strength && a.turn === b.turn && a.seed === b.seed && a.centreX === b.centreX && a.centreY === b.centreY;
}

/**
 * A shaded ball laid into the picture, as the originals laid in their pictures now and then: our
 * own, a sphere lit from the upper left, its values climbing to the palette's hot end.
 */
export function drawBall(picture: Picture, cx: number, cy: number, radius: number, hot: number): void {
  const { width, height, data } = picture;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y += 1) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(width - 1, Math.ceil(cx + radius)); x += 1) {
      const u = (x - cx) / radius;
      const v = (y - cy) / radius;
      const r2 = u * u + v * v;
      if (r2 > 1) continue;
      const z = Math.sqrt(1 - r2);
      const light = Math.max(0, -0.5 * u - 0.55 * v + 0.67 * z);
      const glare = Math.pow(Math.max(0, light), 12);
      data[y * width + x] = Math.round(Math.min(hot, (0.12 + 0.75 * light + 0.25 * glare) * hot));
    }
  }
}
