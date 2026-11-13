import { follow, HEIGHT, trigger, WIDTH, type VsgEffect, type VsgInput } from "./listen";
import type { Raster } from "./raster";

/**
 * VSG's own six effects — two circles, bars, two traces, scope, rolling circles and crosshair —
 * which fomalhaut rebuilt from VSG's code and coloured. Neither VSG's code nor a picture of these
 * six is public, only their names, so each is drawn here from its name in the program's manner:
 * CIRCLE, LINE and PSET in the VGA's sixteen colours, straight from the samples.
 */

/** The dark and the bright of one hue, as the EGA pairs them (blue 1 and 9, and so on). */
const PAIRS: readonly (readonly [number, number])[] = [[1, 9], [3, 11], [2, 10], [6, 14], [4, 12], [5, 13]];

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** A trace of `count` points from `samples` (times `gain`) into `out`, every `step`-th one from `start`. */
function read(samples: Float32Array, start: number, count: number, step: number, gain: number, out: Float32Array): void {
  for (let index = 0; index < count; index += 1) out[index] = clamp(samples[start + index * step]! * gain, -1.2, 1.2);
}

/**
 * Two circles: two sources of rings, the left channel's warm, the right's cold. Each sends out a
 * ring every few ticks, as wide and as bright as its channel is loud at that moment; the rings
 * run outward the faster the louder it plays and darken as they go, so the music's swells travel
 * out across the screen as bands of brighter, wider-spaced rings.
 */
export function twoCircles(): VsgEffect {
  interface Ring { radius: number; color: number; dark: number; }
  const sources = [
    { rings: [] as Ring[], ramp: [[4, 8], [12, 4], [12, 4], [14, 6], [15, 7]] },
    { rings: [] as Ring[], ramp: [[1, 8], [9, 1], [11, 3], [11, 3], [15, 7]] }
  ];
  let ticks = 0;
  return {
    tick(input: VsgInput): void {
      ticks += 1;
      const speed = 1.8 + 5 * input.level + 4 * input.beat;
      for (const [index, source] of sources.entries()) {
        for (const ring of source.rings) ring.radius += speed;
        while (source.rings.length && source.rings[0]!.radius > 350) source.rings.shift();
        if (ticks % 5) continue;
        const level = Math.min(1, (index === 0 ? input.levelLeft : input.levelRight) + input.beat * 0.3);
        const [color, dark] = source.ramp[Math.min(4, Math.floor(level * 5))]!;
        source.rings.push({ radius: 6 + 40 * level, color: color!, dark: dark! });
      }
    },
    draw(screen: Raster, input: VsgInput): void {
      const time = input.time;
      const centres = [
        [212 + 28 * Math.sin(time * 0.31), 240 + 36 * Math.sin(time * 0.23 + 1)],
        [428 + 28 * Math.sin(time * 0.27 + 2), 240 + 36 * Math.sin(time * 0.19 + 4)]
      ];
      for (const [index, source] of sources.entries()) {
        const [x, y] = centres[index]!;
        // The widest (oldest) rings first; past 200 pixels a ring has darkened.
        for (const ring of source.rings) screen.circle(x!, y!, ring.radius, ring.radius > 200 ? ring.dark : ring.color);
      }
    }
  };
}

/**
 * Bars: the waveform as 64 bars standing on the middle line, up for the positive half, down for
 * the negative, each outlined in the bright and filled with the dark of a hue that climbs with
 * its height; a grey cap above and below each marks how far it swung lately.
 */
export function bars(): VsgEffect {
  const COUNT = 64;
  const BLOCK = 12;
  const values = new Float32Array(COUNT);
  const caps = new Float32Array(COUNT);
  let reach = 0.2;
  return {
    tick(input: VsgInput): void {
      for (let bar = 0; bar < COUNT; bar += 1) caps[bar] = Math.max(0, caps[bar]! - 0.8 * input.dt);
    },
    draw(screen: Raster, input: VsgInput): void {
      const samples = input.audio.mono;
      const start = trigger(samples, COUNT * BLOCK, 2400, 0.1 / input.gain);
      let widest = 0;
      for (let bar = 0; bar < COUNT; bar += 1) {
        let sum = 0;
        for (let index = 0; index < BLOCK; index += 1) sum += samples[start + bar * BLOCK + index]!;
        values[bar] = sum / BLOCK;
        widest = Math.max(widest, Math.abs(sum / BLOCK));
      }
      // The bars' own level: what they swung lately reaches nearly to the edge.
      reach = follow(reach, Math.max(widest, 0.004), input.dt, 0.02, 0.8);
      for (let x = 0; x < WIDTH; x += 4) screen.pset(x, 240, 8);
      for (let bar = 0; bar < COUNT; bar += 1) {
        const value = clamp((values[bar]! * 0.92) / reach, -1, 1);
        caps[bar] = Math.max(caps[bar]!, Math.abs(value));
        const left = bar * 10 + 1;
        const cap = Math.round(caps[bar]! * 226) + 3;
        screen.hline(left, left + 7, 240 - cap, 7);
        screen.hline(left, left + 7, 240 + cap, 7);
        const height = Math.round(value * 226);
        if (height === 0) continue;
        const [dark, bright] = PAIRS[Math.min(4, Math.floor(Math.abs(value) * 5))]!;
        screen.fillBox(left + 1, 240 - Math.sign(height), left + 6, 240 - height + Math.sign(height), dark);
        screen.box(left, 240, left + 7, 240 - height, bright);
      }
    }
  };
}

/**
 * Two traces: the left channel above, the right below, each a scope trace with the two before it
 * still glowing on the screen in darker colours.
 */
export function twoTraces(): VsgEffect {
  const POINTS = 320;
  const STEP = 3;
  const AGES = 3;
  const traces = [0, 1].map(() => Array.from({ length: AGES }, () => new Float32Array(POINTS)));
  const colors = [[10, 2, 8], [11, 3, 8]];
  let filled = 0;
  const capture = (input: VsgInput, target: Float32Array[]): void => {
    const start = trigger(input.audio.mono, POINTS * STEP, 2400, 0.1 / input.gain);
    read(input.audio.left, start, POINTS, STEP, input.gain, target[0]!);
    read(input.audio.right, start, POINTS, STEP, input.gain, target[1]!);
  };
  const now = [new Float32Array(POINTS), new Float32Array(POINTS)];
  return {
    tick(input: VsgInput): void {
      // The traces of the last two ticks stay on screen, darker.
      for (const channel of traces) channel.unshift(channel.pop()!);
      capture(input, [traces[0]![0]!, traces[1]![0]!]);
      filled = Math.min(AGES, filled + 1);
    },
    draw(screen: Raster, input: VsgInput): void {
      for (let x = 0; x < WIDTH; x += 8) {
        screen.pset(x, 120, 8);
        screen.pset(x, 360, 8);
      }
      for (let x = 0; x < WIDTH; x += 16) screen.hline(x, x + 7, 240, 8);
      capture(input, now);
      for (let channel = 0; channel < 2; channel += 1) {
        const middle = channel === 0 ? 120 : 360;
        for (let age = Math.max(1, Math.min(filled, AGES)) - 1; age >= 0; age -= 1) {
          const trace = age === 0 ? now[channel]! : traces[channel]![age]!;
          const color = colors[channel]![age]!;
          let previousX = 0;
          let previousY = middle - trace[0]! * 104;
          for (let index = 1; index < POINTS; index += 1) {
            const x = (index * (WIDTH - 1)) / (POINTS - 1);
            const y = middle - trace[index]! * 104;
            screen.line(previousX, previousY, x, y, color);
            previousX = x;
            previousY = y;
          }
        }
      }
    }
  };
}

/**
 * Scope: one trace over the whole screen on a dotted graticule, two samples to a pixel, each
 * stretch coloured by how far it swings — blue near the line, through cyan, green and yellow to
 * red and white at the top.
 */
export function scope(): VsgEffect {
  const SPAN = 1280;
  const ramp = [9, 11, 10, 14, 12, 15];
  let reach = 0.3;
  return {
    draw(screen: Raster, input: VsgInput): void {
      for (let x = 0; x < WIDTH; x += 64) for (let y = 0; y < HEIGHT; y += 4) screen.pset(x, y, 8);
      for (let y = 0; y < HEIGHT; y += 60) for (let x = 0; x < WIDTH; x += 4) screen.pset(x, y, 8);
      screen.vline(WIDTH - 1, 0, HEIGHT - 1, 8);
      screen.hline(0, WIDTH - 1, HEIGHT - 1, 8);
      for (let x = 0; x < WIDTH; x += 2) screen.pset(x, 240, 7);
      for (let y = 0; y < HEIGHT; y += 2) screen.pset(320, y, 7);
      const samples = input.audio.mono;
      const start = trigger(samples, SPAN, 2400, 0.1 / input.gain);
      // Ranged like a scope set to the music: its swings of late nearly fill the screen.
      let widest = 0;
      for (let index = 0; index < SPAN; index += 1) widest = Math.max(widest, Math.abs(samples[start + index]!));
      reach = follow(reach, Math.max(widest, 0.003), input.dt, 0.02, 0.8);
      const gain = 0.92 / reach;
      let previousY = 240 - clamp(samples[start]! * gain, -1.05, 1.05) * 228;
      for (let index = 1; index < SPAN; index += 1) {
        const value = clamp(samples[start + index]! * gain, -1.05, 1.05);
        const y = 240 - value * 228;
        const color = ramp[Math.min(5, Math.floor(Math.abs(value) * 5.2))]!;
        screen.line((index - 1) / 2, previousY, index / 2, y, color);
        previousY = y;
      }
    }
  };
}

/**
 * Rolling circles: wheels roll in from the right along a swaying path, one every few pixels, their
 * size the loudness when they set off, so the music runs through the row as a swelling tube in
 * bands of colour; a spoke across each, in the dark of its colour, shows it turning.
 */
export function rollingCircles(): VsgEffect {
  interface Wheel { x: number; y: number; radius: number; color: number; }
  const wheels: Wheel[] = [];
  const colors = [9, 11, 10, 14, 12, 13];
  let travelled = 0;
  let sway = 0;
  let serial = 0;
  return {
    tick(input: VsgInput): void {
      const speed = 2 + input.level * 3.5 + input.beat * 2;
      for (const wheel of wheels) wheel.x -= speed;
      while (wheels.length && wheels[0]!.x + wheels[0]!.radius < -2) wheels.shift();
      sway += input.dt * (1.1 + input.bass * 1.6);
      travelled += speed;
      while (travelled >= 6) {
        travelled -= 6;
        const radius = 8 + input.level * 64 + input.beat * 34 + input.bass * 24;
        wheels.push({
          x: WIDTH + radius,
          y: 240 + 118 * Math.sin(sway) + 46 * Math.sin(sway * 2.7 + 1),
          radius,
          color: colors[Math.floor(serial / 6) % colors.length]!
        });
        serial += 1;
      }
    },
    draw(screen: Raster): void {
      for (const wheel of wheels) {
        const turn = (WIDTH + wheel.radius - wheel.x) / Math.max(4, wheel.radius);
        const spokeX = Math.cos(turn) * wheel.radius;
        const spokeY = Math.sin(turn) * wheel.radius;
        screen.line(wheel.x - spokeX, wheel.y - spokeY, wheel.x + spokeX, wheel.y + spokeY, wheel.color - 8);
        screen.circle(wheel.x, wheel.y, wheel.radius, wheel.color);
      }
    }
  };
}

/**
 * Crosshair: a gun sight across the whole screen hunts about — a new mark on every kick, and the
 * sooner the louder it plays — swinging onto it and trembling with the treble, with the lines it
 * held a moment ago fading behind it.
 */
export function crosshair(random: () => number): VsgEffect {
  const TRAIL = 40;
  const SPACING = 6;
  const trailX = new Float32Array(TRAIL).fill(320);
  const trailY = new Float32Array(TRAIL).fill(240);
  let newest = 0;
  let x = 320;
  let y = 240;
  let speedX = 0;
  let speedY = 0;
  let targetX = 320;
  let targetY = 240;
  let since = 0;
  const fade = [8, 1, 9, 3, 11];
  return {
    tick(input: VsgInput): void {
      const dt = input.dt;
      since += dt;
      if (input.onset || since > 1.5 - input.level) {
        since = 0;
        targetX = 40 + random() * 560;
        targetY = 36 + random() * 408;
      }
      const tremble = input.treble * 7;
      speedX += (40 * (targetX + (random() - 0.5) * tremble - x) - 8 * speedX) * dt;
      speedY += (40 * (targetY + (random() - 0.5) * tremble - y) - 8 * speedY) * dt;
      x += speedX * dt;
      y += speedY * dt;
      if (x < 4 || x > WIDTH - 5) {
        x = clamp(x, 4, WIDTH - 5);
        speedX = -speedX * 0.6;
      }
      if (y < 4 || y > HEIGHT - 5) {
        y = clamp(y, 4, HEIGHT - 5);
        speedY = -speedY * 0.6;
      }
      newest = (newest + 1) % TRAIL;
      trailX[newest] = x;
      trailY[newest] = y;
    },
    draw(screen: Raster, input: VsgInput): void {
      for (let back = fade.length; back >= 1; back -= 1) {
        const at = (newest - back * SPACING + TRAIL * 2) % TRAIL;
        const color = fade[fade.length - back]!;
        screen.hline(0, WIDTH - 1, trailY[at]!, color);
        screen.vline(trailX[at]!, 0, HEIGHT - 1, color);
      }
      const cx = Math.round(trailX[newest]!);
      const cy = Math.round(trailY[newest]!);
      screen.hline(0, WIDTH - 1, cy, 15);
      screen.vline(cx, 0, HEIGHT - 1, 15);
      // The sight's scale: a tick every 16 pixels from the centre, a longer one every 64.
      for (let offset = 16; offset < WIDTH; offset += 16) {
        const size = offset % 64 === 0 ? 6 : 3;
        for (const tx of [cx - offset, cx + offset]) screen.vline(tx, cy - size, cy + size, 7);
        for (const ty of [cy - offset, cy + offset]) screen.hline(cx - size, cx + size, ty, 7);
      }
      const radius = 14 + input.level * 34 + input.beat * 18;
      screen.circle(cx, cy, radius, 12);
      screen.circle(cx, cy, radius * 2 + 6, 14);
      screen.circle(cx, cy, radius * 3 + 12, 4);
      screen.box(cx - 4, cy - 4, cx + 4, cy + 4, 14);
    }
  };
}
