import { t } from "../i18n";
import type { VisualizerPlugin } from "./types";

/**
 * Formy dźwięku (Sound Forms): 3D visualizations of the project's own in WebGL 2 — spiked spheres,
 * line fields, 3D spectra, point grids, swarms, a dotted planet, rings — as the presets of one
 * visualizer (shared/visualizations/soundforms/). Its code is a chunk of its own, fetched when the
 * visualizer is first chosen.
 */
export const soundformsVisualizers: VisualizerPlugin[] = [{
  id: "soundforms",
  // Read when the list is drawn, so it follows the interface language.
  get label(): string {
    return t("Formy dźwięku");
  },
  external: async (analyser, options) => (await import("./soundforms/index")).createSoundForms(analyser, options),
  catalog: async () => (await import("./soundforms/catalog")).soundformsPresetGroups(() => true, t),
  render: () => undefined
}];
