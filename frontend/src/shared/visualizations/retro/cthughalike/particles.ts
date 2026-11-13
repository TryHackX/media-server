import type { Listener } from "./listen";
import type { Random } from "./random";
import type { Picture } from "./raster";
import type { WaveArea } from "./waves";

/**
 * Particle scenes, as Cthugha98 had them (its author wrote of 5000 particles cut to 4000): a few
 * thousand points thrown about by the music, drawn into the picture as dots that the flame then
 * smears into trails. Each scene is a different law of motion: a stream blown along a wandering
 * path, a fountain, a turning galaxy, fireworks on the kicks, a swarm chasing a point, a vortex.
 */

export type ParticleScene = "stream" | "fountain" | "galaxy" | "fireworks" | "swarm" | "vortex";

export const PARTICLE_SCENES: readonly ParticleScene[] = ["stream", "fountain", "galaxy", "fireworks", "swarm", "vortex"];

export const PARTICLES = 4000;

export class Particles {
  readonly x = new Float32Array(PARTICLES);
  readonly y = new Float32Array(PARTICLES);
  readonly vx = new Float32Array(PARTICLES);
  readonly vy = new Float32Array(PARTICLES);
  /** 1 when born, 0 when gone. */
  readonly life = new Float32Array(PARTICLES);
  scene: ParticleScene = "stream";
  /** Where the galaxy's particles are drawn (it moves them in polar coordinates). */
  private readonly drawnX = new Float32Array(PARTICLES);
  private readonly drawnY = new Float32Array(PARTICLES);
  private next = 0;
  private sinceBurst = 0;
  private attractorX = 0;
  private attractorY = 0;
  private readonly width: number;
  private readonly height: number;
  private readonly random: Random;

  constructor(width: number, height: number, random: Random) {
    this.width = width;
    this.height = height;
    this.random = random;
  }

  /** Starts a scene from nothing (or, for the galaxy and the vortex, from a full sky). */
  begin(scene: ParticleScene): void {
    this.scene = scene;
    this.life.fill(0);
    this.next = 0;
    this.sinceBurst = 10;
    if (scene === "galaxy") {
      for (let k = 0; k < PARTICLES; k += 1) this.spawnOrbit(k);
    } else if (scene === "vortex") {
      for (let k = 0; k < PARTICLES; k += 1) this.spawnRim(k, this.random());
    } else if (scene === "swarm") {
      for (let k = 0; k < PARTICLES; k += 1) {
        this.x[k] = this.random() * this.width;
        this.y[k] = this.random() * this.height;
        this.vx[k] = 0;
        this.vy[k] = 0;
        this.life[k] = 1;
      }
    }
  }

  private take(): number {
    const k = this.next;
    this.next = (this.next + 1) % PARTICLES;
    return k;
  }

  private spawnOrbit(k: number): void {
    // x: radius (share of the size), y: angle, vx: angular speed.
    const r = 0.04 + Math.pow(this.random(), 0.7) * 0.92;
    const arm = Math.floor(this.random() * 3);
    this.x[k] = r;
    this.y[k] = arm * (2 * Math.PI / 3) + Math.log(r) * 1.6 + (this.random() - 0.5) * 0.5;
    this.vx[k] = 0.012 / Math.sqrt(r);
    this.vy[k] = 0;
    this.life[k] = 1;
  }

  private spawnRim(k: number, along: number): void {
    // Anywhere in the whirlpool to begin with, so it turns from the first step.
    const angle = along * 2 * Math.PI;
    const r = Math.min(this.width, this.height) * (0.05 + 0.6 * Math.sqrt(this.random()));
    this.x[k] = this.width / 2 + Math.cos(angle) * r;
    this.y[k] = this.height / 2 + Math.sin(angle) * r * 0.8;
    this.vx[k] = 0;
    this.vy[k] = 0;
    this.life[k] = 1;
  }

  /** One step of motion (at about 30 steps a second). */
  step(sound: Listener, time: number, area: WaveArea = { x0: 0, y0: 0, x1: this.width, y1: this.height }, kicked = sound.onset): void {
    const { x, y, vx, vy, life, width, height, random } = this;
    const level = Math.min(1.5, sound.level);
    const size = Math.min(width, height);
    // Where the emitters stand: within the part of the picture the display shows.
    const ax = area.x0;
    const ay = area.y0;
    const aw = area.x1 - area.x0;
    const ah = area.y1 - area.y0;
    switch (this.scene) {
      case "stream": {
        // A wandering mouth spits particles along its heading; a wind that turns slowly bends
        // their paths into long arcs, a comet's tail sweeping over the screen.
        const ex = ax + aw * (0.5 + 0.28 * Math.sin(time * 0.31) + 0.06 * Math.sin(time * 1.13));
        const ey = ay + ah * (0.5 + 0.26 * Math.sin(time * 0.43 + 1.3));
        const heading = time * 0.29 + Math.sin(time * 0.17) * 2.4;
        const wind = heading + Math.PI * 0.55;
        const windX = Math.cos(wind) * 0.16;
        const windY = Math.sin(wind) * 0.16;
        const count = Math.round(30 + level * 110 + sound.beat * 80);
        for (let n = 0; n < count; n += 1) {
          const k = this.take();
          const speed = (1.5 + random() * 4.5 + level * 3) * (size / 480);
          const spread = (random() - 0.5) * 0.7;
          x[k] = ex + (random() - 0.5) * 4;
          y[k] = ey + (random() - 0.5) * 4;
          vx[k] = Math.cos(heading + spread) * speed;
          vy[k] = Math.sin(heading + spread) * speed;
          life[k] = 0.75 + random() * 0.25;
        }
        for (let k = 0; k < PARTICLES; k += 1) {
          if (life[k]! <= 0) continue;
          vx[k] = vx[k]! * 0.992 + windX + 0.05 * Math.sin(y[k]! * 0.02 + time);
          vy[k] = vy[k]! * 0.992 + windY + 0.05 * Math.cos(x[k]! * 0.02 - time);
          x[k] = x[k]! + vx[k]!;
          y[k] = y[k]! + vy[k]!;
          life[k] = life[k]! - 0.006;
        }
        break;
      }
      case "fountain": {
        const count = Math.round(20 + level * 70 + sound.beat * 120);
        for (let n = 0; n < count; n += 1) {
          const k = this.take();
          x[k] = ax + aw / 2 + (random() - 0.5) * 8;
          y[k] = ay + ah - 4;
          vx[k] = (random() - 0.5) * (2 + level * 5);
          vy[k] = -(5 + random() * 4 + level * 8 + sound.beat * 6) * (height / 480);
          life[k] = 1;
        }
        for (let k = 0; k < PARTICLES; k += 1) {
          if (life[k]! <= 0) continue;
          vy[k] = vy[k]! + 0.2 * (height / 480);
          x[k] = x[k]! + vx[k]!;
          y[k] = y[k]! + vy[k]!;
          if (y[k]! >= height - 1 && vy[k]! > 0) {
            // A bounce off the floor, losing most of its push.
            vy[k] = -vy[k]! * 0.35;
            vx[k] = vx[k]! * 0.8;
            life[k] = life[k]! - 0.35;
          }
          life[k] = life[k]! - 0.004;
        }
        break;
      }
      case "galaxy": {
        // Polar: x is the home radius, y the angle, vx the angular speed, vy the push outwards.
        const spin = 1 + level * 1.5 + sound.beat * 2;
        const tilt = 0.55 + 0.15 * Math.sin(time * 0.2);
        for (let k = 0; k < PARTICLES; k += 1) {
          const band = Math.min(47, Math.floor(x[k]! * 40));
          y[k] = y[k]! + vx[k]! * spin;
          // Pushed out by its band of the spectrum, sprung back home.
          vy[k] = vy[k]! * 0.85 + (sound.bands[band] ?? 0) * 0.02;
          const r = Math.max(0.02, x[k]! + vy[k]!);
          this.drawnX[k] = width / 2 + Math.cos(y[k]!) * r * size * 0.75;
          this.drawnY[k] = height / 2 + Math.sin(y[k]!) * r * size * 0.75 * tilt;
        }
        break;
      }
      case "fireworks": {
        this.sinceBurst += 1 / 30;
        if ((kicked && this.sinceBurst > 0.18) || this.sinceBurst > 1.4) {
          this.sinceBurst = 0;
          const bx = ax + aw * (0.2 + random() * 0.6);
          const by = ay + ah * (0.15 + random() * 0.5);
          const count = Math.round(250 + level * 300);
          const power = (2.5 + level * 4 + random() * 2) * (size / 480);
          for (let n = 0; n < count; n += 1) {
            const k = this.take();
            const angle = random() * 2 * Math.PI;
            const speed = power * (0.3 + 0.7 * Math.sqrt(random()));
            x[k] = bx;
            y[k] = by;
            vx[k] = Math.cos(angle) * speed;
            vy[k] = Math.sin(angle) * speed;
            life[k] = 1;
          }
        }
        for (let k = 0; k < PARTICLES; k += 1) {
          if (life[k]! <= 0) continue;
          vx[k] = vx[k]! * 0.965;
          vy[k] = vy[k]! * 0.965 + 0.06;
          x[k] = x[k]! + vx[k]!;
          y[k] = y[k]! + vy[k]!;
          life[k] = life[k]! - 0.014;
        }
        break;
      }
      case "swarm": {
        // Three clouds, each chasing a point of its own round the screen (they scatter on a kick),
        // each turning about its point, half of it the other way.
        if (kicked && random() < 0.6) {
          this.attractorX = (random() - 0.5) * aw * 0.5;
          this.attractorY = (random() - 0.5) * ah * 0.5;
        }
        const pull = 0.0012 + level * 0.0012;
        const jitter = 0.9 + level * 1.8;
        const turn = 0.02 + level * 0.025;
        const cosA = Math.cos(turn);
        const sinA = Math.sin(turn);
        for (let cloud = 0; cloud < 3; cloud += 1) {
          const phase = cloud * 2.1;
          const tx = ax + aw * (0.5 + 0.3 * Math.sin(time * (0.41 + cloud * 0.13) + phase)) + this.attractorX * (cloud === 0 ? 1 : -0.5);
          const ty = ay + ah * (0.5 + 0.3 * Math.sin(time * (0.57 + cloud * 0.11) + phase * 1.7)) + this.attractorY * (cloud === 1 ? 1 : -0.5);
          for (let k = cloud; k < PARTICLES; k += 3) {
            vx[k] = (vx[k]! + (tx - x[k]!) * pull + (random() - 0.5) * jitter) * 0.97;
            vy[k] = (vy[k]! + (ty - y[k]!) * pull + (random() - 0.5) * jitter) * 0.97;
            const dx = x[k]! + vx[k]! - tx;
            const dy = y[k]! + vy[k]! - ty;
            const s = k & 2 ? sinA : -sinA;
            x[k] = tx + dx * cosA - dy * s;
            y[k] = ty + dx * s + dy * cosA;
            life[k] = 0.4 + Math.min(0.6, Math.hypot(vx[k]!, vy[k]!) * 0.07);
          }
        }
        break;
      }
      case "vortex": {
        // A whirlpool: particles go round, slowly sinking to the middle, and come back at the rim;
        // the music speeds it up.
        const cx = ax + aw / 2;
        const cy = ay + ah / 2;
        const rim = Math.min(aw, ah) * 0.62;
        const swirl = 0.02 + level * 0.03 + sound.beat * 0.03;
        const sink = 0.004 + level * 0.004;
        for (let k = 0; k < PARTICLES; k += 1) {
          const dx = x[k]! - cx;
          const dy = y[k]! - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          if (r < rim * 0.05 || life[k]! <= 0 || r > rim * 1.6) {
            const angle = random() * 2 * Math.PI;
            const at = rim * (0.75 + random() * 0.45);
            x[k] = cx + Math.cos(angle) * at;
            y[k] = cy + Math.sin(angle) * at * 0.8;
            life[k] = 1;
            continue;
          }
          // Faster near the middle, as water down a drain, and sinking faster there too.
          const near = (rim * 0.35) / (r + rim * 0.1);
          const angle = swirl * (0.6 + near);
          const c = Math.cos(angle) * (1 - sink * (1 + near));
          const sn = Math.sin(angle) * (1 - sink * (1 + near));
          x[k] = cx + dx * c - dy * sn;
          y[k] = cy + dx * sn + dy * c;
          life[k] = Math.min(1, 0.35 + (rim * 0.25) / (r + rim * 0.1));
        }
        break;
      }
    }
  }

  /** Every live particle as a dot: young and fast ones hot, old ones dim. */
  draw(picture: Picture, hot: number): void {
    const { width, height, data } = picture;
    const galaxy = this.scene === "galaxy";
    const xs = galaxy ? this.drawnX : this.x;
    const ys = galaxy ? this.drawnY : this.y;
    for (let k = 0; k < PARTICLES; k += 1) {
      const life = this.life[k]!;
      if (life <= 0) continue;
      const px = Math.round(xs[k]!);
      const py = Math.round(ys[k]!);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const value = galaxy ? hot * (0.45 + 0.55 * (1 - this.x[k]!)) : hot * (0.3 + 0.7 * life);
      data[py * width + px] = value;
    }
  }
}
