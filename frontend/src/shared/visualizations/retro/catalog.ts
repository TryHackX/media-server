import cthugha from "virtual:retro-cthugha";

import { AVM_PRESETS } from "./avm-presets";
import { C4W_PRESETS } from "./cthugha4winamp/presets";
import { C98_PRESETS } from "./cthugha98/presets";
import { TRACKER_PRESETS } from "./trackers/presets";
import type { PresetGroup } from "../types";
import type { RetroScene } from "./types";
import { VSG_PRESETS } from "./vsg/presets";

/**
 * The presets of "Klasyka retro", under the headings of RETRO_GROUPS. Cthugha's (the ports of
 * Cthugha 5.3 and Cthugha-L) are there only when the build found them in frontend/vendor/cthugha
 * (scripts/retro-cthugha.mjs): their licence allows no commercial use, so they never become part
 * of this repository. Cthugha98, Cthugha-4-Winamp and VSG+ are our own recreations, made from
 * screenshots and descriptions, so a build always has them; when the vendor folder brings its
 * own presets for a heading (its ports of Cthugha98 and Cthugha-4-Winamp, made from the
 * programs themselves), those take the recreations' places.
 */

export interface RetroPreset {
  /** What the panel, the remembered choice and the favourites store. */
  id: string;
  group: string;
  /** The name in the list: Polish source text when `translate`, else a proper name as it is. */
  name: string;
  translate: boolean;
  /** The scene, its code fetched on first use. */
  create(): Promise<RetroScene>;
}

/** The headings, in the order the list shows them (names are Polish source text for t()). */
export const RETRO_GROUPS: readonly { id: string; name: string }[] = [
  { id: "cthugha", name: "Cthugha" },
  { id: "cthugha98", name: "Cthugha98" },
  { id: "c4w", name: "Cthugha-4-Winamp" },
  { id: "avm", name: "Atari Video Music (1977)" },
  { id: "trackers", name: "Trackery" },
  { id: "vsg", name: "VSG+ (DOS)" },
  { id: "credits", name: "Autorzy" }
];

/**
 * The list: the presets `offered` keeps under RETRO_GROUPS' headings, in their order — names
 * through `translate` (the interface language's t) where they are Polish source text. For the
 * visualizer (index.ts) and the panel's search across visualizers.
 */
export function retroPresetGroups(
  presets: readonly RetroPreset[],
  offered: (id: string) => boolean,
  translate: (text: string) => string
): PresetGroup[] {
  return RETRO_GROUPS
    .map((group) => ({
      label: translate(group.name),
      presets: presets.filter((preset) => preset.group === group.id && offered(preset.id))
        .map((preset) => ({ id: preset.id, label: preset.translate ? translate(preset.name) : preset.name }))
    }))
    .filter((group) => group.presets.length > 0);
}

export function retroPresets(): RetroPreset[] {
  const own: RetroPreset[] = [
    ...C98_PRESETS.map((preset) => ({ ...preset, group: "cthugha98" })),
    ...C4W_PRESETS.map((preset) => ({ ...preset, group: "c4w" })),
    ...AVM_PRESETS.map((preset) => ({ ...preset, group: "avm" })),
    ...TRACKER_PRESETS.map((preset) => ({ ...preset, group: "trackers" })),
    ...VSG_PRESETS.map((preset) => ({ ...preset, group: "vsg" })),
    // The credits: who made the originals, Cthugha's authors included in builds without its port.
    { id: "retro-credits", group: "credits", name: "Autorzy", translate: true, create: async () => (await import("./credits")).createCredits() }
  ];
  if (!cthugha) return own;
  const vendor = cthugha;
  const supplied = new Set(vendor.presets.map((preset) => preset.group ?? "cthugha"));
  return [
    ...vendor.presets.map((preset): RetroPreset => ({
      id: preset.id,
      group: preset.group ?? "cthugha",
      name: preset.name,
      translate: false,
      create: async () => (await vendor.load()).createCthughaScene(preset.id)
    })),
    ...own.filter((preset) => !supplied.has(preset.group))
  ];
}
