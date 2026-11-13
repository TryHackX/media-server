import type { VisualizerPlugin } from "./types";

/**
 * Geiss (Winamp): Ryan Geiss's Geiss 4.30 plug-in ported from its own source (geiss/sim.ts,
 * 3-Clause BSD), its 25 maps the presets. It took the slot — and the id, so settings, order and
 * the enabled list carry over — of "Geiss Classic", a WebGL look-alike it replaced on 08.11.2026.
 * The port is a chunk of its own, fetched when the visualizer is first chosen.
 */
export const geissVisualizers: VisualizerPlugin[] = [
  {
    id: "geiss-classic",
    label: "Geiss (Winamp)",
    // Winamp's 576 samples fit in 1024; its spectrum is computed from them (geiss/index.ts).
    fftSize: 1024,
    smoothing: 0,
    external: async (analyser, options) => (await import("./geiss/index")).createGeiss(analyser, options),
    // The maps and the listener's saved presets, read again for every search (a preset saved meanwhile).
    catalog: async () => (await import("./geiss/catalog")).geissCatalog(),
    catalogLive: true,
    render: () => undefined
  }
];
