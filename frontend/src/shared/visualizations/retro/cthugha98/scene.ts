import { drawBall, CthughaEngine, type Effect } from "../cthughalike/engine";
import { FieldRenderer, type FieldCamera } from "../cthughalike/field3d";
import { IDENTITY, type DisplayKind } from "../cthughalike/display";
import type { FlameKernel, FlameRule, FlameSpec } from "../cthughalike/flames";
import { writeText } from "../cthughalike/lettering";
import { blackFloor, inventPalette, PALETTES, word, type Palette } from "../cthughalike/palettes";
import type { ParticleScene } from "../cthughalike/particles";
import { between, freshSeed, pick, seeded, weighted, whole, type Random } from "../cthughalike/random";
import type { TableKind, TableSpec } from "../cthughalike/translate";
import type { WaveKind } from "../cthughalike/waves";
import type { PixelImage, RetroFrame, RetroScene } from "../types";

/**
 * Cthugha98 (Kevin "Zaph" Burfitt's Cthugha for Windows 95, 1997–98, last as 0.6), recreated:
 * our own engine (cthughalike/) after the program's descriptions and screenshots, nothing of its
 * code. A 640 × 480 picture in 256 colours, run 30 times a second as the program was: flames and
 * waves, translation tables, particle scenes of a few thousand points, smooth palette changes,
 * mirrored and kaleidoscopic displays. Every few seconds, or on a loud attack, the program picks
 * a new effect, all of it or a part.
 *
 * The 3dfx build drew the picture as a landscape on a Voodoo card: here a software height field,
 * lit and turning (field3d.ts), seen from above, from low down, from the top, or as a point cloud.
 */

export type View3d = "orbit" | "low" | "top" | "points";

export const VIEWS_3D: readonly View3d[] = ["orbit", "low", "top", "points"];

/** How often each view comes up: the straight-down one, the least 3D, least often. */
const VIEW_WEIGHTS: readonly (readonly [View3d, number])[] = [["orbit", 3], ["low", 3], ["points", 2], ["top", 1]];

export interface Cthugha98Settings {
  /** The standard program, or the 3dfx build's 3D views. */
  build: "standard" | "3dfx";
  /** What it favours: everything, particle scenes, translation tables, or flames and waves. */
  focus?: "all" | "particles" | "tables" | "flames";
  /** A display it keeps (the standard build). */
  display?: DisplayKind;
  /** A 3D view it keeps (the 3dfx build). */
  view?: View3d;
  seed?: number;
}

const WIDTH = 640;
const HEIGHT = 480;
/** The program's rate: it ran its effects at 30 frames a second. */
const STEP = 1 / 30;
/**
 * The 3dfx build's picture: smaller than the screen, as the card's textures were (256 wide at
 * most); the field samples it into a grid of vertices.
 */
const FIELD_PICTURE: readonly [number, number] = [320, 240];
const FIELD_GRID: readonly [number, number] = [96, 72];

const KERNELS: readonly (readonly [FlameKernel, number])[] = [
  ["rise", 6], ["riseFast", 2], ["glow", 3], ["haze", 2], ["fall", 1.5], ["left", 1], ["right", 1],
  ["sway", 3], ["lift", 2], ["streak", 1], ["climbLeft", 1], ["climbRight", 1], ["still", 1.5]
];

const WAVES: readonly (readonly [WaveKind, number])[] = [
  ["scope", 5], ["scopeDots", 2], ["stereo", 4], ["stereoDots", 1.5], ["vertical", 2], ["lightning", 3],
  ["analyzer", 1.5], ["analyzerMirror", 1.5], ["analyzerLine", 1], ["ring", 3], ["rings", 2],
  ["lissajous", 2.5], ["starburst", 2], ["spiral", 2], ["arches", 1], ["sparks", 1.5], ["fan", 1],
  ["rose", 1.5], ["ridges", 1], ["cross", 1], ["halo", 1.5], ["ribbon", 1], ["zigzag", 1]
];

const TABLES: readonly (readonly [TableKind, number])[] = [
  ["zoom", 4], ["implode", 2], ["rotate", 3], ["swirl", 3], ["hurricane", 2], ["smoke", 3], ["ripple", 2],
  ["warp", 2], ["tunnel", 2], ["twin", 2], ["fountain", 1.5], ["drain", 1.5], ["bubble", 1.5], ["rings", 2],
  ["cells", 1.5], ["shear", 1], ["flag", 1]
];

const DISPLAYS: readonly (readonly [DisplayKind, number])[] = [
  ["normal", 3], ["mirror", 3], ["mirrorFlip", 1], ["mirrorDown", 1.2], ["quad", 2], ["kaleido", 1.2]
];

const PARTICLE_SCENES: readonly (readonly [ParticleScene, number])[] = [
  ["stream", 3], ["fountain", 2], ["galaxy", 2], ["fireworks", 2], ["swarm", 2], ["vortex", 1.5]
];

/**
 * A palette for a flame: one with a black floor for a flame that burns down, any (often one that
 * cycles round) for one that boils.
 */
function choosePalette(random: Random, boiling: boolean): Palette {
  if (boiling && random() < 0.45) return random() < 0.5 ? pick(random, PALETTES.filter((palette) => !blackFloor(palette))) : inventPalette(random, true);
  for (;;) {
    const palette = random() < 0.75 ? pick(random, PALETTES) : inventPalette(random);
    // Grey is too plain for an effect of its own.
    if (blackFloor(palette) && palette.name !== "Grey Ghost") return palette;
  }
}

/**
 * A flame. `gentle` for particles and tables (a glow or a fade, they move the picture
 * themselves); `moving` when something else moves the picture, so it may stand still.
 */
function chooseFlame(random: Random, gentle: boolean, moving: boolean): FlameSpec {
  let kernel = gentle ? weighted(random, [["still", 3], ["glow", 3], ["haze", 2], ["lift", 1.5], ["sway", 1]] as const) : weighted(random, KERNELS);
  if (kernel === "still" && !moving) kernel = "glow";
  let rule: FlameRule = gentle ? "decay" : weighted(random, [["decay", 8], ["boil", 1.4], ["swell", 0.6]] as const);
  // A swell only blooms well through the eight-way haze.
  if (rule === "swell" && kernel !== "haze") rule = "decay";
  let amount: number;
  if (rule === "boil") amount = whole(random, 1, 3);
  else if (rule === "swell") amount = whole(random, 2, 3);
  else if (kernel === "still") amount = whole(random, 3, 9);
  else if (kernel === "haze" || kernel === "glow") amount = whole(random, 1, 3);
  else amount = whole(random, 1, 4);
  return { kernel, rule, amount, speckle: random() < 0.3 ? whole(random, 2, 6) : 0 };
}

function chooseTable(random: Random): TableSpec {
  const kind = weighted(random, TABLES);
  const centred = random() < 0.75;
  return {
    kind,
    strength: between(random, 0.6, 1.5),
    turn: random() < 0.5 ? -1 : 1,
    seed: whole(random, 1, 999_999),
    centreX: centred ? 0.5 : between(random, 0.3, 0.7),
    centreY: centred ? 0.5 : between(random, 0.3, 0.7)
  };
}

/** A table of a kind, the rest of it at random. */
function tableOf(random: Random, kind: TableKind, strength: number): TableSpec {
  return { ...chooseTable(random), kind, strength, centreX: 0.5, centreY: 0.5 };
}

/**
 * Combinations kept because they look well, as the program kept its favourites in its settings
 * and wove them into the changes: rays out of a starburst, a glowing tunnel, banded fire, a
 * whirlpool of rings, smoke, fire columns, a burning spectrum, kaleidoscopic roses, embers
 * blown outwards. Each fills in only some of the effect; the rest is chosen as usual.
 */
const RECIPES: readonly ((random: Random) => Partial<Effect>)[] = [
  (random) => ({ wave: "starburst", table: tableOf(random, "zoom", between(random, 1.2, 1.7)), flame: { kernel: "still", rule: "decay", amount: whole(random, 4, 6), speckle: 3 }, smooth: false }),
  (random) => ({ wave: pick(random, ["stereo", "scope", "ring"] as const), table: tableOf(random, "tunnel", between(random, 0.8, 1.2)), flame: { kernel: "haze", rule: "decay", amount: 1 } }),
  (random) => ({ wave: pick(random, ["lightning", "vertical", "scope"] as const), flame: { kernel: "sway", rule: "decay", amount: 1, speckle: 2 }, palette: pick(random, PALETTES.filter((palette) => ["Spectrum Bands", "Contour", "Lava Bands", "Prism", "Oil Shimmer"].includes(palette.name))), scale: 1.4 }),
  (random) => ({ wave: pick(random, ["ring", "rings", "spiral"] as const), table: tableOf(random, "hurricane", between(random, 0.8, 1.3)), flame: { kernel: "still", rule: "decay", amount: whole(random, 6, 9) } }),
  (random) => ({ wave: pick(random, ["scope", "stereo", "lightning"] as const), table: tableOf(random, "smoke", between(random, 1, 1.4)), flame: { kernel: "glow", rule: "decay", amount: 1, speckle: 4 }, smooth: false }),
  () => ({ wave: "vertical", flame: { kernel: "rise", rule: "decay", amount: 1, speckle: 3 }, display: "mirror", scale: 1.5, smooth: false }),
  (random) => ({ wave: pick(random, ["analyzer", "analyzerMirror"] as const), flame: { kernel: pick(random, ["rise", "riseFast"] as const), rule: "decay", amount: 6 } }),
  (random) => ({ wave: pick(random, ["rose", "spiral", "lissajous"] as const), table: tableOf(random, "swirl", between(random, 0.7, 1.1)), flame: { kernel: "still", rule: "decay", amount: whole(random, 6, 8) }, display: pick(random, ["kaleido", "quad"] as const) }),
  (random) => ({ wave: "sparks", table: tableOf(random, "zoom", between(random, 1.3, 1.7)), flame: { kernel: "still", rule: "decay", amount: 4, speckle: 4 }, smooth: false }),
  (random) => ({ wave: pick(random, ["scope", "stereo", "ribbon"] as const), table: tableOf(random, pick(random, ["ripple", "rings", "warp"] as const), 1), flame: { kernel: "still", rule: "boil", amount: whole(random, 1, 2) } })
];

/** A whole new effect, as the program's change of everything. */
function inventEffect(random: Random, settings: Cthugha98Settings): Effect {
  const focus = settings.focus ?? "all";
  const particles = focus === "particles" || (focus === "all" && random() < 0.2) ? weighted(random, PARTICLE_SCENES) : null;
  // Particles fly on black: a table would smear them into a fog (a gentle turn now and then).
  const table = particles
    ? (focus !== "particles" && random() < 0.15 ? { ...chooseTable(random), kind: pick(random, ["rotate", "zoom"] as const), strength: 0.6 } : null)
    : focus === "tables" || (focus === "all" && random() < 0.5) ? chooseTable(random) : null;
  const flame = chooseFlame(random, particles !== null || (table !== null && random() < 0.6), particles !== null || table !== null);
  const wave = particles && random() < 0.65 ? null : weighted(random, WAVES);
  const effect: Effect = {
    flame,
    wave,
    extraWave: wave && random() < 0.15 ? weighted(random, WAVES) : null,
    table,
    particles,
    display: settings.display ?? weighted(random, DISPLAYS),
    palette: choosePalette(random, flame.rule === "boil"),
    centred: random() < 0.6,
    scale: weighted(random, [[1, 5], [1.4, 3], [1.8, 1.2], [0.75, 1]] as const),
    smooth: random() < 0.7,
    heat: random() < 0.5 ? 1 : between(random, 0.68, 0.9)
  };
  // A third of the time one of the favourites (not where particles or flames only are wanted).
  if (!particles && focus !== "particles" && random() < 0.35) {
    const recipe = pick(random, RECIPES)(random);
    if (focus === "flames") delete recipe.table;
    const mixed: Effect = { ...effect, ...recipe, extraWave: null, display: settings.display ?? recipe.display ?? effect.display };
    if (focus === "tables" && !mixed.table) mixed.table = chooseTable(random);
    // The palette must suit the flame: a boiling one may cycle, one that burns down needs black.
    if (mixed.flame.rule === "boil" ? !recipe.palette && random() < 0.5 : !blackFloor(mixed.palette)) mixed.palette = choosePalette(random, mixed.flame.rule === "boil");
    return mixed;
  }
  return effect;
}

/** A part of the effect changed: as the program's keys for flame, wave, palette, display. */
function alterEffect(random: Random, effect: Effect, settings: Cthugha98Settings): Effect {
  const next: Effect = { ...effect };
  const parts = whole(random, 1, 2);
  for (let k = 0; k < parts; k += 1) {
    switch (weighted(random, [["palette", 4], ["wave", 3], ["flame", 2.5], ["display", settings.display ? 0 : 1.5], ["table", settings.focus === "flames" ? 0 : 1.5]] as const)) {
      case "palette":
        next.palette = choosePalette(random, next.flame.rule === "boil");
        break;
      case "wave":
        next.wave = weighted(random, WAVES);
        next.extraWave = random() < 0.12 ? weighted(random, WAVES) : null;
        next.smooth = random() < 0.7;
        break;
      case "flame":
        next.flame = chooseFlame(random, next.particles !== null, next.particles !== null || next.table !== null);
        if (next.flame.rule !== "boil" && !blackFloor(next.palette)) next.palette = choosePalette(random, false);
        break;
      case "display":
        next.display = weighted(random, DISPLAYS);
        break;
      case "table":
        next.table = next.particles ? null : settings.focus === "tables" || random() < 0.7 ? chooseTable(random) : null;
        break;
    }
  }
  // Nothing left to move a flame that stands still: it rises again.
  if (next.flame.kernel === "still" && !next.table && !next.particles) next.flame = { ...next.flame, kernel: "glow", amount: Math.min(3, next.flame.amount) };
  return next;
}

interface CameraPath {
  view: View3d;
  yaw: number;
  yawSpeed: number;
  pitch: number;
  distance: number;
  lift: number;
  wobble: number;
}

function choosePath(random: Random, view: View3d): CameraPath {
  const base = { view, yaw: random() * Math.PI * 2, yawSpeed: (random() < 0.5 ? -1 : 1) * between(random, 0.12, 0.32), wobble: random() * 10 };
  switch (view) {
    case "low":
      return { ...base, pitch: between(random, 0.32, 0.5), distance: between(random, 2.5, 3), lift: between(random, 0.35, 0.55) };
    case "top":
      return { ...base, pitch: between(random, 1.05, 1.25), distance: between(random, 3, 3.4), lift: between(random, 0.35, 0.55) };
    case "points":
      return { ...base, pitch: between(random, 0.55, 0.9), distance: between(random, 2.8, 3.4), lift: between(random, 0.45, 0.7) };
    default:
      return { ...base, pitch: between(random, 0.7, 1), distance: between(random, 2.9, 3.3), lift: between(random, 0.3, 0.5) };
  }
}

export function createCthugha98(settings: Cthugha98Settings): RetroScene & { describe(): string } {
  // A seed set on globalThis (the offline harness's --cseed) replays a run exactly.
  const random = seeded(settings.seed ?? (globalThis as { cthughaSeed?: number }).cthughaSeed ?? freshSeed());
  const is3d = settings.build === "3dfx";
  const [pictureWidth, pictureHeight] = is3d ? FIELD_PICTURE : [WIDTH, HEIGHT];
  const engine = new CthughaEngine(pictureWidth, pictureHeight, random);
  const field = is3d ? new FieldRenderer(FIELD_GRID[0], FIELD_GRID[1]) : null;
  const folded = is3d ? new Uint8Array(pictureWidth * pictureHeight) : null;
  const screen = new Int32Array(WIDTH * HEIGHT);
  const screenBytes = new Uint8ClampedArray(screen.buffer);
  const black = word(0, 0, 0);
  let path = choosePath(random, settings.view ?? weighted(random, VIEW_WEIGHTS));
  let effect = inventEffect(random, settings);
  engine.apply(effect, true);
  field?.setPalette(engine.rgb);
  let pending = 0;
  let clock = 0;
  let sinceChange = 0;
  let nextChange = between(random, 6, 14);
  let changes = 0;

  const change = (): void => {
    changes += 1;
    effect = random() < 0.55 ? inventEffect(random, settings) : alterEffect(random, effect, settings);
    engine.apply(effect);
    sinceChange = 0;
    nextChange = between(random, 6, 14);
    if (is3d && (!settings.view || random() < 0.5)) {
      // The view moves on too: a new angle, or (unless one is kept) a new kind of view.
      path = choosePath(random, settings.view ?? (random() < 0.6 ? weighted(random, VIEW_WEIGHTS) : path.view));
    }
    if (random() < 0.14) {
      // Now and then a picture laid in, to burn away: our own shaded ball, or the name.
      const area = engine.area();
      if (random() < 0.6) {
        const radius = (area.y1 - area.y0) * between(random, 0.12, 0.3);
        drawBall(engine.picture, between(random, area.x0 + radius, area.x1 - radius), between(random, area.y0 + radius, area.y1 - radius), radius, engine.hot);
      } else {
        const cap = Math.round((area.y1 - area.y0) * between(random, 0.08, 0.14));
        writeText(engine.picture, "Cthugha98", pick(random, ["bold", "italic", "serif", "wide"] as const), cap, area.x0 + (area.x1 - area.x0) * between(random, 0.05, 0.3), (area.y0 + area.y1) / 2, engine.hot);
      }
    }
  };

  const stepOnce = (): void => {
    const sound = engine.sound;
    const kicks = sound.takeKicks();
    const attack = sound.takeAttack();
    sinceChange += STEP;
    // The program changed after a while, sooner on a loud attack; in silence it waits.
    if (sound.sounding && (sinceChange >= nextChange || (attack && sinceChange > 3.5))) change();
    engine.step(clock, STEP, { wave: sound.sounding || sound.silence < 2, kicks });
    clock += STEP;
  };

  /** The palette the field's shades were made from, by the engine's count of changes. */
  let shadedVersion = -1;
  const draw3d = (): void => {
    if (!field || !folded) return;
    // The field takes the picture as the display shows it, so mirrors stand as mirrored hills.
    engine.show(folded, IDENTITY);
    if (shadedVersion !== engine.paletteVersion) {
      field.setPalette(engine.rgb);
      shadedVersion = engine.paletteVersion;
    }
    const t = clock;
    const beat = engine.sound.beat;
    const camera: FieldCamera = {
      yaw: path.yaw + t * path.yawSpeed,
      pitch: path.pitch + 0.12 * Math.sin(t * 0.23 + path.wobble),
      distance: path.distance * (1 + 0.08 * Math.sin(t * 0.17 + path.wobble * 2)),
      lift: path.lift * (1 + 0.25 * beat),
      focal: 0,
      centreX: WIDTH / 2,
      centreY: HEIGHT * (path.view === "low" ? 0.6 : 0.53)
    };
    camera.focal = 205 * camera.distance;
    const target = { pixels: screen, width: WIDTH, height: HEIGHT };
    if (path.view === "points") {
      field.points(folded, pictureWidth, pictureHeight, 1, camera, target, pictureWidth / pictureHeight, engine.words, black);
    } else {
      field.sample(folded, pictureWidth, pictureHeight);
      field.mesh(camera, target, pictureWidth / pictureHeight, black);
    }
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
        stepOnce();
        stepped = true;
      }
      if (stepped || clock === 0) {
        if (is3d) draw3d();
        else engine.show(screen);
      }
      image.data.set(screenBytes);
    },
    describe(): string {
      const e = effect;
      return `${e.flame.kernel}/${e.flame.rule}${e.flame.amount} wave=${e.wave ?? "-"}${e.extraWave ? "+" + e.extraWave : ""} table=${e.table?.kind ?? "-"} particles=${e.particles ?? "-"} display=${e.display} palette=${e.palette.name}${is3d ? ` view=${path.view}` : ""} changes=${changes}`;
    }
  };
}
