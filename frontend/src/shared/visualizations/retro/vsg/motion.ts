import { follow, HEIGHT, WIDTH, type VsgEffect, type VsgInput } from "./listen";
import type { Raster } from "./raster";

/**
 * The effects of VSG+ with things moving about the screen — worms, starfield, bouncing balls and
 * fireworks — drawn from their names in the manner of the rest: outlines of circles, lines and
 * single pixels, the music setting the pace and every kick a jolt.
 */

/** The dark colour of each bright one (9–15), as the EGA pairs them. */
function darkOf(color: number): number {
  return color >= 9 ? color - 8 : 8;
}

/**
 * Worms: six worms of rings crawl about, each listening to its own stretch of the spectrum — the
 * louder, the faster it goes and the more it wriggles — and a kick makes them all turn at once.
 */
export function worms(random: () => number): VsgEffect {
  const COUNT = 6;
  const LENGTH = 84;
  const SPACING = 2;
  const colors = [12, 14, 10, 11, 9, 13];
  const bodies = Array.from({ length: COUNT }, (_, index) => {
    const x = 80 + random() * 480;
    const y = 70 + random() * 340;
    return {
      x: new Float32Array(LENGTH).fill(x),
      y: new Float32Array(LENGTH).fill(y),
      head: 0,
      heading: random() * 2 * Math.PI,
      turn: 0,
      band: 1 + index * 2 + (index > 2 ? 1 : 0),
      wiggle: 1.1 + index * 0.37
    };
  });
  return {
    tick(input: VsgInput): void {
      for (const worm of bodies) {
        const energy = (input.bands[worm.band]! + input.bands[worm.band + 1]!) / 2;
        worm.turn = worm.turn * 0.95 + (random() - 0.5) * 0.05;
        worm.heading += worm.turn + Math.sin(input.time * worm.wiggle * 3) * 0.035 * (1 + 3 * energy);
        if (input.onset) worm.heading += (random() - 0.5) * 2.6;
        const speed = 1 + 4.2 * energy + 2.2 * input.beat;
        let x = worm.x[worm.head]! + Math.cos(worm.heading) * speed;
        let y = worm.y[worm.head]! + Math.sin(worm.heading) * speed;
        if (x < 14 || x > WIDTH - 15) {
          worm.heading = Math.PI - worm.heading;
          x = Math.min(WIDTH - 15, Math.max(14, x));
        }
        if (y < 14 || y > HEIGHT - 15) {
          worm.heading = -worm.heading;
          y = Math.min(HEIGHT - 15, Math.max(14, y));
        }
        worm.head = (worm.head + 1) % LENGTH;
        worm.x[worm.head] = x;
        worm.y[worm.head] = y;
      }
    },
    draw(screen: Raster): void {
      const segments = Math.floor(LENGTH / SPACING);
      bodies.forEach((worm, index) => {
        const bright = colors[index]!;
        for (let segment = segments - 1; segment >= 0; segment -= 1) {
          const at = (worm.head - segment * SPACING + LENGTH * 2) % LENGTH;
          const radius = 3 + 9 * Math.sin((Math.PI / 2) * (1 - segment / segments)) ** 0.7;
          screen.circle(worm.x[at]!, worm.y[at]!, radius, segment % 3 === 1 ? darkOf(bright) : bright);
        }
        // Two eyes, looking where it goes.
        const x = worm.x[worm.head]!;
        const y = worm.y[worm.head]!;
        for (const side of [-0.55, 0.55]) {
          const eyeX = x + Math.cos(worm.heading + side) * 6;
          const eyeY = y + Math.sin(worm.heading + side) * 6;
          screen.box(eyeX - 1, eyeY - 1, eyeX, eyeY, 15);
        }
      });
    }
  };
}

/**
 * Starfield: stars rush out of the depth, grey far off and white close by, a few in colour, each
 * with a short trail; the louder, the faster, and the faster, the longer they streak — a kick
 * sends them into hyperspace. The point they come from drifts.
 */
export function starfield(random: () => number): VsgEffect {
  const COUNT = 540;
  const FOCAL = 250;
  const x = new Float32Array(COUNT);
  const y = new Float32Array(COUNT);
  const z = new Float32Array(COUNT);
  const tint = new Uint8Array(COUNT);
  const tints = [9, 11, 14, 13, 10, 12];
  const place = (star: number, far: boolean): void => {
    x[star] = random() * 2.6 - 1.3;
    y[star] = random() * 2 - 1;
    z[star] = far ? 0.8 + random() * 0.2 : 0.05 + random() * 0.95;
  };
  for (let star = 0; star < COUNT; star += 1) {
    place(star, false);
    tint[star] = star % 7 === 0 ? tints[(star / 7) % tints.length]! : 0;
  }
  let speed = 0.25;
  let drift = 0;
  return {
    tick(input: VsgInput): void {
      speed = follow(speed, 0.12 + 0.8 * input.level + 1.7 * input.beat, input.dt, 0.05, 0.7);
      drift += input.dt * (0.2 + 0.3 * input.level);
      for (let star = 0; star < COUNT; star += 1) {
        z[star] = z[star]! - speed * input.dt * 0.55;
        if (z[star]! <= 0.02) place(star, true);
      }
    },
    draw(screen: Raster): void {
      const middleX = 320 + 60 * Math.sin(drift * 0.9);
      const middleY = 240 + 40 * Math.sin(drift * 0.7 + 1);
      // Every star leaves a short trail of where it was; at speed, a long streak.
      const streak = 0.012 + Math.max(0, speed - 0.4) * 0.12;
      for (let star = 0; star < COUNT; star += 1) {
        const depth = z[star]!;
        const px = middleX + (x[star]! / depth) * FOCAL;
        const py = middleY + (y[star]! / depth) * FOCAL;
        if (px < -40 || px > WIDTH + 40 || py < -40 || py > HEIGHT + 40) {
          place(star, true);
          continue;
        }
        const color = tint[star] || (depth > 0.7 ? 8 : depth > 0.4 ? 7 : 15);
        const tail = depth + streak;
        screen.line(middleX + (x[star]! / tail) * FOCAL, middleY + (y[star]! / tail) * FOCAL, px, py, color);
        if (depth < 0.22) screen.box(px - 1, py - 1, px, py, depth < 0.12 ? 15 : color);
      }
    }
  };
}

/**
 * Bouncing balls: eight wire balls, each kicked up when its band of the spectrum jumps, fall,
 * bounce and roll, spinning as they go, with a dotted trail of their flight; their shadows grow
 * on the floor as they come down, and they squash as they land.
 */
export function bouncingBalls(random: () => number): VsgEffect {
  const FLOOR = 452;
  const GRAVITY = 1150;
  const TRAIL = 30;
  const radii = [40, 35, 31, 27, 24, 21, 18, 15];
  const colors = [12, 14, 10, 11, 9, 13, 15, 7];
  const balls = radii.map((radius, index) => ({
    radius,
    color: colors[index]!,
    band: index * 2,
    x: 50 + index * 75 + random() * 20,
    y: FLOOR - radius - random() * 200,
    vx: (random() - 0.5) * 160,
    vy: 0,
    slow: 0,
    since: 1,
    squash: 0,
    spin: random() * Math.PI,
    trailX: new Float32Array(TRAIL).fill(-100),
    trailY: new Float32Array(TRAIL).fill(-100)
  }));
  let ticks = 0;
  return {
    tick(input: VsgInput): void {
      const dt = input.dt;
      ticks += 1;
      for (const ball of balls) {
        ball.spin += (ball.vx * dt) / ball.radius;
        if (ticks % 2 === 0) {
          const slot = (ticks / 2) % TRAIL;
          ball.trailX[slot] = ball.x;
          ball.trailY[slot] = ball.y;
        }
        const energy = (input.bands[ball.band]! + input.bands[ball.band + 1]!) / 2;
        ball.since += dt;
        // A jump of its band, or a kick for the bass balls: up it goes, if it is near the floor.
        const jump = energy - ball.slow > 0.13 || (input.onset && ball.band < 4);
        const low = FLOOR - ball.radius - ball.y < 110;
        if (jump && low && ball.since > 0.22) {
          ball.vy = Math.min(ball.vy, -(340 + 540 * energy));
          ball.vx += (random() - 0.5) * 220;
          ball.since = 0;
        }
        ball.slow = follow(ball.slow, energy, dt, 0.25, 0.25);
        ball.vy += GRAVITY * dt;
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;
        ball.vx *= 0.995;
        if (ball.x < ball.radius) {
          ball.x = ball.radius;
          ball.vx = Math.abs(ball.vx);
        } else if (ball.x > WIDTH - 1 - ball.radius) {
          ball.x = WIDTH - 1 - ball.radius;
          ball.vx = -Math.abs(ball.vx);
        }
        if (ball.y > FLOOR - ball.radius) {
          ball.squash = Math.min(0.3, ball.vy / 2600);
          ball.y = FLOOR - ball.radius;
          ball.vy = ball.vy > 120 ? -ball.vy * 0.72 : 0;
        } else {
          ball.squash *= 0.75;
        }
        if (ball.y < ball.radius) {
          ball.y = ball.radius;
          ball.vy = Math.abs(ball.vy) * 0.5;
        }
      }
    },
    draw(screen: Raster): void {
      for (let x = 0; x < WIDTH; x += 6) screen.hline(x, x + 2, FLOOR + 1, 8);
      for (let row = FLOOR + 8; row < HEIGHT; row += 9) for (let x = (row * 3) % 12; x < WIDTH; x += 12) screen.pset(x, row, 8);
      for (const ball of balls) {
        const height = FLOOR - ball.radius - ball.y;
        const near = Math.max(0, 1 - height / 360);
        const shadow = ball.radius * (0.45 + 0.75 * near);
        screen.ellipse(ball.x, FLOOR + 6, shadow, Math.max(1, shadow * 0.16), 8);
      }
      for (const ball of balls) {
        const dark = darkOf(ball.color);
        for (let slot = 0; slot < TRAIL; slot += 1) screen.pset(ball.trailX[slot]!, ball.trailY[slot]!, dark);
      }
      for (const ball of balls) {
        const across = ball.radius * (1 + ball.squash);
        const down = ball.radius * (1 - ball.squash);
        const middleY = ball.y + ball.radius - down;
        const dark = darkOf(ball.color);
        // A wire sphere: three meridians turning with the roll, and the equator.
        for (let meridian = 0; meridian < 3; meridian += 1) {
          const width = across * Math.abs(Math.cos(ball.spin + (meridian * Math.PI) / 3));
          screen.ellipse(ball.x, middleY, width, down, dark);
        }
        screen.ellipse(ball.x, middleY, across, down * 0.28, dark);
        screen.ellipse(ball.x, middleY, across, down, ball.color);
        // A shine up and to the left.
        const shine = Math.max(2, ball.radius * 0.16);
        screen.circle(ball.x - across * 0.42, middleY - down * 0.46, shine, 15);
      }
    }
  };
}

/**
 * Fireworks: on a kick (or now and then) a rocket climbs with a trail of sparks and bursts at the
 * top into a ring or a ball of sparks that streak, fall and burn down from bright to dark.
 */
export function fireworks(random: () => number): VsgEffect {
  interface Rocket { x: number; y: number; vx: number; vy: number; color: number; trail: number[]; }
  interface Spark { x: number; y: number; vx: number; vy: number; life: number; span: number; color: number; }
  const ROCKET_GRAVITY = 420;
  const rockets: Rocket[] = [];
  const sparks: Spark[] = [];
  const colors = [9, 10, 11, 12, 13, 14, 15];
  let sinceLaunch = 0.6;

  /** A shell bursts: a ring (with a smaller one of a second colour inside), or a ball of sparks. */
  const burst = (rocket: Rocket, input: VsgInput): void => {
    const ring = random() < 0.45;
    const count = Math.round(80 + 70 * input.level + 40 * input.beat);
    const speed = 125 + 115 * random();
    const second = colors[Math.floor(random() * colors.length)]!;
    for (let index = 0; index < count && sparks.length < 1600; index += 1) {
      const angle = (2 * Math.PI * index) / count + random() * 0.06;
      const inner = ring && index % 3 === 0;
      const pace = ring ? speed * (inner ? 0.55 : 0.97 + random() * 0.06) : speed * (0.25 + 0.75 * Math.sqrt(random()));
      sparks.push({
        x: rocket.x,
        y: rocket.y,
        vx: Math.cos(angle) * pace + rocket.vx * 0.4,
        vy: Math.sin(angle) * pace + rocket.vy * 0.4,
        life: 0,
        span: 1.5 + random() * 1.1,
        color: inner || (!ring && index % 4 === 0) ? second : rocket.color
      });
    }
  };

  return {
    tick(input: VsgInput): void {
      const dt = input.dt;
      sinceLaunch += dt;
      const due = (input.onset && sinceLaunch > 0.2) || sinceLaunch > 1.3 - 0.8 * input.level;
      if (due && rockets.length < 6) {
        sinceLaunch = 0;
        // Climbing to burst between a sixth and a half of the way down the screen.
        const climb = HEIGHT * (0.5 + 0.34 * random()) + 30 * input.level;
        rockets.push({
          x: 70 + random() * 500,
          y: HEIGHT + 2,
          vx: (random() - 0.5) * 90,
          vy: -Math.sqrt(2 * ROCKET_GRAVITY * climb),
          color: colors[Math.floor(random() * colors.length)]!,
          trail: []
        });
      }
      for (let index = rockets.length - 1; index >= 0; index -= 1) {
        const rocket = rockets[index]!;
        rocket.vy += ROCKET_GRAVITY * dt;
        rocket.x += rocket.vx * dt;
        rocket.y += rocket.vy * dt;
        rocket.trail.push(rocket.x + (random() - 0.5) * 3, rocket.y + 4 + random() * 4);
        if (rocket.trail.length > 28) rocket.trail.splice(0, 2);
        if (rocket.vy > -40) {
          burst(rocket, input);
          rockets.splice(index, 1);
        }
      }
      let kept = 0;
      for (const spark of sparks) {
        spark.vx *= 0.985;
        spark.vy = spark.vy * 0.985 + 90 * dt;
        spark.x += spark.vx * dt;
        spark.y += spark.vy * dt;
        spark.life += dt;
        if (spark.life < spark.span && spark.y < HEIGHT + 4) sparks[kept++] = spark;
      }
      sparks.length = kept;
    },
    draw(screen: Raster, input: VsgInput): void {
      for (const rocket of rockets) {
        for (let index = 0; index < rocket.trail.length; index += 2) {
          screen.pset(rocket.trail[index]!, rocket.trail[index + 1]!, index > rocket.trail.length - 8 ? 14 : 6);
        }
        screen.box(rocket.x - 1, rocket.y - 1, rocket.x, rocket.y, 15);
      }
      for (const spark of sparks) {
        const burnt = spark.life / spark.span;
        // White as it flies out, its colour, the dark of it, grey; the last ones twinkle out.
        if (burnt > 0.72 && input.random() < 0.35) continue;
        const color = burnt < 0.08 ? 15 : burnt < 0.6 ? spark.color : burnt < 0.82 ? darkOf(spark.color) : 8;
        const length = burnt < 0.6 ? 0.06 : 0.03;
        screen.line(spark.x - spark.vx * length, spark.y - spark.vy * length, spark.x, spark.y, color);
        if (burnt > 0.3 && burnt < 0.6 && input.random() < 0.04) screen.pset(spark.x, spark.y, 15);
      }
    }
  };
}
