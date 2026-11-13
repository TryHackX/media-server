import { avsVisualizers } from "./avs-plugin";
import { favoritesVisualizers } from "./favorites-plugin";
import { geissVisualizers } from "./geiss";
import { canonicalVisualizerId, internalVisualizers } from "./internal-plugin";
import { milkdropVisualizers } from "./milkdrop";
import { retroVisualizers } from "./retro-plugin";
import { shaderVisualizers } from "./shaders-plugin";
import { soundformsVisualizers } from "./soundforms-plugin";
import type { VisualizerPlugin } from "./types";
import { voltvizVisualizers } from "./voltviz-plugin";

const byId = new Map<string, VisualizerPlugin>();
for (const plugin of [
  ...internalVisualizers, ...favoritesVisualizers, ...milkdropVisualizers, ...geissVisualizers, ...avsVisualizers,
  ...voltvizVisualizers, ...soundformsVisualizers, ...shaderVisualizers, ...retroVisualizers
]) {
  byId.set(plugin.id, plugin);
}

/**
 * Every registered plugin, in the order the panel lists them by default. The
 * operator decides which are enabled (visualizer_enabled); a plugin missing here
 * would be shipped in the bundle yet unreachable from the panel, so the test
 * below insists the two sets match.
 */
export const defaultVisualizerOrder = ["internal", "favorites", "milkdrop", "geiss", "geiss-classic", "avs", "voltviz", "soundforms", "shaders", "retro"];

export function orderedVisualizerPlugins(
  order: readonly string[] = defaultVisualizerOrder,
  enabled?: readonly string[]
): VisualizerPlugin[] {
  // The player's own visualizations were plugins of their own until Internal took them over;
  // a setting that still names them means Internal, where the first of them stood.
  const unique = [...new Set(order.map(canonicalVisualizerId))].filter((id) => byId.has(id));
  for (const id of defaultVisualizerOrder) if (!unique.includes(id)) unique.push(id);
  const enabledIds = enabled === undefined ? null : new Set(enabled.map(canonicalVisualizerId));
  return unique
    .filter((id) => enabledIds === null || enabledIds.has(id))
    .map((id) => byId.get(id))
    .filter((plugin): plugin is VisualizerPlugin => Boolean(plugin));
}
