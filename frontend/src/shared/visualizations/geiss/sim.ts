/**
 * Geiss 4.30 — Ryan Geiss's Winamp plug-in (1998–2023), ported from its own source
 * (github.com/geissomatik/geiss, 3-Clause BSD: LICENSE-geiss.txt beside this file).
 *
 * The plug-in's picture in its three colour depths, function for function:
 *   - render1()/RenderFX() (main.cpp): the frame's order, the effects drawn into the old frame;
 *   - Process_Map() (proc_map.cpp): every pixel the weighted sum of four source pixels. At 8 bits
 *     the sum is carried in DX the way the asm does — DH is the pixel, DL rides on to the next one,
 *     the dither that keeps the slow fade smooth; at 16/32 bits the MMX loop does the same for
 *     blue, green, red and the fourth byte at once, its carry in mm6;
 *   - GenerateChunkOfNewMap(): the 25 maps, the next one built a slice per frame while the current
 *     one plays, put in on a beat;
 *   - GetWaveData()/RenderDots()/RenderWave(): Winamp's 576 samples, the level trigger, the beat
 *     and big-beat detection, the shifting, waveforms 1–7 (in colour above 8 bits);
 *   - Effects.h: shade bobs, chasers, the bar, the dotty chaser, nuclide dots, the grid, solar
 *     particles, the dimmed centre — each in its 8-bit and its colour form;
 *   - video.h: FX_Random_Palette()/PutPalette()/CrankPal() (8 bits), palettes blended in nine
 *     frames; Merge_All_VS_To_Backbuffer()'s doubling and 5-6-5 packing (presentFrame below);
 *   - the song title popup and the custom messages of GEISS.INI (Check_For_New_Song_Title,
 *     Plop_Songtitle…, the keys `m##`), drawn over the picture and burnt into it;
 *   - SavePreset()/LoadPreset() (Effects.h, the keys `]##`/`[##`);
 *   - the Fourier analysis of GetWaveData() and the wave colours it gives when "Don't base the
 *     wave colors on the music" is unticked (g_bSyncColorToSound, off by default).
 *
 * Arithmetic: the plug-in is 32-bit x86 C++ (SSE2, /fp:precise). Where it computes in `float` this
 * file rounds with Math.fround after every operation, where it promotes to `double` it does not;
 * its sinf/cosf/powf/sqrtf are `(float)f((double)x)` on x86, as here. rand() is MSVC's LCG. With
 * the same seed, audio and clock the frames are the original's (the comparison with the original
 * built from its source is described in docs/FRONTEND.md). Not here, being Winamp's window rather
 * than the picture: the help and FPS text and the keyboard.
 *
 * No imports: the tests run this file as it is.
 */

const f32 = Math.fround;

/** MSVC's rand(): srand(seed), then (seed * 214013 + 2531011) >> 16 & 0x7fff. */
export class MsvcRand {
  public state: number;

  public constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  public next(): number {
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }
}

/** (int)x for a float: cvttss2si, whose answer out of range is 0x80000000. */
function toInt(value: number): number {
  const t = Math.trunc(value);
  return t >= -2147483648 && t <= 2147483647 ? t : -2147483648;
}

/** (unsigned char)x for a float: the low byte of (int)x. */
function toByte(value: number): number {
  return toInt(value) & 255;
}

/** AdjustRateToFPS(): a per-frame decay tuned at fps1, the same per second at actual_fps. */
function adjustRateToFps(perFrameAtFps1: number, fps1: number, actualFps: number): number {
  const perSecond = f32(Math.pow(f32(perFrameAtFps1), fps1));
  return f32(Math.pow(perSecond, f32(1 / actualFps)));
}

export const NUM_MODES = 25;
const NUM_WAVES = 6;
const NUM_EFFECTS = 9;
export const CHASERS = 0;
export const BAR = 1;
export const DOTS = 2;
export const SOLAR = 3;
export const GRID = 4;
export const NUCLIDE = 5;
export const SHADE = 6;
const SPECTRAL = 7;
const PAST_VOL_N = 120;
const WAVE_5_BLEND_RANGE = 50;
const MINBUFSIZE = (314 + WAVE_5_BLEND_RANGE) * 2 + 20;
/** The samples a frame gets from Winamp, per channel. */
export const WINAMP_SAMPLES = 576;
const SPECTRUM = 0;
const WAVE = 1;
/** FOURIER_DETAIL: the bands of GetWaveData()'s analysis, from 20 Hz up by 2^(10/24). */
const FOURIER_DETAIL = 24;
/**
 * cosf(w·i) and sinf(w·i) for band n (1–23) and sample i (0–255): w = 6.28·20·2^(n/24·10)/44100
 * as a float, θ = w·i as a float. The same constants the plug-in computed every frame.
 */
const FOURIER_COS = new Float32Array(FOURIER_DETAIL * 256);
const FOURIER_SIN = new Float32Array(FOURIER_DETAIL * 256);
for (let n = 1; n < FOURIER_DETAIL; n += 1) {
  const exponent = f32(f32(n / FOURIER_DETAIL) * 10);
  const w = f32(6.28 * (f32(20 * f32(Math.pow(2, exponent))) / 44100.0));
  for (let i = 0; i < 256; i += 1) {
    const theta = f32(w * i);
    FOURIER_COS[n * 256 + i] = f32(Math.cos(theta));
    FOURIER_SIN[n * 256 + i] = f32(Math.sin(theta));
  }
}
/** The title's colours, RGB(225, 225, 225) with a shadow of RGB(20, 20, 20) (video.h). */
const TITLE_INK = 225;
const TITLE_SHADOW = 20;

/**
 * The video mode's colour depth: 8 bits through a palette (the default until 4.26), 16 bits
 * (5-6-5) or 32 bits (the default from 4.27). 16 and 32 draw alike and differ only on screen.
 */
export type GeissDepth = 8 | 16 | 32;

/** mode_motion_dampened[], rotation_dither[], custom_motion_vectors[] (main.cpp). */
const MOTION_DAMPENED = [true, true, true, false, true, true, false, true, true, true,
  true, true, true, true, true, true, true, false, false, false, false, false, false, false, false, false];
const ROTATION_DITHER = [false, true, false, false, false, false, false, false, false, true,
  false, true, false, false, false, false, false, false, false, false, false, false, false, false, false, false];
const CUSTOM_MOTION_VECTORS = [false, false, false, false, false, false, true, false, false, false,
  true, false, true, false, false, false, false, false, false, false, false, false, false, false, false, false];

/**
 * How often each map is picked: ReadConfigRegistry()'s default_modeprefs (stars, 0–5), the chance
 * of a map its stars over the sum of all. Index 0 is unused; maps count from 1.
 */
export const DEFAULT_MODE_RATINGS: readonly number[] = [0,
  3, 3, 3, 3, 5, 5, 5, 5, 5,
  3, 3, 1, 3, 3, 2, 3, 4, 3, 3,
  3, 3, 3, 3, 3, 3];

interface ModeInfo {
  /** Out of 1000, per effect (CHASERS…SPECTRAL, and a ninth that nothing draws but counts). */
  effectFreq: number[];
  solarMax: number;
  centerDwindle: number;
  minEffects: number;
  maxEffects: number;
}

/** CModeInfo and the table FX_Init() fills; above 8 bits some effects come more often. */
function modeInfoTable(hicolor: boolean): ModeInfo[] {
  const table: ModeInfo[] = [];
  for (let z = 0; z <= NUM_MODES; z += 1) {
    table.push({ effectFreq: new Array<number>(NUM_EFFECTS).fill(Math.trunc(1000 / NUM_EFFECTS)), solarMax: 60, centerDwindle: f32(0.99), minEffects: 1, maxEffects: 2 });
  }
  const set = (z: number, freq: number[], solarMax: number | null, dwindle: number, min?: number, max?: number): void => {
    const info = table[z]!;
    for (let i = 0; i < 8; i += 1) info.effectFreq[i] = freq[i]!;
    if (solarMax !== null) info.solarMax = solarMax;
    info.centerDwindle = f32(dwindle);
    if (min !== undefined) info.minEffects = min;
    if (max !== undefined) info.maxEffects = max;
  };
  // CHASERS, BAR, DOTS, SOLAR, GRID, NUCLIDE, SHADE, SPECTRAL
  set(1, [220, 150, 10, 680, 4, 170, 400, 0], hicolor ? 800 : 400, 1.0);
  set(2, [750, 500, 750, 750, 0, 0, 0, 0], 35, 1.0, undefined, 5);
  set(3, [100, 100, 100, 500, 10, 0, 300, 0], 60, 0.99);
  set(4, [500, 100, 100, 100, 30, 0, 0, 0], 34, 0.98);
  set(5, [100, 350, 100, 500, 15, 180, 500, 0], 60, 0.99);
  set(6, [400, 120, 200, 0, 0, 0, 0, 0], 60, 1.0);
  set(7, [50, 200, 0, 300, 0, 600, 350, 0], 65, 0.985);
  // "effect_freq[SHADE] = effect_freq[SPECTRAL] = 0": a value missing in the original.
  set(8, [150, 150, 150, 150, 25, 0, 0, 0], 60, 0.96);
  set(9, [450, 200, 50, 200, 0, 100, 200, 0], 50, 0.985);
  set(10, [150, 20, 80, 0, 0, 80, 0, 0], 0, 1.0, 0, 2);
  set(11, [360, 200, 230, 550, 10, 330, 150, 0], 750, 1.0, 0, 4);
  set(12, [360, 200, 230, 0, 0, 330, 0, 0], 500, 0.915, 0, 2);
  set(13, [500, 0, 100, 0, 30, 0, 0, 0], 34, 0.98);
  set(14, [500, 0, 100, 0, 30, 0, 0, 0], 34, 0.98);
  set(15, [0, 0, 0, 0, 0, 200, 0, 0], null, 1.0, 0, 1);
  set(16, [500, 100, 100, 100, 30, 0, 0, 0], 34, 0.98);
  for (let z = 17; z <= NUM_MODES; z += 1) set(z, [150, 150, 150, 150, 12, 0, 50, 0], 600, 1.0, 1, 3);
  for (let z = 1; z <= NUM_MODES; z += 1) {
    const freq = table[z]!.effectFreq;
    if (hicolor) {
      freq[NUCLIDE] = Math.trunc(Math.max(0, Math.min(900, f32(freq[NUCLIDE]! * f32(1.3)))));
      freq[CHASERS] = Math.max(0, Math.min(900, freq[CHASERS]! - 50));
      freq[DOTS] = Math.max(0, Math.min(900, freq[DOTS]! + 220));
      freq[BAR] = Math.max(0, Math.min(900, freq[BAR]! + 220));
      freq[SHADE] = Math.max(0, Math.min(900, freq[SHADE]! + 150));
    }
    freq[GRID] = Math.min(1000, freq[GRID]! + 8);
  }
  for (const z of [20, 21, 22, 23]) table[z]!.centerDwindle = f32(0.98);
  return table;
}

/** What Winamp hands a vis plug-in each frame, as the plug-in reads it. */
export interface WinampFrame {
  /** waveformData[2][576] read through `^ 128` - 128: left 0–575, then right, −128…127. */
  wave: Int16Array;
  /** spectrumData[2][576]: left 0–575, then right, 0…255. */
  spectrum: Uint8Array;
}

/**
 * A song title or message as GDI draws it in the font the plug-in made (CreateFont(24, 10, …, 700,
 * …, DEFAULT_CHARSET, …, DEFAULT_QUALITY, VARIABLE_PITCH | FF_DONTCARE, NULL): Arial Bold, a 24 px
 * cell at 20 px to the em, the baseline 19 px down; without smoothing, as at 8 bits always).
 * `width` × `height` is GetTextExtentPoint() (0 × 0 for no text); `mask` holds the glyphs, 1 where
 * the text is, `maskWidth` × `maskHeight` pixels from (`left`, `top`) of the text's cell —
 * negative where a glyph reaches out of it, as W's and j's do on the left.
 */
export interface TitleMask {
  width: number;
  height: number;
  left: number;
  top: number;
  maskWidth: number;
  maskHeight: number;
  mask: Uint8Array;
}

/** The title popup while it is drawn over the picture (Plop_Songtitle_…, phase 1). */
export interface TitleOverlay {
  text: string;
  mask: TitleMask;
  x: number;
  y: number;
}

/**
 * A preset as Geiss 4.30 keeps it in GEISS.INI, section [PRESET ##] (SavePreset() and
 * LoadPreset() in Effects.h, the keys `]##` and `[##`): its keys, with what they hold.
 *
 * - x_center, y_center: the map's centre over the width and the height (a size-free fraction);
 * - mode: the map, 1–25; damping: how far it moves a frame; magic: its weight sum (the fade);
 * - wave: the waveform (0 none); shift: the shifting on beats; spectrum: 1 for spectrum dots;
 * - volpos: the wave's volume step (10 the middle); gamma: the palette's brightness;
 * - t1, t2, s1, s2: rotation and scale (t2/s2 those of the dithered pixels), f1–f4 the map's
 *   own parameters;
 * - effect_*: each effect, -1 off, 1 on (2 for two chasers);
 * - pal_*: the 8-bit palette (a band brighter, the "FX" palettes, or three curves 1–7). Saved at
 *   8 bits only; above it the plug-in made no palette.
 */
export interface GeissPreset {
  x_center: number;
  y_center: number;
  mode: number;
  damping: number;
  wave: number;
  magic: number;
  volpos: number;
  shift: number;
  gamma: number;
  t1: number;
  t2: number;
  s1: number;
  s2: number;
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  effect_chasers: number;
  effect_bar: number;
  effect_dots: number;
  effect_solar: number;
  effect_grid: number;
  effect_nuclide: number;
  effect_shadebobs: number;
  effect_spectral: number;
  pal_lo_band?: number;
  pal_hi_band?: number;
  pal_bFX?: number;
  pal_FXpalnum?: number;
  pal_curve_id_1?: number;
  pal_curve_id_2?: number;
  pal_curve_id_3?: number;
  spectrum: number;
}

/** The keys LoadPreset() reads as floats (sscanf "%f"); the others it reads as integers. */
export const GEISS_PRESET_FLOATS: readonly (keyof GeissPreset)[] = [
  "x_center", "y_center", "damping", "t1", "t2", "s1", "s2", "f1", "f2", "f3", "f4"
];

/** The effects of a preset, by key, in the order of effect[]. */
const PRESET_EFFECTS: readonly (readonly [keyof GeissPreset, number])[] = [
  ["effect_chasers", CHASERS], ["effect_bar", BAR], ["effect_dots", DOTS], ["effect_solar", SOLAR],
  ["effect_grid", GRID], ["effect_nuclide", NUCLIDE], ["effect_shadebobs", SHADE], ["effect_spectral", SPECTRAL]
];

/** The float next to `value` (an f32) towards `direction` (+1 up, -1 down). */
function f32Step(value: number, direction: 1 | -1): number {
  const bits = new Float32Array([value]);
  const word = new Int32Array(bits.buffer);
  if (value === 0) {
    word[0] = direction > 0 ? 1 : -2147483647;
  } else {
    word[0] = word[0]! + ((value > 0) === (direction > 0) ? 1 : -1);
  }
  return bits[0]!;
}

/** What LoadPreset() also restores, the part GenerateChunkOfNewMap(true) reads back. */
interface PresetMap {
  t1: number;
  t2: number;
  s1: number;
  s2: number;
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  effects: readonly number[];
  shift: boolean;
}

export interface GeissOptions {
  titles?: (text: string, width: number) => TitleMask | null;
  ratings?: readonly number[];
  /** The video mode's colour depth; 8 when not given. */
  depth?: GeissDepth;
  /**
   * Go on from this one at the new size or depth (the plug-in only ever had one): its picture
   * carried over, its palette, clock, sound history and random sequence, and its map built anew.
   */
  from?: GeissSim;
  /** Start with this preset loaded (`[##`) instead of a map of its own (or of `from`'s). */
  preset?: Partial<GeissPreset>;
}

/** The plug-in's state (its globals) and its frame. */
export class GeissSim {
  public readonly width: number;
  public readonly height: number;
  public readonly depth: GeissDepth;
  public readonly rand: MsvcRand;
  /**
   * The picture: VS1 after the frame — at 8 bits a palette index per pixel, above 8 bits four
   * bytes per pixel (blue, green, red, unused), at half the brightness shown (Merge doubles it).
   */
  public vs1: Uint8Array;
  private vs2: Uint8Array;
  /** The palette shown at 8 bits (PutPalette's apetemp): r, g, b per index. */
  public readonly palette = new Uint8Array(768);

  /** Above 8 bits: four bytes per pixel. */
  private readonly hicolor: boolean;
  private readonly bytes: number;
  private readonly fxYcut: number;
  private readonly fxYcutHide: number;
  private readonly bufsize: number;
  private readonly modeInfo: ModeInfo[];
  /**
   * The MMX warp's carry (mm6) per lane — blue, green, red, unused — when the next frame starts:
   * at 32 bits whatever the screen copy left in it, at 16 bits the warp's own last carry.
   */
  private readonly mm6 = new Int32Array(4);
  /** Map 15's atan2 ran on the x87 stack since the last warp, which shares mm6's register. */
  private x87Clobbered = false;
  /** …and its last call turned a quadrant (x < 0), leaving π's significand there. */
  private x87Pi = false;

  // DATA_FX / DATA_FX2: per pixel the look-at offset (the sum of the asm's deltas) and the four
  // weights, packed low byte first (top left, top right, bottom left, bottom right).
  private mapOffset: Int32Array;
  private mapWeights: Uint32Array;
  private nextOffset: Int32Array;
  private nextWeights: Uint32Array;

  // Palette (video.h).
  private readonly ape = new Uint8Array(768);
  private readonly ape2 = new Uint8Array(768);
  private readonly remap = new Uint8Array(768);
  private blendsLeftInPal = 0;
  private oldPalette = { loBand: -1, hiBand: -1, fx: false, fxNum: -1, c1: -1, c2: -1, c3: -1 };
  public gamma = 10;
  public solarPalFreq = 1;
  public coarsePalFreq = 1;
  public palLocked = false;

  // Map generation.
  public mode = 0;
  public newMode = 0;
  private gXC = 0;
  private gYC = 0;
  private newGXC = 0;
  private newGYC = 0;
  private yMapPos = -1;
  private rOffset = 0;
  private rushMap = false;
  public locked = false;
  private framesCrunching = 0;
  private framesThisMode = 0;
  private framesTilAutoSwitch = 550;
  /** frames_til_auto_switch__registry: the map's lifetime at 30 fps. */
  public framesTilAutoSwitchRegistry = 550;
  private weightsum = 256;
  private weightsumResAdjusted = 253;
  private newDamping = 1;
  private readonly suggestedDamping = 1;
  private scale1 = 0;
  private scale2 = 0;
  private turn1 = 0;
  private turn2 = 0;
  private cosTurn1 = 0;
  private sinTurn1 = 0;
  private cosTurn2 = 0;
  private sinTurn2 = 0;
  private f1 = 0;
  private f2 = 0;
  private f3 = 0;
  /** Drawn by map 17 and never read by a map, but SavePreset() writes it. */
  private f4 = 0;
  /** damping: the map on screen's (new_damping is the next one's). */
  private damping = 1;
  // old_f1…old_scale2, old_weightsum: the map on screen's parameters, which SavePreset() writes
  // (the globals belong to the next map as soon as it starts to be built).
  private oldF1 = 0;
  private oldF2 = 0;
  private oldF3 = 0;
  private oldF4 = 0;
  private oldTurn1 = 0;
  private oldTurn2 = 0;
  private oldScale1 = 0;
  private oldScale2 = 0;
  /**
   * The weight sum a map starts from (256, or a preset's `magic`) before its own set-up lowers it
   * (map 12: ×0.98), for the next map and for the one on screen: what `magic` must hold for
   * LoadPreset() to give the map's weight sum back.
   */
  private newMagic = 256;
  private oldMagic = 256;
  /** volpos: the wave's volume step, 0–20 (keys + and -), 10 the middle; volscale follows it. */
  public volpos = 10;
  /** A preset being loaded: what GenerateChunkOfNewMap(true) reads back from GEISS.INI. */
  private loading: PresetMap | null = null;
  /** Maps put on screen so far (a loaded preset is still on screen while this has not moved). */
  public mapsApplied = 0;
  private rmult = 0;
  /** Read by map 9's set-up before this map sets it: 0 on the very first map, as in C. */
  private protectiveFactor = 0;
  private readonly cx = new Float32Array(10);
  private readonly cy = new Float32Array(10);
  private readonly ci = new Float32Array(10);
  private readonly cj = new Float32Array(10);
  private readonly ctype = new Int32Array(10);
  private randArrayPos = 0;
  private readonly randArray = new Float32Array(2345);
  private ratings: number[] = [...DEFAULT_MODE_RATINGS];
  private ratingsTotal = DEFAULT_MODE_RATINGS.reduce((sum, value) => sum + value, 0);

  // Effects.
  public readonly effect = new Int32Array(NUM_EFFECTS);
  public waveform = 0;
  private newWaveform = 0;
  private visMode = SPECTRUM;
  private solarMax = 60;
  private centerDwindle = f32(0.99);
  private gridDir = 1;
  private chaserOffset = 0;
  private readonly chaserX = new Int32Array(20);
  private readonly chaserY = new Int32Array(20);
  private readonly chaserR = new Uint8Array(20);
  private readonly chaserG = new Uint8Array(20);
  private readonly chaserB = new Uint8Array(20);
  private chaserPtr = 0;
  private readonly microC1 = new Float32Array(10);
  private readonly microC2 = new Float32Array(10);
  private readonly microC3 = new Float32Array(10);
  private readonly microF1 = new Float32Array(10);
  private readonly microF2 = new Float32Array(10);
  private readonly microF3 = new Float32Array(10);
  private readonly microF4 = new Float32Array(10);
  private readonly microRad = [new Float32Array(10), new Float32Array(10), new Float32Array(10), new Float32Array(10)];
  private readonly gF = new Float32Array(6);
  private readonly sqrtTab = new Float32Array(21 * 21);

  // Time.
  private intframe = 0;
  private floatframe = 0;
  public fps = f32(40);
  public fpsAtLastModeSwitch = f32(40);
  private readonly timeArray = new Float32Array(30);
  private timeArrayPos = 0;
  private timeArrayReady = false;

  // Sound (GetWaveData, RenderDots, RenderWave).
  private readonly soundBuffer = new Int16Array(16384);
  private readonly fSoundBuffer = new Float32Array(16384);
  private readonly passBuffer = new Float32Array(16384);
  private soundActive = false;
  private readonly soundEmpty = false;
  public volscale = f32(0.2);
  private lastFrameV = 0;
  private lastFrameSlope = 0;
  private currentVol = 0;
  private avgVol = 1;
  private avgVolNarrow = 1;
  private readonly pastVol = new Float32Array(PAST_VOL_N);
  private pastVolPos = 0;
  public beatMode = false;
  public bigBeat = false;
  private bigBeatThreshold = f32(1.1);
  public useBeatDetection = true;
  public slider1 = 0;
  public slideShift = true;
  public slideShiftFreq = 33;
  private framesSinceShift = 0;
  private shiftMaxVol = 0;
  /**
   * g_bSyncColorToSound: above 8 bits the waves take their colour from the music (the Fourier
   * analysis below) rather than from the frame number alone. Off by default, as in Geiss 4.30
   * ("Don't base the wave colors on the music" ticked in its config panel).
   */
  public syncColorToSound = false;
  /** g_power[] and g_power_smoothed[]: the 24 bands of GetWaveData()'s analysis (above 8 bits). */
  private readonly power = new Float32Array(FOURIER_DETAIL);
  private readonly powerSmoothed = new Float32Array(FOURIER_DETAIL);

  // Song titles (plug-in only).
  /** g_bDisableSongTitlePopups, inverted: when false no rand() is spent on titles, as there. */
  public titles: boolean;
  /** g_song_tooltip_frames: frames at 30 fps a title stays before it melts. */
  public titleFrames = 20;
  private hit = 0;
  private hitPrev = -1;
  /** g_song_title: the title shown, or the custom message shown instead. */
  private songTitle = "";
  /** g_LastMessageWasCustom: the next new title replaces a message without popping up. */
  private lastMessageWasCustom = false;
  private pendingTitle = "";
  private titleMask: TitleMask | null = null;
  private titleX = 0;
  private titleY = 0;
  /** g_title_R/G/B: the colour a title is burnt in above 8 bits. */
  private titleR = 0;
  private titleG = 0;
  private titleB = 0;
  private readonly rasterise: ((text: string, width: number) => TitleMask | null) | null;

  /**
   * FX_Init() at `width` × `height` (multiples of 4, at least 320 × 200; at 32 bits the width a
   * multiple of 16, as Merge's copy needs), rand() seeded with `seed`. `titles` rasterises a song
   * title or message as GDI drew it at this width (in the plug-in's font, at 320 in SYSTEM_FONT),
   * and turns the popups on; `ratings` are the stars the first map is already picked by.
   */
  public constructor(width: number, height: number, seed = 1, options: GeissOptions = {}) {
    const depth = options.depth ?? 8;
    if (width < 320 || height < 200 || width % 4 || height % 4 || (depth === 32 && width % 16)) {
      throw new Error(`Geiss: ${width}×${height}×${depth} is not a mode it could run`);
    }
    this.width = width;
    this.height = height;
    this.depth = depth;
    this.hicolor = depth !== 8;
    this.bytes = this.hicolor ? 4 : 1;
    this.modeInfo = modeInfoTable(this.hicolor);
    this.rand = new MsvcRand(seed);
    this.rasterise = options.titles ?? null;
    this.titles = this.rasterise !== null;
    if (options.ratings) this.setRatings(options.ratings);
    // OnFxwFxhUpdated() with the vertical size at 100 %.
    this.fxYcut = Math.trunc(Math.max(4, (65 - 0.65 * 100) * 0.5 * 0.01 * height));
    this.fxYcutHide = this.fxYcut;
    this.bufsize = Math.min(1023, Math.max(width * 2, MINBUFSIZE));
    const pixels = width * height;
    this.vs1 = new Uint8Array(pixels * this.bytes + 1024);
    this.vs2 = new Uint8Array(pixels * this.bytes + 1024);
    this.mapOffset = new Int32Array(pixels);
    this.mapWeights = new Uint32Array(pixels);
    this.nextOffset = new Int32Array(pixels);
    this.nextWeights = new Uint32Array(pixels);
    this.fxInit(!options.from && !options.preset);
    if (options.from) {
      this.continueFrom(options.from, options.preset);
      return;
    }
    // doInit(): the palette starts from black (at 8 bits; above, there is none).
    this.ape2.fill(0);
    // A preset to start with brings its own palette, blended in from black.
    if (options.preset && this.loadPreset(options.preset)) return;
    this.randomPalette();
    if (options.preset) {
      // Not a preset after all: the map FX_Init() would have made.
      this.pickRandomMode();
      this.rushMap = true;
      this.yMapPos = -1;
      do this.generateChunkOfNewMap(); while (this.yMapPos !== -1);
    }
  }

  /** The rows Process_Map() computes; the rest of the screen is black (palette index 0). */
  public get band(): { top: number; bottom: number } {
    return { top: this.fxYcutHide, bottom: this.height - this.fxYcutHide };
  }

  /** The map on screen, 1–25. */
  public get currentMode(): number {
    return this.mode;
  }

  /** The stars of every map (index 1–25) Auto picks by; none above zero and it picks evenly. */
  public setRatings(ratings: readonly number[]): void {
    this.ratings = [0];
    for (let index = 1; index <= NUM_MODES; index += 1) this.ratings.push(Math.max(0, Math.min(5, Math.trunc(ratings[index] ?? 0))));
    this.ratingsTotal = this.ratings.reduce((sum, value) => sum + value, 0);
  }

  // ---- FX_Init ------------------------------------------------------------------------------

  private fxInit(withMap: boolean): void {
    const r = this.rand;
    this.chaserOffset = r.next() % 40000;
    for (let z = 0; z < 256; z += 1) this.remap[z] = Math.min(255, z * 2);
    // fScatter[]: drawn and never used, but the draws count.
    for (let z = 0; z < 226; z += 1) r.next();
    for (let z = 0; z < 20; z += 1) {
      this.chaserX[z] = 1;
      this.chaserY[z] = 1;
    }
    for (let x = 0; x <= 20; x += 1) {
      for (let z = 0; z <= 20; z += 1) this.sqrtTab[x * 21 + z] = f32(Math.sqrt((x - 10) * (x - 10) + (z - 10) * (z - 10)));
    }
    for (let z = 0; z < 10; z += 1) {
      this.microC1[z] = 0.08 + 0.09 * (r.next() % 1000) * 0.001;
      this.microC2[z] = 0.08 + 0.09 * (r.next() % 1000) * 0.001;
      this.microC3[z] = 0.08 + 0.09 * (r.next() % 1000) * 0.001;
      this.microF1[z] = 0.1 + 0.05 * (r.next() % 1000) * 0.001;
      this.microF2[z] = 0.1 + 0.05 * (r.next() % 1000) * 0.001;
      this.microF3[z] = 0.1 + 0.05 * (r.next() % 1000) * 0.001;
      this.microF4[z] = 0.1 + 0.05 * (r.next() % 1000) * 0.001;
      for (let k = 0; k < 4; k += 1) this.microRad[k]![z] = 2.0 + 2.8 * (r.next() % 1000) * 0.001;
    }
    for (let z = 0; z < 6; z += 1) this.gF[z] = ((r.next() % 1000) * 0.001) * 0.01 + 0.02;
    for (let z = 0; z < 2345; z += 1) this.randArray[z] = (r.next() % 100) * 0.0005;
    if (!withMap) return;
    this.pickRandomMode();
    this.rushMap = true;
    this.yMapPos = -1;
    do this.generateChunkOfNewMap(); while (this.yMapPos !== -1);
  }

  /** FX_Pick_Random_Mode(): by the stars, or evenly (with 5 and 7 a little likelier). */
  private pickRandomMode(): void {
    const r = this.rand;
    if (this.ratingsTotal <= 0) {
      this.newMode = 1 + r.next() % NUM_MODES;
      if (r.next() % 25 === 0) this.newMode = 7;
      if (r.next() % 25 === 0) this.newMode = 5;
      this.yMapPos = -1;
      return;
    }
    const a = r.next() % this.ratingsTotal;
    let b = 0;
    for (let i = 1; i <= NUM_MODES; i += 1) {
      b += this.ratings[i]!;
      if (a < b) {
        this.newMode = i;
        this.yMapPos = -1;
        return;
      }
    }
  }

  // ---- GenerateChunkOfNewMap ----------------------------------------------------------------

  private initNewMap(): void {
    const r = this.rand;
    const W = this.width;
    const H = this.height;
    const rnd = (): number => (r.next() % 1000) * 0.001;
    const m = this.newMode;
    // A preset brings its centre, weight sum, damping and waveform (LoadPreset() set them).
    const load = this.loading;
    if (!load) {
      this.newGXC = Math.trunc(W / 2) - 1 + r.next() % 60 - 30;
      this.newGYC = Math.trunc(H / 2) - 1 + r.next() % 30 - 15;
      this.weightsum = 256;
      let damping = f32(this.suggestedDamping);
      if (damping < 0.5) damping = f32(0.5);
      if (damping > 1.0) damping = f32(1.0);
      if (MOTION_DAMPENED[this.newMode]) damping = f32(damping * 0.5);
      this.newDamping = damping;
      let wave: number;
      do wave = Math.trunc((r.next() % (NUM_WAVES * 3 - 1)) / 3) + 1;
      while ((m === 6 && wave === 5) || (m === 12 && (wave === 4 || wave === 6)) || (m === 14 && (wave === 3 || wave === 4))
        || ((m === 8 || m === 23 || m === 24) && wave === 6));
      this.newWaveform = wave;
    }
    this.newMagic = this.weightsum;
    this.bigBeatThreshold = f32(1.1);
    this.framesThisMode = 0;
    this.framesCrunching = 0;

    if (m === 1) {
      this.scale1 = f32(0.985 - 0.12 * f32(Math.pow(f32(rnd()), 2)));
      this.scale2 = this.scale1;
      this.turn1 = f32(0.01 + 0.01 * rnd());
      this.turn2 = this.turn1;
      if (this.scale1 > 0.97 && r.next() % 3 === 1) this.turn1 = f32(this.turn1 * -1);
    } else if (m === 2) {
      this.scale1 = f32(1.0 + 0.02 * rnd());
      this.turn1 = f32(0.02 + 0.07 * rnd());
    } else if (m === 3) {
      this.scale1 = f32(0.85 + 0.1 * rnd());
      this.scale2 = this.scale1;
      this.turn1 = f32(0.01 + 0.015 * rnd());
      this.turn2 = this.turn1;
    } else if (m === 4) {
      this.turn1 = f32(0.007 + 0.02 * rnd());
      this.turn2 = this.turn1;
    } else if (m === 5) {
      this.turn1 = f32(0.01 + 0.03 * rnd());
      this.turn2 = this.turn1;
    } else if (m === 6) {
      for (let x = 0; x < 10; x += 1) {
        this.cx[x] = (r.next() % (W * 10)) * 0.1;
        this.cy[x] = this.fxYcut + (r.next() % ((H - this.fxYcut * 2) * 10)) * 0.1;
        const d = f32((r.next() % 628) * 0.01);
        const f = f32(1 + (r.next() % 80) * 0.01);
        this.ci[x] = f32(f32(Math.cos(d)) * f);
        this.cj[x] = f32(f32(Math.sin(d)) * f);
        this.ctype[x] = r.next() % 3;
        r.next(); // cr[x] = 80 + (rand() % 1200)*0.1: drawn, unused by the map
      }
    } else if (m === 7) {
      this.turn1 = f32(0.01 + 0.01 * rnd());
      this.turn2 = this.turn1;
    } else if (m === 8) {
      this.turn1 = f32(0.05 * (0.001 * (r.next() % 1000)));
      this.turn2 = this.turn1;
    } else if (m === 9) {
      this.scale1 = f32(0.8 + 0.25 * rnd());
      this.scale1 = f32(f32(f32(this.scale1 - 1) * this.protectiveFactor) + 1);
      this.scale2 = this.scale1;
      this.turn1 = f32(0.01 + 0.03 * rnd());
      this.turn2 = this.turn1;
    } else if (m === 11) {
      this.scale1 = f32(1.008 + 0.008 * rnd());
      this.scale2 = this.scale1;
      this.turn1 = f32(0.12 + 0.06 * rnd());
      this.turn2 = this.turn1;
      this.turn1 = f32(this.turn1 * -0.6);
      this.turn2 = f32(this.turn2 * 0.1);
      this.scale1 = f32(this.scale1 * 0.99);
      this.scale2 = f32(this.scale2 * 1.01);
    } else if (m === 12) {
      this.weightsum = Math.trunc(this.weightsum * 0.98);
    } else if (m === 13 || m === 14 || m === 16 || m >= 17) {
      this.turn1 = f32(0.007 + 0.02 * rnd());
      this.turn2 = this.turn1;
    } else if (m === 15) {
      // MSVC calls the right-hand rand() of "a*rand… + b*rand…" first.
      const b = rnd();
      this.turn1 = f32(0.04 * rnd() + 0.045 * b);
      this.turn2 = this.turn1;
    }

    if (r.next() % 2 === 1) {
      this.turn1 = f32(this.turn1 * -1);
      this.turn2 = f32(this.turn2 * -1);
    }

    this.f1 = f32(0.92 + 0.05 * rnd());
    this.f2 = f32(0.0009 + 0.0012 * rnd());
    if (m === 5) {
      const a = rnd();
      this.f1 = f32(0.05 + 0.05 * a + 0.07 * rnd());
      const b = rnd();
      this.f2 = f32(0.99 - 0.01 * b - 0.02 * rnd());
    } else if (m === 7) {
      this.f1 = f32(0.92 + 0.01 * rnd());
      this.f2 = f32(0.0006 + 0.0005 * rnd());
    } else if (m === 8) {
      let f1 = f32(0.001 * (r.next() % 1000));
      f1 = f32(f1 * f1);
      f1 = f32(f1 * f1);
      f1 = f32(f1 * 8);
      this.f1 = f32(f1 + 1.5);
    } else if (m === 9) {
      this.f1 = f32(0.98 + 0.01 * rnd());
      this.f2 = f32(0.0009 + 0.0012 * rnd());
    } else if (m === 13) {
      this.f1 = f32(0.92 + 0.16 * rnd());
    } else if (m === 15) {
      this.f1 = r.next() % 5 + 2;
      this.f2 = f32(0.92 + 0.06 * rnd());
      this.f3 = f32(0.05 + 0.05 * rnd());
    } else if (m === 17) {
      this.f1 = f32(0.01 + 0.09 * rnd());
      this.f2 = f32(0.01 + 0.09 * rnd());
      this.f3 = f32(0.01 + 0.09 * rnd());
      this.f4 = f32(0.01 + 0.09 * rnd()); // never read by the map
    }

    this.turn1 = f32(this.turn1 * 0.6);
    this.turn2 = f32(this.turn2 * 0.6);
    this.rOffset = 0;
    this.rmult = f32(640.0 / W);
    this.protectiveFactor = W > 640 ? f32(640.0 / W) : 1;
    if (load) {
      // The preset's own, over what was just drawn for the map.
      this.turn1 = load.t1;
      this.turn2 = load.t2;
      this.scale1 = load.s1;
      this.scale2 = load.s2;
      this.f1 = load.f1;
      this.f2 = load.f2;
      this.f3 = load.f3;
      this.f4 = load.f4;
    }
    this.cosTurn1 = f32(Math.cos(this.turn1));
    this.sinTurn1 = f32(Math.sin(this.turn1));
    this.cosTurn2 = f32(Math.cos(this.turn2));
    this.sinTurn2 = f32(Math.sin(this.turn2));

    const pixels = W * H;
    const share = pixels <= 320 * 240 ? 250 : pixels <= 400 * 300 ? 251 : pixels <= 512 * 384 ? 252
      : pixels <= 800 * 600 ? 253 : pixels <= 1280 * 960 ? 254 : 255;
    this.weightsumResAdjusted = Math.trunc((this.weightsum * share) / 256);
    this.framesTilAutoSwitch = this.framesTilAutoSwitchRegistry;
    if (this.fps >= 10 && this.fps < 120) this.framesTilAutoSwitch = toInt(f32(f32(this.framesTilAutoSwitchRegistry * this.fps) / 30));
  }

  private generateChunkOfNewMap(): void {
    const W = this.width;
    const H = this.height;
    const ycut = this.fxYcut;
    if (this.yMapPos === -1) this.yMapPos = ycut * W;
    if (this.yMapPos === ycut * W) this.initNewMap();

    const end = (H - ycut) * W;
    if (this.yMapPos < end) {
      const m = this.newMode;
      this.framesCrunching += 1;
      let damping = this.newDamping;
      if (this.fpsAtLastModeSwitch >= 10 && this.fpsAtLastModeSwitch <= 120) damping = f32(damping * f32(30 / this.fpsAtLastModeSwitch));
      const undamped = f32(1 - damping);
      let endPos = toInt(f32(W * f32(ycut + f32(f32(this.framesCrunching / this.framesTilAutoSwitch) * (H - ycut * 2)))));
      if (this.rushMap || endPos > end) endPos = end;
      // Map 15's atan2 runs on the x87 stack, whose registers MMX shares (see processMapMmx):
      // what it leaves in mm6's register depends on the last pixel it did.
      if (m === 15 && endPos > this.yMapPos) {
        this.x87Clobbered = true;
        this.x87Pi = (endPos - 1) % W - this.newGXC < 0;
      }

      const invFXW = f32(2.0 / W);
      const halfFXW = m <= 16 ? 1 : f32(0.5 * W);
      const gx = this.newGXC;
      const gy = this.newGYC;
      const offsets = this.nextOffset;
      const weights = this.nextWeights;
      const wsum = this.weightsumResAdjusted;
      const lowest = W * 2;
      const highest = W * (H - 3) - 1;
      const custom = CUSTOM_MOTION_VECTORS[m]!;
      const dither = ROTATION_DITHER[m]!;
      let y = Math.trunc(this.yMapPos / W);
      let x = this.yMapPos % W;
      let rOffset = this.rOffset;
      for (; this.yMapPos < endPos; this.yMapPos += 1) {
        let nx2 = x - gx;
        let ny2 = y - gy;
        let newx: number;
        let newy: number;
        if (m <= 16) {
          if (m === 3) {
            this.scale1 = f32(0.95 - (ny2 * (480.0 / H)) * 0.0005);
          } else if (m === 4) {
            let r = f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2))));
            r = f32(r * this.rmult);
            this.scale1 = f32(0.9 + r * 0.0025 * 0.14);
          } else if (m === 5) {
            let r = f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2))));
            r = f32(r * (1.0 / 200.0));
            r = f32(r * this.rmult);
            if (this.effect[NUCLIDE] === -1) r = f32(Math.sqrt(r));
            else r = f32(r * 1.7);
            const s = f32(this.f2 - f32(this.f1 * r));
            this.scale1 = f32(f32(f32(s - 1) * this.protectiveFactor) + 1);
          } else if (m === 7) {
            let r = f32(f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2)))) * this.f2);
            r = f32(r * this.rmult);
            let s = f32(this.f1 - r);
            s = f32(f32(f32(s - 1) * this.protectiveFactor) + 1);
            this.scale1 = f32(s + this.randArray[this.randArrayPos]!);
            this.randArrayPos += 1;
            if (this.randArrayPos >= 2345) this.randArrayPos = 0;
          } else if (m === 8) {
            let r = f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2))));
            r = f32(r * this.rmult);
            this.scale1 = f32(0.85 + 0.1 * f32(Math.sin(f32(f32(Math.sqrt(r)) * this.f1))));
          } else if (m === 9) {
            let r = f32(f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2)))) * this.f2);
            r = f32(r * this.rmult);
            const s = f32(this.f1 - r);
            this.scale1 = f32(f32(f32(s - 1) * this.protectiveFactor) + 1);
          } else if (m === 13) {
            let r = f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2))));
            r = f32(r * this.rmult);
            const s = f32(1.04 - f32(r * f32(Math.sqrt(r))) * 0.00025 * 0.14);
            this.scale1 = f32(f32(f32(s - 1) * this.f1) + 1);
          } else if (m === 14) {
            const q = f32((this.rand.next() & 1023) / 1024);
            this.scale1 = f32(0.9 + 0.2 * f32(Math.cos(f32(f32(ny2 * 12) / f32(H + q)))));
          } else if (m === 15) {
            this.scale1 = f32(this.f2 + f32(this.f3 * f32(Math.sin(f32(Math.atan2(ny2, nx2) * this.f1)))));
          } else if (m === 16) {
            let r = f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2))));
            r = f32(r * this.rmult);
            let s = f32(1.05 - f32(r * r) * 0.00025 * 0.09);
            if (s < -1.5) s = f32(-1.5);
            this.scale1 = s;
          }
        } else {
          nx2 = f32(nx2 * invFXW);
          ny2 = f32(ny2 * invFXW);
          if (m === 17) {
            this.scale1 = f32(0.97 - f32(ny2 * ny2) * 0.40);
          } else if (m === 18) {
            this.scale1 = f32(0.97 - f32(nx2 * nx2) * 0.40);
          } else if (m === 19) {
            this.scale1 = f32(1.04 - 0.25 * f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2)))));
          } else if (m === 20) {
            this.scale1 = f32(1.15 - f32(Math.sqrt(f32(ny2 + 1.4))) * 0.20);
          } else if (m === 21) {
            this.scale1 = f32(0.95 - toInt(f32(Math.abs(nx2) * 10)) * 0.03 - toInt(f32(Math.abs(ny2) * 10)) * 0.03);
          } else if (m === 22) {
            this.scale1 = f32(0.95 - toInt(f32(f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2)))) * 10)) * 0.04);
          } else if (m === 23) {
            this.scale1 = f32(0.95 - (toInt(f32(f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2)))) * 20)) % 4) * 0.12);
          } else if (m === 24) {
            this.scale1 = f32(0.96);
            this.turn1 = f32(0.05);
            this.cosTurn1 = f32(Math.cos(this.turn1));
            this.sinTurn1 = f32(Math.sin(this.turn1));
          } else if (m === 25) {
            this.scale1 = f32(3.0 / (3.0 + f32(Math.sqrt(f32(f32(nx2 * nx2) + f32(ny2 * ny2))))));
          }
        }

        if (custom) {
          if (m === 6) {
            let tx = 0;
            let ty = 0;
            let f = 0;
            for (let n = 0; n < 5; n += 1) {
              const nx = f32(this.cx[n]! - x);
              const ny = f32(this.cy[n]! - y);
              const xxyy = f32(f32(nx * nx) + f32(ny * ny));
              let d = f32(1.0 / (xxyy + 0.1));
              f = f32(f + d);
              const type = this.ctype[n];
              if (type === 0) {
                tx = f32(tx + f32(this.ci[n]! * d));
                ty = f32(ty + f32(this.cj[n]! * d));
              } else {
                let z = f32(Math.sqrt(xxyy));
                z = f32(1.0 / (z + 0.01));
                d = f32(d + d);
                if (type === 1) {
                  tx = f32(tx + f32(f32(d * -ny) * z));
                  ty = f32(ty + f32(f32(d * nx) * z));
                } else {
                  tx = f32(tx + f32(f32(d * ny) * z));
                  ty = f32(ty + f32(f32(d * -nx) * z));
                }
              }
            }
            if (f > 0.000001) {
              f = f32(1.9 / f);
              tx = f32(tx * f);
              ty = f32(ty * f);
            } else {
              tx = 0;
              ty = 0;
            }
            newx = f32(f32(x + tx) - 0.1);
            newy = f32(f32(y + ty) + 0.6);
          } else if (m === 10) {
            newx = f32(nx2 * (1.03 + 0.03 * f32(y / H)) + gx);
            newy = f32(y * 1.04);
          } else {
            if (nx2 < -0.5) newx = f32(f32(-f32(Math.sqrt(-nx2)) + gx) + 0.9);
            else if (nx2 > 0.5) newx = f32(f32(f32(Math.sqrt(nx2)) + gx) - 0.9);
            else newx = gx;
            newy = f32(ny2 + gy);
          }
        } else {
          let c = this.cosTurn1;
          let s = this.sinTurn1;
          let scale = this.scale1;
          if (dither && (x % 2) !== (y % 2)) {
            c = this.cosTurn2;
            s = this.sinTurn2;
            scale = this.scale2;
          }
          const rx = f32(f32(nx2 * c) - f32(ny2 * s));
          const ry = f32(f32(nx2 * s) + f32(ny2 * c));
          newx = f32(f32(f32(rx * scale) * halfFXW) + gx);
          newy = f32(f32(f32(ry * scale) * halfFXW) + gy);
        }

        newx = f32(f32(x * undamped) + f32(newx * damping));
        newy = f32(f32(y * undamped) + f32(newy * damping));
        if (Number.isFinite(newx)) {
          while (newx < 0.0) newx = f32(newx + (W - 1));
          while (newx > W - 1) newx = f32(newx - (W - 1));
        }

        const a = toInt(newx);
        const b = toInt(newy);
        rOffset = (Math.imul(b, W) + a) | 0;
        if (rOffset < lowest) rOffset = lowest;
        if (rOffset >= highest) rOffset = highest;
        // a and b are unsigned long in the original: a newy below -1 makes b huge, and the
        // weights of that pixel come out 0.
        const fx = f32(newx - f32(a >>> 0));
        const fy = f32(newy - f32(b >>> 0));
        const gxw = f32(1 - fx);
        const gyw = f32(1 - fy);
        const index = y * W + x;
        offsets[index] = rOffset;
        weights[index] = (toByte(f32(f32(gxw * gyw) * wsum))
          | (toByte(f32(f32(fx * gyw) * wsum)) << 8)
          | (toByte(f32(f32(gxw * fy) * wsum)) << 16)
          | (toByte(f32(f32(fx * fy) * wsum)) << 24)) >>> 0;
        x += 1;
        if (x === W) {
          x = 0;
          y += 1;
        }
      }
      this.rOffset = rOffset;
    }

    if (this.yMapPos === end && !this.rushMap && this.beatMode && !this.bigBeat) {
      this.bigBeatThreshold = f32(this.bigBeatThreshold - 0.2 / this.framesTilAutoSwitch);
    } else if (this.yMapPos === end && (this.rushMap || !this.beatMode || this.bigBeat)) {
      this.applyNewMap();
    }
  }

  /** The finished map takes over: GenerateChunkOfNewMap()'s last part. */
  private applyNewMap(): void {
    const r = this.rand;
    const W = this.width * this.bytes;
    const H = this.height;
    const load = this.loading;
    this.loading = null;
    this.yMapPos = -1;
    this.mode = this.newMode;
    this.damping = this.newDamping;
    this.gXC = this.newGXC;
    this.gYC = this.newGYC;
    this.waveform = this.newWaveform;
    if (this.fps >= 5 && this.fps <= 120) this.fpsAtLastModeSwitch = this.fps;
    this.oldF1 = this.f1;
    this.oldF2 = this.f2;
    this.oldF3 = this.f3;
    this.oldF4 = this.f4;
    this.oldMagic = this.newMagic;
    this.oldTurn1 = this.turn1;
    this.oldTurn2 = this.turn2;
    this.oldScale1 = this.scale1;
    this.oldScale2 = this.scale2;
    this.mapsApplied += 1;
    this.locked = false;
    if (this.mode !== 6) {
      const k = Math.max(0, this.fxYcutHide - 6);
      const lines = Math.min(6, this.fxYcutHide);
      for (const vs of [this.vs1, this.vs2]) {
        vs.fill(0, k * W, (k + lines) * W);
        vs.fill(0, (H - 1 - k - lines) * W, (H - 1 - k) * W);
      }
    }

    const info = this.modeInfo[this.mode]!;
    if (load) {
      // The preset's effects and shifting; the waveform and spectrum dots came with it.
      for (const [index, value] of load.effects.entries()) this.effect[PRESET_EFFECTS[index]![1]] = value;
      this.slideShift = load.shift;
    } else {
      this.slideShift = (r.next() % 100 + 1) <= this.slideShiftFreq;
      for (let x = 0; x < NUM_EFFECTS; x += 1) {
        let thresh = info.effectFreq[x]!;
        if (this.soundActive && !this.soundEmpty) thresh = Math.trunc(thresh * 0.7);
        this.effect[x] = r.next() % 1000 < thresh ? 1 : -1;
      }
      this.clipNumEffects(info);
      if (this.effect[CHASERS] === 1) this.effect[CHASERS] = 1 + r.next() % 2;
      if (this.effect[GRID] === 1) this.effect[BAR] = -1;
      if (this.mode === 1 && r.next() % 2 === 0) this.dropSolarParticles(500);
      this.gridDir = (r.next() % 2) * 2 - 1;
      if (this.effect[NUCLIDE]! > 0 && r.next() % 7 > 2) this.waveform = 0;
      this.visMode = WAVE;
      if (this.newMode === 10) {
        this.waveform = 1;
        if (r.next() % 4 > 0) this.visMode = SPECTRUM;
      }
      if (this.newMode === 15 && r.next() % 5 === 0) this.waveform = 5;
      if (this.effect[SPECTRAL] === 1) this.waveform = 0;
    }
    if (!this.slideShift) this.slider1 = 0;
    this.solarMax = info.solarMax;
    this.centerDwindle = info.centerDwindle;

    [this.mapOffset, this.nextOffset] = [this.nextOffset, this.mapOffset];
    [this.mapWeights, this.nextWeights] = [this.nextWeights, this.mapWeights];
    if (!load && this.intframe > 0) this.randomPalette();
    this.rushMap = false;
  }

  /** CModeInfo::Clip_Num_Effects(). */
  private clipNumEffects(info: ModeInfo): void {
    const r = this.rand;
    const effect = this.effect;
    let n = 0;
    for (let i = 0; i < NUM_EFFECTS; i += 1) if (effect[i]! > 0) n += 1;
    if (!this.soundActive || this.soundEmpty) {
      while (n < info.minEffects) {
        let gotOne = false;
        for (let j = 0; j < NUM_EFFECTS; j += 1) {
          if (effect[j] === -1 && r.next() % 1000 < info.effectFreq[j]! && !gotOne) {
            effect[j] = 1;
            gotOne = true;
            n += 1;
          }
        }
      }
    }
    for (let j = 0; j < NUM_EFFECTS; j += 1) if (info.effectFreq[j]! >= 1000) effect[j] = 1;
    while (n > info.maxEffects) {
      const j = r.next() % NUM_EFFECTS;
      if (effect[j] === 1 && info.effectFreq[j]! < 1000) {
        effect[j] = -1;
        n -= 1;
      }
    }
  }

  // ---- palettes (video.h) ------------------------------------------------------------------

  /** CrankPal(): one of the seven curves a random palette's channels are drawn from. */
  private static crankPal(curve: number, z: number): number {
    const x = z;
    switch (curve) {
      case 1: return f32(f32(Math.sqrt(x)) * 22.6);
      case 2: return f32(x * 2.0);
      case 3: return f32((x * x) / 64.0);
      case 4: return f32(255 * Math.sin(x / 256.0 * 0.5 * 3.1415927));
      case 5: return f32(x * 3.5);
      case 6: return f32(Math.pow(1.5, x / 20.0) - 1);
      case 7: return f32(x * 1.5 + 128 * 0.25 + 128 * 0.25 * Math.sin(z * 0.3));
      default: return 255.0;
    }
  }

  /**
   * FX_Random_Palette(): a new palette, blended in over the next nine frames (8 bits only). With
   * `load` (LoadPreset()'s FX_Random_Palette(true)), the one oldPalette describes.
   */
  public randomPalette(load = false): void {
    if (this.palLocked) return;
    if (this.depth !== 8) return;
    const r = this.rand;
    const p = this.oldPalette;
    if (!load) {
      p.loBand = -1;
      p.hiBand = -1;
      p.fx = false;
      p.fxNum = -1;
      p.c1 = -1;
      p.c2 = -1;
      p.c3 = -1;
      if (r.next() % 10 < this.coarsePalFreq) {
        p.loBand = 7 + r.next() % 6;
        p.hiBand = 17 + r.next() % 6;
      }
    }
    this.blendsLeftInPal = 18;
    let kind = r.next() % 6;
    if (load) kind = p.fx ? 0 : 1;
    const ape = this.ape;
    const ape2 = this.ape2;
    if (kind === 0) {
      p.fx = true;
      if (!load) p.fxNum = r.next() % 4;
      const square = (a: number): number => Math.trunc((a * a) / 64.0);
      const double = (a: number): number => a * 2;
      const root = (a: number): number => Math.trunc(f32(Math.sqrt(a)) * 22.6);
      // A number other than 0–3 (only from a hand-edited preset) leaves REMAP as it was.
      const curves = [[square, double, root], [square, root, double], [root, double, square], [double, square, root]][p.fxNum];
      const remap = this.remap;
      for (let a = 0; curves && a < 128; a += 1) {
        remap[a] = curves[0]!(a);
        remap[256 + a] = curves[1]!(a);
        remap[512 + a] = curves[2]!(a);
      }
      for (let n = 128; n < 256; n += 1) {
        remap[n] = remap[127]!;
        remap[256 + n] = remap[256 + 127]!;
        remap[512 + n] = remap[512 + 127]!;
      }
      for (let n = 0; n < 256; n += 1) {
        ape[n * 3] = ape2[n * 3]!;
        ape[n * 3 + 1] = ape2[n * 3 + 1]!;
        ape[n * 3 + 2] = ape2[n * 3 + 2]!;
        // peRed = REMAP, peBlue = REMAP2, peGreen = REMAP3.
        ape2[n * 3] = remap[n]!;
        ape2[n * 3 + 2] = remap[256 + n]!;
        ape2[n * 3 + 1] = remap[512 + n]!;
      }
      return;
    }
    let dark: number;
    if (!load) {
      do {
        if (r.next() % 5 < this.solarPalFreq) {
          p.c1 = r.next() % 7 + 1;
          p.c2 = r.next() % 7 + 1;
          p.c3 = r.next() % 7 + 1;
        } else {
          p.c1 = r.next() % 6 + 1;
          p.c2 = r.next() % 6 + 1;
          p.c3 = r.next() % 6 + 1;
        }
        dark = (p.c1 === 6 ? 1 : 0) + (p.c2 === 6 ? 1 : 0) + (p.c3 === 6 ? 1 : 0);
      } while (dark > 1);
    }
    let gammaFactor = f32(1 + this.gamma * 0.01);
    if (this.soundEmpty) gammaFactor = f32(gammaFactor + 0.3);
    for (let n = 0; n < 256; n += 1) {
      ape[n * 3] = ape2[n * 3]!;
      ape[n * 3 + 1] = ape2[n * 3 + 1]!;
      ape[n * 3 + 2] = ape2[n * 3 + 2]!;
      let x = f32(GeissSim.crankPal(p.c1, n) * gammaFactor);
      let y = f32(GeissSim.crankPal(p.c2, n) * gammaFactor);
      let z = f32(GeissSim.crankPal(p.c3, n) * gammaFactor);
      if (n > p.loBand && n < p.hiBand) {
        x = f32(x * 2);
        y = f32(y * 2);
        z = f32(z * 2);
      }
      // peRed = x, peBlue = y, peGreen = z.
      ape2[n * 3] = toByte(Math.min(255.0, x));
      ape2[n * 3 + 2] = toByte(Math.min(255.0, y));
      ape2[n * 3 + 1] = toByte(Math.min(255.0, z));
    }
  }

  /** PutPalette(): the next step of the blend, given to the screen. */
  private putPalette(): void {
    this.blendsLeftInPal -= 1;
    const x = f32(this.blendsLeftInPal / 18.0);
    const y = f32(1 - x);
    const ape = this.ape;
    const ape2 = this.ape2;
    const out = this.palette;
    for (let i = 0; i < 768; i += 1) out[i] = toByte(f32(f32(ape[i]! * x) + f32(ape2[i]! * y)));
  }

  // ---- the frame (render1) -----------------------------------------------------------------

  /**
   * One frame of render1(): `clock` is the plug-in's clock() (ms since it started), `audio` what
   * Winamp gave for this frame. Afterwards `vs1` and `palette` are the picture (presentFrame).
   */
  public frame(clock: number, audio: WinampFrame): void {
    this.soundActive = true;
    this.renderFX();
    if (this.hicolor) this.processMapMmx();
    else this.processMap();
    this.getWaveData(audio);
    this.renderDots(this.vs2);
    this.renderWave(this.vs2);
    [this.vs1, this.vs2] = [this.vs2, this.vs1];
    this.checkForNewSongTitle();
    this.plopSongTitle();
    // Merge_All_VS_To_Backbuffer(): the next map, a slice a frame, then the copy to the screen.
    if (!this.locked) {
      if (this.yMapPos === -1) this.pickRandomMode();
      this.generateChunkOfNewMap();
    }
    if (this.depth === 32) {
      // The 32-bit copy reads 16 pixels a turn, the last pair of each turn through mm6, doubled:
      // the warp of the next frame starts from what the bottom row's end left there.
      const row = this.height - this.fxYcutHide - 1;
      const at = (row * this.width + this.width - 4) * 4;
      const vs = this.vs1;
      const twice = (i: number): number => Math.min(255, vs[at + i]! * 2);
      for (let lane = 0; lane < 4; lane += 1) this.mm6[lane] = twice(lane * 2) | (twice(lane * 2 + 1) << 8);
      this.x87Clobbered = false;
    }
    const now = f32(clock);
    if (this.timeArrayReady) {
      const mix = this.intframe <= 32 ? 0 : f32(0.95);
      this.fps = f32(f32(this.fps * mix) + (f32(1 - mix) * 30.0) / f32(f32(now - this.timeArray[this.timeArrayPos]!) / 1000));
    }
    this.timeArray[this.timeArrayPos] = now;
    this.timeArrayPos += 1;
    if (this.timeArrayPos >= 30) {
      this.timeArrayPos = 0;
      this.timeArrayReady = true;
    }
  }

  /** The keys "01"…"25": that map, now (its parameters new). */
  public selectMode(mode: number): void {
    if (mode < 1 || mode > NUM_MODES) return;
    this.yMapPos = -1;
    this.newMode = mode;
    this.rushMap = true;
    this.generateChunkOfNewMap();
    this.timeArrayPos = 0;
    this.timeArrayReady = false;
  }

  /** The key "n": the map being prepared, finished and shown now. */
  public rush(): void {
    this.rushMap = true;
    this.generateChunkOfNewMap();
    this.timeArrayPos = 0;
    this.timeArrayReady = false;
  }

  /** The map being prepared (the one Auto shows next). */
  public get comingMode(): number {
    return this.newMode;
  }

  /**
   * The panel's "next" in Auto: "n", but with another map than the one on screen when the stars
   * allow one (Geiss's own picks may repeat a map; a listener asking for the next one means
   * another).
   */
  public rushNext(): void {
    if (this.yMapPos === -1 || this.newMode === this.mode) this.pickAnotherMode();
    this.rush();
  }

  /** A map picked by the stars now, other than the one on screen if it can be, shown now. */
  public rushRandom(): void {
    this.pickAnotherMode();
    this.rush();
  }

  private pickAnotherMode(): void {
    for (let tries = 0; tries < 16; tries += 1) {
      this.pickRandomMode();
      if (this.newMode !== this.mode) return;
    }
  }

  /** The map being prepared is dropped; the next frame picks one by the (new) stars. */
  public restartNext(): void {
    if (!this.locked) this.yMapPos = -1;
  }

  // ---- presets (Effects.h) ------------------------------------------------------------------

  /**
   * SavePreset() (`]##`): the map on screen as GEISS.INI keeps it — its centre, parameters,
   * waveform, effects, shifting, the 8-bit palette, the spectrum dots. Null before the first map.
   *
   * The values are the ones LoadPreset() needs to give this map back exactly, where Geiss's own
   * file did not quite: the floats at full precision (Geiss printed "%f", six decimals); the
   * centre as a fraction that LoadPreset()'s `(int)(fraction * FXW)` turns into this centre again
   * (gXC/FXW printed with six decimals could land a pixel short); `magic` the weight sum before
   * map 12's set-up lowers it (×0.98), which loading does again (Geiss saved it lowered, so map
   * 12 darkened with each load); and the palette's upper band under the key LoadPreset() reads
   * (Geiss wrote "pal_hi_oband", so a palette with a brighter band lost it).
   */
  public savePreset(): GeissPreset | null {
    if (this.mode < 1) return null;
    const fraction = (centre: number, size: number): number => {
      let value = f32(centre / size);
      for (let step = 0; step < 8 && toInt(f32(value * size)) < centre; step += 1) value = f32Step(value, 1);
      for (let step = 0; step < 8 && toInt(f32(value * size)) > centre; step += 1) value = f32Step(value, -1);
      return value;
    };
    const p = this.oldPalette;
    const preset: GeissPreset = {
      x_center: fraction(this.gXC, this.width),
      y_center: fraction(this.gYC, this.height),
      mode: this.mode,
      damping: this.damping,
      wave: this.waveform,
      magic: this.oldMagic,
      volpos: this.volpos,
      shift: this.slideShift ? 1 : 0,
      gamma: this.gamma,
      t1: this.oldTurn1,
      t2: this.oldTurn2,
      s1: this.oldScale1,
      s2: this.oldScale2,
      f1: this.oldF1,
      f2: this.oldF2,
      f3: this.oldF3,
      f4: this.oldF4,
      effect_chasers: 0,
      effect_bar: 0,
      effect_dots: 0,
      effect_solar: 0,
      effect_grid: 0,
      effect_nuclide: 0,
      effect_shadebobs: 0,
      effect_spectral: 0,
      spectrum: this.visMode === SPECTRUM ? 1 : 0
    };
    for (const [key, index] of PRESET_EFFECTS) preset[key] = this.effect[index]!;
    if (this.depth === 8) {
      preset.pal_lo_band = p.loBand;
      preset.pal_hi_band = p.hiBand;
      preset.pal_bFX = p.fx ? 1 : 0;
      preset.pal_FXpalnum = p.fxNum;
      preset.pal_curve_id_1 = p.c1;
      preset.pal_curve_id_2 = p.c2;
      preset.pal_curve_id_3 = p.c3;
    }
    return preset;
  }

  /**
   * LoadPreset() (`[##`) and GenerateChunkOfNewMap(true): the preset's map built and shown now,
   * with its centre, parameters, waveform, effects, shifting, spectrum dots and (at 8 bits) its
   * palette, blended in over nine frames. What a preset does not hold is drawn anew as Geiss draws
   * it: map 6's vortices, map 7's dither and map 14's jitter, the grid's direction stays. A key
   * missing takes LoadPreset()'s default; without x_center there is no preset (false).
   *
   * One addition: a preset saved in colour holds no palette, and at 8 bits it gets a new one, as a
   * new map would (Geiss would build its palette from curves 0, all white).
   */
  public loadPreset(preset: Partial<GeissPreset>): boolean {
    const value = (key: keyof GeissPreset, fallback: number): number => {
      const raw = preset[key];
      return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
    };
    // sscanf("%f") into a float; GetPrivateProfileInt() an integer.
    const float = (key: keyof GeissPreset, fallback: number): number => f32(value(key, fallback));
    const int = (key: keyof GeissPreset, fallback: number): number => Math.trunc(value(key, fallback));
    const xCenter = float("x_center", -999);
    if (xCenter < -998) return false;
    const mode = int("mode", 5);
    // Geiss would read its tables past their end; such a file is not a preset.
    if (mode < 1 || mode > NUM_MODES) return false;
    this.newGXC = toInt(f32(xCenter * this.width));
    this.newGYC = toInt(f32(float("y_center", 0.5) * this.height));
    this.newMode = mode;
    this.newWaveform = int("wave", 1);
    this.newDamping = float("damping", 1);
    this.weightsum = int("magic", 1);
    this.slideShift = int("shift", 0) !== 0;
    this.gamma = int("gamma", 0);
    const volpos = int("volpos", 10);
    while (this.volpos < volpos) {
      this.volpos += 1;
      this.volscale = f32(this.volscale * f32(1.25));
    }
    while (this.volpos > volpos) {
      this.volpos -= 1;
      this.volscale = f32(this.volscale * f32(0.8));
    }
    const palette = typeof preset.pal_bFX === "number";
    const p = this.oldPalette;
    p.loBand = int("pal_lo_band", -1);
    p.hiBand = int("pal_hi_band", -1);
    p.fx = int("pal_bFX", -1) !== 0;
    p.fxNum = int("pal_FXpalnum", -1);
    p.c1 = int("pal_curve_id_1", -1);
    p.c2 = int("pal_curve_id_2", -1);
    p.c3 = int("pal_curve_id_3", -1);
    this.visMode = int("spectrum", 0) === 1 ? SPECTRUM : WAVE;
    this.randomPalette(palette);
    this.loading = {
      t1: float("t1", 1), t2: float("t2", 1), s1: float("s1", 1), s2: float("s2", 1),
      f1: float("f1", 1), f2: float("f2", 1), f3: float("f3", 1), f4: float("f4", 1),
      effects: PRESET_EFFECTS.map(([key]) => int(key, 0)),
      shift: int("shift", 0) !== 0
    };
    this.yMapPos = -1;
    this.rushMap = true;
    this.generateChunkOfNewMap();
    return true;
  }

  /**
   * Go on from `old` at this size or depth (GeissOptions.from): its picture carried over (scaled;
   * between depths through the palette and back by brightness), its palette, clock, sound history
   * and random sequence, and its map anew (new parameters, the same map).
   */
  private continueFrom(old: GeissSim, preset?: Partial<GeissPreset>): void {
    const W = this.width;
    const H = this.height;
    const oldPixel = (x: number, y: number): number => Math.min(old.height - 1, Math.trunc((y * old.height) / H)) * old.width
      + Math.min(old.width - 1, Math.trunc((x * old.width) / W));
    for (const [from, to] of [[old.vs1, this.vs1], [old.vs2, this.vs2]] as const) {
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const source = oldPixel(x, y);
          const target = y * W + x;
          if (old.hicolor === this.hicolor) {
            for (let c = 0; c < this.bytes; c += 1) to[target * this.bytes + c] = from[source * this.bytes + c]!;
          } else if (this.hicolor) {
            // 8 → 16/32 bits: the colour the palette gave the index, at the half the copy doubles.
            const index = from[source]!;
            to[target * 4] = old.palette[index * 3 + 2]! >> 1;
            to[target * 4 + 1] = old.palette[index * 3 + 1]! >> 1;
            to[target * 4 + 2] = old.palette[index * 3]! >> 1;
          } else {
            // 16/32 → 8 bits: Geiss's palettes rise with the index, so the brightest channel.
            to[target] = Math.max(from[source * 4]!, from[source * 4 + 1]!, from[source * 4 + 2]!);
          }
        }
      }
    }
    this.rand.state = old.rand.state;
    if (this.depth === 8 && old.depth === 8) {
      this.ape.set(old.ape);
      this.ape2.set(old.ape2);
      this.palette.set(old.palette);
      this.remap.set(old.remap);
      this.blendsLeftInPal = old.blendsLeftInPal;
      this.oldPalette = { ...old.oldPalette };
    } else if (this.depth === 8) {
      // Coming from colour: a palette at once, not out of black.
      this.randomPalette();
      this.ape.set(this.ape2);
      this.palette.set(this.ape2);
      this.blendsLeftInPal = 0;
    }
    if (this.depth === old.depth) this.mm6.set(old.mm6);
    this.ratings = [...old.ratings];
    this.ratingsTotal = old.ratingsTotal;
    this.fps = old.fps;
    this.fpsAtLastModeSwitch = old.fpsAtLastModeSwitch;
    this.soundActive = old.soundActive;
    this.currentVol = old.currentVol;
    this.avgVol = old.avgVol;
    this.avgVolNarrow = old.avgVolNarrow;
    this.pastVol.set(old.pastVol);
    this.pastVolPos = old.pastVolPos;
    this.beatMode = old.beatMode;
    this.bigBeat = old.bigBeat;
    this.shiftMaxVol = old.shiftMaxVol;
    this.framesSinceShift = old.framesSinceShift;
    this.lastFrameV = old.lastFrameV;
    this.lastFrameSlope = old.lastFrameSlope;
    this.syncColorToSound = old.syncColorToSound;
    this.power.set(old.power);
    this.powerSmoothed.set(old.powerSmoothed);
    this.titles = old.titles;
    this.songTitle = old.songTitle;
    this.lastMessageWasCustom = old.lastMessageWasCustom;
    this.pendingTitle = old.pendingTitle;
    this.titleR = old.titleR;
    this.titleG = old.titleG;
    this.titleB = old.titleB;
    this.chaserOffset = old.chaserOffset;
    this.gamma = old.gamma;
    this.volpos = old.volpos;
    this.volscale = old.volscale;
    // A preset is loaded at the new size or depth as `[##` would load it there; a map otherwise.
    const loaded = preset !== undefined && this.loadPreset(preset);
    if (!loaded && old.mode >= 1) this.selectMode(old.mode);
    else if (!loaded) this.rushRandom();
    this.intframe = old.intframe;
    this.floatframe = old.floatframe;
  }

  private renderFX(): void {
    this.floatframe = f32(this.floatframe + f32(f32(1.6) * Math.min(1, f32(47 / this.fps))));
    this.intframe += 1;
    this.framesThisMode += 1;
    if (this.blendsLeftInPal > 0) {
      this.blendsLeftInPal -= 1;
      this.putPalette();
    }
    const effect = this.effect;
    if (effect[SHADE]! > 0) this.shadeBobs();
    if (effect[CHASERS]! >= 1) this.twoChasers(f32(this.floatframe + this.chaserOffset));
    if (effect[BAR] === 1) {
      const frame = f32(this.floatframe + f32(this.chaserOffset * f32(0.6)));
      this.solidLine(frame, 0);
      if (this.hicolor) {
        // The bar three times, red and green and blue apart: 3.5 × chromatic_dispersion 4.
        const ff = this.floatframe;
        const sin = (a: number): number => f32(Math.sin(f32(a)));
        const cos = (a: number): number => f32(Math.cos(f32(a)));
        this.solidLine(f32(frame + 3.5 * 4 * f32(sin(ff * 0.03 + 1) + cos(ff * 0.04 + 3))), 1);
        this.solidLine(f32(frame - 3.5 * 4 * f32(cos(ff * 0.05 + 2) + sin(ff * 0.06 + 4))), 2);
      }
    }
    if (effect[DOTS] === 1) this.oneDottyChaser(this.floatframe);
    if (effect[NUCLIDE] === 1) this.nuclide();
    if (effect[GRID] === 1) this.grid();
    if (effect[SOLAR] === 1) {
      const sm = this.solarMax;
      if (this.width === 320) {
        const fx = Math.trunc(3 + sm * (2.4 + 0.35 * f32(Math.sin(f32(this.intframe * 0.05))) + 0.4 * f32(Math.sin(f32(this.intframe * 0.038 + 1)))));
        this.dropSolarParticles320(Math.trunc(fx * 0.01));
      } else {
        const fx = Math.trunc(3 + sm * 1.6 + sm * 0.43 * f32(Math.sin(f32(this.intframe * 0.05))) + sm * 0.43 * f32(Math.sin(f32(this.intframe * 0.038 + 1))));
        this.dropSolarParticles(Math.trunc(fx * 0.05));
      }
    }
    this.diminishCenter(this.vs1);
  }

  /** Process_Map() at 8 bits: the warp, DH the pixel and DL carried on as the asm's dither. */
  private processMap(): void {
    const src = this.vs1;
    const dst = this.vs2;
    const W = this.width;
    const offsets = this.mapOffset;
    const weights = this.mapWeights;
    const slider = this.slider1;
    const start = this.fxYcut * W;
    const end = (this.height - this.fxYcut) * W;
    // DL is not cleared before the loop: it holds what EDX held at the call, the 23457 (0x5BA1)
    // the last ReplaceDWORD() searched for. Across black rows it rides on unchanged.
    let dl = 0xa1;
    for (let p = start; p < end; p += 1) {
      const s = offsets[p]! + slider;
      const w = weights[p]!;
      const acc = (dl + src[s]! * (w & 255) + src[s + 1]! * ((w >>> 8) & 255)
        + src[s + W]! * ((w >>> 16) & 255) + src[s + W + 1]! * (w >>> 24)) & 0xffff;
      dst[p] = acc >> 8;
      dl = acc & 255;
    }
  }

  /**
   * Process_Map() above 8 bits, the MMX loop: four lanes (blue, green, red, the fourth byte) each
   * the weighted sum of four source pixels in 16 bits (pmullw, paddw), the pixel its high byte
   * and its low byte carried on in mm6 (psllw/psrlw 8). The loop never clears mm6: the first
   * pixel adds whatever the register held, whole words.
   */
  private processMapMmx(): void {
    // A pixel a 32-bit word: blue, green, red and the fourth byte from the lowest byte up.
    const src = new Uint32Array(this.vs1.buffer, this.vs1.byteOffset, this.vs1.byteLength >> 2);
    const dst = new Uint32Array(this.vs2.buffer, this.vs2.byteOffset, this.vs2.byteLength >> 2);
    const W = this.width;
    const offsets = this.mapOffset;
    const weights = this.mapWeights;
    const slider = this.slider1;
    const start = this.fxYcut * W;
    const end = (this.height - this.fxYcut) * W;
    const mm6 = this.mm6;
    let d0 = mm6[0]!;
    let d1 = mm6[1]!;
    let d2 = mm6[2]!;
    let d3 = mm6[3]!;
    if (this.x87Clobbered) {
      // x87 code left an 80-bit value's significand there: π's (0xC90FDAA22168C235) when the
      // last atan2 corrected a quadrant, else a pixel offset's, zero in all but the fourth lane.
      if (this.x87Pi) {
        d0 = 0xc235;
        d1 = 0x2168;
        d2 = 0xdaa2;
        d3 = 0xc90f;
      } else {
        d0 = 0;
        d1 = 0;
        d2 = 0;
      }
      this.x87Clobbered = false;
    }
    // The lanes two to an integer, 16 bits each: blue and red in `even`, green and the fourth
    // byte in `odd`, and so their carries.
    let even = d0 | (d2 << 16);
    let odd = d1 | (d3 << 16);
    for (let p = start; p < end; p += 1) {
      const q = offsets[p]! + slider;
      const w = weights[p]!;
      const w0 = w & 255;
      const w1 = (w >>> 8) & 255;
      const w2 = (w >>> 16) & 255;
      const w3 = w >>> 24;
      const a = src[q]!;
      const b = src[q + 1]!;
      const c = src[q + W]!;
      const e = src[q + W + 1]!;
      if (p > start && w0 + w1 + w2 + w3 <= 256) {
        // A carry below 256 and weights summing to 256 at most keep the lower lane below 65536:
        // it never reaches the upper one, which wraps at the top of the integer as at 16 bits.
        const lower = (even + Math.imul(a & 0xff00ff, w0) + Math.imul(b & 0xff00ff, w1)
          + Math.imul(c & 0xff00ff, w2) + Math.imul(e & 0xff00ff, w3)) | 0;
        const upper = (odd + Math.imul((a >>> 8) & 0xff00ff, w0) + Math.imul((b >>> 8) & 0xff00ff, w1)
          + Math.imul((c >>> 8) & 0xff00ff, w2) + Math.imul((e >>> 8) & 0xff00ff, w3)) | 0;
        dst[p] = ((lower >>> 8) & 0xff00ff) | (((upper >>> 8) & 0xff00ff) << 8);
        even = lower & 0xff00ff;
        odd = upper & 0xff00ff;
        continue;
      }
      // Lane by lane, each wrapping at 16 bits: the first pixel (mm6 may hold whole words) and
      // the rare weights above 256 (a source just above the picture's top: toByte() wrapped).
      const l0 = ((even & 0xffff) + (a & 255) * w0 + (b & 255) * w1 + (c & 255) * w2 + (e & 255) * w3) & 0xffff;
      const l1 = ((odd & 0xffff) + ((a >>> 8) & 255) * w0 + ((b >>> 8) & 255) * w1
        + ((c >>> 8) & 255) * w2 + ((e >>> 8) & 255) * w3) & 0xffff;
      const l2 = ((even >>> 16) + ((a >>> 16) & 255) * w0 + ((b >>> 16) & 255) * w1
        + ((c >>> 16) & 255) * w2 + ((e >>> 16) & 255) * w3) & 0xffff;
      const l3 = ((odd >>> 16) + (a >>> 24) * w0 + (b >>> 24) * w1 + (c >>> 24) * w2 + (e >>> 24) * w3) & 0xffff;
      dst[p] = (l0 >> 8) | ((l1 >> 8) << 8) | ((l2 >> 8) << 16) | ((l3 >> 8) << 24);
      even = (l0 & 255) | ((l2 & 255) << 16);
      odd = (l1 & 255) | ((l3 & 255) << 16);
    }
    mm6[0] = even & 0xffff;
    mm6[1] = odd & 0xffff;
    mm6[2] = even >>> 16;
    mm6[3] = odd >>> 16;
  }

  // ---- effects (Effects.h) -----------------------------------------------------------------

  private shadeBobs(): void {
    const r = this.rand;
    const vs = this.vs1;
    const W = this.width;
    const W4 = W * 4;
    const ff = this.floatframe;
    for (let x = 0; x < this.effect[SHADE]!; x += 1) {
      const channelOn = [this.microC1, this.microC2, this.microC3].map((c) => toInt(f32(1 + f32(Math.sin(f32(ff * c[x]!))))));
      let a = this.gXC + Math.trunc(f32(f32(this.microRad[0]![x]! * f32(Math.cos(f32(ff * this.microF1[x]!))))
        + f32(this.microRad[2]![x]! * f32(Math.cos(f32(ff * this.microF2[x]!))))));
      let b = this.gYC + Math.trunc(f32(f32(this.microRad[1]![x]! * f32(Math.cos(f32(ff * this.microF3[x]!))))
        + f32(this.microRad[3]![x]! * f32(Math.cos(f32(ff * this.microF4[x]!))))));
      for (let k = 0; k < 4; k += 1) {
        b += r.next() % 5 - 2;
        a += r.next() % 5 - 2;
        if (b > this.fxYcut && b < this.height - 1 - this.fxYcut) {
          if (!this.hicolor) {
            const d = b * W + a;
            if (vs[d]! < 250) vs[d] = vs[d]! + 2;
            if (vs[d + 1]! < 250) vs[d + 1] = vs[d + 1]! + 1;
            if (vs[d - 1]! < 250) vs[d - 1] = vs[d - 1]! + 1;
            if (vs[d + W]! < 250) vs[d + W] = vs[d + W]! + 1;
            if (vs[d - W]! < 250) vs[d - W] = vs[d - W]! + 1;
            continue;
          }
          // cr lights the first byte (blue), cg the second, cb the third, each when sin > 0.
          let d = (b * W + a) * 4;
          for (const on of channelOn) {
            if (on === 1) {
              if (vs[d]! < 250) vs[d] = vs[d]! + 5;
              for (const n of [d + 4, d - 4, d + W4, d - W4]) if (vs[n]! < 250) vs[n] = vs[n]! + 3;
            }
            d += 1;
          }
        }
      }
    }
  }

  private diminishCenter(vs: Uint8Array): void {
    const cd = this.centerDwindle;
    if (!(cd < 0.999)) return;
    const W = this.width;
    const dim = (i: number): void => {
      if (vs[i]! > 1) vs[i] = toByte(f32(vs[i]! * cd));
    };
    const scale = (i: number): void => {
      vs[i] = toByte(f32(vs[i]! * cd));
    };
    if (this.mode !== 12) {
      const c = this.gXC + this.gYC * W;
      const points = [c, c - 1, c + 1, c + W, c - W];
      if (!this.hicolor) {
        for (const at of points) dim(at);
        return;
      }
      for (let channel = 0; channel < 3; channel += 1) for (const at of points) dim(at * 4 + channel);
      return;
    }
    let offset = (this.fxYcut * W + this.gXC) * this.bytes;
    const around = this.hicolor ? [-4, -3, -2, 0, 1, 2, 4, 5, 6] : [-1, 0, 1];
    for (let i = this.fxYcut; i < this.height - this.fxYcut; i += 1) {
      for (const at of around) scale(offset + at);
      offset += W * this.bytes;
    }
  }

  private dropSolarParticles320(count: number): void {
    const r = this.rand;
    const vs = this.vs1;
    const W4 = this.width * 4;
    for (let k = (this.hicolor ? count : count * 4); k > 0; k -= 1) {
      let newx = 100;
      let x = 0;
      let y = 0;
      while (newx >= 17) {
        y = r.next() % 48 - 24;
        x = r.next() % 64 - 32;
        newx = f32(Math.sqrt(x * x + y * y));
      }
      y += this.gYC;
      x += this.gXC;
      if (y > this.fxYcut && y < this.height - 1 - this.fxYcut) {
        const d = y * 320 + x;
        const p1 = r.next() % 256;
        const p2 = r.next() % 256;
        const p3 = r.next() % 256;
        if (!this.hicolor) {
          const i0 = 2 + r.next() % 3;
          const i1 = Math.trunc(i0 / 2);
          const i2 = Math.trunc(i1 / 2);
          if (vs[d]! < 207 - i0) {
            vs[d] = vs[d]! + i0;
            for (const at of [d + 1, d - 1, d + 320, d - 320]) vs[at] = vs[at]! + i1;
            for (const at of [d - 321, d - 319, d + 319, d + 321]) vs[at] = vs[at]! + i2;
          }
          continue;
        }
        const edge = f32(17 - newx);
        let at = d * 4;
        for (const p of [p1, p2, p3]) {
          const i0 = Math.trunc((edge * 12.0) * (p / 256.0));
          const i1 = Math.trunc((edge * 3.0) * (p / 256.0));
          const i2 = Math.trunc((edge * 0.8) * (p / 256.0));
          if (vs[at]! < 207 - i0) {
            vs[at] = vs[at]! + i0;
            for (const n of [at + 4, at - 4, at + W4, at - W4]) vs[n] = vs[n]! + i1;
            for (const n of [at - W4 - 4, at - W4 + 4, at + W4 - 4, at + W4 + 4]) vs[n] = vs[n]! + i2;
          }
          at += 1;
        }
      }
    }
  }

  private dropSolarParticles(count: number): void {
    const r = this.rand;
    const vs = this.vs1;
    const W = this.width;
    const W4 = W * 4;
    for (let k = (this.hicolor ? count : count * 4); k > 0; k -= 1) {
      let newx = 100;
      let x = 0;
      let y = 0;
      while (newx >= 35) {
        y = r.next() % 72 - 36;
        x = r.next() % 96 - 48;
        newx = f32(Math.sqrt(x * x + y * y));
      }
      y += this.gYC;
      x += this.gXC;
      if (y > this.fxYcut && y < this.height - 1 - this.fxYcut) {
        if (!this.hicolor) {
          const d = y * W + x;
          const i0 = Math.trunc(f32((2 + r.next() % 2) + f32(f32(35 - newx) / 9)));
          const i1 = i0 - 1;
          const i2 = i1 - 1;
          if (vs[d]! < 207 - i0) {
            vs[d] = vs[d]! + i0;
            for (const at of [d + 1, d - 1, d + W, d - W]) vs[at] = vs[at]! + i1;
            for (const at of [d - W - 1, d - W + 1, d + W - 1, d + W + 1]) vs[at] = vs[at]! + i2;
          }
          continue;
        }
        let at = (y * W + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const i0 = toInt(f32(4 + f32(f32((r.next() % 30) * f32(35 - newx)) / 25)));
          const i1 = i0 - 3;
          const i2 = Math.trunc(i1 / 2);
          if (vs[at]! < 207 - i0) {
            vs[at] = vs[at]! + i0;
            for (const n of [at + 4, at - 4, at + W4, at - W4]) vs[n] = vs[n]! + i1;
            for (const n of [at - W4 - 4, at - W4 + 4, at + W4 - 4, at + W4 + 4]) vs[n] = vs[n]! + i2;
          }
          at += 1;
        }
      }
    }
  }

  /** Solid_Line() into one channel of VS1 (0 at 8 bits; above, the bar drawn per channel). */
  private solidLine(frame: number, channel: number): void {
    const vs = this.vs1;
    const W = this.width;
    const bytes = this.bytes;
    const top = this.fxYcut;
    const bottom = this.height - 1 - this.fxYcut;
    const t = f32(frame * 0.55 / (0.08 * 20));
    const cos = (a: number): number => f32(Math.cos(f32(a)));
    if (W === 320) {
      const newx = f32(this.gXC + f32(f32(12 * cos(t * 0.1102 + 10)) + f32(15 * cos(t * 0.1312 + 20))));
      const newy = f32(this.gYC + f32(f32(11 * cos(t * 0.1204 + 40)) + f32(10 * cos(t * 0.1715 + 30))));
      const newx2 = f32(this.gXC + f32(f32(10 * cos(t * 0.1213 + 33)) + f32(13 * cos(t * 0.1408 + 15))));
      const newy2 = f32(this.gYC + f32(f32(9 * cos(t * 0.1304 + 12)) + f32(11 * cos(t * 0.1103 + 21))));
      for (let k = 0; k < 43; k += 1) {
        const a = Math.trunc(newx * (k / 43.0) + newx2 * (1 - k / 43.0));
        const b = Math.trunc(newy * (k / 43.0) + newy2 * (1 - k / 43.0));
        if (b > top && b < bottom) {
          const at = (b * 320 + a) * bytes + channel;
          if (vs[at]! < 223) vs[at] = vs[at]! + 16;
        }
      }
      return;
    }
    const s = f32(W / 640.0);
    const term = (amp: number, rate: number, phase: number): number => f32(f32(s * amp) * cos(t * rate + phase));
    const newx = f32(this.gXC + f32(term(16, 0.1102, 10) + term(15, 0.1312, 20)));
    const newy = f32(this.gYC + f32(term(15, 0.1204, 40) + term(10, 0.1715, 30)));
    const newx2 = f32(this.gXC + f32(term(14, 0.1213, 33) + term(13, 0.1408, 15)));
    const newy2 = f32(this.gYC + f32(term(13, 0.1304, 12) + term(11, 0.1103, 21)));
    const k2 = Math.trunc(f32(s * 50));
    const invS = f32(1 / k2);
    for (let k = 0; k < k2; k += 1) {
      const u = f32(k * invS);
      const v = f32(1 - u);
      const a = Math.trunc(f32(f32(newx * u) + f32(newx2 * v)));
      const b = Math.trunc(f32(f32(newy * u) + f32(newy2 * v)));
      if (b > top && b < bottom) {
        const at = (b * W + a) * bytes + channel;
        if (vs[at]! < 223) vs[at] = vs[at]! + 16;
      }
    }
  }

  private twoChasers(frame: number): void {
    const vs = this.vs1;
    const W = this.width;
    const s = f32(W / 640.0);
    let timeScale = 1;
    if (this.fpsAtLastModeSwitch >= 10 && this.fpsAtLastModeSwitch < 120) timeScale = f32(30 / this.fpsAtLastModeSwitch);
    let t = f32(frame * timeScale);
    const passes = this.effect[CHASERS] === 2 ? 2 : 1;
    const k2 = Math.trunc(f32(20 * s));
    const step = f32(f32(f32(f32(0.08) * timeScale) * 20) / k2);
    const term = (amp: number, rate: number, phase: number): number => f32(f32(s * amp) * f32(Math.cos(f32(f32(t * f32(rate)) + phase))));
    const lighten = (at: number): void => {
      vs[at] = toByte(f32(255 - f32((255 - vs[at]!) * f32(0.6))));
    };
    for (let k = 0; k < k2; k += 1) {
      t = f32(t + step);
      for (let pass = 0; pass < passes; pass += 1) {
        let a: number;
        let b: number;
        if (pass === 0) {
          a = this.gXC + Math.trunc(f32(term(74, 0.1102, 10) + term(65, 0.1312, 20)));
          b = this.gYC + Math.trunc(f32(term(54, 0.1204, 40) + term(55, 0.1715, 30)));
        } else {
          a = this.gXC + Math.trunc(f32(term(64, 0.1213, 33) + term(55, 0.1408, 15)));
          b = this.gYC + Math.trunc(f32(term(52, 0.1304, 12) + term(51, 0.1103, 21)));
        }
        if (b > this.fxYcut && b < this.height - 1 - this.fxYcut) {
          const at = (b * W + a) * this.bytes;
          lighten(at);
          if (this.hicolor) {
            lighten(at + 1);
            lighten(at + 2);
          }
        }
      }
    }
  }

  private nuclide(): void {
    // Only without sound; the plug-in always has it.
    if (this.soundActive && !this.soundEmpty) return;
    const r = this.rand;
    if (r.next() % 12 !== 0) return;
    const W = this.width;
    const nodes = 3 + r.next() % 5;
    const phase = r.next() % 1000;
    r.next(); // rad = 20 + rand()%30, overwritten below
    const radius = W === 320 ? 2 + r.next() % 6 : 3 + r.next() % 8;
    const rad = W === 320 ? 22 + r.next() % 6 : 34 + r.next() % 8;
    if (this.hicolor) return;
    for (let n = 0; n < nodes; n += 1) {
      const c = f32(n / nodes) * 6.28 + phase;
      const cx = Math.trunc(f32(this.gXC + f32(rad * f32(Math.cos(f32(c))))));
      const cy = Math.trunc(f32(this.gYC + f32(rad * f32(Math.sin(f32(c))))));
      if (cy - 10 > this.fxYcut && cy + 10 < this.height - 1 - this.fxYcut) {
        const d = cy * W + cx;
        for (let x = -10; x < 10; x += 1) {
          for (let y = -10; y < 10; y += 1) {
            const val = Math.trunc(f32(f32(radius - f32(Math.sqrt(x * x + y * y))) * 25));
            if (val > 0) this.vs1[d + y * W + x] = Math.min(255, this.vs1[d + y * W + x]! + val);
          }
        }
      }
    }
  }

  private oneDottyChaser(frame: number): void {
    const vs = this.vs1;
    const W = this.width;
    const s = f32(W / 640.0);
    let t = frame;
    if (this.fpsAtLastModeSwitch >= 10 && this.fpsAtLastModeSwitch < 120) t = f32(t * f32(30 / this.fpsAtLastModeSwitch));
    const term = (amp: number, rate: number, phase: number): number => f32(f32(s * amp) * f32(Math.cos(f32(t * rate + phase))));
    const a = this.gXC + Math.trunc(f32(term(64, 0.0613, 33) + term(55, 0.0708, 15)));
    const b = this.gYC + Math.trunc(f32(term(52, 0.0704, 12) + term(51, 0.0503, 21)));
    if (!(b > this.fxYcut && b < this.height - 1 - this.fxYcut)) return;
    this.chaserPtr = (this.chaserPtr + 1) % 20;
    this.chaserX[this.chaserPtr] = a;
    this.chaserY[this.chaserPtr] = b;
    const level = (rate: number, phase: number): number => toByte(f32(127 + f32(126 * f32(Math.sin(f32(t * rate + phase))))));
    this.chaserR[this.chaserPtr] = level(0.0613, 33);
    this.chaserG[this.chaserPtr] = level(0.0713, 30);
    this.chaserB[this.chaserPtr] = level(0.0513, 27);
    for (let k = 0; k < 20; k += 1) {
      const pixel = this.chaserY[k]! * W + this.chaserX[k]!;
      if (!this.hicolor) {
        const value = this.chaserR[k]!;
        vs[pixel] = value;
        if (W >= 1050) {
          vs[pixel + 1] = value;
          vs[pixel + W] = value;
          vs[pixel + W + 1] = value;
        }
      } else {
        // chaser_r goes into the first byte (blue), as in the original.
        const colours = [this.chaserR[k]!, this.chaserG[k]!, this.chaserB[k]!];
        const at = pixel * 4;
        const corners = W >= 880 ? [at, at + 4, at + W * 4, at + W * 4 + 4] : [at];
        for (const corner of corners) for (let c = 0; c < 3; c += 1) vs[corner + c] = colours[c]!;
      }
      this.chaserX[k] = this.chaserX[k]! + 1;
    }
  }

  private grid(): void {
    const vs = this.vs1;
    const W = this.width;
    const xInc = Math.trunc(W / 30);
    const yInc = xInc;
    const q = (rate: number): number => f32(f32(f32(this.intframe * f32(rate)) * 30) / this.fpsAtLastModeSwitch);
    let v = f32(65 + f32(45 * f32(Math.sin(q(0.06033)))));
    v = f32(v + f32(35 * f32(Math.cos(f32(q(0.04710) + 1)))));
    v = f32(v + f32(25 * f32(Math.cos(f32(q(0.00523) - 1)))));
    const s = toByte(0 > v ? 0 : v);
    let dir = this.intframe % xInc;
    if (this.gridDir === 1) dir = -dir;
    const raise = (at: number): void => {
      if (vs[at]! < s) vs[at] = s;
    };
    for (let y = this.fxYcutHide; y < this.height - this.fxYcutHide; y += yInc) {
      const k1 = y * W;
      if (!this.hicolor) {
        if (W >= 1700) {
          for (let x = 0; x < W - 1; x += xInc) {
            const k = k1 + x + dir;
            for (const at of [k, k + 1, k + W, k + W + 1]) raise(at);
          }
        } else {
          for (let x = 0; x < W; x += xInc) raise(k1 + x + dir);
        }
        continue;
      }
      for (let x = 0; x < W - 1; x += xInc) {
        const k = (k1 + x + dir) * 4;
        const corners = W >= 1800 ? [k, k + 4, k + W * 4, k + W * 4 + 4] : [k];
        for (const corner of corners) for (let c = 0; c < 3; c += 1) raise(corner + c);
      }
    }
  }

  // ---- sound (GetWaveData, RenderDots, RenderWave) -----------------------------------------

  private getWaveData(audio: WinampFrame): void {
    const W = this.width;
    const fDiv = f32(1.0 / (64.0 * (640.0 / W)));
    const billy = f32(this.volscale * fDiv);
    const wave = audio.wave;
    const spectrum = audio.spectrum;
    const sb = this.soundBuffer;
    const fb = this.fSoundBuffer;
    const size = this.bufsize;
    const w4 = Math.trunc(W / 4);
    let x = 0;
    let y = 5;
    // waveformData[0][y] past 575 is waveformData[1][y - 576] in the struct; beyond both, 0.
    const sample = (index: number): number => wave[index] ?? 0;
    if (this.visMode !== SPECTRUM) {
      y += w4;
      const stop = 511 - 365 + w4;
      while (y < stop) {
        const oldV = sample(y - 5);
        const v = sample(y);
        if (Math.abs(v - this.lastFrameV) <= 1 && this.lastFrameSlope * (v - oldV) >= 0) {
          this.lastFrameSlope = v - oldV;
          this.lastFrameV = v;
          break;
        }
        y += 1;
      }
      if (y >= stop) {
        y = 5 + w4;
        const oldV = sample(y - 5);
        const v = sample(y);
        this.lastFrameSlope = v - oldV;
        this.lastFrameV = v;
      }
      y -= w4;
    }
    if (this.visMode === SPECTRUM) {
      for (x = 0, y = 0; x < size && y < 512; x += 2, y += 1) {
        const factor = 0.4 + 5.6 * (y / 512.0);
        let nL = (((256 - spectrum[y]!) << 10) << 16) >> 16;
        let nR = (((256 - spectrum[576 + y]!) << 10) << 16) >> 16;
        nL = (toInt(nL * factor) << 16) >> 16;
        nR = (toInt(nR * factor) << 16) >> 16;
        sb[x] = Math.min(nL, sb[x]! + 2200);
        sb[x + 1] = Math.min(nR, sb[x + 1]! + 2200);
      }
    } else {
      for (; x < size && y < 512; x += 2, y += 1) {
        sb[x] = sample(y) << 8;
        sb[x + 1] = sample(576 + y) << 8;
      }
    }
    for (let i = 0; i < size - 2; i += 1) fb[i] = 0.8 * sb[i]! + 0.2 * sb[i + 2]!;
    for (let i = 0; i < size; i += 1) fb[i] = f32(fb[i]! * billy);
    if (this.visMode !== SPECTRUM) {
      let c0 = 0;
      let c1 = 0;
      for (let i = 0; i < size; i += 8) c0 = f32(c0 + fb[i]!);
      for (let i = 1; i < size; i += 8) c1 = f32(c1 + fb[i]!);
      c0 = f32(c0 / (W * 0.125));
      c1 = f32(c1 / (W * 0.125));
      for (let i = 0; i < size; i += 2) fb[i] = f32(fb[i]! - c0);
      for (let i = 1; i < size; i += 2) fb[i] = f32(fb[i]! - c1);
    }
    // Above 8 bits, every frame whether the option is on or not: the power of 23 bands over the
    // left channel's first 256 samples, smoothed. It feeds the wave colours from the music; the
    // map damping it also gave the plug-in then forced to 1.
    if (this.hicolor) {
      const power = this.power;
      const smoothed = this.powerSmoothed;
      for (let n = 1; n < FOURIER_DETAIL; n += 1) {
        let a = 0;
        let b = 0;
        const row = n * 256;
        for (let i = 0; i < 256; i += 1) {
          const sample = fb[i * 2]!;
          a = f32(a + f32(sample * FOURIER_COS[row + i]!));
          b = f32(b + f32(sample * FOURIER_SIN[row + i]!));
        }
        power[n] = f32(Math.sqrt(f32(f32(a * a) + f32(b * b))));
        smoothed[n] = f32(smoothed[n]! * 0.94 + 0.06 * power[n]!);
      }
    }
  }

  private renderDots(vs: Uint8Array): void {
    const sb = this.soundBuffer;
    let low = sb[0]!;
    let high = sb[0]!;
    for (let i = this.bufsize - 4; i > 0; i -= 4) {
      low = Math.min(low, sb[i]!);
      high = Math.max(high, sb[i]!);
    }
    const vol = f32((high - low) / 256.0);
    this.pastVolPos = (this.pastVolPos + 1) % PAST_VOL_N;
    this.pastVol[this.pastVolPos] = this.currentVol;
    this.currentVol = vol;
    const last = this.fpsAtLastModeSwitch;
    let rate = adjustRateToFps(0.30, 30, last);
    this.avgVolNarrow = f32(f32(this.avgVolNarrow * rate) + f32(vol * f32(1 - rate)));
    rate = adjustRateToFps(0.85, 30, last);
    this.avgVol = f32(f32(this.avgVol * rate) + f32(vol * f32(1 - rate)));

    this.hit = Math.max(this.hit - 1, -1);
    if (this.titles && this.hit === -1) this.rand.next(); // random popups, at frequency 0

    if (this.effect[NUCLIDE]! > 0 && !this.soundEmpty && vol > this.avgVolNarrow * 1.1) {
      const r = this.rand;
      const W = this.width;
      const nodes = 3 + r.next() % 5;
      const phase = r.next() % 1000;
      const ratio = f32(vol / this.avgVolNarrow);
      let radius = toInt((W === 320 ? 2 : 3) + 40 * (ratio - 1.1));
      if (radius < 1) radius = 1;
      if (W === 320 && radius > 7) radius = 7;
      if (W !== 320 && radius > 10) radius = 10;
      let rad: number;
      if (W === 320) {
        rad = 22 + r.next() % 6;
      } else {
        rad = 34 + r.next() % 8;
        if (W > 1024) rad = Math.trunc(f32((rad * W) / 1024));
      }
      // Above 8 bits the dots are coloured, after the frame number and the random gF[].
      let cr = 1;
      let cg = 1;
      let cb = 1;
      if (this.hicolor) {
        const intfram = this.intframe + this.chaserOffset;
        const gF = this.gF;
        const sin = (a: number): number => f32(Math.sin(f32(a)));
        const cos = (a: number): number => f32(Math.cos(f32(a)));
        const f = f32(f32(7 * sin(intfram * 0.007 + 29)) + f32(5 * cos(intfram * 0.0057 + 27)));
        const arg = (g: number, add: number, sign: number): number => f32(f32(f32(intfram * g) + add) + sign * f);
        cr = f32(0.58 + 0.21 * sin(arg(gF[0]!, 20, -1)) + 0.21 * cos(arg(gF[3]!, 17, 1)));
        cg = f32(0.58 + 0.21 * sin(arg(gF[1]!, 42, 1)) + 0.21 * cos(arg(gF[4]!, 26, -1)));
        cb = f32(0.58 + 0.21 * sin(arg(gF[2]!, 57, -1)) + 0.21 * cos(arg(gF[5]!, 35, 1)));
      }
      const tab = this.sqrtTab;
      const bytes = this.bytes;
      for (let n = 0; n < nodes; n += 1) {
        const angle = f32(f32(n / nodes) * 6.28 + phase);
        const cx = Math.trunc(f32(this.gXC + f32(rad * f32(Math.cos(angle)))));
        const cy = Math.trunc(f32(this.gYC + f32(rad * f32(Math.sin(angle)))));
        for (let yy = -10; yy <= 10; yy += 1) {
          let t = ((cy + yy) * W + (cx - 10)) * bytes;
          for (let xx = -10; xx <= 10; xx += 1) {
            const val = Math.trunc(f32(f32(radius - tab[(xx + 10) * 21 + yy + 10]!) * 25));
            if (val > 0) {
              if (!this.hicolor) {
                vs[t] = Math.min(255, vs[t]! + val);
              } else {
                vs[t] = Math.min(255, toInt(f32(vs[t]! + f32(val * cb))));
                vs[t + 1] = Math.min(255, toInt(f32(vs[t + 1]! + f32(val * cg))));
                vs[t + 2] = Math.min(255, toInt(f32(vs[t + 2]! + f32(val * cr))));
              }
            }
            t += bytes;
          }
        }
      }
    }
  }

  private renderWave(vs: Uint8Array): void {
    const W = this.width;
    const H = this.height;
    const r = this.rand;
    let base = Math.trunc(f32(this.currentVol * 4) + this.avgVol * 0.4 - 10);

    const pv = this.pastVol;
    pv[this.pastVolPos] = this.avgVolNarrow;
    let uniform = 0;
    for (let i = 0; i < PAST_VOL_N; i += 1) uniform = f32(uniform + pv[i]!);
    uniform = f32(uniform / PAST_VOL_N);
    let beatStrength = 0;
    for (let i = 1; i < PAST_VOL_N; i += 1) {
      const step = Math.abs(f32(pv[i]! - pv[i - 1]!)) - uniform * 0.15;
      beatStrength = f32(beatStrength + (0 > step ? 0 : step));
    }
    beatStrength = f32(beatStrength / uniform);
    beatStrength = f32(beatStrength * 10);
    if (uniform < 10) beatStrength = 0;
    if (beatStrength > 90 + 19) this.beatMode = true;
    if (beatStrength < 90 - 19) this.beatMode = false;
    let variance = 0;
    for (let i = 0; i < PAST_VOL_N; i += 1) {
      const d = f32(pv[i]! - uniform);
      variance = f32(variance + f32(d * d));
    }
    variance = f32(variance / (PAST_VOL_N - 1));
    const stdDev = f32(Math.sqrt(variance));
    let maxVol = 0;
    for (let i = 0; i < PAST_VOL_N / 3; i += 1) maxVol = Math.max(maxVol, pv[i]!);
    this.bigBeat = this.avgVolNarrow > f32(maxVol * this.bigBeatThreshold);
    let briteScale = f32(f32(this.currentVol - uniform) / (stdDev * 0.5));
    if (briteScale < 0) briteScale = 0;
    if (briteScale > 1) briteScale = 1;
    if (this.beatMode && this.useBeatDetection && this.visMode !== SPECTRUM && this.waveform !== 6) base = toInt(f32(base * briteScale));

    const oldSlider = this.slider1;
    if (this.beatMode && this.slideShift) {
      if (this.currentVol > this.shiftMaxVol) {
        this.shiftMaxVol = f32(this.currentVol * 1.05);
        if (this.framesSinceShift > 2) {
          this.framesSinceShift = 0;
          this.slider1 = Math.trunc(((r.next() % Math.trunc(W / 2)) + 50) / 145);
          if (oldSlider > 0) this.slider1 *= -1;
          this.slider1 += (r.next() % 3 - 1) * W;
        }
      } else {
        const rate = adjustRateToFps(0.975, 30, this.fps);
        const limit = f32(uniform * 1.43);
        this.shiftMaxVol = f32(f32(this.shiftMaxVol * rate) + f32(limit * f32(1 - rate)));
        this.framesSinceShift += 1;
      }
    }

    if (base > 155) base = 155;
    if (base < 0) base = 0;
    // 8 bits: the wave is palette index `base`. Above: a colour whose red, green and blue wander
    // with the frame number and gF[], at `base`'s brightness ("sync to sound" off, the default),
    // or (on) a colour mostly from the music: bass red, mids green, treble blue.
    let red = base;
    let green = base;
    let blue = base;
    if (this.hicolor && this.syncColorToSound) {
      [red, green, blue] = this.soundColour(base);
    } else if (this.hicolor) {
      const intfram = f32(f32(f32(this.intframe + this.chaserOffset) * 30) / this.fpsAtLastModeSwitch);
      const gF = this.gF;
      const sin = (a: number): number => f32(Math.sin(f32(a)));
      const cos = (a: number): number => f32(Math.cos(f32(a)));
      const f = f32(f32(7 * sin(intfram * 0.006 + 59)) + f32(5 * cos(intfram * 0.0077 + 17)));
      const c1 = f32(0.55);
      const c2 = f32(0.5);
      const term = (g0: number, add0: number, sign0: number, g1: number, add1: number, sign1: number): number => {
        const a = f32(1 + f32(c1 * sin(f32(f32(f32(intfram * g0) + add0) + sign0 * f))));
        const b = f32(1 + f32(c2 * cos(f32(f32(f32(intfram * g1) + add1) + sign1 * f))));
        const value = f32(base * 1.07 * a * b);
        return toByte(value < 0 ? 0 : value > 255 ? 255 : value);
      };
      red = term(gF[0]!, 10, -1, gF[1]!, 37, 1);
      green = term(gF[2]!, 32, 1, gF[3]!, 16, -1);
      blue = term(gF[4]!, 87, -1, gF[5]!, 25, 1);
    }
    const fb = this.fSoundBuffer;
    const top = this.fxYcutHide;
    const bottom = H - this.fxYcutHide;
    const plot = this.hicolor
      ? (at: number): void => {
        const d = at * 4;
        if (vs[d]! < blue) vs[d] = blue;
        if (vs[d + 1]! < green) vs[d + 1] = green;
        if (vs[d + 2]! < red) vs[d + 2] = red;
      }
      : (at: number): void => {
        if (vs[at]! < base) vs[at] = base;
      };

    let passes = 0;
    if (this.waveform === 1 || this.waveform === 2) {
      if (W >= 1920) passes = 2;
      else if (W > 1024) passes = 1;
    } else if (W >= 1440) {
      passes = 1;
    }
    for (let pass = 0; pass < passes; pass += 1) {
      const tmp = this.passBuffer;
      tmp.set(fb.subarray(0, Math.min(16384, W * 4)));
      let sL = tmp[0]!;
      let sR = tmp[1]!;
      for (let i = 0; i < W * 2; i += 2) {
        const tL = f32(tmp[i + 2]! * f32(1.14));
        const tR = f32(tmp[i + 3]! * f32(1.14));
        fb[i * 2] = sL;
        fb[i * 2 + 1] = sR;
        fb[i * 2 + 2] = f32(0.5 * f32(sL + tL));
        fb[i * 2 + 3] = f32(0.5 * f32(sR + tR));
        sL = tL;
        sR = tR;
      }
    }

    const gx = this.gXC;
    const gy = this.gYC;
    switch (this.waveform) {
      case 1: {
        let yCenter = gy;
        let start = 0;
        let end = W;
        if (this.mode === 10) {
          yCenter = Math.trunc(((H - this.fxYcut) + H * 0.5) * 0.5);
          if (this.visMode === SPECTRUM) yCenter = Math.trunc(0.9 * (H - this.fxYcut) + 0.1 * (H * 0.5));
          start += 10;
          end -= 10;
          if (W >= 640) {
            start += 5;
            end -= 5;
          }
        }
        let zL = f32(fb[start & ~1]! + yCenter);
        for (let i = start; i < end; i += 1) {
          const prev = zL;
          zL = f32(fb[i & ~1]! + yCenter);
          zL = f32(prev * 0.9 + zL * 0.1);
          const yL = Math.trunc(zL);
          if (yL >= top && yL < bottom) plot(W * yL + i);
        }
        break;
      }
      case 2: {
        const fDiv = f32(0.7);
        const h1 = f32(gy - H * 0.12);
        const h2 = f32(gy + H * 0.12);
        let zL = f32(f32(fb[0]! * fDiv) + h1);
        let zR = f32(f32(fb[1]! * fDiv) + h2);
        for (let i = 0; i < W; i += 1) {
          const pL = zL;
          const pR = zR;
          zL = f32(f32(fb[i & ~1]! * fDiv) + h1);
          zR = f32(f32(fb[(i & ~1) + 1]! * fDiv) + h2);
          zL = f32(pL * 0.9 + zL * 0.1);
          zR = f32(pR * 0.9 + zR * 0.1);
          const yL = Math.trunc(zL);
          const yR = Math.trunc(zR);
          if (yL > top && yL < bottom) plot(W * yL + i);
          if (yR > top && yR < bottom) plot(W * yR + i);
        }
        break;
      }
      case 3: {
        let zL = f32(fb[top ^ (top & 1)]! + gx);
        for (let i = top; i < bottom; i += 1) {
          const prev = zL;
          zL = f32(fb[i & ~1]! + gx);
          zL = f32(prev * 0.9 + zL * 0.1);
          const xL = Math.trunc(zL);
          if (xL >= 0 && xL < W) plot(W * i + xL);
        }
        break;
      }
      case 4: {
        const fDiv = f32(0.9);
        let zL = f32(fb[top ^ (top & 1)]! * fDiv);
        // FX_YCUT_HIDE^(FX_YCUT_HIDE & 1)+1: "+" before "^".
        let zR = f32(fb[top ^ ((top & 1) + 1)]! * fDiv);
        for (let i = top; i < bottom; i += 1) {
          const pL = zL;
          const pR = zR;
          zL = f32(fb[i & ~1]! * fDiv);
          zR = f32(fb[(i & ~1) + 1]! * fDiv);
          zL = f32(pL * 0.9 + zL * 0.1);
          zR = f32(pR * 0.9 + zR * 0.1);
          const xL = Math.trunc(zL) + i;
          const xR = Math.trunc(zR) + i + (W - H);
          if (xL >= 0 && xL < W) plot(W * i + xL);
          if (xR >= 0 && xR < W) plot(W * i + xR);
        }
        break;
      }
      case 5: {
        const rangeInv = f32(1.0 / WAVE_5_BLEND_RANGE);
        const baseRad = W === 320 ? 40 : f32(f32(W / 640) * 60.0);
        const fDiv = f32(0.7);
        for (let i = 0; i < WAVE_5_BLEND_RANGE; i += 1) {
          const amt = f32(i * rangeInv);
          const j = i + 314;
          fb[i & ~1] = f32(f32(fb[i & ~1]! * amt) + f32(f32(1 - amt) * fb[j ^ (j & 1)]!));
        }
        let rad = f32(baseRad + f32(fb[0]! * fDiv));
        for (let i = 0; i < 314; i += 1) {
          rad = f32(rad * 0.5 + 0.5 * f32(baseRad + f32(fb[i & ~1]! * fDiv)));
          if (rad >= 5) {
            const px = Math.trunc(f32(gx + f32(rad * f32(Math.cos(f32(i * 0.02))))));
            const py = Math.trunc(f32(gy + f32(rad * f32(Math.sin(f32(i * 0.02))))));
            if (px >= 0 && px < W && py >= this.fxYcut && py < H - this.fxYcut) plot(W * py + px);
          }
        }
        break;
      }
      case 6: {
        const fDiv = f32(1.2);
        const ang = f32(Math.sin(f32(this.intframe * 0.01)));
        const cosang = f32(Math.cos(ang));
        const sinang = f32(Math.sin(ang));
        let px2 = fb[0]!;
        let py2 = fb[1]!;
        for (let i = 0; i < 314; i += 1) {
          px2 = f32(px2 * 0.5 + 0.5 * fb[i * 2]! * fDiv);
          py2 = f32(py2 * 0.5 + 0.5 * fb[i * 2 + 1]! * fDiv);
          let px = Math.trunc(f32(f32(px2 * cosang) + f32(py2 * sinang)));
          let py = Math.trunc(f32(f32(px2 * -sinang) + f32(py2 * cosang)));
          px += gx;
          py += gy;
          if (px >= 0 && px < W && py >= this.fxYcut && py < H - this.fxYcut) plot(W * py + px);
        }
        break;
      }
      case 7: {
        const dx = f32(Math.cos(f32(this.intframe * 0.03)));
        const dy = f32(Math.sin(f32(this.intframe * 0.03)));
        if (Math.abs(dx) > 0.001) {
          // `float b` (the line's intercept) is declared in the very blocks that plot, so above
          // 8 bits "b*t" is the intercept, not the blue of the wave: the first byte is set from
          // it (wrapping like any float stored in a byte) and the third byte tested against it.
          const line = (at: number, sampleAt: number, intercept: number): void => {
            const t = f32(Math.min(1.0, Math.abs(f32(fb[sampleAt ^ (sampleAt & 1)]! / 64))));
            if (!this.hicolor) {
              const level = f32(base * t);
              if (vs[at]! < level) vs[at] = toByte(level);
              return;
            }
            const d = at * 4;
            if (vs[d]! < f32(red * t)) vs[d] = toByte(f32(intercept * t));
            if (vs[d + 1]! < f32(green * t)) vs[d + 1] = toByte(f32(green * t));
            if (vs[d + 2]! < f32(intercept * t)) vs[d + 2] = toByte(f32(red * t));
          };
          if (Math.abs(dx) > Math.abs(dy)) {
            const m = f32(dy / dx);
            const b = f32(gy - f32(m * gx));
            for (let x = 0; x < W; x += 1) {
              const y = Math.trunc(f32(f32(m * x) + b));
              if (y > this.fxYcut && y < H - this.fxYcut) line(W * y + x, x, b);
            }
          } else {
            const m = f32(dx / dy);
            const b = f32(gx - f32(m * gy));
            for (let y = this.fxYcut; y < H - this.fxYcut; y += 1) {
              const x = Math.trunc(f32(f32(m * y) + b));
              if (x >= 0 && x < W) line(W * y + x, y, b);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // ---- song titles (video.h) ---------------------------------------------------------------

  /**
   * Above 8 bits with g_bSyncColorToSound (RenderWave()): the wave's colour, 97% from the music —
   * bands 0–7 red, 7–14 green, 13–23 blue (2.4 times as much, and some of it taken from red),
   * scaled to `base` — and 3% from the frame number, then 35% brighter.
   */
  private soundColour(base: number): [number, number, number] {
    const intfram = this.intframe + this.chaserOffset;
    const gF = this.gF;
    const sin = (a: number): number => f32(Math.sin(f32(a)));
    const cos = (a: number): number => f32(Math.cos(f32(a)));
    const f = f32(f32(7 * sin(intfram * 0.006 + 59)) + f32(5 * cos(intfram * 0.0077 + 17)));
    const time = (g0: number, add0: number, sign0: number, g1: number, add1: number, sign1: number): number =>
      f32(base * 1.07 * (1 + 0.3 * sin(f32(f32(f32(intfram * g0) + add0) + sign0 * f))) * (1 + 0.2 * cos(f32(f32(f32(intfram * g1) + add1) + sign1 * f))));
    const red2 = time(gF[0]!, 10, -1, gF[1]!, 37, 1);
    const green2 = time(gF[2]!, 32, 1, gF[3]!, 16, -1);
    const blue2 = time(gF[4]!, 87, -1, gF[5]!, 25, 1);
    const power = this.powerSmoothed;
    let red = 0;
    let green = 0;
    let blue = 0;
    // a < FOURIER_DETAIL*0.31, from FOURIER_DETAIL*0.30 (7) to < *0.59, from *0.56 (13) to the end.
    for (let a = 0; a < FOURIER_DETAIL * 0.31; a += 1) red = f32(red + power[a]!);
    for (let a = Math.trunc(FOURIER_DETAIL * 0.3); a < FOURIER_DETAIL * 0.59; a += 1) green = f32(green + power[a]!);
    for (let a = Math.trunc(FOURIER_DETAIL * 0.56); a < FOURIER_DETAIL; a += 1) blue = f32(blue + power[a]!);
    red = f32(red * 0.93);
    green = f32(green * 1.18);
    blue = f32(blue * 2.4);
    red = f32(red - blue * 0.4);
    const scale = f32(base / f32(Math.sqrt(f32(f32(f32(red * red) + f32(green * green)) + f32(blue * blue)))));
    red = f32(red * scale);
    green = f32(green * scale);
    blue = f32(blue * scale);
    const mix = (music: number, time: number): number => {
      const value = f32((music * 0.97 + time * 0.03) * 1.35);
      // Clamped as there: NaN (silence, 0/0) passes both tests and becomes 0.
      return toByte(value < 0 ? 0 : value > 255 ? 255 : value);
    };
    return [mix(red, red2), mix(green, green2), mix(blue, blue2)];
  }

  // ---- song titles and custom messages (video.h, the keys m##) ------------------------------

  /** The track's title (Winamp's window title), popped up the next time no other title is showing. */
  public announce(text: string): void {
    this.pendingTitle = text;
  }

  /**
   * The keys `m##`: LoadCustomMsg() puts message ## of GEISS.INI's [CUSTOM MESSAGES] in place of
   * the title (`text`, or "" when there is no such message: Geiss popped up nothing then, but did
   * everything else), for (g_song_tooltip_frames + 1) frames at 30 fps, at once, over any title
   * showing. The colour it burns in at 16/32 bits is the last title's. The next new title then
   * comes back without popping up (g_LastMessageWasCustom).
   */
  public showMessage(text: string): void {
    if (!this.rasterise) return;
    this.lastMessageWasCustom = true;
    this.songTitle = text;
    this.titleMask = this.rasterise(text, this.width);
    this.hit = toInt(f32(f32((this.titleFrames + 1) * this.fpsAtLastModeSwitch) / 30));
  }

  /** Check_For_New_Song_Title(). */
  private checkForNewSongTitle(): void {
    if (!this.titles || this.hit >= 0) return;
    if (this.pendingTitle === this.songTitle) return;
    const r = this.rand;
    this.titleR = 128 + r.next() % 99;
    this.titleG = 128 + r.next() % 99;
    this.titleB = 128 + r.next() % 99;
    this.songTitle = this.pendingTitle;
    this.titleMask = this.rasterise ? this.rasterise(this.songTitle, this.width) : null;
    if (!this.lastMessageWasCustom && this.titleMask) this.hit = toInt(f32(f32(this.titleFrames * this.fpsAtLastModeSwitch) / 30));
    this.lastMessageWasCustom = false;
  }

  /**
   * Plop_Songtitle_Using_Backbuffer_As_Scratch(0): placed on its first frame, burnt in on the last.
   * There GDI drew the text opaque (black behind it) into the back buffer, and every pixel of the
   * text's box above index 1 (8 bits) or with blue above 1 (16/32 bits) went into the picture: at
   * 8 bits as index 225, above in the title's colour. At 8 bits that is the palette's nearest
   * colours to the ink and to black, so a palette whose nearest black lies above index 1 burnt
   * the whole box in (Geiss's "white block").
   */
  private plopSongTitle(): void {
    const mask = this.titleMask;
    if (this.hit < 2 || !mask) return;
    const r = this.rand;
    const yRange = this.height - this.fxYcutHide * 2 - mask.height;
    const xRange = this.width - mask.width;
    if (this.hitPrev < this.hit) {
      const xs = Math.trunc(xRange / 4);
      const ys = Math.trunc(yRange / 4);
      this.titleX = xRange > 0 && xs > 0 ? r.next() % xs + r.next() % xs + r.next() % xs + r.next() % xs : 0;
      this.titleY = this.fxYcutHide + (ys > 0 ? r.next() % ys + r.next() % ys + r.next() % ys + r.next() % ys : 0);
    }
    this.hitPrev = this.hit;
    if (this.hit !== 2) return;
    const W = this.width;
    const last = Math.min(W - 2, this.titleX + mask.width);
    // The byte the test reads: the index, or the pixel's lowest byte (blue at 32 bits).
    const ink = this.titleColours().ink & 255;
    const paper = this.hicolor ? 0 : gdiNearestIndex(this.palette, 0, 0, 0);
    for (let y = 0; y < mask.height; y += 1) {
      const row = this.titleY + y;
      const maskRow = y - mask.top;
      for (let x = this.titleX; x < last; x += 1) {
        const column = x - this.titleX - mask.left;
        const glyph = maskRow >= 0 && maskRow < mask.maskHeight && column >= 0 && column < mask.maskWidth && mask.mask[maskRow * mask.maskWidth + column] !== 0;
        if ((glyph ? ink : paper) <= 1) continue;
        if (!this.hicolor) {
          this.vs1[row * W + x] = 225;
        } else {
          // g_title_R into the first byte (blue), as in the original.
          const at = (row * W + x) * 4;
          this.vs1[at] = this.titleR;
          this.vs1[at + 1] = this.titleG;
          this.vs1[at + 2] = this.titleB;
        }
      }
    }
  }

  /** The title drawn over this frame (phase 1 of the popup), or null. */
  public titleOverlay(): TitleOverlay | null {
    if (this.hit <= 2 || !this.titleMask) return null;
    return { text: this.songTitle, mask: this.titleMask, x: this.titleX, y: this.titleY };
  }

  /**
   * The ink and shadow of the title over this frame as the surface holds them: at 8 bits the
   * palette indices GDI picks for RGB(225, 225, 225) and RGB(20, 20, 20), at 16 bits 5-6-5 words,
   * at 32 bits 0x00RRGGBB.
   */
  public titleColours(): { ink: number; shadow: number } {
    if (this.depth === 8) {
      return { ink: gdiNearestIndex(this.palette, TITLE_INK, TITLE_INK, TITLE_INK), shadow: gdiNearestIndex(this.palette, TITLE_SHADOW, TITLE_SHADOW, TITLE_SHADOW) };
    }
    if (this.depth === 16) return { ink: rgb565(TITLE_INK, TITLE_INK, TITLE_INK), shadow: rgb565(TITLE_SHADOW, TITLE_SHADOW, TITLE_SHADOW) };
    return { ink: TITLE_INK * 0x10101, shadow: TITLE_SHADOW * 0x10101 };
  }
}

/** A colour as GDI writes it into a 5-6-5 surface: each channel's top bits. */
function rgb565(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/**
 * The palette index GDI draws a COLORREF with on an 8-bit surface (SetTextColor/SetBkColor): the
 * nearest colour of the palette (r, g, b per index), the first of equals.
 */
export function gdiNearestIndex(palette: Uint8Array, r: number, g: number, b: number): number {
  let best = 0;
  let distance = Infinity;
  for (let index = 0; index < 256; index += 1) {
    const dr = palette[index * 3]! - r;
    const dg = palette[index * 3 + 1]! - g;
    const db = palette[index * 3 + 2]! - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < distance) {
      distance = d;
      best = index;
    }
  }
  return best;
}

/**
 * Phase 1 of the popup into `out`, a surface as the plug-in's back buffer holds it (8 bits an
 * index a byte, 16 bits a 5-6-5 word, 32 bits blue, green, red, unused): the shadow one pixel down
 * and right, then the text, transparent, clipped to the surface.
 */
export function drawTitle(sim: GeissSim, out: Uint8Array): void {
  const overlay = sim.titleOverlay();
  if (!overlay) return;
  const { ink, shadow } = sim.titleColours();
  const bytes = sim.depth / 8;
  const put = (at: number, colour: number): void => {
    if (bytes === 1) out[at] = colour;
    else if (bytes === 2) {
      out[at * 2] = colour & 255;
      out[at * 2 + 1] = colour >> 8;
    } else {
      out[at * 4] = colour & 255;
      out[at * 4 + 1] = (colour >> 8) & 255;
      out[at * 4 + 2] = colour >> 16;
      out[at * 4 + 3] = 0;
    }
  };
  forEachTitlePixel(sim, overlay, put, ink, shadow);
}

/** Every pixel of the title over the frame, the shadow first, with its colour. */
function forEachTitlePixel(sim: GeissSim, overlay: TitleOverlay, put: (at: number, colour: number) => void, ink: number, shadow: number): void {
  const W = sim.width;
  const H = sim.height;
  const { mask, maskWidth, maskHeight, left, top } = overlay.mask;
  for (const [offset, colour] of [[1, shadow], [0, ink]] as const) {
    for (let y = 0; y < maskHeight; y += 1) {
      const row = overlay.y + top + y + offset;
      if (row < 0 || row >= H) continue;
      for (let x = 0; x < maskWidth; x += 1) {
        const column = overlay.x + left + x + offset;
        if (mask[y * maskWidth + x] && column >= 0 && column < W) put(row * W + column, colour);
      }
    }
  }
}

/** Merge's PADDUSB: a byte doubled, at most 255. */
const DOUBLED = Uint8Array.from({ length: 256 }, (_, value) => Math.min(255, value * 2));
/** 16 bits: the doubled byte cut to 5 or 6 bits by the 5-6-5 packing, widened again by the card. */
const FIVE_BITS = Uint8Array.from({ length: 256 }, (_, value) => {
  const bits = DOUBLED[value]! >> 3;
  return (bits << 3) | (bits >> 2);
});
const SIX_BITS = Uint8Array.from({ length: 256 }, (_, value) => {
  const bits = DOUBLED[value]! >> 2;
  return (bits << 2) | (bits >> 4);
});
const paletteWords = new Uint32Array(256);

/**
 * The frame as the screen showed it (Merge_All_VS_To_Backbuffer() and the video card), into
 * `out` as RGBA words (little-endian 0xAABBGGRR), `width` × `height`: at 8 bits each index through
 * the palette, outside the computed band index 0; at 32 bits every byte doubled, at most 255
 * (PADDUSB); at 16 bits doubled, then packed to 5-6-5. Black outside the band above 8 bits.
 */
export function presentFrame(sim: GeissSim, out: Uint32Array): void {
  const W = sim.width;
  const end = W * sim.height;
  const { top, bottom } = sim.band;
  const vs = sim.vs1;
  if (sim.depth === 8) {
    const palette = sim.palette;
    for (let index = 0; index < 256; index += 1) {
      paletteWords[index] = (0xff000000 | (palette[index * 3 + 2]! << 16) | (palette[index * 3 + 1]! << 8) | palette[index * 3]!) >>> 0;
    }
    out.fill(paletteWords[0]!, 0, top * W);
    out.fill(paletteWords[0]!, bottom * W, end);
    for (let p = top * W, stop = bottom * W; p < stop; p += 1) out[p] = paletteWords[vs[p]!]!;
    presentTitle(sim, out);
    return;
  }
  // A pixel a word: blue, green, red and the fourth byte from the lowest byte up.
  const words = new Uint32Array(vs.buffer, vs.byteOffset, vs.byteLength >> 2);
  out.fill(0xff000000, 0, top * W);
  out.fill(0xff000000, bottom * W, end);
  if (sim.depth === 32) {
    for (let p = top * W, stop = bottom * W; p < stop; p += 1) {
      const v = words[p]!;
      // PADDUSB on all four bytes at once: doubled, and 255 where the top bit was set.
      const doubled = ((v & 0x7f7f7f7f) << 1) | (((v >>> 7) & 0x01010101) * 0xff);
      out[p] = 0xff000000 | ((doubled & 0xff) << 16) | (doubled & 0xff00) | ((doubled >>> 16) & 0xff);
    }
    presentTitle(sim, out);
    return;
  }
  for (let p = top * W, stop = bottom * W; p < stop; p += 1) {
    const v = words[p]!;
    out[p] = 0xff000000 | (FIVE_BITS[v & 255]! << 16) | (SIX_BITS[(v >>> 8) & 255]! << 8) | FIVE_BITS[(v >>> 16) & 255]!;
  }
  presentTitle(sim, out);
}

/** The title popup over the frame as the card showed what GDI wrote (drawTitle) in RGBA words. */
function presentTitle(sim: GeissSim, out: Uint32Array): void {
  const overlay = sim.titleOverlay();
  if (!overlay) return;
  const { ink, shadow } = sim.titleColours();
  let shown: (colour: number) => number;
  if (sim.depth === 8) {
    const palette = sim.palette;
    shown = (index) => (0xff000000 | (palette[index * 3 + 2]! << 16) | (palette[index * 3 + 1]! << 8) | palette[index * 3]!) >>> 0;
  } else if (sim.depth === 16) {
    // The card widens 5 and 6 bits again as it does for the picture.
    const widen5 = (bits: number): number => (bits << 3) | (bits >> 2);
    const widen6 = (bits: number): number => (bits << 2) | (bits >> 4);
    shown = (word) => (0xff000000 | (widen5(word & 31) << 16) | (widen6((word >> 5) & 63) << 8) | widen5(word >> 11)) >>> 0;
  } else {
    shown = (rgb) => (0xff000000 | ((rgb & 255) << 16) | (rgb & 0xff00) | (rgb >>> 16)) >>> 0;
  }
  forEachTitlePixel(sim, overlay, (at, colour) => {
    out[at] = colour;
  }, shown(ink), shown(shadow));
}
