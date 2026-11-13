import type { VisualizerPlugin } from "./types";

/**
 * VoltViz: the visualizations of voltviz (MIT, vendored in ./voltviz), each one a preset.
 * The adapter, voltviz's audio analysis, three.js and every visualization are chunks of their
 * own, fetched when the visualizer is first chosen.
 */
export const voltvizVisualizers: VisualizerPlugin[] = [
  {
    id: "voltviz",
    label: "VoltViz",
    external: async (analyser, options) => (await import("./voltviz/index")).createVoltViz(analyser, options),
    catalog: async () => (await import("./voltviz/listing")).voltvizSearchCatalog(),
    render: () => undefined
  }
];
