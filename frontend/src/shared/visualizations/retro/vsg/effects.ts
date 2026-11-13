import { bars, crosshair, rollingCircles, scope, twoCircles, twoTraces } from "./classic";
import { circleScope, lissajous, moire, phaseLoops, sineWaves, strings, tunnel } from "./lines";
import type { VsgEffect } from "./listen";
import { bandCircles, radar, vuBars } from "./meters";
import { bouncingBalls, fireworks, starfield, worms } from "./motion";

/**
 * The twenty effects of VSG+ (DOS), in fomalhaut's order: VSG's own six, then the fourteen it
 * added. Each makes a fresh effect; `random` is the scene's own sequence.
 */
export const EFFECTS = [
  { id: "two-circles", create: twoCircles },
  { id: "bars", create: bars },
  { id: "two-traces", create: twoTraces },
  { id: "scope", create: scope },
  { id: "rolling-circles", create: rollingCircles },
  { id: "crosshair", create: crosshair },
  { id: "phase-loops", create: phaseLoops },
  { id: "worms", create: worms },
  { id: "strings", create: strings },
  { id: "sine-waves", create: sineWaves },
  { id: "vu-bars", create: vuBars },
  { id: "band-circles", create: bandCircles },
  { id: "starfield", create: starfield },
  { id: "tunnel", create: tunnel },
  { id: "radar", create: radar },
  { id: "circle-scope", create: circleScope },
  { id: "bouncing-balls", create: bouncingBalls },
  { id: "moire", create: moire },
  { id: "lissajous", create: lissajous },
  { id: "fireworks", create: fireworks }
] as const satisfies readonly { id: string; create(random: () => number): VsgEffect }[];

export type VsgEffectId = (typeof EFFECTS)[number]["id"];
