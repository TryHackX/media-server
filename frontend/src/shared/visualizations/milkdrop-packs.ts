import type { PresetGroup, PresetPool } from "./types";

/**
 * The MilkDrop packs a build converted from vendor/milkdrop-presets
 * (scripts/milkdrop-presets.mjs), as the visualizer offers them beside
 * butterchurn's own presets.
 *
 * A "pool" is what the listener plays from — butterchurn's presets, one pack,
 * one category of a pack, or everything — and it decides both what the preset
 * list shows and what "Auto" draws. butterchurn's presets keep their names as
 * ids, exactly as before the packs existed; a pack's preset is `pack:path`, so
 * the two never collide and a pack can repeat a name butterchurn has.
 *
 * Pure logic, testable without a browser: milkdrop.ts fetches and translates.
 */

/** What the build lists for one pack. */
export interface PackInfo {
  id: string;
  name: string;
  count: number;
  /** URL of the pack's index. */
  index: string;
  categories: readonly { name: string; count: number }[];
}

/** A pack's index file: chunk files, and every preset by category and group. */
export interface PackIndex {
  chunks: readonly string[];
  groups: readonly {
    category: string;
    group: string;
    folder: string;
    presets: readonly (readonly [name: string, chunk: number])[];
  }[];
}

/** One preset of a pack, with what the list shows and where its data is. */
export interface PackPreset {
  id: string;
  name: string;
  pack: string;
  category: string;
  group: string;
  /** Its key inside the chunk. */
  key: string;
  /** URL of the chunk holding it. */
  chunk: string;
}

/** butterchurn's presets, which every build has. */
export const BUILTIN_POOL = "builtin";
/** butterchurn's presets and every pack together. */
export const ALL_POOL = "all";

export function packPool(pack: string, category?: string): string {
  return category ? `pack:${pack}/${category}` : `pack:${pack}`;
}

type Pool = { kind: "builtin" } | { kind: "all" } | { kind: "pack"; pack: string; category: string | null };

export function parsePool(id: string, packs: readonly PackInfo[]): Pool | null {
  if (id === BUILTIN_POOL) return { kind: "builtin" };
  if (id === ALL_POOL) return packs.length ? { kind: "all" } : null;
  const match = /^pack:([^/]+)(?:\/(.+))?$/.exec(id);
  const pack = match ? packs.find((candidate) => candidate.id === match[1]) : undefined;
  if (!match || !pack) return null;
  const category = match[2] ?? null;
  if (category !== null && !pack.categories.some((candidate) => candidate.name === category)) return null;
  return { kind: "pack", pack: pack.id, category };
}

/**
 * The pool a preset is at home in — butterchurn's presets, or its pack whole — for a preset to
 * start on that the pool chosen does not have (the panel's search found it elsewhere); null for
 * one nobody has. A pack preset's id is `pack:path`, so its pack is the longest pack id it starts
 * with followed by ":".
 */
export function presetPool(id: string, builtin: readonly string[], packs: readonly PackInfo[]): string | null {
  if (builtin.includes(id)) return BUILTIN_POOL;
  let home: PackInfo | null = null;
  for (const pack of packs) {
    if (id.startsWith(`${pack.id}:`) && id.length > pack.id.length + 1 && (!home || pack.id.length > home.id.length)) home = pack;
  }
  return home ? packPool(home.id) : null;
}

/**
 * butterchurn's preset names from butterchurn-presets' presetPackMeta (30 kB) instead of its
 * presets (3.4 MB): the names of the image, base, extra and md1 packs MilkDrop loads, each once.
 * The module is a UMD bundle; its functions sit under up to three `default`s. Nothing readable
 * there: no names.
 */
export function builtinPresetNames(meta: unknown): string[] {
  let value: unknown = meta;
  for (let depth = 0; depth < 3 && value && typeof value === "object" && !("getBasePresetKeys" in value) && "default" in value; depth += 1) {
    value = (value as { default: unknown }).default;
  }
  const lists = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const names = new Set<string>();
  for (const key of ["getImagePresetKeys", "getBasePresetKeys", "getExtraPresetKeys", "getMD1PresetKeys"]) {
    const read = lists[key];
    if (typeof read !== "function") continue;
    const presets = (read as () => { presets?: unknown }).call(lists)?.presets;
    if (Array.isArray(presets)) for (const name of presets) if (typeof name === "string") names.add(name);
  }
  return [...names];
}

/** The packs whose index a pool needs. */
export function poolPacks(id: string, packs: readonly PackInfo[]): string[] {
  const pool = parsePool(id, packs);
  if (pool?.kind === "all") return packs.map((pack) => pack.id);
  return pool?.kind === "pack" ? [pool.pack] : [];
}

function isIndex(value: unknown): value is PackIndex {
  const index = value as PackIndex | null;
  return Boolean(index && Array.isArray(index.chunks) && Array.isArray(index.groups)
    && index.groups.every((group) => group && typeof group.folder === "string" && Array.isArray(group.presets)));
}

/** A pack's presets from its index, chunk names resolved next to the index. */
export function packPresets(pack: PackInfo, index: unknown): PackPreset[] {
  if (!isIndex(index)) throw new Error(`MilkDrop pack index unreadable: ${pack.id}`);
  const folder = pack.index.slice(0, pack.index.lastIndexOf("/") + 1);
  const presets: PackPreset[] = [];
  for (const group of index.groups) {
    for (const [name, chunk] of group.presets) {
      const file = index.chunks[chunk];
      if (typeof name !== "string" || typeof file !== "string") continue;
      const key = group.folder ? `${group.folder}/${name}` : name;
      presets.push({ id: `${pack.id}:${key}`, name, pack: pack.id, category: group.category, group: group.group, key, chunk: folder + file });
    }
  }
  return presets;
}

export interface PoolLabels {
  builtin: string;
  all: string;
  allCategories: string;
  pack(pack: PackInfo): string;
  count(value: number): string;
}

/**
 * What the pack choice offers: butterchurn's presets first — the default, and
 * what the visualizer played before there were packs — then everything
 * together, then each pack. A pack with several categories comes last, under
 * its own heading, so that no plain choice follows a heading and seems to
 * belong to it. Nothing at all without packs: then there is nothing to choose.
 */
export function poolOptions(packs: readonly PackInfo[], builtinCount: number, labels: PoolLabels): PresetPool[] {
  if (packs.length === 0) return [];
  const counted = (label: string, count: number): string => `${label} (${labels.count(count)})`;
  const pools: PresetPool[] = [
    { id: BUILTIN_POOL, label: counted(labels.builtin, builtinCount) },
    { id: ALL_POOL, label: counted(labels.all, builtinCount + packs.reduce((total, pack) => total + pack.count, 0)) }
  ];
  const headed: PresetPool[] = [];
  for (const pack of packs) {
    const name = labels.pack(pack);
    const categories = pack.categories.filter((category) => category.name);
    if (categories.length < 2) {
      pools.push({ id: packPool(pack.id), label: counted(name, pack.count) });
      continue;
    }
    headed.push({ id: packPool(pack.id), label: counted(labels.allCategories, pack.count), group: name });
    for (const category of categories) {
      headed.push({ id: packPool(pack.id, category.name), label: counted(category.name, category.count), group: name });
    }
  }
  return [...pools, ...headed];
}

const joined = (...parts: string[]): string => parts.filter(Boolean).join(" · ");

/**
 * A pool's presets as the list shows them: under the headings of their
 * category and group (only as much of it as the pool does not already say),
 * leaving out the ones in `excluded`. butterchurn's presets alone stay one
 * plain list, as they always were.
 */
export function poolGroups(
  id: string,
  builtin: readonly string[],
  packs: readonly PackInfo[],
  loaded: ReadonlyMap<string, readonly PackPreset[]>,
  labels: Pick<PoolLabels, "builtin" | "pack">,
  excluded: ReadonlySet<string> = new Set()
): PresetGroup[] {
  const pool = parsePool(id, packs) ?? { kind: "builtin" };
  const groups: { label: string; presets: { id: string; label: string }[] }[] = [];
  const add = (label: string, presetId: string, name: string): void => {
    if (excluded.has(presetId)) return;
    if (groups.at(-1)?.label !== label) groups.push({ label, presets: [] });
    groups.at(-1)!.presets.push({ id: presetId, label: name });
  };
  if (pool.kind !== "pack") {
    for (const name of builtin) add(pool.kind === "all" ? labels.builtin : "", name, name);
  }
  if (pool.kind === "builtin") return groups;
  for (const pack of packs) {
    if (pool.kind === "pack" && pack.id !== pool.pack) continue;
    for (const preset of loaded.get(pack.id) ?? []) {
      if (pool.kind === "pack" && pool.category !== null && preset.category !== pool.category) continue;
      const label = pool.kind === "all"
        ? joined(labels.pack(pack), preset.category, preset.group)
        : pool.category === null ? joined(preset.category, preset.group) : preset.group;
      add(label, preset.id, preset.name);
    }
  }
  return groups;
}

interface CompactShape {
  baseVals?: Record<string, number>;
  init_eqs_eel?: string;
  frame_eqs_eel?: string;
}

interface CompactWave extends CompactShape {
  point_eqs_eel?: string;
}

/** A preset as stored in a chunk: defaults and empty equations left out (scripts/milkdrop-convert.mjs). */
interface CompactPreset {
  version?: number;
  baseVals?: Record<string, number>;
  shapes?: (CompactShape | null)[];
  waves?: (CompactWave | null)[];
  init_eqs_eel?: string;
  frame_eqs_eel?: string;
  pixel_eqs_eel?: string;
  warp?: string;
  comp?: string;
  /** What the patched engine reads besides (scripts/butterchurn-patches.mjs): BeatDrop's variables, get_fft()'s smoothing. */
  md?: object;
}

/** BeatDrop and MilkDrop 3 have up to 16 custom shapes and waves; butterchurn's own presets have 4. */
export const MAX_CUSTOM = 16;

/** How many shapes or waves a preset is given: 4 as always, more when it has them. */
const customCount = (list: readonly unknown[] | undefined): number => Math.max(4, Math.min(MAX_CUSTOM, list?.length ?? 0));

/** How a MilkDrop 3 double preset blends its halves (scripts/milkdrop-convert.mjs splitMilk2). */
export interface DoubleBlend {
  pattern: string;
  progress: number;
  direction: number;
  randoms: readonly number[];
}

/** A MilkDrop 3 double preset (`.milk2`), its halves as butterchurn takes presets. */
export interface DoublePreset {
  double: { first: object; second: object; blend: DoubleBlend };
}

export function isDoublePreset(preset: unknown): preset is DoublePreset {
  const double = (preset as Partial<DoublePreset> | null)?.double;
  return Boolean(double && typeof double === "object" && double.first && double.second && double.blend);
}

/**
 * The full shape butterchurn 3 expects: four shapes and four waves (or up to 16), every equation
 * field present — for a double preset, each half so.
 */
export function hydratePreset(value: unknown): object {
  if (isDoublePreset(value)) {
    return { double: { first: hydratePreset(value.double.first), second: hydratePreset(value.double.second), blend: value.double.blend } };
  }
  const preset = (value && typeof value === "object" ? value : {}) as CompactPreset;
  const shapes = Array.from({ length: customCount(preset.shapes) }, (_, index) => {
    const shape: CompactShape = preset.shapes?.[index] ?? {};
    return { baseVals: shape.baseVals ?? { enabled: 0 }, init_eqs_eel: shape.init_eqs_eel ?? "", frame_eqs_eel: shape.frame_eqs_eel ?? "" };
  });
  const waves = Array.from({ length: customCount(preset.waves) }, (_, index) => {
    const wave: CompactWave = preset.waves?.[index] ?? {};
    return {
      baseVals: wave.baseVals ?? { enabled: 0 },
      init_eqs_eel: wave.init_eqs_eel ?? "",
      frame_eqs_eel: wave.frame_eqs_eel ?? "",
      point_eqs_eel: wave.point_eqs_eel ?? ""
    };
  });
  return {
    version: preset.version ?? 2,
    baseVals: preset.baseVals ?? {},
    shapes,
    waves,
    init_eqs_eel: preset.init_eqs_eel ?? "",
    frame_eqs_eel: preset.frame_eqs_eel ?? "",
    pixel_eqs_eel: preset.pixel_eqs_eel ?? "",
    warp: preset.warp ?? "",
    comp: preset.comp ?? "",
    ...(preset.md ? { md: preset.md } : {})
  };
}

/**
 * Chunks by URL, the most recent `limit` of them kept: auto mode visits a
 * different chunk nearly every time, and an hour of it would otherwise keep
 * every one it ever fetched. A fetch that failed is tried again next time.
 */
export function chunkLoader(fetchJson: (url: string) => Promise<unknown>, limit = 12): (url: string) => Promise<Record<string, unknown>> {
  const cache = new Map<string, Promise<Record<string, unknown>>>();
  return (url) => {
    const kept = cache.get(url);
    if (kept) {
      cache.delete(url);
      cache.set(url, kept);
      return kept;
    }
    const loading = fetchJson(url).then((value) => {
      if (!value || typeof value !== "object") throw new Error(`MilkDrop chunk unreadable: ${url}`);
      return value as Record<string, unknown>;
    });
    loading.catch(() => {
      if (cache.get(url) === loading) cache.delete(url);
    });
    cache.set(url, loading);
    while (cache.size > limit) cache.delete(cache.keys().next().value!);
    return loading;
  };
}
