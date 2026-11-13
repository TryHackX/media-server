import { t } from "../../i18n";
import { storedIds } from "../preset-search";
import type { PresetGroup } from "../types";
import type { ShaderEntry, ShaderIndex } from "./types";

/**
 * Shadery's list as the panel shows it — the names, the order, the headings — for the visualizer
 * (index.ts) and for the panel's search across visualizers, which reads it here from the build's
 * index without fetching the runner.
 */

/** Shaders this browser would not compile, by URL, remembered (index.ts) and left out of the list. */
export const FAILED_KEY = "media-visualizer-failed-shaders";

/** The headings, in the list's order. */
export const SHADER_GROUPS = ["volts-audio", "volts-vertex", "volts-fx", "volts-ambient", "mv"] as const;

export function shaderGroupLabel(group: string): string {
  switch (group) {
    case "volts-audio": return t("Monkey Hi Hat — reagują na muzykę");
    case "volts-vertex": return "Monkey Hi Hat — VertexShaderArt";
    case "volts-fx": return t("Monkey Hi Hat — efekty na losowej wizualizacji");
    case "volts-ambient": return t("Monkey Hi Hat — bez reakcji na muzykę");
    default: return "music_visualizer (Bradley Bauer)";
  }
}

/** A shader in the list: its name, Volt's Laboratory's with its authors. */
export function shaderLabel(entry: ShaderEntry): string {
  return entry.authors.length && entry.source === "volts" ? `${entry.name} (${entry.authors.join(", ")})` : entry.name;
}

/**
 * The shaders the build has (not those it lists as missing), by id, and in the list's order: by
 * heading, then by name.
 */
export function shaderListing(index: ShaderIndex): { entries: Map<string, ShaderEntry>; ordered: ShaderEntry[] } {
  const entries = new Map<string, ShaderEntry>();
  for (const entry of index.presets) if (!(entry as ShaderEntry & { missing?: string }).missing) entries.set(entry.id, entry);
  const rank = (entry: ShaderEntry): number => SHADER_GROUPS.indexOf(entry.group as typeof SHADER_GROUPS[number]);
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const ordered = [...entries.values()].sort((left, right) => rank(left) - rank(right) || collator.compare(shaderLabel(left), shaderLabel(right)));
  return { entries, ordered };
}

/** The list: the shaders of `ordered` that `ids` has, under their headings. */
export function shaderPresetGroups(ordered: readonly ShaderEntry[], ids: ReadonlySet<string>): PresetGroup[] {
  return SHADER_GROUPS.map((group) => ({
    label: shaderGroupLabel(group),
    presets: ordered.filter((entry) => entry.group === group && ids.has(entry.id)).map((entry) => ({ id: entry.id, label: shaderLabel(entry) }))
  })).filter((group) => group.presets.length > 0);
}

/** For the panel's search: every shader the build has, as the list names it with every source, those that failed here left out. */
export function shaderSearchCatalog(index: unknown): PresetGroup[] {
  const presets = (index as Partial<ShaderIndex> | null)?.presets;
  if (!Array.isArray(presets)) throw new Error("Shader index unreadable");
  const { ordered } = shaderListing(index as ShaderIndex);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FAILED_KEY);
  } catch { /* pamięć przeglądarki może być niedostępna */ }
  const failed = new Set(storedIds(stored));
  return shaderPresetGroups(ordered, new Set(ordered.filter((entry) => !failed.has(entry.url)).map((entry) => entry.id)));
}
