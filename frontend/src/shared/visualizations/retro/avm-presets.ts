import type { AvmSettings } from "./avm";
import type { RetroScene } from "./types";

/**
 * The Atari Video Music's presets: settings of its front panel. Their names are the panel's own
 * labels (SOLID, HOLE, RING, AUTO ALL; across × down), so the list keeps them as they are; where
 * a knob makes the difference, the manual's words for it follow (Polish source text, translated).
 * The first is where the manual says to begin: both CONTOUR knobs fully clockwise, SOLID,
 * HORIZONTAL DISPLAY 1, VERTICAL DISPLAY 1. COLOR in the middle gives its "rainbow of colors";
 * GAIN apart lets HOLE and RING cut one channel's diamond out of the other's.
 */
function avm(id: string, name: string, settings: AvmSettings, translate = false): { id: string; name: string; translate: boolean; create(): Promise<RetroScene> } {
  return { id, name, translate, create: async () => (await import("./avm")).createAvm(settings) };
}

export const AVM_PRESETS = [
  avm("avm-solid", "Solid · 1 × 1", { shape: "solid", across: 1, down: 1, contour: [1, 1], gain: [1, 0.8], color: 0.5, tint: 150 }),
  avm("avm-auto-all", "Auto All", { shape: "auto", across: 1, down: 1, autoAll: true, scanRate: 2, contour: [1, 0.85], color: 0.5 }),
  avm("avm-hole", "Hole · 1 × 1", { shape: "hole", across: 1, down: 1, contour: [1, 1], gain: [1.25, 0.6], color: 0.45, tint: 100 }),
  avm("avm-ring", "Ring · 1 × 1", { shape: "ring", across: 1, down: 1, contour: [1, 1], gain: [1.15, 0.6], color: 0.78, tint: 230 }),
  avm("avm-soft", "Solid · 1 × 1 · miękkie kształty", { shape: "solid", across: 1, down: 1, contour: [0.04, 0.08], gain: [1.2, 1], color: 0.5, tint: 170 }, true),
  avm("avm-solid-colour", "Solid · 1 × 1 · jednolity kolor", { shape: "solid", across: 1, down: 1, contour: [1, 1], gain: [1, 0.8], color: 1, tint: 295 }, true),
  avm("avm-solid-3x2", "Solid · 3 × 2", { shape: "solid", across: 3, down: 2, contour: [0.6, 0.75], color: 0.42, tint: 300 }),
  avm("avm-hole-2x2", "Hole · 2 × 2", { shape: "hole", across: 2, down: 2, contour: [0.8, 1], gain: [1.2, 0.65], color: 0.5, tint: 180 }),
  avm("avm-ring-5x4", "Ring · 5 × 4", { shape: "ring", across: 5, down: 4, contour: [1, 1], color: 0.6, tint: 100 }),
  avm("avm-auto-5x8", "Auto · 5 × 8", { shape: "auto", across: 5, down: 8, scanRate: 1, contour: [0.3, 0.4], color: 0.35, tint: 20 })
];
