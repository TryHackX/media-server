import type { Listener } from "./listen";
import { BANDS, SAMPLES } from "./listen";
import type { Random } from "./random";
import { dot, line, lineShaded, plot, type Picture } from "./raster";

/**
 * Waves: the sound drawn into the picture each step, sharp and bright on top of the burning
 * trails. Scopes across or down, in stereo, as dots or as lightning; analyzers; rings, rays,
 * spirals, loops and arches. Our own set, after what the originals' screenshots and videos show.
 *
 * A wave draws into the part of the picture its display shows (`area`), so a mirrored display
 * gets a whole wave in its half; one about the centre of the screen comes out whole by mirroring.
 */

export type WaveKind =
  | "scope" | "scopeDots" | "stereo" | "stereoDots" | "vertical" | "lightning" | "analyzer" | "analyzerMirror"
  | "analyzerLine" | "ring" | "rings" | "lissajous" | "starburst" | "spiral" | "arches" | "sparks" | "fan"
  | "rose" | "ridges" | "cross" | "halo" | "ribbon" | "zigzag";

export const WAVE_KINDS: readonly WaveKind[] = [
  "scope", "scopeDots", "stereo", "stereoDots", "vertical", "lightning", "analyzer", "analyzerMirror",
  "analyzerLine", "ring", "rings", "lissajous", "starburst", "spiral", "arches", "sparks", "fan",
  "rose", "ridges", "cross", "halo", "ribbon", "zigzag"
];

/** Waves that draw the spectrum rather than the samples (an "analyzer" in Cthugha-4-Winamp). */
export const ANALYZER_WAVES: readonly WaveKind[] = ["analyzer", "analyzerMirror", "analyzerLine", "halo"];

export interface WaveArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WaveContext {
  picture: Picture;
  sound: Listener;
  random: Random;
  /** Seconds since the scene began; steps so far. */
  time: number;
  step: number;
  /** The palette's hottest value and the one to draw with now. */
  hot: number;
  /** "Wave scale": 1 as it comes, 2 twice as tall. */
  scale: number;
  area: WaveArea;
  /** Centre on the screen's middle (shapes that mirror into one) or the area's. */
  centred: boolean;
  /** What a wave keeps from step to step. */
  memory: Float32Array;
  /** Draw from the smoothed samples. */
  smooth: boolean;
  /** How far up the palette lines reach (1: to the hot end; less: coloured rather than white). */
  heat: number;
}

/** Room each wave may use in `memory`. */
export const WAVE_MEMORY = 16 * 160 + 16;

function centre(ctx: WaveContext): [number, number] {
  const { area, picture } = ctx;
  return ctx.centred
    ? [Math.min(area.x1 - 1, picture.width / 2), Math.min(area.y1 - 1, picture.height / 2)]
    : [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2];
}

/** A value for a sample of size `amount` (0–1): hot at the loud end, cooler for quiet ones. */
function shade(ctx: WaveContext, amount: number): number {
  const top = ctx.hot * ctx.heat;
  return Math.max(24, Math.min(255, Math.round(top - 70 + Math.min(1, amount) * 70)));
}

/** `count` samples of a channel, spread evenly over the newest `span`. */
function sampleAt(samples: Float32Array, k: number, count: number, span: number): number {
  const index = SAMPLES - span + Math.floor((k * span) / count);
  return samples[Math.min(SAMPLES - 1, Math.max(0, index))]!;
}

function scope(ctx: WaveContext, samples: Float32Array, y: number, amplitude: number, dots: boolean): void {
  const { area, picture } = ctx;
  const width = area.x1 - area.x0;
  const count = Math.min(width, 640);
  const span = Math.min(SAMPLES, Math.round(count * 1.1));
  let px = area.x0;
  let py = y + sampleAt(samples, 0, count, span) * amplitude;
  for (let k = 1; k < count; k += 1) {
    const s = sampleAt(samples, k, count, span);
    const x = area.x0 + (k * width) / count;
    const sy = y + s * amplitude;
    if (dots) plot(picture, x, sy, shade(ctx, Math.abs(s) * 1.5 + 0.3));
    else line(picture, px, py, x, sy, shade(ctx, Math.abs(s) * 1.5 + 0.35));
    px = x;
    py = sy;
  }
}

function verticalScope(ctx: WaveContext, samples: Float32Array, x: number, amplitude: number): void {
  const { area, picture } = ctx;
  const height = area.y1 - area.y0;
  const count = Math.min(height, 480);
  const span = Math.min(SAMPLES, count);
  let px = x + sampleAt(samples, 0, count, span) * amplitude;
  let py = area.y0;
  for (let k = 1; k < count; k += 1) {
    const s = sampleAt(samples, k, count, span);
    const y = area.y0 + (k * height) / count;
    const sx = x + s * amplitude;
    line(picture, px, py, sx, y, shade(ctx, Math.abs(s) * 1.5 + 0.35));
    px = sx;
    py = y;
  }
}

/** A closed loop about (cx, cy): radius `r` swelled by the samples. */
function ring(ctx: WaveContext, samples: Float32Array, cx: number, cy: number, r: number, amplitude: number, spin: number): void {
  const count = 180;
  const span = 720;
  let fx = 0;
  let fy = 0;
  let px = 0;
  let py = 0;
  for (let k = 0; k <= count; k += 1) {
    // The loop closes on its first sample, so it has no seam.
    const s = sampleAt(samples, k % count, count, span);
    const angle = spin + (2 * Math.PI * k) / count;
    const radius = Math.max(2, r + s * amplitude);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (k === 0) {
      fx = x;
      fy = y;
    } else {
      line(ctx.picture, px, py, k === count ? fx : x, k === count ? fy : y, shade(ctx, Math.abs(s) * 1.6 + 0.4));
    }
    px = x;
    py = y;
  }
}

export function drawWave(kind: WaveKind, ctx: WaveContext): void {
  const { area, picture, memory } = ctx;
  // The samples as the effect hears them: raw, or through the smoothing.
  const sound = ctx.smooth
    ? { left: ctx.sound.smoothLeft, right: ctx.sound.smoothRight, mono: ctx.sound.smoothMono, bands: ctx.sound.bands, level: ctx.sound.level, beat: ctx.sound.beat }
    : ctx.sound;
  const width = area.x1 - area.x0;
  const height = area.y1 - area.y0;
  const size = Math.min(width, height);
  const scale = ctx.scale;
  const [cx, cy] = centre(ctx);
  switch (kind) {
    case "scope":
    case "scopeDots":
      scope(ctx, sound.mono, (area.y0 + area.y1) / 2, height * 0.32 * scale, kind === "scopeDots");
      break;
    case "stereo":
    case "stereoDots":
      scope(ctx, sound.left, area.y0 + height / 3, height * 0.2 * scale, kind === "stereoDots");
      scope(ctx, sound.right, area.y0 + (2 * height) / 3, height * 0.2 * scale, kind === "stereoDots");
      break;
    case "vertical":
      verticalScope(ctx, sound.left, area.x0 + width / 3, width * 0.18 * scale);
      verticalScope(ctx, sound.right, area.x0 + (2 * width) / 3, width * 0.18 * scale);
      break;
    case "zigzag": {
      // A sample held across a few pixels: the blocky scope of a coarse input.
      const y = (area.y0 + area.y1) / 2;
      const hold = 6;
      let px = area.x0;
      let py = y;
      for (let x = area.x0; x < area.x1; x += hold) {
        const s = sampleAt(sound.mono, x - area.x0, width, Math.min(SAMPLES, width * 2));
        const sy = y + s * height * 0.35 * scale;
        line(picture, px, py, x, sy, shade(ctx, Math.abs(s) * 2 + 0.3));
        line(picture, x, sy, x + hold, sy, shade(ctx, Math.abs(s) * 2 + 0.3));
        px = x + hold;
        py = sy;
      }
      break;
    }
    case "lightning": {
      // Lines from the middle out to each sample: a wave filled in, the flame's favourite fuel.
      const y = (area.y0 + area.y1) / 2;
      const count = Math.floor(width / 3);
      for (let k = 0; k < count; k += 1) {
        const s = sampleAt(sound.mono, k, count, Math.min(SAMPLES, count * 3));
        const x = area.x0 + k * 3;
        lineShaded(picture, x, y, x, y + s * height * 0.4 * scale, ctx.hot * 0.7, shade(ctx, Math.abs(s) * 2 + 0.3));
      }
      break;
    }
    case "analyzer":
    case "analyzerMirror": {
      const mirror = kind === "analyzerMirror";
      const bar = width / BANDS;
      const base = mirror ? (area.y0 + area.y1) / 2 : area.y1 - 1;
      for (let band = 0; band < BANDS; band += 1) {
        const value = Math.min(1, sound.bands[band]! * scale * 0.9);
        const tall = value * height * (mirror ? 0.22 : 0.45);
        const x0 = area.x0 + band * bar;
        // Bars with gaps between them, every other column lit: the burning keeps them apart.
        for (let x = Math.floor(x0); x < Math.floor(x0 + bar) - (bar > 4 ? 2 : 0); x += 2) {
          // Dim at the foot, bright at the tip: the flame carries the tips up like sparks.
          lineShaded(picture, x, base, x, base - tall, ctx.hot * 0.12, shade(ctx, value));
          if (mirror) lineShaded(picture, x, base, x, base + tall, ctx.hot * 0.12, shade(ctx, value));
        }
      }
      break;
    }
    case "analyzerLine": {
      const base = area.y1 - height * 0.12;
      let px = area.x0;
      let py = base;
      for (let band = 0; band <= BANDS; band += 1) {
        const value = sound.bands[Math.min(BANDS - 1, band)]!;
        const x = area.x0 + (band * width) / BANDS;
        const y = base - Math.min(1, value * scale) * height * 0.7;
        line(picture, px, py, x, y, shade(ctx, value));
        px = x;
        py = y;
      }
      break;
    }
    case "halo": {
      // The spectrum round a circle: a spiky crown that pulses with the bass.
      const r0 = size * (0.16 + 0.06 * sound.level);
      const spin = ctx.time * 0.4;
      for (let k = 0; k < BANDS * 2; k += 1) {
        const band = k < BANDS ? k : BANDS * 2 - 1 - k;
        const value = Math.min(1, sound.bands[band]! * scale);
        const angle = spin + (Math.PI * k) / BANDS;
        const r1 = r0 + value * size * 0.3;
        lineShaded(picture, cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0, cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1, ctx.hot * 0.5, shade(ctx, value));
      }
      break;
    }
    case "ring":
      ring(ctx, sound.mono, cx, cy, size * (0.22 + 0.08 * sound.level), size * 0.18 * scale, ctx.time * 0.5);
      break;
    case "rings": {
      const r = size * (0.14 + 0.05 * sound.level);
      ring(ctx, sound.left, area.x0 + width * 0.3, cy, r, size * 0.12 * scale, ctx.time * 0.7);
      ring(ctx, sound.right, area.x0 + width * 0.7, cy, r, size * 0.12 * scale, -ctx.time * 0.7);
      break;
    }
    case "lissajous": {
      // Left against right, turned 45°: a mono sound is a line, stereo opens it into loops.
      const count = 512;
      const amplitude = size * 0.42 * scale;
      let px = cx;
      let py = cy;
      for (let k = 0; k < count; k += 1) {
        const index = SAMPLES - count + k;
        const l = sound.left[index]!;
        const r = sound.right[index]!;
        const x = cx + (l - r) * amplitude * 0.9;
        const y = cy - (l + r) * amplitude * 0.5;
        if (k) line(picture, px, py, x, y, shade(ctx, Math.abs(l) + Math.abs(r)));
        px = x;
        py = y;
      }
      break;
    }
    case "starburst": {
      const spokes = 96;
      const spin = (memory[0] = (memory[0]! + 0.01 + sound.level * 0.03) % (2 * Math.PI));
      const inner = size * 0.04;
      for (let k = 0; k < spokes; k += 1) {
        const s = sampleAt(sound.mono, k, spokes, 512);
        const angle = spin + (2 * Math.PI * k) / spokes;
        const length = inner + Math.abs(s) * size * 0.75 * scale;
        lineShaded(picture, cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner, cx + Math.cos(angle) * length, cy + Math.sin(angle) * length, ctx.hot * 0.6, shade(ctx, Math.abs(s) * 2));
      }
      break;
    }
    case "spiral": {
      const count = 400;
      const turns = 3.5;
      const spin = ctx.time * 0.8;
      let px = cx;
      let py = cy;
      for (let k = 0; k < count; k += 1) {
        const t = k / count;
        const s = sampleAt(sound.mono, k, count, 800);
        const angle = spin + t * turns * 2 * Math.PI;
        const radius = t * size * 0.46 + s * size * 0.08 * scale;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (k) line(picture, px, py, x, y, shade(ctx, Math.abs(s) * 1.5 + t * 0.5));
        px = x;
        py = y;
      }
      break;
    }
    case "arches": {
      // An arch over the area that rises with the music: with slow trails, a bundle of arcs.
      const count = 160;
      const base = area.y1 - 2;
      const rise = height * (0.25 + Math.min(0.6, sound.level * 0.9)) * scale;
      let px = area.x0;
      let py = base;
      for (let k = 1; k <= count; k += 1) {
        const t = k / count;
        const s = sampleAt(sound.mono, k, count, 640);
        const x = area.x0 + t * width;
        const y = base - Math.sin(Math.PI * t) * (rise + s * height * 0.08);
        line(picture, px, py, x, y, shade(ctx, 0.6 + Math.abs(s)));
        px = x;
        py = y;
      }
      break;
    }
    case "sparks": {
      // Embers thrown out of a wandering point, more of them and further on a kick.
      const ox = cx + Math.sin(ctx.time * 0.7) * width * 0.25;
      const oy = cy + Math.cos(ctx.time * 0.53) * height * 0.25;
      const count = 90 + Math.round(sound.level * 260 + sound.beat * 300);
      for (let k = 0; k < count; k += 1) {
        const angle = ctx.random() * 2 * Math.PI;
        const distance = Math.pow(ctx.random(), 0.6) * size * (0.12 + sound.level * 0.55 + sound.beat * 0.3) * scale;
        dot(picture, ox + Math.cos(angle) * distance, oy + Math.sin(angle) * distance, shade(ctx, 1.2 - distance / size), ctx.random() < 0.35 ? 2 : 1);
      }
      break;
    }
    case "fan": {
      // Rays from the side of the area to the wave on the far side: a fan that shivers.
      const count = 36;
      const ox = area.x0;
      const oy = area.y0 + height * 0.5;
      for (let k = 0; k < count; k += 1) {
        const s = sampleAt(sound.mono, k, count, 600);
        const t = k / (count - 1);
        const ty = area.y0 + t * height + s * height * 0.25 * scale;
        lineShaded(picture, ox, oy, area.x1 - 1, ty, ctx.hot * 0.25, shade(ctx, Math.abs(s) * 2 + 0.3));
      }
      break;
    }
    case "rose": {
      // A rose curve whose petals breathe with the samples.
      const count = 600;
      const petals = 3 + (Math.floor(ctx.time / 8) % 4);
      const spin = ctx.time * 0.3;
      let px = 0;
      let py = 0;
      for (let k = 0; k <= count; k += 1) {
        const t = (k / count) * 2 * Math.PI;
        const s = sampleAt(sound.mono, k % count, count, 900);
        const radius = size * 0.45 * (Math.cos(petals * t) * (0.75 + s * 0.6 * scale));
        const x = cx + Math.cos(t + spin) * radius;
        const y = cy + Math.sin(t + spin) * radius;
        if (k) line(picture, px, py, x, y, shade(ctx, Math.abs(s) * 2 + 0.3));
        px = x;
        py = y;
      }
      break;
    }
    case "ridges": {
      // The scope's last sixteen shapes in perspective, the newest in front: a range of hills.
      const rows = 16;
      const count = 160;
      const head = Math.floor(memory[0]!) % rows;
      const next = (head + 1) % rows;
      memory[0] = next;
      for (let k = 0; k < count; k += 1) memory[16 + next * count + k] = sampleAt(sound.mono, k, count, 640);
      for (let back = rows - 1; back >= 0; back -= 1) {
        const row = (next - back + rows) % rows;
        const depth = 1 + back * 0.18;
        const y = area.y0 + height * (0.82 - back * 0.035) ;
        const half = (width * 0.45) / depth;
        let px = 0;
        let py = 0;
        for (let k = 0; k < count; k += 1) {
          const x = cx + (k / (count - 1) - 0.5) * 2 * half;
          const s = memory[16 + row * count + k]!;
          const sy = y - (Math.abs(s) * height * 0.35 * scale) / depth;
          if (k) line(picture, px, py, x, sy, Math.round(ctx.hot * (1 - back / (rows + 4))));
          px = x;
          py = sy;
        }
      }
      break;
    }
    case "cross": {
      scope(ctx, sound.left, cy, height * 0.22 * scale, false);
      verticalScope(ctx, sound.right, cx, width * 0.18 * scale);
      break;
    }
    case "ribbon": {
      // Left and right twisted round each other, joined by rungs.
      const count = 120;
      const y = (area.y0 + area.y1) / 2;
      const twist = ctx.time * 2;
      for (let k = 0; k < count; k += 1) {
        const x = area.x0 + (k / (count - 1)) * width;
        const a = Math.sin(k * 0.09 + twist);
        const l = sampleAt(sound.left, k, count, 480);
        const r = sampleAt(sound.right, k, count, 480);
        const y1 = y + a * height * 0.18 + l * height * 0.15 * scale;
        const y2 = y - a * height * 0.18 + r * height * 0.15 * scale;
        if (k % 3 === 0) lineShaded(picture, x, y1, x, y2, ctx.hot * 0.45, shade(ctx, 0.5 + Math.abs(l)));
        plot(picture, x, y1, ctx.hot);
        plot(picture, x, y2, ctx.hot);
      }
      break;
    }
  }
}
