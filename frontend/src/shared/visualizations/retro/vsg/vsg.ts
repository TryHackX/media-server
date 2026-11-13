import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { EFFECTS, type VsgEffectId } from "./effects";
import { HEIGHT, Listener, WIDTH, type VsgEffect, type VsgInput } from "./listen";
import { DEFAULT_PALETTE, packPalette, PALETTES } from "./palettes";
import { blit, Raster } from "./raster";

/**
 * VSG+ (DOS): a recreation of VSG 1.0 VGA ("View sounds in graphics"), the little QuickBASIC
 * program Neven Pintaric wrote in 2000, as fomalhaut grew it into VSG+ — twenty effects drawn
 * with circles, lines and dots on the 640 × 480 sixteen-colour screen of VGA mode 12h.
 *
 * VSG itself is nowhere to be found — no program, no source, no screenshot — and fomalhaut is
 * closed, so this is drawn from what fomalhaut's README tells: the names of the effects, its
 * description, and its screenshot of six of them (strings, VU bars, moiré, tunnel, circle scope,
 * Lissajous), which these follow as closely as the picture shows. The other fourteen are drawn
 * from their names in the same manner. Nothing of fomalhaut's code was used.
 *
 * The screen is cleared and drawn afresh each frame with whole-pixel primitives (raster.ts), then
 * looked up in the palette: EGA, or another machine's sixteen colours (palettes.ts). What an
 * effect remembers moves on 60 times a second, whatever the frame rate. "VSG+" (auto) changes the
 * effect on a kick once it has run 20 seconds, as fomalhaut does, and now and then the palette.
 */

/** The step of what an effect remembers: 60 a second. */
const TICK = 1 / 60;
/** Auto: an effect gives way on the first kick after this long, and without one after the latest. */
const SWITCH_AFTER = 20;
const SWITCH_LATEST = 32;
/**
 * Auto: how often a new effect brings another palette, how often that is EGA again, and for how
 * many effects at most another palette stays.
 */
const PALETTE_CHANCE = 0.35;
const BACK_TO_EGA = 0.5;
const PALETTE_STAYS = 3;
/** The effects' own sequence, the same each time: an effect starts the same way. */
const SEED = 0x56534721;

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export interface VsgScene extends RetroScene {
  /** The effect and palette on screen, for the harness. */
  describe(): string;
}

/** One effect for good, or "auto" to change them as VSG+ does; `palette` an id from palettes.ts. */
export function createVsg(choice: VsgEffectId | "auto", options: { palette?: string } = {}): VsgScene {
  const auto = choice === "auto";
  const random = seeded(auto ? (Math.random() * 4294967296) >>> 0 : SEED);
  const screen = new Raster(WIDTH, HEIGHT);
  const listener = new Listener();
  const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const palettes = PALETTES.map((palette) => packPalette(palette.colors, littleEndian));
  const asked = PALETTES.findIndex((palette) => palette.id === options.palette);
  let palette = asked >= 0 ? asked : DEFAULT_PALETTE;

  /** Auto deals the effects like a shuffled deck: all twenty before one comes again. */
  let deck: number[] = [];
  const deal = (): number => {
    if (!deck.length) {
      deck = EFFECTS.map((_, index) => index);
      for (let index = deck.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [deck[index], deck[other]] = [deck[other]!, deck[index]!];
      }
    }
    return deck.pop()!;
  };

  let current = auto ? deal() : Math.max(0, EFFECTS.findIndex((effect) => effect.id === choice));
  let effect: VsgEffect = EFFECTS[current]!.create(random);
  let shownFor = 0;
  /** Auto: effects shown since the palette last changed. */
  let paletteFor = 0;
  let clock = 0;
  let pending = 0;
  let started = false;
  /** A kick heard since the last tick (a frame may fall between two ticks). */
  let kicked = false;
  let view: Uint32Array | null = null;
  let viewOf: Uint8ClampedArray | null = null;

  const input: VsgInput = {
    audio: null as unknown as VsgInput["audio"],
    time: 0,
    dt: TICK,
    level: 0,
    levelLeft: 0,
    levelRight: 0,
    gain: 1,
    bands: listener.bands,
    bass: 0,
    treble: 0,
    beat: 0,
    onset: false,
    random
  };

  const change = (): void => {
    let next = deal();
    if (next === current) next = deal();
    current = next;
    effect = EFFECTS[current]!.create(random);
    shownFor = 0;
    clock = 0;
    started = false;
    paletteFor += 1;
    const away = palette !== DEFAULT_PALETTE;
    const due = away && paletteFor >= PALETTE_STAYS;
    if (due || random() < PALETTE_CHANCE) {
      paletteFor = 0;
      if (away && (due || random() < BACK_TO_EGA)) {
        palette = DEFAULT_PALETTE;
      } else {
        const others = PALETTES.map((_, index) => index).filter((index) => index !== palette);
        palette = others[Math.floor(random() * others.length)]!;
      }
    }
  };

  const tick = (): void => {
    clock += TICK;
    input.time = clock;
    input.dt = TICK;
    input.onset = kicked;
    kicked = false;
    effect.tick?.(input);
  };

  return {
    width: WIDTH,
    height: HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      const audio = frame.audio;
      const dt = Math.min(0.1, Math.max(0, frame.dt));
      listener.update(audio, dt);
      if (auto) {
        shownFor += dt;
        if ((shownFor >= SWITCH_AFTER && audio.onset) || shownFor >= SWITCH_LATEST) change();
      }
      input.audio = audio;
      input.level = listener.level;
      input.levelLeft = listener.levelLeft;
      input.levelRight = listener.levelRight;
      input.gain = listener.gain;
      input.bass = listener.bass;
      input.treble = listener.treble;
      input.beat = audio.beat;
      kicked ||= audio.onset;

      if (!started) {
        // A new effect takes one step before it is first drawn.
        started = true;
        pending = 0;
        tick();
      } else {
        pending += dt;
        // A hair under a tick counts as one, so 60 frames a second are 60 ticks, not 59 and 61.
        for (let steps = 0; pending >= TICK - 1e-6; steps += 1) {
          if (steps === 6) {
            pending = 0;
            break;
          }
          pending -= TICK;
          tick();
        }
      }
      input.time = clock + pending;
      input.dt = dt;
      input.onset = audio.onset;

      screen.clear(0);
      effect.draw(screen, input);

      const data = image.data;
      if (data.byteOffset % 4 === 0) {
        if (viewOf !== data || !view) {
          view = new Uint32Array(data.buffer, data.byteOffset, Math.min(data.length >> 2, WIDTH * HEIGHT));
          viewOf = data;
        }
        blit(screen.pixels, palettes[palette]!, view);
      } else {
        const colors = PALETTES[palette]!.colors;
        const pixels = screen.pixels;
        for (let index = 0, at = 0; index < pixels.length; index += 1, at += 4) {
          const color = colors[pixels[index]!]!;
          data[at] = (color >> 16) & 255;
          data[at + 1] = (color >> 8) & 255;
          data[at + 2] = color & 255;
          data[at + 3] = 255;
        }
      }
    },
    describe(): string {
      return `${EFFECTS[current]!.id} · ${PALETTES[palette]!.name}`;
    }
  };
}
