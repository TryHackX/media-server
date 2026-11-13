import {
  ACROSS, type AvmShape, contourRelease, DOWN, ENERGY_PER_VOLT, ENERGY_POLES, LINES_PER_FIELD,
  NOMINAL_INPUT, ramp, shapeLine, STEP_VOLTS, tapChromaAt, tapOfCount, VISIBLE_CLOCKS, VISIBLE_LINES,
  yiqToRgb, ZERO_AXIS_DIVIDER, ZERO_AXIS_HIGH_PASS, ZERO_AXIS_HYSTERESIS
} from "./avm-circuit";
import type { PixelImage, RetroFrame, RetroScene } from "./types";

/**
 * Atari Video Music C240 (1977): its circuit (avm-circuit.ts) run over the music sample by sample.
 *
 * The beam draws 262 lines a field, 60 fields a second, whatever the panel's frame rate: each
 * line takes the channels' energies of its own moment — the hold capacitor's charge, topped up
 * by every peak of the band-passed music and let go as CONTOUR sets — so a soft contour draws
 * streaks and a geometric one steady diamonds, as the manual's pictures show. The colour of each
 * channel is a tap of the delay line on the colour clock, picked by its count of zero crossings
 * (TABLE I): the counter serves the channels on alternate fields, and the channel it counts
 * takes its tap from the count so far, so its hue steps on as the beam goes down, while the
 * other keeps the count of its last field. The COLOR pot sets the delay line's bias, which the
 * ramps move too: rings of colour round the middle of each diamond. A line is drawn as the set
 * showed it: luminance sharp, colour soft along the line (a TV's narrow chroma band), and where
 * the hue steps from one line to the next the set's decoder lost the colour for a line, grey. A
 * line stays on screen until the beam comes round again; the eye sees the last two fields.
 *
 * The input is a hi-fi's line out: the music brought to the manual's 250 mV. GAIN is set as an
 * owner set it, by eye: the music's usual peaks a diamond reaching most of the way to the edges
 * (each preset turns the channels up or down from there). AUTO changes the shape, and AUTO ALL
 * the number of diamonds too, at random moments at the chosen scan rate, preferably on a beat.
 */

export interface AvmSettings {
  /** The shape button: SOLID, HOLE, RING, or AUTO (a random one, changed at the scan rate). */
  shape: AvmShape | "auto";
  /** HORIZONTAL DISPLAY 1, 2, 3, 5 and VERTICAL DISPLAY 1, 2, 4, 8. */
  across: number;
  down: number;
  /** AUTO ALL: the numbers across and down change too. */
  autoAll?: boolean;
  /** SCAN RATE 1, 2, 4, 8: the higher, the longer between automatic changes. */
  scanRate?: number;
  /** CONTOUR, left and right: 0 fully anticlockwise (soft shapes) … 1 fully clockwise (geometric). */
  contour?: [number, number];
  /** GAIN, left and right: each channel's size against the owner's setting (1). */
  gain?: [number, number];
  /** COLOR: 0 fully anticlockwise (less colour), 0.5 a rainbow of colours, 1 a solid colour. */
  color?: number;
  /** The TV's tint: the phase (degrees) the hues start from. */
  tint?: number;
}

/** Lines per second of an NTSC set, and the first field line the picture shows. */
const LINE_RATE = 15734.26;
const FIRST_VISIBLE = 18;
/** The set's luminance of a lit pixel and the length of its chroma (YIQ). */
const LUMA = 0.68;
const CHROMA = 0.62;
/** Half the width, in clocks, over which a set's chroma filter spreads a colour along the line. */
const CHROMA_SPREAD = 3;
/** The hold capacitor charges within a millisecond. */
const ATTACK_SECONDS = 0.0003;
/** The usual size, in ramp steps: the widest line of a field, on average, most of the way to the edges (15). */
const TARGET_STEPS = 15;
/** Energy beyond the corners lights everything; no more is needed. */
const MOST_STEPS = 40;
/** The fields of music the first turn of GAIN is judged by. */
const FIRST_FIELDS = 12;

/** The coefficients of one channel's circuit at the sample rate. */
interface Coefficients {
  zero: number;
  bandHigh: number;
  bandLow: number;
  attack: number;
  release: number;
  idle: number;
}

/** One input channel: the zero axis detector (before GAIN) and the energy detector (after it). */
class Channel {
  private zeroHigh = 0;
  private zeroLast = 0;
  private squared = false;
  /** Swings of the squared signal counted this field (counter 53, when it serves us). */
  crossings = 0;
  private bandHigh = 0;
  private bandLast = 0;
  private bandLow = 0;
  /** The hold node's rise above its idle level (V). */
  energy = 0;

  step(jack: number, gain: number, k: Coefficients, bandGain: number): void {
    // Zero axis: high-pass, halved, a comparator with hysteresis; one count a swing.
    this.zeroHigh = k.zero * (this.zeroHigh + jack - this.zeroLast);
    this.zeroLast = jack;
    const level = ZERO_AXIS_DIVIDER * this.zeroHigh;
    if (!this.squared && level < -ZERO_AXIS_HYSTERESIS) {
      this.squared = true;
      this.crossings += 1;
    } else if (this.squared && level > 0) {
      this.squared = false;
    }
    // Energy: the band-pass (GAIN is a plain divider before it, so it may come after), then the
    // negative half-cycles charge the hold capacitor; it lets go towards the level below idle.
    this.bandHigh = k.bandHigh * (this.bandHigh + jack - this.bandLast);
    this.bandLast = jack;
    this.bandLow += (this.bandHigh - this.bandLow) * k.bandLow;
    const drive = -this.bandLow * bandGain;
    const charge = drive * gain;
    if (charge > this.energy) this.energy += (charge - this.energy) * k.attack;
    else this.energy = Math.max(0, this.energy - (this.energy + k.idle) * k.release);
  }
}

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** The band-pass's gain in the middle of the band, so ENERGY_PER_VOLT holds there. */
function bandGainAtCentre(): number {
  const [low, high] = ENERGY_POLES;
  const centre = Math.sqrt(low * high);
  const highPass = centre / low / Math.hypot(1, centre / low);
  const lowPass = 1 / Math.hypot(1, centre / high);
  return ENERGY_PER_VOLT / (highPass * lowPass);
}

export function createAvm(settings: AvmSettings): RetroScene {
  const width = VISIBLE_CLOCKS;
  const height = VISIBLE_LINES;
  const screen = new Uint8ClampedArray(width * height * 4);
  for (let index = 3; index < screen.length; index += 4) screen[index] = 255;
  /** Each line of the last two fields (RGB), even fields and odd ones. */
  const fields = [new Uint8ClampedArray(width * height * 3), new Uint8ClampedArray(width * height * 3)];
  /** Each field's lines that lost their colour (a step of the hue). */
  const greyLines = [new Uint8Array(height), new Uint8Array(height)];
  const horizontal = new Map<number, Uint8Array>();
  const rampAcross = (across: number): Uint8Array => {
    let values = horizontal.get(across);
    if (!values) {
      values = new Uint8Array(width);
      for (let clock = 0; clock < width; clock += 1) values[clock] = ramp((clock + 0.5) / width, across);
      horizontal.set(across, values);
    }
    return values;
  };
  const lineOut = new Uint8Array(width);
  /** One line as luminance and chroma (YIQ), before and after the set's filters. */
  const lumaLine = new Float32Array(width);
  const iLine = new Float32Array(width);
  const qLine = new Float32Array(width);
  const iSoft = new Float32Array(width);
  const qSoft = new Float32Array(width);
  const left = new Channel();
  const right = new Channel();
  const random = seeded(0x1977c240);
  const [contourLeft, contourRight] = settings.contour ?? [1, 1];
  const [gainLeft, gainRight] = settings.gain ?? [1, 0.85];
  const scanRate = settings.scanRate ?? 2;
  const color = settings.color ?? 0.5;
  const tint = settings.tint ?? 150;
  const bandGain = bandGainAtCentre();
  /** Each tap's chroma at each sum of the ramps (0 … 30): 31 × 17 pairs, tap 0 unused. */
  const chromaI = new Float32Array(31 * 17);
  const chromaQ = new Float32Array(31 * 17);
  for (let sum = 0; sum <= 30; sum += 1) {
    for (let tap = 1; tap <= 16; tap += 1) {
      const [i, q] = tapChromaAt(tap, sum, color, tint, CHROMA);
      chromaI[sum * 17 + tap] = i;
      chromaQ[sum * 17 + tap] = q;
    }
  }

  let shape: AvmShape = settings.shape === "auto" ? "solid" : settings.shape;
  let across = settings.across;
  let down = settings.down;
  /** The colour registers: the tap of each channel's count at the end of its last field. */
  let registerLeft = 12;
  let registerRight = 6;
  /** The tap of the channel being counted, on the line drawn last (a step: a grey line). */
  let lastLiveTap = 0;
  let field = 0;
  let beamLine = 0;
  let lineClock = 0;
  /** The line out: the music's mean square of late, and so its scale to the manual's level. */
  let meanSquare = 0.01;
  /** The owner's GAIN, set by the size the shapes usually reach (steps; 0 before any music). */
  let usualSize = 0;
  let fieldSize = 0;
  let heard = 0;
  let firstSum = 0;
  let firstFields = 0;
  let gain = 1;
  let sinceChange = 0;
  let nextChange = 0;
  let rate = 0;
  let coefficients: [Coefficients, Coefficients] | null = null;

  const coefficientsFor = (sampleRate: number, contour: number): Coefficients => {
    const { tau, idle } = contourRelease(contour);
    return {
      zero: Math.exp((-2 * Math.PI * ZERO_AXIS_HIGH_PASS) / sampleRate),
      bandHigh: Math.exp((-2 * Math.PI * ENERGY_POLES[0]) / sampleRate),
      bandLow: 1 - Math.exp((-2 * Math.PI * ENERGY_POLES[1]) / sampleRate),
      attack: 1 - Math.exp(-1 / (sampleRate * ATTACK_SECONDS)),
      release: 1 - Math.exp(-1 / (sampleRate * tau)),
      idle
    };
  };

  const planChange = (): void => {
    // SCAN RATE 1 is the quickest: a change every few seconds, 8 the slowest.
    nextChange = (2.5 + random() * 2.5) * Math.sqrt(scanRate) * 1.4;
    sinceChange = 0;
  };
  planChange();

  const autoChange = (): void => {
    // The random register: the colour registers' lowest bits and a running count.
    const bits = (registerLeft & 3) ^ ((registerRight & 3) << 2) ^ Math.floor(random() * 16);
    if (settings.shape === "auto") shape = (["solid", "hole", "ring"] as const)[bits % 3]!;
    if (settings.autoAll) {
      across = ACROSS[Math.floor(random() * ACROSS.length)]!;
      down = DOWN[(bits >> 2) % DOWN.length]!;
      // Many small diamonds only now and then; one to a few most of the time.
      if (across * down > 12 && random() < 0.5) {
        across = ACROSS[Math.floor(random() * 2)]!;
        down = DOWN[Math.floor(random() * 2)]!;
      }
    }
    planChange();
  };

  /** The beam draws one line of the field, with the energies of this moment. */
  const drawLine = (fieldLine: number): void => {
    const y = fieldLine - FIRST_VISIBLE;
    if (y < 0 || y >= height) return;
    const vertical = ramp((y + 0.5) / height, down);
    const rampLine = rampAcross(across);
    const stepsLeft = Math.min(MOST_STEPS, left.energy / STEP_VOLTS);
    const stepsRight = Math.min(MOST_STEPS, right.energy / STEP_VOLTS);
    fieldSize = Math.max(fieldSize, stepsLeft, stepsRight);
    shapeLine(shape, stepsLeft, stepsRight, vertical, rampLine, lineOut);
    // The channel the counter serves this field takes its tap from the count so far.
    const counting = field % 2 === 0;
    const liveTap = tapOfCount((counting ? left : right).crossings);
    const tapLeft = counting ? liveTap : registerLeft;
    const tapRight = counting ? registerRight : liveTap;
    // Where the hue steps from one line to the next, the set's decoder shows the line grey.
    const grey = liveTap !== lastLiveTap;
    lastLiveTap = liveTap;
    for (let clock = 0; clock < width; clock += 1) {
      const lit = lineOut[clock]!;
      if (lit) {
        const at = (rampLine[clock]! + vertical) * 17 + (lit === 1 ? tapLeft : tapRight);
        lumaLine[clock] = LUMA;
        iLine[clock] = chromaI[at]!;
        qLine[clock] = chromaQ[at]!;
      } else {
        lumaLine[clock] = 0;
        iLine[clock] = 0;
        qLine[clock] = 0;
      }
    }
    // The chroma filter: colour spread over a few clocks along the line, softer than the luma.
    let sumI = 0;
    let sumQ = 0;
    const span = 2 * CHROMA_SPREAD + 1;
    for (let clock = -CHROMA_SPREAD; clock < width + CHROMA_SPREAD; clock += 1) {
      const enter = clock + CHROMA_SPREAD;
      const leave = clock - CHROMA_SPREAD - 1;
      if (enter < width) {
        sumI += iLine[enter]!;
        sumQ += qLine[enter]!;
      }
      if (leave >= 0) {
        sumI -= iLine[leave]!;
        sumQ -= qLine[leave]!;
      }
      if (clock >= 0 && clock < width) {
        iSoft[clock] = sumI / span;
        qSoft[clock] = sumQ / span;
      }
    }
    const mine = fields[field % 2]!;
    const other = fields[(field + 1) % 2]!;
    greyLines[field % 2]![y] = grey ? 1 : 0;
    // A grey line of either field greys the line the eye sees.
    const greyed = grey || greyLines[(field + 1) % 2]![y] === 1;
    let at = y * width * 4;
    let rgb = y * width * 3;
    for (let clock = 0; clock < width; clock += 1, at += 4, rgb += 3) {
      // Colour only where there is light: a set shows no chroma on black.
      const luma = (lumaLine[Math.max(0, clock - 1)]! + 2 * lumaLine[clock]! + lumaLine[Math.min(width - 1, clock + 1)]!) / 4;
      const keep = luma > 0 ? 1 : 0;
      yiqToRgb(luma, iSoft[clock]! * keep, qSoft[clock]! * keep, mine, rgb);
      let r = (mine[rgb]! + other[rgb]! + 1) >> 1;
      let g = (mine[rgb + 1]! + other[rgb + 1]! + 1) >> 1;
      let b = (mine[rgb + 2]! + other[rgb + 2]! + 1) >> 1;
      if (greyed) {
        const y601 = 0.299 * r + 0.587 * g + 0.114 * b;
        r = y601 + (r - y601) * 0.15;
        g = y601 + (g - y601) * 0.15;
        b = y601 + (b - y601) * 0.15;
      }
      screen[at] = r;
      screen[at + 1] = g;
      screen[at + 2] = b;
    }
  };

  /** A field is over: the counter's count goes into its channel's register, and AUTO may act. */
  const endField = (dt: number, onset: boolean, sounding: boolean): void => {
    // GAIN by eye: the fields' widest lines, on average, against the size wanted; turned slowly,
    // as an owner would for a record. The first turn comes after a fifth of a second of music,
    // straight to about the right place; then a little quicker for the first seconds.
    if (sounding) {
      heard += dt;
      if (firstFields < FIRST_FIELDS) {
        firstSum += fieldSize;
        firstFields += 1;
        if (firstFields === FIRST_FIELDS) {
          const size = firstSum / FIRST_FIELDS;
          gain = Math.max(0.25, Math.min(4, gain * Math.max(0.25, Math.min(4, TARGET_STEPS / Math.max(size, 1)))));
          usualSize = TARGET_STEPS;
        }
      } else {
        usualSize += (fieldSize - usualSize) * (1 - Math.exp(-dt / (heard < 3 ? 0.5 : 3)));
        const error = Math.log(TARGET_STEPS / Math.max(usualSize, 1));
        gain = Math.max(0.25, Math.min(4, gain * Math.exp(error * (1 - Math.exp(-dt / (heard < 3 ? 1 : 6))))));
      }
    }
    fieldSize = 0;
    const counted = field % 2 === 0 ? left : right;
    const tap = tapOfCount(counted.crossings);
    if (field % 2 === 0) registerLeft = tap;
    else registerRight = tap;
    left.crossings = 0;
    right.crossings = 0;
    field += 1;
    if (settings.shape === "auto" || settings.autoAll) {
      sinceChange += dt;
      if ((sinceChange >= nextChange && onset) || sinceChange >= nextChange * 1.8) autoChange();
    }
  };

  return {
    width,
    height,
    aspect: 4 / 3,
    crt: "tv",
    render(frame: RetroFrame, image: PixelImage): void {
      const audio = frame.audio;
      if (audio.rate !== rate || !coefficients) {
        rate = audio.rate;
        coefficients = [coefficientsFor(rate, contourLeft), coefficientsFor(rate, contourRight)];
      }
      const [kLeft, kRight] = coefficients;
      const fresh = Math.min(audio.fresh, audio.left.length);
      const samplesPerLine = rate / LINE_RATE;
      const fieldSeconds = LINES_PER_FIELD / LINE_RATE;
      // The line out: the music of late brought to the manual's level (silence left alone).
      if (audio.sounding && fresh > 0) {
        let sum = 0;
        for (let index = audio.left.length - fresh; index < audio.left.length; index += 1) {
          const mono = 0.5 * (audio.left[index]! + audio.right[index]!);
          sum += mono * mono;
        }
        const recent = sum / fresh;
        meanSquare += (recent - meanSquare) * (1 - Math.exp(-frame.dt / (recent > meanSquare ? 1 : 4)));
      }
      const jackScale = Math.max(0.25, Math.min(40, NOMINAL_INPUT / Math.sqrt(Math.max(meanSquare, 1e-6))));
      const leftGain = gain * gainLeft;
      const rightGain = gain * gainRight;
      for (let index = audio.left.length - fresh; index < audio.left.length; index += 1) {
        left.step(audio.left[index]! * jackScale, leftGain, kLeft, bandGain);
        right.step(audio.right[index]! * jackScale, rightGain, kRight, bandGain);
        lineClock += 1;
        if (lineClock >= samplesPerLine) {
          lineClock -= samplesPerLine;
          drawLine(beamLine);
          beamLine += 1;
          if (beamLine >= LINES_PER_FIELD) {
            beamLine = 0;
            endField(fieldSeconds, audio.onset, audio.sounding);
          }
        }
      }
      image.data.set(screen);
    }
  };
}
