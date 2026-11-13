import { t } from "../i18n";
import type { VisualizerPlugin } from "./types";

/** The id of "Ulubione"; never a key of the favourites themselves. */
export const FAVORITES_VISUALIZER = "favorites";

/**
 * "Ulubione": the listener's favourite presets of every visualizer the panel offers, in one list,
 * and "Auto" playing them in turn — MilkDrop's, then an AVS preset, then a VoltViz one… It opens
 * each visualizer on its favourite (shared/visualizations/favorites-visualizer.ts), so nothing
 * of the visualizers' own is duplicated, and leaves their own saved choices alone.
 */
export const favoritesVisualizers: VisualizerPlugin[] = [{
  id: "favorites",
  // Read when the list is drawn, so it follows the interface language.
  get label(): string {
    return t("Ulubione");
  },
  external: async (analyser, options) => (await import("./favorites-visualizer")).createFavorites(analyser, options),
  render: () => undefined
}];
