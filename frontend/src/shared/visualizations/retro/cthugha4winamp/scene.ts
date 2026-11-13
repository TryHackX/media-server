import { CthughaEngine, type Effect } from "../cthughalike/engine";
import type { DisplayKind } from "../cthughalike/display";
import type { FlameKernel, FlameRule, FlameSpec } from "../cthughalike/flames";
import { spellTitle } from "../cthughalike/font-block";
import { drawBlockLetter, TEXT_FACES, textUnits, writeText, type LetterStyle, type TextFace } from "../cthughalike/lettering";
import { blackFloor, inventPalette, PALETTES, type Palette } from "../cthughalike/palettes";
import { between, freshSeed, pick, seeded, weighted, whole, type Random } from "../cthughalike/random";
import type { TableKind, TableSpec } from "../cthughalike/translate";
import type { WaveKind } from "../cthughalike/waves";
import type { PixelImage, RetroFrame, RetroScene } from "../types";

/**
 * Cthugha-4-Winamp (Krunoslav Pisačić's Cthugha plug-in for Winamp, 1998, here as its version
 * 1.50 looked), recreated: our own engine (cthughalike/) after the plug-in's page and a recording
 * of it, nothing of its code. A 640 × 480 picture in 256 colours: flames and waves, translations,
 * mirrored and four-way displays, dozens of palettes; the effect changes after a number of beats.
 *
 * At the start of each song big 3D letters, one at a time, turn and spell its title; then the
 * title is written into the picture and burns away with it. Now and then during the song the
 * title comes back, in another face and place, and sometimes the letters too.
 */

export interface C4wSettings {
  /** The waves: the oscilloscope ones, the analyzer ones (the plug-in had both), or either. */
  wave?: "scope" | "analyzer" | "any";
  /** Always a translation table (its `.tab` translations; ours are our own). */
  translate?: boolean;
  /** A display it keeps. */
  display?: DisplayKind;
  seed?: number;
}

const WIDTH = 640;
const HEIGHT = 480;
const STEP = 1 / 30;
/** Seconds each letter of the intro turns, and the most letters an intro spells. */
const LETTER_SECONDS = 1.05;
const MOST_LETTERS = 14;
/** Seconds the title stays written into the picture. */
const TITLE_SECONDS = 5;

const KERNELS: readonly (readonly [FlameKernel, number])[] = [
  ["still", 4], ["rise", 3], ["glow", 2], ["haze", 1], ["sway", 1.5], ["riseFast", 1], ["lift", 1.5],
  ["climbLeft", 0.7], ["climbRight", 0.7], ["fall", 0.6], ["left", 0.5], ["right", 0.5], ["streak", 0.6]
];

const SCOPES: readonly (readonly [WaveKind, number])[] = [
  ["scope", 4], ["scopeDots", 2], ["stereo", 3], ["stereoDots", 1.5], ["vertical", 2], ["lightning", 2],
  ["ring", 2.5], ["rings", 2], ["lissajous", 2.5], ["starburst", 2], ["spiral", 1.5], ["arches", 2],
  ["fan", 1.5], ["rose", 1.5], ["ridges", 1.2], ["cross", 1], ["ribbon", 1.2], ["zigzag", 1], ["sparks", 1]
];

const ANALYZERS: readonly (readonly [WaveKind, number])[] = [
  ["analyzer", 3], ["analyzerMirror", 2], ["analyzerLine", 2], ["halo", 2]
];

const TABLES: readonly (readonly [TableKind, number])[] = [
  ["zoom", 4], ["rotate", 2], ["swirl", 2], ["hurricane", 2], ["smoke", 2.5], ["ripple", 1.5], ["warp", 2],
  ["tunnel", 2], ["implode", 1.5], ["twin", 1], ["drain", 1], ["rings", 1.5], ["shear", 1], ["flag", 1]
];

/** The plug-in's displays: as it is, mirrored, mirrored down, four ways. */
const DISPLAYS: readonly (readonly [DisplayKind, number])[] = [
  ["normal", 3], ["mirror", 2.5], ["mirrorDown", 1.2], ["quad", 2]
];

/** The intro's look: white letters on black, a short glow behind them as they turn. */
const INTRO_PALETTE: Palette = PALETTES.find((palette) => palette.name === "Grey Ghost") ?? PALETTES[0]!;

function chooseFlame(random: Random, moving: boolean): FlameSpec {
  let kernel = weighted(random, KERNELS);
  if (kernel === "still" && !moving) kernel = weighted(random, [["rise", 2], ["glow", 1]] as const);
  let rule: FlameRule = weighted(random, [["decay", 8], ["boil", 0.9], ["swell", 0.4]] as const);
  if (rule === "swell" && kernel !== "haze") rule = "decay";
  let amount: number;
  if (rule === "boil") amount = whole(random, 1, 3);
  else if (rule === "swell") amount = whole(random, 1, 3);
  else if (kernel === "still") amount = whole(random, 2, 7);
  else amount = whole(random, 1, 4);
  return { kernel, rule, amount, speckle: random() < 0.25 ? whole(random, 2, 5) : 0 };
}

function chooseTable(random: Random): TableSpec {
  return {
    kind: weighted(random, TABLES),
    strength: between(random, 0.6, 1.4),
    turn: random() < 0.5 ? -1 : 1,
    seed: whole(random, 1, 999_999),
    centreX: random() < 0.8 ? 0.5 : between(random, 0.3, 0.7),
    centreY: random() < 0.8 ? 0.5 : between(random, 0.3, 0.7)
  };
}

function chooseWave(random: Random, settings: C4wSettings): WaveKind {
  const which = settings.wave ?? "any";
  if (which === "scope") return weighted(random, SCOPES);
  if (which === "analyzer") return weighted(random, ANALYZERS);
  return random() < 0.22 ? weighted(random, ANALYZERS) : weighted(random, SCOPES);
}

/** A palette for a flame: a black floor unless the flame boils round through the colours. */
function choosePalette(random: Random, boiling: boolean): Palette {
  if (boiling && random() < 0.45) return inventPalette(random, true);
  for (;;) {
    const palette = random() < 0.5 ? pick(random, PALETTES) : inventPalette(random);
    if (blackFloor(palette) && palette !== INTRO_PALETTE) return palette;
  }
}

/** A table of a kind about the middle, the rest of it at random. */
function tableOf(random: Random, kind: TableKind, strength: number): TableSpec {
  return { ...chooseTable(random), kind, strength, centreX: 0.5, centreY: 0.5 };
}

/**
 * Looks the plug-in's recording shows again and again, kept as favourites (it had a list of
 * them) and dealt now and then: scope lines fanned out by a translation, a bundle of arches left
 * standing, a starburst on fire, many rings, fans from the corners four ways, a rose, loops, the
 * spectrum burning. Each fills in some of the effect; the rest is chosen as usual.
 */
const SCOPE_RECIPES: readonly ((random: Random) => Partial<Effect>)[] = [
  (random) => ({ wave: pick(random, ["scope", "stereo", "zigzag"] as const), table: tableOf(random, pick(random, ["zoom", "rotate", "tunnel"] as const), between(random, 0.8, 1.3)), flame: { kernel: "still", rule: "decay", amount: whole(random, 4, 6) } }),
  (random) => ({ wave: "arches", table: null, flame: { kernel: "still", rule: "decay", amount: whole(random, 5, 8) }, display: pick(random, ["normal", "mirror"] as const) }),
  (random) => ({ wave: "starburst", table: null, flame: { kernel: pick(random, ["rise", "glow"] as const), rule: "decay", amount: whole(random, 3, 4) }, scale: 1.8 }),
  (random) => ({ wave: "rings", table: tableOf(random, "rotate", 0.6), flame: { kernel: "still", rule: "decay", amount: whole(random, 3, 5) } }),
  () => ({ wave: "fan", table: null, flame: { kernel: "still", rule: "decay", amount: 6 }, display: "quad" }),
  (random) => ({ wave: "rose", table: null, flame: { kernel: "glow", rule: "decay", amount: whole(random, 2, 3) }, display: pick(random, ["mirror", "quad"] as const) }),
  (random) => ({ wave: "lissajous", table: tableOf(random, "swirl", 0.8), flame: { kernel: "still", rule: "decay", amount: whole(random, 4, 6) } })
];

const ANALYZER_RECIPES: readonly ((random: Random) => Partial<Effect>)[] = [
  (random) => ({ wave: "analyzer", table: null, flame: { kernel: pick(random, ["rise", "riseFast", "sway"] as const), rule: "decay", amount: 6 }, display: pick(random, ["normal", "mirror"] as const) }),
  (random) => ({ wave: "halo", table: tableOf(random, "zoom", 1.2), flame: { kernel: "still", rule: "decay", amount: 5 } }),
  (random) => ({ wave: "analyzerMirror", table: tableOf(random, "implode", 0.8), flame: { kernel: "glow", rule: "decay", amount: 6 } })
];

function inventEffect(random: Random, settings: C4wSettings): Effect {
  const wave = chooseWave(random, settings);
  const table = settings.translate || random() < 0.45 ? chooseTable(random) : null;
  const flame = chooseFlame(random, table !== null);
  const effect: Effect = {
    flame,
    wave,
    extraWave: random() < 0.1 ? chooseWave(random, settings) : null,
    table,
    particles: null,
    display: settings.display ?? weighted(random, DISPLAYS),
    palette: choosePalette(random, flame.rule === "boil"),
    centred: random() < 0.6,
    // The plug-in's wave scale: as it comes, or doubled.
    scale: random() < 0.75 ? 1 : 1.8,
    smooth: random() < 0.75,
    heat: random() < 0.45 ? 1 : between(random, 0.65, 0.9)
  };
  if (random() < 0.4) {
    const which = settings.wave ?? "any";
    const recipes = which === "scope" ? SCOPE_RECIPES : which === "analyzer" ? ANALYZER_RECIPES : random() < 0.75 ? SCOPE_RECIPES : ANALYZER_RECIPES;
    const recipe = pick(random, recipes)(random);
    const mixed: Effect = { ...effect, ...recipe, extraWave: null, display: settings.display ?? recipe.display ?? effect.display };
    if (settings.translate && !mixed.table) mixed.table = chooseTable(random);
    if (!blackFloor(mixed.palette)) mixed.palette = choosePalette(random, false);
    return mixed;
  }
  return effect;
}

/** The title written into the picture: where, how big, in which face, for how long. */
interface Writing {
  lines: { text: string; face: TextFace; cap: number; x: number; y: number }[];
  until: number;
}

/** Letters turning one after another. */
interface Spelling {
  letters: string[];
  from: number;
  style: LetterStyle;
  /** The song intro on black, or letters thrown into the running effect. */
  intro: boolean;
}

export function createCthugha4Winamp(settings: C4wSettings): RetroScene & { describe(): string } {
  // A seed set on globalThis (the offline harness's --cseed) replays a run exactly.
  const random = seeded(settings.seed ?? (globalThis as { cthughaSeed?: number }).cthughaSeed ?? freshSeed());
  const engine = new CthughaEngine(WIDTH, HEIGHT, random);
  const screen = new Int32Array(WIDTH * HEIGHT);
  const screenBytes = new Uint8ClampedArray(screen.buffer);
  let effect = inventEffect(random, settings);
  engine.apply(effect, true);
  let pending = 0;
  let clock = 0;
  let title = "";
  let spelling: Spelling | null = null;
  let writing: Writing | null = null;
  let beats = 0;
  let beatsToChange = whole(random, 16, 40);
  let beatsToTitle = whole(random, 48, 96);
  let sinceChange = 0;
  let changes = 0;

  const change = (): void => {
    changes += 1;
    effect = inventEffect(random, settings);
    engine.apply(effect);
    beats = 0;
    beatsToChange = whole(random, 16, 40);
    sinceChange = 0;
  };

  /** The title (and the artist) written somewhere in the part of the picture that shows. */
  const write = (seconds: number): void => {
    const [name, artist] = title.split(" — ");
    const area = engine.area();
    const areaWidth = area.x1 - area.x0;
    const areaHeight = area.y1 - area.y0;
    const lines: Writing["lines"] = [];
    const parts = [name, artist].filter((part): part is string => Boolean(part && part.trim()));
    const copies = random() < 0.25 ? 2 : 1;
    for (let copy = 0; copy < copies; copy += 1) {
      // The song's name, and the artist's under it, smaller, in a face of its own.
      let y = area.y0 + between(random, copies > 1 ? 0.12 + copy * 0.45 : 0.2, copies > 1 ? 0.3 + copy * 0.45 : 0.6) * areaHeight;
      for (const [index, text] of parts.entries()) {
        const face = pick(random, TEXT_FACES);
        // As big as fits the area.
        const units = Math.max(1, textUnits(text, face));
        const fit = ((areaWidth * 0.9) / units) * 10;
        const cap = Math.max(10, Math.min(index === 0 ? 48 : 24, fit, areaHeight * (index === 0 ? 0.13 : 0.08)));
        const width = (units * cap) / 10;
        if (index > 0) y += cap * 1.9;
        lines.push({
          text,
          face,
          cap,
          x: area.x0 + between(random, 0.03, Math.max(0.04, 0.97 - width / areaWidth)) * areaWidth,
          y: Math.min(area.y1 - cap, y)
        });
        y += cap * 0.6;
      }
    }
    writing = { lines, until: clock + seconds };
  };

  const startIntro = (): void => {
    const letters = spellTitle(title, MOST_LETTERS);
    if (!letters.length) {
      write(TITLE_SECONDS);
      return;
    }
    spelling = { letters, from: clock, style: random() < 0.75 ? "wire" : "solid", intro: true };
    engine.clear();
    engine.apply({
      flame: { kernel: "still", rule: "decay", amount: 150 },
      wave: null,
      extraWave: null,
      table: null,
      particles: null,
      display: "normal",
      palette: INTRO_PALETTE,
      centred: true,
      scale: 1
    }, true);
  };

  /** The letter turning now, drawn into the picture. */
  const drawSpelling = (): void => {
    if (!spelling) return;
    const elapsed = clock - spelling.from;
    const index = Math.floor(elapsed / LETTER_SECONDS);
    if (index >= spelling.letters.length) {
      const wasIntro = spelling.intro;
      spelling = null;
      if (wasIntro) {
        // The intro is over: the effects return, the title is written.
        change();
        write(TITLE_SECONDS);
      }
      return;
    }
    const within = (elapsed - index * LETTER_SECONDS) / LETTER_SECONDS;
    const area = engine.area();
    const intro = spelling.intro;
    const size = (intro ? HEIGHT * 0.62 : (area.y1 - area.y0) * 0.55);
    drawBlockLetter(engine.picture, spelling.letters[index]!, {
      // A turn and a quarter about the upright as the letter comes and goes, a little nod.
      yaw: -Math.PI * 0.6 + within * Math.PI * 2.5,
      pitch: 0.25 * Math.sin(within * Math.PI * 2 + index),
      roll: 0.12 * Math.sin(within * Math.PI + index * 1.7),
      x: intro ? WIDTH / 2 : (area.x0 + area.x1) / 2,
      y: intro ? HEIGHT / 2 : (area.y0 + area.y1) / 2,
      size,
      // Flat letters, as the plug-in's were: a thin slab, its outline twice.
      depth: spelling.style === "wire" ? 0.8 : 1.4,
      distance: 3.2
    }, spelling.style, engine.hot, Math.round(engine.hot * 0.55));
  };

  const drawWriting = (): void => {
    if (!writing) return;
    if (clock >= writing.until) {
      writing = null;
      return;
    }
    for (const line of writing.lines) writeText(engine.picture, line.text, line.face, line.cap, line.x, line.y, engine.hot);
  };

  const stepOnce = (frame: RetroFrame): void => {
    const sound = engine.sound;
    const kicks = sound.takeKicks();
    sinceChange += STEP;
    const next = frame.track.title.trim();
    if (next && next !== title) {
      title = next;
      startIntro();
    }
    if (!spelling?.intro && sound.sounding) {
      // Beat-driven, as the plug-in was: a change after so many beats; with no beat to count,
      // after a while all the same.
      beats += kicks;
      beatsToTitle -= kicks;
      if (beats >= beatsToChange || sinceChange > 24) change();
      if (beatsToTitle <= 0 && title) {
        beatsToTitle = whole(random, 48, 96);
        if (random() < 0.3 && !spelling) {
          const letters = spellTitle(title, MOST_LETTERS);
          if (letters.length) spelling = { letters, from: clock, style: random() < 0.6 ? "wire" : "solid", intro: false };
        } else {
          write(TITLE_SECONDS);
        }
      }
    }
    const intro = spelling?.intro ?? false;
    engine.step(clock, STEP, { wave: !intro && (sound.sounding || sound.silence < 2), kicks });
    drawWriting();
    drawSpelling();
    clock += STEP;
  };

  return {
    width: WIDTH,
    height: HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      engine.hear(frame.audio, frame.dt);
      pending = Math.min(pending + frame.dt, STEP * 3);
      let stepped = false;
      while (pending >= STEP) {
        pending -= STEP;
        stepOnce(frame);
        stepped = true;
      }
      if (stepped || clock === 0) engine.show(screen);
      image.data.set(screenBytes);
    },
    describe(): string {
      const e = effect;
      const spell = spelling as Spelling | null;
      return `${e.flame.kernel}/${e.flame.rule}${e.flame.amount} wave=${e.wave ?? "-"}${e.extraWave ? "+" + e.extraWave : ""} table=${e.table?.kind ?? "-"} display=${e.display} palette=${e.palette.name} beats=${beats}/${beatsToChange}${spell ? ` spelling=${spell.letters.join("")}${spell.intro ? "(intro)" : ""}` : ""}${writing ? " writing" : ""} changes=${changes}`;
    }
  };
}
