import { BANDS, follow, type VsgEffect, type VsgInput } from "./listen";
import type { Raster } from "./raster";

/**
 * The effects of VSG+ that read the spectrum: VU bars (in fomalhaut's screenshot, drawn to match
 * it), band circles and radar (by their names).
 */

/**
 * VU bars: sixteen bands as LED columns of 40 segments — green, yellow from the 24th, red from
 * the 34th, as in fomalhaut's picture — with a grey cap that holds each band's peak and then drops.
 */
export function vuBars(): VsgEffect {
  const SEGMENTS = 40;
  const lit = new Float32Array(BANDS);
  const peak = new Float32Array(BANDS);
  const hold = new Float32Array(BANDS);
  const drop = new Float32Array(BANDS);
  return {
    tick(input: VsgInput): void {
      const dt = input.dt;
      for (let band = 0; band < BANDS; band += 1) {
        // Bent down, so that music that plays well up still leaves the top for its peaks.
        const target = input.bands[band]! ** 1.6 * SEGMENTS;
        // Up at once, down at about a column's height in a second and a half.
        lit[band] = target > lit[band]! ? target : Math.max(target, lit[band]! - 27 * dt);
        if (lit[band]! >= peak[band]!) {
          peak[band] = lit[band]!;
          hold[band] = 0.55;
          drop[band] = 0;
        } else if (hold[band]! > 0) {
          hold[band] = hold[band]! - dt;
        } else {
          drop[band] = drop[band]! + 34 * dt;
          peak[band] = Math.max(0, peak[band]! - drop[band]! * dt);
        }
      }
    },
    draw(screen: Raster): void {
      for (let band = 0; band < BANDS; band += 1) {
        const left = band * 40 + 2;
        const right = left + 35;
        const segments = Math.min(SEGMENTS, Math.round(lit[band]!));
        for (let segment = 0; segment < segments; segment += 1) {
          const bottom = 479 - segment * 12;
          const color = segment < 23 ? 10 : segment < 33 ? 14 : 12;
          screen.fillBox(left, bottom - 9, right, bottom, color);
        }
        // The cap: three rows of light grey, white at its ends.
        const top = Math.round(477 - peak[band]! * 12);
        screen.fillBox(left, top, right, top + 2, 7);
        screen.vline(left, top, top + 2, 15);
        screen.vline(right, top, top + 2, 15);
      }
    }
  };
}

/**
 * Band circles: the sixteen bands as circles round a ring that turns with the music — each as
 * wide as its band is loud, a darker ring where it last peaked, its neighbours joined by a thin
 * polygon — and in the middle the bass as rings of its own.
 */
export function bandCircles(): VsgEffect {
  const size = new Float32Array(BANDS);
  const peak = new Float32Array(BANDS);
  const bright = [12, 12, 14, 14, 10, 10, 11, 11, 9, 9, 13, 13, 15, 15, 7, 7];
  const dark = [4, 4, 6, 6, 2, 2, 3, 3, 1, 1, 5, 5, 7, 7, 8, 8];
  let turn = 0;
  let ring = 160;
  let bass = 0;
  return {
    tick(input: VsgInput): void {
      const dt = input.dt;
      turn += dt * (0.12 + 0.5 * input.level + 0.8 * input.beat);
      ring = follow(ring, 150 + 40 * input.beat + 20 * input.level, dt, 0.04, 0.5);
      bass = follow(bass, input.bass, dt, 0.02, 0.2);
      for (let band = 0; band < BANDS; band += 1) {
        size[band] = follow(size[band]!, 3 + 52 * input.bands[band]! ** 1.5, dt, 0.02, 0.18);
        peak[band] = Math.max(size[band]!, peak[band]! - 30 * dt);
      }
    },
    draw(screen: Raster): void {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let band = 0; band < BANDS; band += 1) {
        const angle = turn + (2 * Math.PI * band) / BANDS - Math.PI / 2;
        xs.push(320 + ring * Math.cos(angle));
        ys.push(240 + ring * 0.86 * Math.sin(angle));
      }
      for (let band = 0; band < BANDS; band += 1) {
        const next = (band + 1) % BANDS;
        screen.line(xs[band]!, ys[band]!, xs[next]!, ys[next]!, 8);
        if (band % 4 === 0) screen.line(320, 240, xs[band]!, ys[band]!, 8);
      }
      const middle = [15, 14, 12, 4];
      for (let rings = 0; rings < middle.length; rings += 1) screen.circle(320, 240, 6 + rings * (8 + 26 * bass), middle[rings]!);
      for (let band = 0; band < BANDS; band += 1) {
        screen.circle(xs[band]!, ys[band]!, peak[band]! + 4, dark[band]!);
        screen.circle(xs[band]!, ys[band]!, size[band]!, bright[band]!);
        screen.circle(xs[band]!, ys[band]!, size[band]! * 0.5, bright[band]!);
        screen.pset(xs[band]!, ys[band]!, 15);
      }
    }
  };
}

/**
 * Radar: a sweep turns over range rings, and where it passes it marks what it hears — the bass
 * near the middle, the treble at the rim, louder as brighter blips — which glow green and fade
 * through the turn: a spectrum written round the clock.
 */
export function radar(): VsgEffect {
  const STEPS = 180;
  const RADIUS = 226;
  /** Each step of a turn: the bands heard when the sweep passed, and when that was (in turns). */
  const heard = new Float32Array(STEPS * BANDS);
  const when = new Float64Array(STEPS).fill(-10);
  let sweep = 0;
  return {
    tick(input: VsgInput): void {
      const before = Math.floor(sweep * STEPS);
      sweep += input.dt * (0.3 + 0.25 * input.level);
      const after = Math.floor(sweep * STEPS);
      for (let step = before + 1; step <= after; step += 1) {
        const slot = step % STEPS;
        when[slot] = step / STEPS;
        for (let band = 0; band < BANDS; band += 1) heard[slot * BANDS + band] = input.bands[band]!;
      }
    },
    draw(screen: Raster): void {
      const angleOf = (turns: number): number => turns * 2 * Math.PI - Math.PI / 2;
      // The afterglow of the sweep: dark green spokes behind it.
      for (let back = 1; back <= 28; back += 1) {
        const angle = angleOf(sweep) - back * 0.02;
        screen.line(320, 240, 320 + RADIUS * Math.cos(angle), 240 + RADIUS * Math.sin(angle), 2);
      }
      for (let rings = 1; rings <= 4; rings += 1) screen.circle(320, 240, (RADIUS * rings) / 4, 2);
      screen.circle(320, 240, RADIUS + 3, 10);
      screen.hline(320 - RADIUS, 320 + RADIUS, 240, 2);
      screen.vline(320, 240 - RADIUS, 240 + RADIUS, 2);
      for (let degrees = 0; degrees < 360; degrees += 5) {
        const angle = (degrees * Math.PI) / 180;
        const inner = RADIUS + 3 + (degrees % 30 === 0 ? 4 : 0);
        const outer = RADIUS + 3 + (degrees % 30 === 0 ? 13 : degrees % 10 === 0 ? 8 : 5);
        screen.line(320 + inner * Math.cos(angle), 240 + inner * Math.sin(angle), 320 + outer * Math.cos(angle), 240 + outer * Math.sin(angle), 10);
      }
      // The blips: fresh ones white and wide, then light green, green, and gone within a turn.
      for (let slot = 0; slot < STEPS; slot += 1) {
        const age = sweep - when[slot]!;
        if (age < 0 || age >= 0.92) continue;
        const angle = angleOf(when[slot]!);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        for (let band = 0; band < BANDS; band += 1) {
          const value = heard[slot * BANDS + band]! - age * 0.35;
          if (value < 0.42) continue;
          const distance = 18 + band * 13.2;
          const x = 320 + distance * cos;
          const y = 240 + distance * sin;
          if (age < 0.05 && value > 0.62) {
            screen.circle(x, y, 2, 15);
            screen.pset(x, y, 15);
          } else if (value > 0.6) {
            screen.box(x - 1, y - 1, x + 1, y + 1, age < 0.3 ? 10 : 2);
          } else {
            screen.pset(x, y, age < 0.45 ? 10 : 2);
          }
        }
      }
      const angle = angleOf(sweep);
      screen.line(320, 240, 320 + RADIUS * Math.cos(angle), 240 + RADIUS * Math.sin(angle), 15);
      screen.circle(320, 240, 2, 15);
    }
  };
}
