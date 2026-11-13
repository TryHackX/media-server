/**
 * Formy dźwięku (Sound Forms): every preset — the scene that draws it, that scene's settings and
 * the name the list shows. Names and group headings are Polish, the keys of i18n.ts, translated
 * where the list is drawn.
 *
 * The looks answer visualizations of vizz.fm the owner liked (each preset says which); the code,
 * the shaders and every number here are this project's own — nothing of vizz.fm's was read or
 * copied, only its pictures looked at.
 *
 * No imports, so the tests read this file as it is (soundforms.test.ts).
 */

export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];

/** Colour stops of a gradient, 0xRRGGBB, from its first end to its last. */
export type Stops = readonly number[];

export interface CameraSettings {
  eye: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees for a 16:9 picture; a narrower picture widens it. */
  fov: number;
  /** Radians a second the camera circles the target around the vertical axis. */
  orbit?: number;
  /** How far the camera drifts, slowly, and a little more with the bass. */
  sway?: number;
  /** Tilt of the picture, radians. */
  roll?: number;
}

/** What happens to the picture after the scene drew it (soundforms/pipeline.ts). */
export interface PostSettings {
  /** Glow around bright parts, and the brightness it starts at. */
  bloom?: number;
  threshold?: number;
  /** 0–1: how much of the picture is a blurred copy of itself (soft focus). */
  soft?: number;
  /** 0–1: blur along lines towards the centre (zoom blur). */
  zoomBlur?: number;
  /** Height of a mirror floor, 0–1 from the bottom; 0 = none. */
  horizon?: number;
  /** Brightness of the mirror image. */
  reflection?: number;
  /** Below the horizon only the mirror image (the camera sits inside a sphere). */
  reflectOnly?: boolean;
  /** Barrel distortion, a fisheye lens. */
  lens?: number;
  /** Colour fringes towards the edges. */
  aberration?: number;
  /** 0–1: how long earlier frames linger; 0 = not at all. */
  trails?: number;
  /** How much an earlier frame grows each frame while it fades. */
  trailZoom?: number;
  vignette?: number;
  /** Above 0: additive light is tone-mapped (1 − e^(−x·exposure)) instead of clipped. */
  exposure?: number;
}

/** A sphere displaced by noise and by the music, drawn as wires, dots or facets. */
export interface SphereSettings {
  mode: "wire" | "points" | "facets";
  /** The grid: rings from pole to pole and meridians around. */
  rings: number;
  meridians: number;
  radius: number;
  /** Height of the spikes (a fraction of the radius), how fine they are and how sharp. */
  spikes: number;
  spikeScale: number;
  sharpness: number;
  /** Slow swelling of the whole ball. */
  swell: number;
  /** Spikes without music, a fraction of `spikes`. */
  idle: number;
  colors: Stops;
  /** 0: by height in the picture, 1: by spike height, 2: by patch. */
  colorBy: 0 | 1 | 2;
  /** How dark the valleys between spikes get, 0–1. */
  shade: number;
  /** Holes where slow noise is below this (0 = none), and their size. */
  holes?: number;
  holeScale?: number;
  /** A bright patch wandering over the surface, and its colour. */
  spot?: number;
  spotColor?: number;
  /** The camera at the centre, the spikes growing towards it. */
  inside?: boolean;
  /** The far side hidden behind the near one. */
  occlude: boolean;
  pointSize?: number;
  alpha: number;
  /** Radians a second around x, y and z. */
  spin: Vec3;
  /** Radians a second the colours turn round the colour wheel. */
  hueSpeed?: number;
  camera: CameraSettings;
}

export type LineShape =
  | "horizon" | "tunnel" | "thread" | "twist" | "corridor" | "whirl" | "wing"
  | "coil" | "disc" | "crown" | "rays" | "silk" | "braids";

/**
 * Many lines, each one a moment of the music (the newest first), bent into a shape: a field to the
 * horizon, a tunnel, a ribbon, a coil… `shape` and the four numbers in `a` and `b` say how.
 */
export interface LineSettings {
  shape: LineShape;
  lines: number;
  samples: number;
  /** Line width in pixels of a 1080p picture. */
  width: number;
  /** Dots instead of lines, this big. */
  points?: number;
  /** How far the music moves a line. */
  amplitude: number;
  /** What moves it: the spectrum, the waveform, or a mix. */
  spectrum: number;
  wave: number;
  colors: Stops;
  colorBy: "along" | "across" | "height" | "centre" | "shape";
  alpha: number;
  /** Brightness the music adds where it moves a line. */
  lift: number;
  a: Vec4;
  b?: Vec4;
  /** A bright seam down the middle. */
  seam?: number;
  /** Stars behind (how many). */
  stars?: number;
  hueSpeed?: number;
  camera: CameraSettings;
}

/** The spectrum in three dimensions: sheets one behind another, or columns of blocks. */
export interface SpectrumSettings {
  mode: "slices" | "ring" | "tube" | "city";
  columns: number;
  rows: number;
  /** Moments of history between two rows. */
  rowStep: number;
  height: number;
  colors: Stops;
  /** A second palette the first turns into and back, every `cycle` seconds. */
  colorsAlt?: Stops;
  cycle?: number;
  /** Lit blocks per unit of height, with dark gaps between (0 = a smooth column). */
  segments?: number;
  alpha: number;
  /** Rows further back fade by this much. */
  fade: number;
  camera: CameraSettings;
}

/** A grid of points or wires: a bokeh field, a spiral, a flower. */
export interface MeshSettings {
  mode: "bokeh" | "spiral" | "flower";
  grid: readonly [number, number];
  size: readonly [number, number];
  amplitude: number;
  colors: Stops;
  pointSize: number;
  /** Depth of field: the distance in focus and how strongly the rest blurs. */
  focus?: number;
  blur?: number;
  hueSpeed?: number;
  camera: CameraSettings;
}

/** A swarm the camera flies through. */
export interface ParticleSettings {
  mode: "iris" | "warp";
  count: number;
  /** The swarm fills a tube around the camera's path, between these radii, this deep. */
  radius: readonly [number, number];
  depth: number;
  size: number;
  /** Speed without music and the speed the music adds. */
  speed: number;
  boost: number;
  /** How much speed stretches a particle into a streak. */
  streak: number;
  colors: Stops;
  camera: CameraSettings;
}

/** A ball of dots with the bass rolling over it in waves. */
export interface DotSettings {
  rings: number;
  meridians: number;
  amplitude: number;
  colors: Stops;
  pointSize: number;
  spin: Vec3;
  camera: CameraSettings;
}

/** Rings of dots, each one a moment later than the one inside it. */
export interface RingSettings {
  rings: number;
  dots: number;
  /** Radius of the first ring and the gap between rings. */
  radius: number;
  gap: number;
  /** Moments of history between two rings. */
  step: number;
  colors: Stops;
  pointSize: number;
  /** Tilt of the rings' plane, radians. */
  tilt: number;
  camera: CameraSettings;
}

interface SceneSettings {
  sphere: SphereSettings;
  lines: LineSettings;
  spectrum: SpectrumSettings;
  mesh: MeshSettings;
  particles: ParticleSettings;
  dots: DotSettings;
  rings: RingSettings;
}

export type SceneKind = keyof SceneSettings;

export type GroupId = "spheres" | "waves" | "spectrum" | "meshes" | "particles" | "dots" | "rings";

/**
 * The list: the presets `offered` keeps under the headings of GROUPS, in their order, names through
 * `translate` (the interface language's t; passed in, so this file keeps no imports and the tests
 * read it as it is). For the visualizer (index.ts) and the panel's search across visualizers.
 */
export function soundformsPresetGroups(
  offered: (id: string) => boolean,
  translate: (text: string) => string
): { label: string; presets: { id: string; label: string }[] }[] {
  return GROUPS
    .map((group) => ({
      label: translate(group.name),
      presets: PRESETS.filter((preset) => preset.group === group.id && offered(preset.id))
        .map((preset) => ({ id: preset.id, label: translate(preset.name) }))
    }))
    .filter((group) => group.presets.length > 0);
}

/** The headings of the list, in its order (Polish, translated where shown). */
export const GROUPS: readonly { id: GroupId; name: string }[] = [
  { id: "spheres", name: "Kule z kolców" },
  { id: "waves", name: "Fale z linii" },
  { id: "spectrum", name: "Widmo w przestrzeni" },
  { id: "meshes", name: "Siatki punktów" },
  { id: "particles", name: "Roje cząstek" },
  { id: "dots", name: "Kropki" },
  { id: "rings", name: "Pierścienie" }
];

interface PresetBase {
  /** Stable: kept in the browser and in the account's favourites. */
  id: string;
  /** Polish, the dictionary key. */
  name: string;
  group: GroupId;
  /** Which vizz.fm visualization and variant the look answers (for the documentation). */
  answers: string;
  /** Backdrop from the bottom of the picture to its top (one colour: flat). */
  background: Stops;
  /** A faint grid of dots over the backdrop. */
  pattern?: boolean;
  post?: PostSettings;
}

export type PresetDef = { [K in SceneKind]: PresetBase & { scene: K; settings: SceneSettings[K] } }[SceneKind];


const RAINBOW_UP = [0x1d3cff, 0x00b4ff, 0x2bff6a, 0xf3ff2a, 0xff8a00, 0xff2a10];

export const PRESETS: readonly PresetDef[] = [
  // ——— Kule z kolców: a sphere displaced by noise and the music (vizz.fm "Textured Sphere") ———
  {
    id: "sphere-rainbow", name: "Tęczowy jeż", group: "spheres", answers: "Textured Sphere 1",
    background: [0x000000], post: { bloom: 0.3, threshold: 0.85 },
    scene: "sphere",
    settings: {
      mode: "wire", rings: 130, meridians: 260, radius: 1, spikes: 0.55, spikeScale: 20, sharpness: 2.8,
      swell: 0.1, idle: 0.14, colors: RAINBOW_UP, colorBy: 0, shade: 0.88, occlude: true, alpha: 1.1,
      spin: [0.02, 0.09, 0.0], camera: { eye: [0, 0, 3.7], target: [0, 0, 0], fov: 50, sway: 0.12 }
    }
  },
  {
    id: "sphere-needles", name: "Igły zorzy", group: "spheres", answers: "Textured Sphere 2",
    background: [0x000000], post: { bloom: 0.4, threshold: 0.75 },
    scene: "sphere",
    settings: {
      mode: "wire", rings: 130, meridians: 260, radius: 0.95, spikes: 0.75, spikeScale: 30, sharpness: 3.4,
      swell: 0.05, idle: 0.12, colors: [0xff9a3c, 0xff5fb0, 0x9b5cff, 0x6a4dff, 0x5fd8ff, 0x3dff8a], colorBy: 0,
      shade: 0.96, occlude: true, alpha: 1.1, spin: [0.0, -0.07, 0.03],
      camera: { eye: [0, 0, 3.6], target: [0, 0, 0], fov: 50, sway: 0.12 }
    }
  },
  {
    id: "sphere-sepia", name: "Sepiowy wybuch", group: "spheres", answers: "Textured Sphere 3",
    background: [0x030201], post: { zoomBlur: 0.26, soft: 0.2, vignette: 0.6, exposure: 1.4 },
    scene: "sphere",
    settings: {
      mode: "wire", rings: 90, meridians: 180, radius: 0.8, spikes: 1.6, spikeScale: 12, sharpness: 3.4,
      swell: 0.1, idle: 0.15, colors: [0x2a1a0e, 0x8a6a48, 0xe8d2a8, 0xfff4dc], colorBy: 1, shade: 0.7,
      occlude: false, alpha: 0.5, spin: [0.05, 0.06, 0.03],
      camera: { eye: [0, 0, 2.6], target: [0, 0, 0], fov: 60, sway: 0.2 }
    }
  },
  {
    id: "sphere-coral", name: "Rafa koralowa", group: "spheres", answers: "Textured Sphere 4",
    background: [0x010605, 0x061210], post: { bloom: 0.35, threshold: 0.8 },
    scene: "sphere",
    settings: {
      mode: "wire", rings: 140, meridians: 280, radius: 1, spikes: 0.5, spikeScale: 16, sharpness: 2.2,
      swell: 0.12, idle: 0.25, colors: [0x1a5a55, 0x48c8b4, 0xb8f5e0, 0xfffbe0], colorBy: 1, shade: 0.7,
      occlude: true, alpha: 1.5, spin: [0.03, 0.05, 0.0],
      camera: { eye: [0, 0.1, 2.2], target: [0, 0.05, 0], fov: 60, sway: 0.08 }
    }
  },
  {
    id: "sphere-islands", name: "Wyspy z trójkątów", group: "spheres", answers: "Textured Sphere 5",
    background: [0x000000], post: { bloom: 0.35, threshold: 0.65 },
    scene: "sphere",
    settings: {
      mode: "facets", rings: 46, meridians: 92, radius: 1, spikes: 0.3, spikeScale: 4, sharpness: 1.5,
      swell: 0.35, idle: 0.3, colors: [0x7b3cff, 0x3dff7a, 0xff3d5a, 0xffe03d, 0x3d8bff, 0xff4dd2], colorBy: 2,
      shade: 0.4, holes: 0.55, holeScale: 2.6, occlude: false, alpha: 1.3, spin: [0.04, 0.07, 0.02],
      camera: { eye: [0, 0.25, 1.5], target: [0, 0, 0], fov: 72, sway: 0.1 }
    }
  },
  {
    id: "sphere-openwork", name: "Ażurowa kula", group: "spheres", answers: "Textured Sphere 6",
    background: [0x000000], post: { bloom: 0.3, threshold: 0.8 },
    scene: "sphere",
    settings: {
      mode: "wire", rings: 130, meridians: 260, radius: 1, spikes: 0.12, spikeScale: 5, sharpness: 1.4,
      swell: 0.06, idle: 0.3, colors: RAINBOW_UP, colorBy: 0, shade: 0.5, holes: 0.5, holeScale: 4.2,
      occlude: true, alpha: 1.2, spin: [0.0, 0.08, 0.0],
      camera: { eye: [0, 0, 3.0], target: [0, 0, 0], fov: 50, sway: 0.1 }
    }
  },
  {
    id: "sphere-patches", name: "Rozproszone plamy", group: "spheres", answers: "Textured Sphere 7",
    background: [0x05051a, 0x0c0c2e], post: { aberration: 0.7, bloom: 0.4, threshold: 0.5 },
    scene: "sphere",
    settings: {
      mode: "points", rings: 100, meridians: 200, radius: 1.05, spikes: 0.18, spikeScale: 3, sharpness: 1.2,
      swell: 0.3, idle: 0.2, colors: [0x37f2ff, 0x7a6bff, 0xff3df0], colorBy: 2, shade: 0.2, holes: 0.6,
      holeScale: 1.9, occlude: false, pointSize: 3.2, alpha: 2.2, spin: [0.06, 0.11, 0.04],
      camera: { eye: [0, 0, 3.2], target: [0, 0, 0], fov: 50, sway: 0.2 }
    }
  },
  {
    id: "sphere-firefly", name: "Świetlik na globie", group: "spheres", answers: "Textured Sphere 8",
    background: [0x000000, 0x020a0c], post: { bloom: 0.55, threshold: 0.55 },
    scene: "sphere",
    settings: {
      mode: "points", rings: 150, meridians: 300, radius: 1, spikes: 0.05, spikeScale: 6, sharpness: 1,
      swell: 0.55, idle: 0.25, colors: [0x062a32, 0x0e4a56, 0x1a7a8a], colorBy: 1, shade: 0.2,
      spot: 1, spotColor: 0xfff3c4, occlude: false, pointSize: 1.8, alpha: 1, spin: [0.02, 0.05, 0.01],
      camera: { eye: [0, 0, 3.5], target: [0, 0, 0], fov: 50, sway: 0.15 }
    }
  },
  {
    id: "sphere-lake", name: "Kula nad wodą", group: "spheres", answers: "Textured Sphere 9",
    background: [0x040818, 0x0c1638], post: { horizon: 0.47, reflection: 0.65, bloom: 0.25, threshold: 0.85 },
    scene: "sphere",
    settings: {
      mode: "wire", rings: 120, meridians: 240, radius: 0.85, spikes: 0.55, spikeScale: 18, sharpness: 2.6,
      swell: 0.08, idle: 0.14, colors: [0x06231a, 0x1f7a3a, 0xa8d81a, 0xffe600], colorBy: 1, shade: 0.88,
      occlude: true, alpha: 1.2, spin: [0.0, 0.1, 0.0],
      camera: { eye: [0, -0.35, 4.4], target: [0, -0.75, 0], fov: 50, sway: 0.06 }
    }
  },
  {
    id: "sphere-crystal", name: "Wnętrze kryształu", group: "spheres", answers: "Textured Sphere 10",
    background: [0x000006], post: { zoomBlur: 0.12, horizon: 0.5, reflection: 0.7, reflectOnly: true, bloom: 0.5, threshold: 0.45 },
    scene: "sphere",
    settings: {
      mode: "wire", rings: 100, meridians: 200, radius: 3, spikes: 0.6, spikeScale: 12, sharpness: 2.6,
      swell: 0.05, idle: 0.2, colors: [0x1a1a7a, 0x4a3aff, 0x9a5dff, 0x5ad8ff], colorBy: 1, shade: 0.75,
      inside: true, occlude: false, alpha: 2.6, spin: [0.0, 0.0, 0.08],
      camera: { eye: [0, 0, 0], target: [0, 0, -1], fov: 80, sway: 0.05 }
    }
  },
  {
    id: "sphere-emerald", name: "Szmaragdowa studnia", group: "spheres", answers: "Textured Sphere 11",
    background: [0x000604], post: { zoomBlur: 0.16, horizon: 0.5, reflection: 0.7, reflectOnly: true, bloom: 0.65, threshold: 0.45 },
    scene: "sphere",
    settings: {
      mode: "wire", rings: 100, meridians: 200, radius: 3, spikes: 0.62, spikeScale: 8, sharpness: 2.2,
      swell: 0.1, idle: 0.25, colors: [0x0a4a34, 0x1fd88a, 0x7af5e0, 0xf0fffa], colorBy: 1, shade: 0.7,
      inside: true, occlude: false, alpha: 2.8, spin: [0.0, 0.0, -0.06],
      camera: { eye: [0, 0, 0], target: [0, 0, -1], fov: 80, sway: 0.05 }
    }
  },

  // ——— Fale z linii: lines, each a moment of the music, bent into shapes (vizz.fm "Wavy Form") ———
  {
    id: "lines-horizon", name: "Horyzont linii", group: "waves", answers: "Wavy Form 1",
    background: [0x030102, 0x1d0a0c], post: { bloom: 0.4, threshold: 0.7, exposure: 1.3 },
    scene: "lines",
    settings: {
      shape: "horizon", lines: 140, samples: 256, width: 1.2, amplitude: 0.6, spectrum: 1, wave: 0.15,
      colors: [0xd23cff, 0x8a5cff, 0x46e8ff, 0xb8ffe8, 0xffe35a, 0xff7ab0], colorBy: "across", alpha: 0.6,
      lift: 1.4, a: [9, 14, 0.2, 0], seam: 2.5,
      camera: { eye: [0, 0.9, 1.6], target: [0, -0.5, -7], fov: 55, sway: 0.08 }
    }
  },
  {
    id: "lines-echo-tunnel", name: "Tunel ech", group: "waves", answers: "Wavy Form 2",
    background: [0x141a32, 0x232b4c], post: { bloom: 0.5, threshold: 0.6, exposure: 1.2 },
    scene: "lines",
    settings: {
      shape: "tunnel", lines: 120, samples: 256, width: 1.1, amplitude: 0.12, spectrum: 1, wave: 0.2,
      colors: [0x5fe8ff, 0xb8fff4, 0xffffff, 0xf0ff8a, 0x9fe63c], colorBy: "across", alpha: 0.6, lift: 1.2,
      a: [1, 10, 0.05, 1.0],
      camera: { eye: [0, 0, 0], target: [0, 0, -1], fov: 70, sway: 0.03 }
    }
  },
  {
    id: "lines-thread", name: "Neonowa nić", group: "waves", answers: "Wavy Form 3",
    background: [0x000000], post: { bloom: 0.9, threshold: 0.4 },
    scene: "lines",
    settings: {
      shape: "thread", lines: 3, samples: 384, width: 3.5, amplitude: 0.55, spectrum: 0, wave: 1,
      colors: [0xff2d8a, 0xffd23c, 0x6dff5a, 0x3ce8ff, 0x8a5cff, 0xff2d8a], colorBy: "along", alpha: 1.6, lift: 0.4,
      a: [7.6, 1.15, 10, 0.25],
      camera: { eye: [0, 0, 4], target: [0, 0, 0], fov: 50, sway: 0.05, roll: -0.04 }
    }
  },
  {
    id: "lines-twist", name: "Skręcona wstęga", group: "waves", answers: "Wavy Form 4",
    background: [0x000000], post: { bloom: 0.8, threshold: 0.45, exposure: 1.2 },
    scene: "lines",
    settings: {
      shape: "twist", lines: 90, samples: 320, width: 1.1, amplitude: 0.25, spectrum: 1, wave: 0.3,
      colors: [0xff2a3c, 0xff4fb8, 0xffffff, 0x4fe8ff, 0x9a4dff, 0xff2a5a], colorBy: "along", alpha: 0.75, lift: 0.8,
      a: [9, 2, 1.3, 0.25],
      camera: { eye: [0, 0.6, 3.9], target: [0, 0, 0], fov: 55, sway: 0.08 }
    }
  },
  {
    id: "lines-corridor", name: "Korytarz światła", group: "waves", answers: "Wavy Form 5",
    background: [0x000000], post: { bloom: 1, threshold: 0.5, exposure: 1 },
    scene: "lines",
    settings: {
      shape: "corridor", lines: 200, samples: 200, width: 1.4, amplitude: 0.35, spectrum: 1, wave: 0.2,
      colors: [0xb8ff9a, 0xffb8f0, 0xffffff, 0xc8a8ff, 0x9affd8], colorBy: "across", alpha: 1.1, lift: 1,
      a: [8, 24, 0.35, 0.5],
      camera: { eye: [0, 0, 0], target: [0, 0, -1], fov: 75, sway: 0.05, roll: 0.1 }
    }
  },
  {
    id: "lines-whirl", name: "Wir w studni", group: "waves", answers: "Wavy Form 6",
    background: [0x080503, 0x1c1208], post: { bloom: 0.7, threshold: 0.5, exposure: 1.2 },
    scene: "lines",
    settings: {
      shape: "whirl", lines: 140, samples: 256, width: 1.3, amplitude: 0.1, spectrum: 1, wave: 0.2,
      colors: [0xff7ad8, 0xffd0f0, 0xffffff, 0xfff27a, 0xffc23c, 0x7aff3c], colorBy: "across", alpha: 1.2, lift: 1,
      a: [1.15, 14, 9, 0.35],
      camera: { eye: [0.35, 0.25, 0], target: [0.05, 0.05, -1], fov: 75, sway: 0.08 }
    }
  },
  {
    id: "lines-wing", name: "Skrzydło zorzy", group: "waves", answers: "Wavy Form 7",
    background: [0x0a0304, 0x1c0a0e], post: { bloom: 0.75, threshold: 0.45, exposure: 1.2 },
    scene: "lines",
    settings: {
      shape: "wing", lines: 110, samples: 300, width: 1.1, amplitude: 0.5, spectrum: 1, wave: 0.25,
      colors: [0xffffff, 0x5ff0ff, 0x3d6bff, 0xa03dff, 0xff3d8a, 0xff2a3a], colorBy: "centre", alpha: 0.6, lift: 0.9,
      a: [10, 5, 0.035, 0],
      camera: { eye: [0, 3.4, 6.2], target: [0, -0.2, 0], fov: 50, sway: 0.1 }
    }
  },
  {
    id: "lines-coil", name: "Sprężyna", group: "waves", answers: "Wavy Form 8",
    background: [0x000000], post: { bloom: 0.55, threshold: 0.55 },
    scene: "lines",
    settings: {
      shape: "coil", lines: 1100, samples: 2, width: 1.3, amplitude: 0.5, spectrum: 1, wave: 0,
      colors: [0xff2a6a, 0xd43cff, 0x5a6bff, 0x3cf0ff], colorBy: "shape", alpha: 0.7, lift: 0.6,
      a: [4, 12, 1.25, 0.35], b: [0.28, 0, 0, 0],
      camera: { eye: [5.6, 2.6, 9.4], target: [0.2, 0, 0], fov: 42, sway: 0.08 }
    }
  },
  {
    id: "lines-disc", name: "Pierścień planety", group: "waves", answers: "Wavy Form 9",
    background: [0x000000], post: { bloom: 0.4, threshold: 0.65 },
    scene: "lines",
    settings: {
      shape: "disc", lines: 110, samples: 300, width: 1, amplitude: 0.35, spectrum: 1, wave: 0.15,
      colors: [0xffe03c, 0x3cc8ff, 0xe83cb4, 0xff2a8a, 0xff2a8a, 0xe83cb4, 0x3cc8ff, 0xffe03c],
      colorBy: "along", alpha: 0.5, lift: 0.8, a: [0.9, 1.25, 0, 0.06], stars: 700,
      camera: { eye: [0, 2.1, 3.3], target: [0, -0.15, 0], fov: 50, sway: 0.06 }
    }
  },
  {
    id: "lines-crown", name: "Korona", group: "waves", answers: "Wavy Form 10",
    background: [0x0c0306, 0x1e0810], post: { bloom: 0.85, threshold: 0.4, exposure: 1.2 },
    scene: "lines",
    settings: {
      shape: "crown", lines: 70, samples: 300, width: 1.1, amplitude: 0.45, spectrum: 1, wave: 0.2,
      colors: [0xff3da8, 0xff5ad0, 0xc85aff, 0x5ae8ff, 0xd8fff0, 0x8aff5a], colorBy: "across", alpha: 0.7, lift: 0.8,
      a: [1.15, 0.6, 0.9, 0.12],
      camera: { eye: [0, 1.15, 3.0], target: [0, 0.05, 0], fov: 50, sway: 0.08 }
    }
  },
  {
    id: "lines-rays", name: "Tunel promieni", group: "waves", answers: "Wavy Form 11",
    background: [0x12082a, 0x1d0c3c], post: { bloom: 0.9, threshold: 0.45, exposure: 1.1 },
    scene: "lines",
    settings: {
      shape: "rays", lines: 260, samples: 160, width: 1.3, amplitude: 0.28, spectrum: 1, wave: 0.2,
      colors: [0x8a3cff, 0x5a5aff, 0x3cd8ff, 0x5aff8a, 0xffff6a, 0xffffff], colorBy: "along", alpha: 0.7, lift: 0.9,
      a: [1, 18, 0.4, 0.05],
      camera: { eye: [0, 0, 0], target: [0, 0, -1], fov: 75, sway: 0.04 }
    }
  },
  {
    id: "lines-silk", name: "Jedwabne wydmy", group: "waves", answers: "Wavy Form 12",
    background: [0x4a3634, 0x8a6c64], post: { bloom: 0.5, threshold: 0.6, exposure: 1.1 },
    scene: "lines",
    settings: {
      shape: "silk", lines: 220, samples: 280, width: 1, amplitude: 0.45, spectrum: 1, wave: 0.15,
      colors: [0xa07ab8, 0xe8a8d0, 0xffd0c0, 0xfff4d8, 0xc8b8ff], colorBy: "shape", alpha: 0.4, lift: 0.6,
      a: [24, 26, 1.2, 0],
      camera: { eye: [0, 2.2, 3], target: [1.5, 0.3, -6], fov: 60, sway: 0.1, roll: -0.12 }
    }
  },
  {
    id: "lines-braids", name: "Trzy warkocze", group: "waves", answers: "Wavy Form 13",
    background: [0x000000], post: { bloom: 0.5, threshold: 0.5 },
    scene: "lines",
    settings: {
      shape: "braids", lines: 90, samples: 220, width: 1, points: 3.2, amplitude: 0.18, spectrum: 1, wave: 0.3,
      colors: [0x9a2aff, 0xb43cff, 0xffe83c, 0x5aff6a, 0x3cd8ff, 0xb43cff, 0x9a2aff], colorBy: "shape", alpha: 1.2, lift: 0.7,
      a: [11, 1.3, 2.2, 0.2], b: [1.7, 0, 0, 0],
      camera: { eye: [0, 0, 6.2], target: [0, 0, 0], fov: 50, sway: 0.05 }
    }
  },

  // ——— Widmo w przestrzeni: the spectrum in 3D (vizz.fm "Classic Spectrum") ———
  {
    id: "spectrum-mist", name: "Mgliste widmo", group: "spectrum", answers: "Classic Spectrum 6",
    background: [0x000000], post: { soft: 0.7, bloom: 0.2, threshold: 0.4 },
    scene: "spectrum",
    settings: {
      mode: "slices", columns: 48, rows: 14, rowStep: 4, height: 1.5, colors: [0xff8a2a, 0xa04dff, 0x8a5aff],
      colorsAlt: [0x6a3cff, 0x3ca0ff, 0x3cffd0], cycle: 24, alpha: 0.6, fade: 0.9,
      camera: { eye: [-1.5, 1.8, 3.9], target: [0.4, 0.5, -1.4], fov: 45, sway: 0.08 }
    }
  },
  {
    id: "spectrum-cascade", name: "Kaskada widma", group: "spectrum", answers: "Classic Spectrum 7",
    background: [0x000000], post: { bloom: 0.75, threshold: 0.45 },
    scene: "spectrum",
    settings: {
      mode: "slices", columns: 56, rows: 14, rowStep: 4, height: 1.6, colors: [0xff3cd8, 0x8a5aff, 0xd8f0ff],
      colorsAlt: [0x3c6bff, 0x3cf0e0, 0xc8ff5a], cycle: 20, alpha: 0.7, fade: 0.85,
      camera: { eye: [-1.5, 1.8, 3.9], target: [0.4, 0.5, -1.4], fov: 45, sway: 0.08 }
    }
  },
  {
    id: "spectrum-arena", name: "Arena słupków", group: "spectrum", answers: "Classic Spectrum 10",
    background: [0x04041a, 0x0a0a26], post: { bloom: 0.5, threshold: 0.55 },
    scene: "spectrum",
    settings: {
      mode: "ring", columns: 64, rows: 3, rowStep: 10, height: 1.6, colors: [0x2a0a6a, 0x7a2aff, 0xc86aff, 0xf0c8ff],
      segments: 9, alpha: 1.1, fade: 0.35,
      camera: { eye: [0, 3.3, 4.2], target: [0, 0.3, 0], fov: 50, orbit: 0.06, sway: 0.08 }
    }
  },
  {
    id: "spectrum-tube", name: "Tuba widma", group: "spectrum", answers: "Classic Spectrum 11",
    background: [0x02070a, 0x061218], post: { bloom: 0.5, threshold: 0.55 },
    scene: "spectrum",
    settings: {
      mode: "tube", columns: 48, rows: 36, rowStep: 2, height: 0.9, colors: [0x0a3a4a, 0x1a8aa8, 0x5ae8ff, 0xd8ffff],
      segments: 12, alpha: 1.1, fade: 1.6,
      camera: { eye: [2.4, 1.5, 3.1], target: [-1.2, 0, 0], fov: 50, sway: 0.08 }
    }
  },
  {
    id: "spectrum-city", name: "Miasto słupków", group: "spectrum", answers: "Classic Spectrum 12",
    background: [0x05051a, 0x0a0a24], post: { bloom: 0.5, threshold: 0.55 },
    scene: "spectrum",
    settings: {
      mode: "city", columns: 48, rows: 30, rowStep: 2, height: 2.6, colors: [0x3a1a8a, 0x8a3cff, 0xd05aff, 0xffb8ff],
      segments: 8, alpha: 1.1, fade: 1.3,
      camera: { eye: [-3, 2.4, 3.4], target: [0.5, 0.4, -3.2], fov: 55, sway: 0.08 }
    }
  },

  // ——— Siatki punktów: grids of points and wires (vizz.fm "Mesh Grid") ———
  {
    id: "mesh-bokeh", name: "Pole bokeh", group: "meshes", answers: "Mesh Grid 5",
    background: [0x041009, 0x0f2a1b], post: { bloom: 0.35, threshold: 0.55 },
    scene: "mesh",
    settings: {
      mode: "bokeh", grid: [170, 110], size: [26, 34], amplitude: 1.5, colors: [0x2a6a48, 0x6ad89a, 0xa8ffd0, 0xe8fff0],
      pointSize: 2, focus: 9, blur: 30, camera: { eye: [0, 2, 2.2], target: [0, -0.4, -10], fov: 55, sway: 0.12 }
    }
  },
  {
    id: "mesh-spiral", name: "Spiralna galaktyka", group: "meshes", answers: "Mesh Grid 6",
    background: [0x000000], post: { bloom: 0.6, threshold: 0.5 },
    scene: "mesh",
    settings: {
      mode: "spiral", grid: [210, 210], size: [12, 12], amplitude: 1.4, colors: [0xff8a2a, 0xfff03c, 0xffffff],
      pointSize: 3.2, focus: 7, blur: 6, hueSpeed: 0.12,
      camera: { eye: [0, 7.2, 5.6], target: [0, 0, 0.4], fov: 55, sway: 0.08 }
    }
  },
  {
    id: "mesh-flower", name: "Neonowy kwiat", group: "meshes", answers: "Mesh Grid 9",
    background: [0x000000], post: { bloom: 0.4, threshold: 0.65 },
    scene: "mesh",
    settings: {
      mode: "flower", grid: [150, 150], size: [2.4, 2.4], amplitude: 0.42, colors: [0x0a3a14, 0x1aff3c, 0x3cffe8, 0xfff03c, 0xffffff],
      pointSize: 1, camera: { eye: [0, 2.35, 0.3], target: [0, 0, 0], fov: 50, sway: 0.05 }
    }
  },

  // ——— Roje cząstek: swarms the camera flies through (vizz.fm "Particle Dance") ———
  {
    id: "particles-iris", name: "Tęczówka", group: "particles", answers: "Particle Dance 3",
    background: [0x000000], post: { lens: 1.5, aberration: 2, vignette: 0.7, bloom: 0.45, threshold: 0.5 },
    scene: "particles",
    settings: {
      mode: "iris", count: 5000, radius: [1, 2.6], depth: 7, size: 0.085, speed: 0.6, boost: 4, streak: 1.8,
      colors: [0xffffff, 0xffe8f0, 0xe8fff0, 0xf0e8ff, 0xffffff],
      camera: { eye: [0, 0, 0], target: [0, 0, -1], fov: 80, sway: 0.03 }
    }
  },
  {
    id: "particles-warp", name: "Skok w nadprzestrzeń", group: "particles", answers: "Particle Dance 4",
    background: [0x000000], post: { lens: 0.25, aberration: 1.6, bloom: 0.6, threshold: 0.6, vignette: 0.3 },
    scene: "particles",
    settings: {
      mode: "warp", count: 1800, radius: [0.25, 3], depth: 18, size: 0.12, speed: 1, boost: 16, streak: 1.2,
      colors: [0xffffff, 0xd8b8ff, 0xfff0a0, 0x9a8aff, 0xffffff],
      camera: { eye: [0, 0, 0], target: [0, 0, -1], fov: 80, sway: 0.03 }
    }
  },

  // ——— Kropki: a ball of dots (vizz.fm "Dot Grid") ———
  {
    id: "dots-planet", name: "Kropkowa planeta", group: "dots", answers: "Dot Grid 3",
    background: [0x04050b, 0x080a16], post: { trails: 0.9, trailZoom: 1.018, bloom: 0.35, threshold: 0.45 },
    scene: "dots",
    settings: {
      rings: 64, meridians: 128, amplitude: 0.3, colors: [0x0e4a4a, 0x3cc8b8, 0x9afff0, 0xffffff], pointSize: 1.9,
      spin: [0.0, 0.12, 0.0], camera: { eye: [0, 0, 6.4], target: [0, 0, 0], fov: 40, sway: 0.05 }
    }
  },

  // ——— Pierścienie: rings of dots (vizz.fm "Equalizer Rings") ———
  {
    id: "rings-ripples", name: "Kręgi na wodzie", group: "rings", answers: "Equalizer Rings 4",
    background: [0x080808, 0x0d0d0d], pattern: true, post: { bloom: 0.6, threshold: 0.4 },
    scene: "rings",
    settings: {
      rings: 7, dots: 150, radius: 0.36, gap: 0.21, step: 7, colors: [0xff5ad8, 0xffe85a, 0x5affd8, 0x9a7aff, 0xff5ad8],
      pointSize: 3.6, tilt: 0.75, camera: { eye: [0, 0, 5.2], target: [0, 0, 0], fov: 40, sway: 0.04 }
    }
  }
];
