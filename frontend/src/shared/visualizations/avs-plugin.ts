import presetsInfo from "virtual:avs-presets";

import type { CatalogFetch, PresetGroup, VisualizerPlugin } from "./types";

/**
 * Every AVS preset, for the panel's search across visualizers: from the build's one index, named
 * as the list names them with every pack chosen ("pack · category · group" over each), the ones
 * that would not build on this browser left out as the list leaves them out.
 */
async function avsCatalog(fetchJson: CatalogFetch): Promise<PresetGroup[]> {
  const info = presetsInfo;
  if (!info) return [];
  const [packs, { poolGroups }] = await Promise.all([import("./avs/packs"), import("./milkdrop-packs")]);
  const packList = info.packs.map((pack) => ({ ...pack, index: info.index }));
  const loaded = packs.avsPackPresets(packList, await fetchJson(info.index), info.index);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(packs.FAILED_KEY);
  } catch { /* pamięć przeglądarki może być niedostępna */ }
  const failed = new Set(packs.storedFailures(stored));
  return poolGroups(packs.ALL_POOL, [], packList, loaded, { builtin: "", pack: (pack) => pack.name }, failed);
}

/**
 * Winamp AVS: the packs in frontend/vendor/avs-presets plus mscopes' own presets,
 * which every build has (see scripts/avs-presets.mjs). The engine (webvs, forked
 * after vis_avs) and the presets are fetched only when the visualizer is first
 * chosen.
 */
export const avsVisualizers: VisualizerPlugin[] = presetsInfo
  ? [{
      id: "avs",
      label: "AVS (Winamp)",
      fftSize: 1024,
      // Winamp handed AVS each frame's spectrum as it was, without smoothing.
      smoothing: 0,
      external: async (analyser, options) => (await import("./avs/index")).createAvs(analyser, options),
      catalog: avsCatalog,
      render: () => undefined
    }]
  : [];
