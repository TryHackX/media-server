import info from "virtual:shader-visualizers";

import { t } from "../i18n";
import type { VisualizerPlugin } from "./types";

/**
 * Shadery: Monkey Hi Hat's and music_visualizer's shader visualizations, when the build has them
 * (frontend/vendor/shader-visualizers, converted by scripts/shader-visualizers.mjs). The runner
 * (shared/visualizations/shaders/) is a chunk of its own, and the presets are files of their
 * own, fetched when the visualizer is first chosen and a preset is about to play.
 */
const build = info;

export const shaderVisualizers: VisualizerPlugin[] = build
  ? [{
      id: "shaders",
      // Read when the list is drawn, so it follows the interface language.
      get label(): string {
        return t("Shadery");
      },
      external: async (analyser, options) => (await import("./shaders/index")).createShaders(analyser, options, build),
      catalog: async (fetchJson) => (await import("./shaders/listing")).shaderSearchCatalog(await fetchJson(build.index)),
      render: () => undefined
    }]
  : [];
