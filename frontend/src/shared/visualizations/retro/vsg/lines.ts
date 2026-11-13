import { follow, HEIGHT, WIDTH, type VsgEffect, type VsgInput } from "./listen";
import type { Raster } from "./raster";

/**
 * The line and circle figures of VSG+: strings, moiré, tunnel, circle scope and Lissajous (all
 * five in fomalhaut's screenshot, drawn to match it), phase loops and sine waves (by their names).
 */

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Phase loops: six octaves of the music, each plotted against itself a quarter of its period
 * earlier. A steady tone draws a circle; music swells, fades and drifts, and draws coils and
 * spirals instead — six of them nested, the bass outermost, each turning its own way.
 */
export function phaseLoops(): VsgEffect {
  const PERIODS = 3.5;
  const Q = 6.5;
  const loops = [
    { hz: 70, color: 12, glow: 4, reach: 226 },
    { hz: 140, color: 14, glow: 6, reach: 184 },
    { hz: 280, color: 10, glow: 2, reach: 146 },
    { hz: 560, color: 11, glow: 3, reach: 110 },
    { hz: 1120, color: 9, glow: 1, reach: 78 },
    { hz: 2240, color: 13, glow: 5, reach: 50 }
  ].map((loop, index) => ({ ...loop, turn: index * 1.3, size: 0.05, way: index % 2 ? -1 : 1 }));
  let filtered = new Float32Array(0);
  return {
    tick(input: VsgInput): void {
      for (const loop of loops) loop.turn += input.dt * loop.way * (0.15 + 0.9 * input.level + 1.2 * input.beat);
    },
    draw(screen: Raster, input: VsgInput): void {
      const samples = input.audio.mono;
      const rate = input.audio.rate;
      for (const loop of loops) {
        // A band-pass run over the newest periods, after a few more to settle.
        const period = rate / loop.hz;
        const quarter = Math.round(period / 4);
        const span = Math.round(period * PERIODS);
        const total = Math.min(samples.length, span + quarter + Math.round(period * 6));
        if (filtered.length < total) filtered = new Float32Array(total);
        const omega = (2 * Math.PI * loop.hz) / rate;
        const alpha = Math.sin(omega) / (2 * Q);
        const a0 = 1 + alpha;
        const b0 = alpha / a0;
        const a1 = (-2 * Math.cos(omega)) / a0;
        const a2 = (1 - alpha) / a0;
        // Twice over, so what lies outside the band does not ripple the loops.
        let x1 = 0;
        let x2 = 0;
        let y1 = 0;
        let y2 = 0;
        let z1 = 0;
        let z2 = 0;
        const first = samples.length - total;
        for (let index = 0; index < total; index += 1) {
          const x = samples[first + index]!;
          const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = x;
          const z = b0 * (y - y2) - a1 * z1 - a2 * z2;
          y2 = y1;
          y1 = y;
          z2 = z1;
          z1 = z;
          filtered[index] = z;
        }
        const step = Math.max(1, Math.round(period / 48));
        const from = total - span;
        let sum = 0;
        let points = 0;
        for (let index = from; index < total; index += step) {
          sum += Math.hypot(filtered[index]!, filtered[index - quarter]!);
          points += 1;
        }
        // Scaled to its mean radius of late, so a loop keeps its place and its swells reach past it.
        loop.size = follow(loop.size, Math.max((sum / Math.max(1, points)) * 1.2, 0.002), input.dt, 0.08, 0.8);
        const scale = loop.reach / loop.size;
        const cos = Math.cos(loop.turn) * scale;
        const sin = Math.sin(loop.turn) * scale;
        let previousX = 0;
        let previousY = 0;
        for (let index = from; index < total; index += step) {
          const u = filtered[index]!;
          const v = filtered[index - quarter]!;
          const x = 320 + u * cos - v * sin;
          const y = 240 + (u * sin + v * cos) * 0.92;
          // The oldest period in the dark of the colour, the rest bright.
          if (index > from) screen.line(previousX, previousY, x, y, index - from < period ? loop.glow : loop.color);
          previousX = x;
          previousY = y;
        }
      }
    }
  };
}

/**
 * Strings: from each corner of the screen a string to a point that sweeps about with the music;
 * the last twelve places of the point stay strung, three to a colour, so the strings fan out
 * behind it in white, light magenta, light red and yellow, as in fomalhaut's picture.
 */
export function strings(random: () => number): VsgEffect {
  const HUBS = 12;
  const hubX = new Float32Array(HUBS);
  const hubY = new Float32Array(HUBS);
  const hubColor = new Uint8Array(HUBS);
  const cycle = [14, 12, 13, 15];
  let newest = -1;
  let count = 0;
  let serial = 0;
  let ticks = 0;
  let phaseX = random() * 6.28;
  let phaseY = random() * 6.28;
  return {
    tick(input: VsgInput): void {
      phaseX += input.dt * (0.3 + 1.4 * input.level + 1.6 * input.beat);
      phaseY += input.dt * (0.39 + 1.1 * input.level + 1.2 * input.beat);
      ticks += 1;
      if (ticks % 2) return;
      const reach = 0.7 + 0.3 * input.bass;
      newest = (newest + 1) % HUBS;
      hubX[newest] = 320 + 318 * reach * Math.sin(phaseX);
      hubY[newest] = 240 + 238 * reach * Math.sin(phaseY);
      hubColor[newest] = cycle[Math.floor(serial / 3) % cycle.length]!;
      serial += 1;
      count = Math.min(HUBS, count + 1);
    },
    draw(screen: Raster): void {
      for (let back = count - 1; back >= 0; back -= 1) {
        const at = (newest - back + HUBS) % HUBS;
        const x = hubX[at]!;
        const y = hubY[at]!;
        const color = hubColor[at]!;
        screen.line(0, 0, x, y, color);
        screen.line(WIDTH - 1, 0, x, y, color);
        screen.line(0, HEIGHT - 1, x, y, color);
        screen.line(WIDTH - 1, HEIGHT - 1, x, y, color);
      }
    }
  };
}

/**
 * Sine waves: eight waves across the screen, one to each pair of bands — the bass slow and wide,
 * the treble quick and fine — each as tall as its band is loud, drifting left and right in turn.
 */
export function sineWaves(): VsgEffect {
  const WAVES = 8;
  const heights = new Float32Array(WAVES);
  const phases = new Float64Array(WAVES);
  const colors = [12, 14, 10, 11, 9, 13, 7, 15];
  const cycles = [1, 1.5, 2, 2.5, 3, 4, 5, 6.5];
  return {
    tick(input: VsgInput): void {
      for (let wave = 0; wave < WAVES; wave += 1) {
        const band = (input.bands[wave * 2]! + input.bands[wave * 2 + 1]!) / 2;
        heights[wave] = follow(heights[wave]!, 10 + 205 * band * band + 30 * input.beat * (wave < 2 ? 1 : 0), input.dt, 0.03, 0.3);
        const way = wave % 2 ? -1 : 1;
        phases[wave] = phases[wave]! + input.dt * way * (0.7 + 0.22 * wave) * (0.5 + 2.2 * input.level);
      }
    },
    draw(screen: Raster): void {
      for (let wave = WAVES - 1; wave >= 0; wave -= 1) {
        const height = heights[wave]!;
        const frequency = (2 * Math.PI * cycles[wave]!) / WIDTH;
        const phase = phases[wave]!;
        let previousY = 240 - height * Math.sin(phase);
        for (let x = 4; x <= WIDTH + 3; x += 4) {
          const y = 240 - height * Math.sin(x * frequency + phase);
          screen.line(x - 4, previousY, x, y, colors[wave]!);
          previousY = y;
        }
      }
    }
  };
}

/**
 * Circle scope: the waveform wound three times round a circle in yellow, the radius swinging
 * with the samples — the ragged ring of fomalhaut's picture.
 */
export function circleScope(): VsgEffect {
  const LAP = 256;
  const LAPS = 3;
  const STEP = 2;
  return {
    draw(screen: Raster, input: VsgInput): void {
      const samples = input.audio.mono;
      const count = LAP * LAPS;
      const start = samples.length - count * STEP;
      const middle = 126 + 14 * input.bass;
      const swing = 78;
      let previousX = 0;
      let previousY = 0;
      for (let index = 0; index <= count; index += 1) {
        const value = clamp(samples[Math.min(samples.length - 1, start + index * STEP)]! * input.gain, -1.5, 1.5);
        const angle = (2 * Math.PI * index) / LAP - Math.PI / 2;
        const radius = middle + swing * value;
        const x = 320 + radius * Math.cos(angle);
        const y = 240 + radius * Math.sin(angle);
        if (index > 0) screen.line(previousX, previousY, x, y, 14);
        previousX = x;
        previousY = y;
      }
    }
  };
}

/**
 * Lissajous: a 3 : 2 figure over the whole screen turning as if in space, the music driving the
 * turn; the figure of the last few ticks stays beside it, light cyan and white as in fomalhaut's
 * picture. On a kick, after a while, the ratio changes.
 */
export function lissajous(): VsgEffect {
  const ratios: readonly (readonly [number, number])[] = [[3, 2], [3, 4], [5, 4], [2, 1], [5, 3], [4, 3], [1, 2], [3, 5]];
  const POINTS = 640;
  const TRAIL = 3;
  const phases = new Float64Array(TRAIL);
  const colors = [11, 15, 11];
  let phase = 0.9;
  let newest = 0;
  let ratio = 0;
  let since = 0;
  phases.fill(phase);
  return {
    tick(input: VsgInput): void {
      phase += input.dt * (0.3 + 1.5 * input.level + 1.4 * input.beat);
      newest = (newest + 1) % TRAIL;
      phases[newest] = phase;
      since += input.dt;
      if ((since > 9 && input.onset) || since > 20) {
        ratio = (ratio + 1) % ratios.length;
        since = 0;
      }
    },
    draw(screen: Raster): void {
      const [a, b] = ratios[ratio]!;
      for (let back = TRAIL - 1; back >= 0; back -= 1) {
        const shift = phases[(newest - back + TRAIL) % TRAIL]!;
        const color = colors[TRAIL - 1 - back]!;
        let previousX = 320 + 288 * Math.sin(shift);
        let previousY = 240;
        for (let index = 1; index <= POINTS; index += 1) {
          const u = (2 * Math.PI * index) / POINTS;
          const x = 320 + 288 * Math.sin(a * u + shift);
          const y = 240 + 222 * Math.sin(b * u);
          screen.line(previousX, previousY, x, y, color);
          previousX = x;
          previousY = y;
        }
      }
    }
  };
}

/**
 * Moiré: two sets of rings eight pixels apart, light blue and light red, round two centres that
 * keep apart and turn about each other with the music; the rings flow outward with the bass and
 * each set reaches as far as its channel is loud. Where they cross, the moiré of fomalhaut's
 * picture.
 */
export function moire(): VsgEffect {
  let orbit = 2.4;
  let wander = 0;
  let ripple = 0;
  let reachLeft = 420;
  let reachRight = 420;
  return {
    tick(input: VsgInput): void {
      orbit += input.dt * (0.12 + 0.5 * input.level + 0.9 * input.beat);
      wander += input.dt * (0.2 + 0.3 * input.level);
      ripple = (ripple + input.dt * (4 + 26 * input.bass)) % 8;
      reachLeft = follow(reachLeft, 250 + 320 * input.levelLeft, input.dt, 0.08, 0.8);
      reachRight = follow(reachRight, 250 + 320 * input.levelRight, input.dt, 0.08, 0.8);
    },
    draw(screen: Raster): void {
      const middleX = 300 + 50 * Math.sin(wander * 0.9);
      const middleY = 240 + 36 * Math.sin(wander * 0.7 + 1);
      const apart = 150 + 40 * Math.sin(wander * 0.5 + 2);
      const redX = middleX + apart * Math.cos(orbit);
      const redY = middleY + apart * 0.75 * Math.sin(orbit);
      const blueX = middleX - apart * Math.cos(orbit);
      const blueY = middleY - apart * 0.75 * Math.sin(orbit);
      for (let radius = ripple; radius <= reachRight; radius += 8) screen.circle(blueX, blueY, radius, 9);
      for (let radius = ripple; radius <= reachLeft; radius += 8) screen.circle(redX, redY, radius, 12);
    }
  };
}

/**
 * Tunnel: some fourteen rectangles of the screen's shape, two pixels wide, each a colour of its
 * own (1 to 14 in turn), flying out of the middle; their size grows with the square of their
 * nearness, which is how the rings of fomalhaut's picture are spaced. The music sets the speed,
 * and the far end sways a little.
 */
export function tunnel(): VsgEffect {
  const STEP = 1.25;
  const NEAREST = 18.6;
  let depth = 0;
  let sway = 0;
  return {
    tick(input: VsgInput): void {
      depth += input.dt * (0.8 + 3 * input.level + 2.5 * input.beat);
      sway += input.dt * (0.25 + 0.5 * input.level);
    },
    draw(screen: Raster): void {
      const middleX = 326 + 12 * Math.sin(sway * 1.3);
      const middleY = 240 + 8 * Math.sin(sway * 0.9 + 1);
      const bendX = 24 * Math.sin(sway * 0.7 + 2);
      const bendY = 16 * Math.sin(sway * 0.5);
      const newest = Math.floor(depth);
      // Far rings first, so the near ones are drawn over them.
      for (let serial = newest; ; serial -= 1) {
        const root = (depth - serial) * STEP;
        if (root > NEAREST) break;
        if (root <= 0) continue;
        const halfWidth = root * root;
        const halfHeight = halfWidth * 0.75;
        // The far end bends away: a ring's centre moves with how far off it is.
        const farness = (1 - root / NEAREST) ** 2;
        const x = middleX + bendX * farness;
        const y = middleY + bendY * farness;
        const color = 1 + ((((-serial) % 14) + 14) % 14);
        screen.box(x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight, color);
        if (halfWidth >= 3) screen.box(x - halfWidth + 1, y - halfHeight + 1, x + halfWidth - 1, y + halfHeight - 1, color);
      }
    }
  };
}
