import { t } from "../i18n";
import type { VisualizerPlugin } from "./types";

/**
 * Klasyka retro (Retro classics): the looks of the first music visualizers recreated — the Atari
 * Video Music of 1977 (its circuit, from the patent and the manual), the screens of the music
 * trackers of the Amiga, DOS, Windows, the C64 and the Amstrad CPC, our own recreations of
 * Cthugha98, Cthugha-4-Winamp and VSG+ and, in builds with the ports in frontend/vendor/cthugha,
 * Cthugha 5.3 and Cthugha-L — as the presets of one visualizer (shared/visualizations/retro/).
 * Its code is a chunk of its own, fetched when the visualizer is first chosen.
 */
export const retroVisualizers: VisualizerPlugin[] = [{
  id: "retro",
  // Read when the list is drawn, so it follows the interface language.
  get label(): string {
    return t("Klasyka retro");
  },
  external: async (analyser, options) => (await import("./retro/index")).createRetro(analyser, options),
  catalog: async () => {
    const { retroPresetGroups, retroPresets } = await import("./retro/catalog");
    return retroPresetGroups(retroPresets(), () => true, t);
  },
  render: () => undefined
}];
