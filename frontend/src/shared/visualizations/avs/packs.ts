import type { PackIndex, PackInfo, PackPreset, PoolLabels } from "../milkdrop-packs";
import type { PresetPool } from "../types";

/**
 * The AVS packs a build converted from vendor/avs-presets (scripts/avs-presets.mjs): one index
 * for all of them, and chunks of presets fetched when one of them is about to play. The pools,
 * lists and chunk cache are MilkDrop's (milkdrop-packs.ts); what differs is that AVS has no
 * presets of its own beside the packs, so "every pack" is where it starts, and that a preset
 * keeps the name it had before there were packs.
 *
 * Pure logic with no imports at run time (node --test reads it as it is): index.ts fetches and
 * draws. The pool ids are milkdrop-packs.ts's, which packs.test.ts holds them to.
 */

/** Every pack together (milkdrop-packs.ts ALL_POOL). */
export const ALL_POOL = "all";
/**
 * Presets that would not build on this browser, remembered (index.ts) and left out of the list.
 * ":2" since the effect ports (07.11.2026): presets remembered as broken got another chance.
 */
export const FAILED_KEY = "media-visualizer-failed-avs:2";

/** The ids FAILED_KEY holds, from its stored text; nothing readable, none. */
export function storedFailures(stored: string | null): string[] {
  try {
    const value: unknown = JSON.parse(stored ?? "[]");
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}
const BUILTIN_POOL = "builtin";
const POOL = /^pack:([^/]+)(?:\/(.+))?$/;

/** The build's index: every pack's chunks (relative to the index) and its presets by group. */
export interface AvsIndex {
  packs: Record<string, PackIndex>;
}

/**
 * What a preset is called: its name, then its pack and folders after a dash
 * ("Name — Anthology / 01 - Mirror Us CD1") — the name presets had when the build made one
 * list of them, kept by favourites and the remembered choice (scripts/avs-presets.mjs presetId).
 */
export function presetId(name: string, pack: string, folder = ""): string {
  const where = [pack, ...folder.split("/")].filter(Boolean).join(" / ");
  return where ? `${name} — ${where}` : name;
}

function isIndex(value: unknown): value is AvsIndex {
  const index = value as AvsIndex | null;
  return Boolean(index && typeof index.packs === "object" && index.packs !== null);
}

/** Every pack's presets from the build's index, chunk names resolved next to it. */
export function avsPackPresets(packs: readonly PackInfo[], index: unknown, indexUrl: string): Map<string, PackPreset[]> {
  if (!isIndex(index)) throw new Error("AVS preset index unreadable");
  const folder = indexUrl.slice(0, indexUrl.lastIndexOf("/") + 1);
  const result = new Map<string, PackPreset[]>();
  for (const pack of packs) {
    const entry = index.packs[pack.id];
    const presets: PackPreset[] = [];
    for (const group of entry?.groups ?? []) {
      for (const [name, chunk] of group.presets) {
        const file = entry!.chunks[chunk];
        if (typeof name !== "string" || typeof file !== "string") continue;
        presets.push({
          id: presetId(name, pack.name, group.folder),
          name,
          pack: pack.id,
          category: group.category,
          group: group.group,
          key: group.folder ? `${group.folder}/${name}` : name,
          chunk: folder + file
        });
      }
    }
    result.set(pack.id, presets);
  }
  return result;
}

/** A pool the build offers, or every pack: the pool AVS starts with, and MilkDrop's "butterchurn's own" here. */
export function avsPool(id: string | null, packs: readonly PackInfo[]): string {
  if (!id || id === BUILTIN_POOL) return ALL_POOL;
  if (id === ALL_POOL) return ALL_POOL;
  const match = POOL.exec(id);
  const pack = match ? packs.find((candidate) => candidate.id === match[1]) : undefined;
  if (!match || !pack) return ALL_POOL;
  return match[2] === undefined || pack.categories.some((category) => category.name === match[2]) ? id : ALL_POOL;
}

const poolOf = (pack: string, category?: string): string => (category ? `pack:${pack}/${category}` : `pack:${pack}`);

/**
 * What the pack choice offers: every pack together first — where AVS starts, as it did before
 * packs — then each pack; one with several categories (an author's packs) last, under its own
 * heading. Nothing at all with a single pack: then there is nothing to choose.
 */
export function avsPoolOptions(packs: readonly PackInfo[], labels: Omit<PoolLabels, "builtin">): PresetPool[] {
  if (packs.length < 2) return [];
  const counted = (label: string, count: number): string => `${label} (${labels.count(count)})`;
  const pools: PresetPool[] = [{ id: ALL_POOL, label: counted(labels.all, packs.reduce((total, pack) => total + pack.count, 0)) }];
  const headed: PresetPool[] = [];
  for (const pack of packs) {
    const name = labels.pack(pack);
    const categories = pack.categories.filter((category) => category.name);
    if (categories.length < 2) {
      pools.push({ id: poolOf(pack.id), label: counted(name, pack.count) });
      continue;
    }
    headed.push({ id: poolOf(pack.id), label: counted(labels.allCategories, pack.count), group: name });
    for (const category of categories) {
      headed.push({ id: poolOf(pack.id, category.name), label: counted(category.name, category.count), group: name });
    }
  }
  return [...pools, ...headed];
}
