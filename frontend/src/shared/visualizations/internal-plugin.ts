import type { VisualizerPlugin } from "./types";

/**
 * The player's own 2D visualizations, in the order Internal lists them: the four curated originals
 * first. Until 08.11.2026 each one was a visualizer of its own in the panel's first list.
 * (After them Internal lists the Fable visualizations, drawn with WebGL 2: fable/catalog.ts.)
 */
export const INTERNAL_ORDER: readonly string[] = [
  "snow-spectrum", "poweramp", "solar-flare", "flow-field",
  "warp-tunnel", "kaleidoscope",
  "ring-warp", "orbit-analyzer", "glitch-spectrum", "prism-tunnel",
  "chromatic-cathedral", "quantum-ribbon", "milkdrop-pulse", "neon-metropolis",
  "particle-spectrum", "vortex"
];

const formerPlugins = new Set(INTERNAL_ORDER);

/**
 * A visualizer id as the panel knows it today: a setting or a saved choice that still names one
 * of the former plugins means Internal (the PHP side maps stored settings the same way).
 */
export function canonicalVisualizerId(id: string): string {
  return formerPlugins.has(id) ? "internal" : id;
}

/**
 * Internal: the player's own visualizations (spectra, Poweramp, flow fields, tunnels…) as the
 * presets of one visualizer, with Auto, the lock, favourites and "next" as MilkDrop has them.
 * Drawn by shared/visualizations/internal.ts, a chunk of its own together with the
 * visualizations, fetched when Internal is first shown.
 */
export const internalVisualizers: VisualizerPlugin[] = [{
  id: "internal",
  label: "Internal",
  external: async (analyser, options) => (await import("./internal")).createInternal(analyser, options),
  catalog: async () => (await import("./internal")).internalPresetGroups(),
  render: () => undefined
}];
