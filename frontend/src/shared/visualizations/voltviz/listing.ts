import extraCatalog from "virtual:voltviz-extra";
import logoFiles from "virtual:voltviz-logos";

import { t } from "../../i18n";
import { storedIds } from "../preset-search";
import type { PresetGroup } from "../types";
import { voltvizCatalog, type VoltVizEntry } from "./catalog";
import { halftoneVariants, type HalftoneVariant } from "./halftone";

/**
 * VoltViz's list as the panel shows it — the names, the order, the headings over Halftone Pulse's
 * choices — for the visualizer (index.ts) and for the panel's search across visualizers, which
 * reads it here without fetching voltviz itself.
 */

export const HALFTONE = "halftonepulse";
/** Visualizations that would not start on this browser, remembered (index.ts) and left out of the list. */
export const FAILED_KEY = "media-visualizer-failed-voltviz";

/** What the list needs of an entry: its names, its heading, what it is a choice of. */
export type ListedEntry = Pick<VoltVizEntry, "id" | "name" | "webgpu" | "label" | "family" | "variantOf" | "group">;

let webgpuCheck: Promise<boolean> | null = null;

/** Whether the browser hands out a WebGPU adapter (asked once per page). */
export function webgpuAvailable(): Promise<boolean> {
  webgpuCheck ??= (async (): Promise<boolean> => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    try {
      const adapter = await Promise.race([
        gpu.requestAdapter(),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 3000))
      ]);
      return Boolean(adapter);
    } catch {
      return false;
    }
  })();
  return webgpuCheck;
}

/** One of Halftone Pulse's choices as the list names it, after Halftone Pulse. */
export function halftoneListed(variant: HalftoneVariant): ListedEntry & { variantOf: string } {
  return { id: variant.id, name: variant.name, label: variant.label, group: variant.group, variantOf: HALFTONE };
}

/** Your Logo with one of the owner's logos, as the list names it; Auto deals them as one card. */
export function logoListed(logo: { id: string; name: string }): ListedEntry {
  return { id: logo.id, name: `Your Logo: ${logo.name}`, label: () => t("Twoje logo: {name}", { name: logo.name }), family: "yourlogo" };
}

/**
 * The entries by id — a raw WebGPU one named for what draws it on this browser, "Pulsar (WebGPU)"
 * or "Pulsar (WebGL)" — and the list's order: alphabetical, each visualization followed by its
 * choices in their own order.
 */
export function voltvizListing<T extends ListedEntry>(catalog: readonly T[], webgpu: boolean): { entries: Map<string, T>; ids: string[] } {
  const entries = new Map<string, T>();
  for (const entry of catalog) {
    entries.set(entry.id, entry.webgpu ? { ...entry, name: `${entry.name} (${webgpu ? "WebGPU" : "WebGL"})` } : entry);
  }
  const listed = [...entries.values()];
  const ids = listed
    .filter((entry) => !entry.variantOf)
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => [entry.id, ...listed.filter((variant) => variant.variantOf === entry.id).map((variant) => variant.id)]);
  return { entries, ids };
}

/** One list without headings, but for the choices of a visualization (Halftone Pulse's modes and shapes), each kind under its own. */
export function voltvizGroups(ids: readonly string[], entries: ReadonlyMap<string, ListedEntry>): PresetGroup[] {
  const groups: { label: string; presets: { id: string; label: string }[] }[] = [];
  for (const id of ids) {
    const entry = entries.get(id);
    const heading = entry?.group?.() ?? "";
    let group = groups.at(-1);
    if (!group || group.label !== heading) {
      group = { label: heading, presets: [] };
      groups.push(group);
    }
    group.presets.push({ id, label: entry?.label?.() ?? entry?.name ?? id });
  }
  return groups;
}

/** For the panel's search: VoltViz's whole list as it shows it on this browser, what failed here left out. */
export async function voltvizSearchCatalog(): Promise<PresetGroup[]> {
  const webgpu = await webgpuAvailable();
  const { entries, ids } = voltvizListing<ListedEntry>([
    ...voltvizCatalog, ...halftoneVariants().map(halftoneListed), ...extraCatalog, ...logoFiles.map(logoListed)
  ], webgpu);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FAILED_KEY);
  } catch { /* pamięć przeglądarki może być niedostępna */ }
  const failed = new Set(storedIds(stored));
  return voltvizGroups(ids.filter((id) => !failed.has(id)), entries);
}
