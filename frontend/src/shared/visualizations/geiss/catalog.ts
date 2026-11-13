import { t } from "../../i18n";
import type { PresetGroup } from "../types";
import { GEISS_MAPS, type GeissMap } from "./maps";
import { presetId, readPresets, slotName } from "./presets";
import type { GeissPreset } from "./sim";

/**
 * Geiss's list as the panel shows it — its 25 maps, then the listener's own presets (GEISS.INI)
 * under their heading — for the visualizer (index.ts) and for the panel's search across
 * visualizers, which reads it here without fetching the port.
 */

/** A map in the list: its number and name, "3. Lądowanie". */
export function mapLabel(map: GeissMap): string {
  return `${map.mode}. ${t(map.name)}`;
}

/** The map a saved preset plays, named as the list names it. */
export function presetMapName(preset: GeissPreset): string {
  const map = GEISS_MAPS[preset.mode - 1];
  return map ? mapLabel(map) : String(preset.mode);
}

/** A saved preset in the list: "Preset 07: 3. Lądowanie". */
export function savedPresetLabel(slot: number, preset: GeissPreset): string {
  return t("Preset {slot}: {map}", { slot: slotName(slot), map: presetMapName(preset) });
}

export function geissPresetGroups(saved: ReadonlyMap<number, GeissPreset>): PresetGroup[] {
  const groups: PresetGroup[] = [{ label: "", presets: GEISS_MAPS.map((map) => ({ id: map.id, label: mapLabel(map) })) }];
  if (saved.size) {
    groups.push({
      label: t("Twoje presety (GEISS.INI)"),
      presets: [...saved].map(([slot, preset]) => ({ id: presetId(slot), label: savedPresetLabel(slot, preset) }))
    });
  }
  return groups;
}

/** The list as it stands now: the maps, and the presets saved in this browser. */
export function geissCatalog(): PresetGroup[] {
  let storage: Storage | null = null;
  try {
    storage = localStorage;
  } catch { /* pamięć przeglądarki może być niedostępna */ }
  return geissPresetGroups(readPresets(storage));
}
