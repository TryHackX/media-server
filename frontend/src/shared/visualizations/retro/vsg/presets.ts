import type { RetroScene } from "../types";
import type { VsgEffectId } from "./effects";

/**
 * The presets of VSG+ (DOS): "VSG+", which changes the effect on a kick every twenty seconds or
 * so and now and then the palette, as fomalhaut's VSG+ does, then each of the twenty effects on
 * its own in EGA colours. The effects' names describe them rather than name them, so the list
 * shows them in the interface's language (Polish source text for t()); "VSG+" stays as it is.
 */
function vsg(id: string, name: string, effect: VsgEffectId | "auto", translate = true): { id: string; name: string; translate: boolean; create(): Promise<RetroScene> } {
  return { id, name, translate, create: async () => (await import("./vsg")).createVsg(effect) };
}

export const VSG_PRESETS: readonly { id: string; name: string; translate: boolean; create(): Promise<RetroScene> }[] = [
  vsg("vsg-auto", "VSG+", "auto", false),
  vsg("vsg-two-circles", "Dwa okręgi", "two-circles"),
  vsg("vsg-bars", "Słupki", "bars"),
  vsg("vsg-two-traces", "Dwa przebiegi", "two-traces"),
  vsg("vsg-scope", "Oscyloskop", "scope"),
  vsg("vsg-rolling-circles", "Toczące się okręgi", "rolling-circles"),
  vsg("vsg-crosshair", "Celownik", "crosshair"),
  vsg("vsg-phase-loops", "Pętle fazowe", "phase-loops"),
  vsg("vsg-worms", "Robaki", "worms"),
  vsg("vsg-strings", "Struny", "strings"),
  vsg("vsg-sine-waves", "Sinusoidy", "sine-waves"),
  vsg("vsg-vu-bars", "Słupki VU", "vu-bars"),
  vsg("vsg-band-circles", "Okręgi pasm", "band-circles"),
  vsg("vsg-starfield", "Gwiazdy", "starfield"),
  vsg("vsg-tunnel", "Tunel", "tunnel"),
  vsg("vsg-radar", "Radar", "radar"),
  vsg("vsg-circle-scope", "Oscyloskop kołowy", "circle-scope"),
  vsg("vsg-bouncing-balls", "Skaczące piłki", "bouncing-balls"),
  vsg("vsg-moire", "Mora", "moire"),
  vsg("vsg-lissajous", "Figury Lissajous", "lissajous"),
  vsg("vsg-fireworks", "Fajerwerki", "fireworks")
];
