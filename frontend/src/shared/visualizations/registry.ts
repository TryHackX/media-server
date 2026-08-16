import { classicVisualizers } from "./classic";
import { fieldVisualizers } from "./fields";
import { psychedelicVisualizers } from "./psychedelic";
import { radialVisualizers } from "./radial";
import { showcaseVisualizers } from "./showcase";
import { spectrumVisualizers } from "./spectrum";
import type { VisualizerPlugin } from "./types";

const byId = new Map<string, VisualizerPlugin>();
for (const plugin of [
  ...spectrumVisualizers, ...radialVisualizers, ...fieldVisualizers,
  ...classicVisualizers, ...psychedelicVisualizers, ...showcaseVisualizers
]) {
  byId.set(plugin.id, plugin);
}

/**
 * Every registered plugin, in the order the panel lists them by default. The
 * operator decides which are enabled (visualizer_enabled); a plugin missing here
 * would be shipped in the bundle yet unreachable from the panel, so the test
 * below insists the two sets match.
 */
export const defaultVisualizerOrder = [
  "snow-spectrum", "poweramp", "solar-flare", "flow-field",
  "warp-tunnel", "kaleidoscope",
  "ring-warp", "orbit-analyzer", "glitch-spectrum", "prism-tunnel",
  "chromatic-cathedral", "quantum-ribbon", "milkdrop-pulse", "neon-metropolis",
  "particle-spectrum", "vortex"
];

export function orderedVisualizerPlugins(
  order: readonly string[] = defaultVisualizerOrder,
  enabled?: readonly string[]
): VisualizerPlugin[] {
  const unique = [...new Set(order)].filter((id) => byId.has(id));
  for (const id of defaultVisualizerOrder) if (!unique.includes(id)) unique.push(id);
  const enabledIds = enabled === undefined ? null : new Set(enabled);
  return unique
    .filter((id) => enabledIds === null || enabledIds.has(id))
    .map((id) => byId.get(id))
    .filter((plugin): plugin is VisualizerPlugin => Boolean(plugin));
}
