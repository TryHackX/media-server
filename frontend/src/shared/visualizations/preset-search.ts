import type { PickerHeading, PickerOption, PickerRow } from "../list-picker-model";
import type { PresetCatalogEntry, PresetGroup } from "./types";

/**
 * The panel's search across the visualizers (11.11.2026): typing in the preset list also finds the
 * presets of every other visualizer the panel offers, under a heading per visualizer below the
 * list's own matches. This is its arithmetic, apart from the DOM and the fetching
 * (preset-catalogs.ts), so it can be tested on its own: a catalog folded once, what a query leaves
 * of each, capped, and the rows the list shows for them.
 *
 * Imports types only (node --test reads it as it is). The folding is handed in: list-picker-model's
 * foldText, so a word matches here exactly as it matches in the list's own search ("lodz" finds
 * "Łódź"), and every word has to be found, in the name or in the heading over it.
 */

/** How many matches a visualizer lists before "show the rest"… */
export const FOREIGN_LIMIT = 50;
/** …unless no more than this many would be left out: then those are listed too. */
export const FOREIGN_SLACK = 10;

/**
 * A found preset's value in the list, and the "show the rest" row's: control characters no
 * preset id starts with, so neither is ever taken for one of the visualizer's own presets, nor
 * for the same id in another visualizer (Internal and VoltViz both have a "kaleidoscope").
 */
const FOUND = "\u0000";
const MORE = "\u0001";

export function foundValue(visualizer: string, preset: string): string {
  return `${FOUND}${visualizer}${FOUND}${preset}`;
}

/** The visualizer and preset a found row stands for; null for any other value. */
export function parseFoundValue(value: string): { visualizer: string; preset: string } | null {
  if (!value.startsWith(FOUND)) return null;
  const split = value.indexOf(FOUND, 1);
  if (split < 2) return null;
  return { visualizer: value.slice(1, split), preset: value.slice(split + 1) };
}

export function moreValue(visualizer: string): string {
  return `${MORE}${visualizer}`;
}

/** The visualizer whose rest a "show the rest" row lists; null for any other value. */
export function parseMoreValue(value: string): string | null {
  return value.startsWith(MORE) && value.length > 1 ? value.slice(1) : null;
}

/**
 * The ids a visualizer keeps in the browser's storage as a JSON list (the presets that failed
 * there, which its list leaves out, and so does its catalog); nothing readable, none.
 */
export function storedIds(stored: string | null): string[] {
  try {
    const value: unknown = JSON.parse(stored ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** A visualizer's list as its catalog: each preset under the heading it has there. */
export function catalogFromGroups(groups: readonly PresetGroup[]): PresetCatalogEntry[] {
  const entries: PresetCatalogEntry[] = [];
  for (const group of groups) {
    for (const preset of group.presets) {
      entries.push(group.label ? { id: preset.id, label: preset.label, group: group.label } : { id: preset.id, label: preset.label });
    }
  }
  return entries;
}

/** A catalog ready to be searched: what it lists, folded once. */
export interface PreparedCatalog {
  visualizer: string;
  ids: readonly string[];
  labels: readonly string[];
  /** The heading over each, "" for none. */
  groups: readonly string[];
  foldedLabels: readonly string[];
  foldedGroups: readonly string[];
  /** Each entry's row, made the first time it is listed and kept: the list redraws only rows that changed. */
  rows: (PickerOption | undefined)[];
}

/**
 * A catalog folded for searching. An entry without an id or a name is left out, and an id listed
 * twice is listed once (the first time), as the list would choose it. A heading shared by many
 * presets (a pack's) is folded once.
 */
export function prepareCatalog(
  visualizer: string,
  entries: readonly PresetCatalogEntry[],
  fold: (text: string) => string
): PreparedCatalog {
  const ids: string[] = [];
  const labels: string[] = [];
  const groups: string[] = [];
  const foldedLabels: string[] = [];
  const foldedGroups: string[] = [];
  const seen = new Set<string>();
  const foldedHeadings = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.label !== "string" || !entry.label) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const group = typeof entry.group === "string" ? entry.group : "";
    let foldedGroup = foldedHeadings.get(group);
    if (foldedGroup === undefined) {
      foldedGroup = fold(group);
      foldedHeadings.set(group, foldedGroup);
    }
    ids.push(entry.id);
    labels.push(entry.label);
    groups.push(group);
    foldedLabels.push(fold(entry.label));
    foldedGroups.push(foldedGroup);
  }
  return { visualizer, ids, labels, groups, foldedLabels, foldedGroups, rows: new Array<PickerOption | undefined>(ids.length) };
}

export interface CatalogMatches {
  /** Every entry the query leaves. */
  total: number;
  /** The ones listed (indices into the catalog), at most the limit asked for. */
  shown: readonly number[];
}

/**
 * The entries a query leaves: each word ("words" as list-picker-model's queryWords gives them) in
 * the name or in the heading over it. Those found by their name alone come first — "dancer" lists
 * the presets called so before the hundreds under Cream of the Crop's "Dancer" — each kind in the
 * catalog's order. All are counted, at most `limit` of them listed.
 */
export function matchCatalog(
  catalog: PreparedCatalog,
  words: readonly string[],
  limit = Number.POSITIVE_INFINITY,
  exclude?: ReadonlySet<string>
): CatalogMatches {
  const byName: number[] = [];
  const byHeading: number[] = [];
  const { foldedLabels, foldedGroups } = catalog;
  const count = foldedLabels.length;
  const wordCount = words.length;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const label = foldedLabels[index]!;
    let viaHeading = false;
    let found = true;
    for (let at = 0; at < wordCount; at += 1) {
      const word = words[at]!;
      if (label.includes(word)) continue;
      if (foldedGroups[index]!.includes(word)) {
        viaHeading = true;
        continue;
      }
      found = false;
      break;
    }
    if (!found || exclude?.has(catalog.ids[index]!)) continue;
    total += 1;
    if (!viaHeading) {
      if (byName.length < limit) byName.push(index);
    } else if (byHeading.length < limit) {
      byHeading.push(index);
    }
  }
  const shown = byName.length >= limit ? byName : byName.concat(byHeading.slice(0, Math.max(0, limit - byName.length)));
  return { total, shown };
}

/** How many of a visualizer's matches are listed: all when expanded or within the limit and its slack. */
export function listedCount(total: number, expanded: boolean, limit = FOREIGN_LIMIT, slack = FOREIGN_SLACK): number {
  if (expanded || total <= limit + slack) return total;
  return limit;
}

/** One visualizer the search looks in: its id, its name in the panel, and its catalog once there. */
export interface FoundSource {
  visualizer: string;
  label: string;
  /** Null while its catalog is on its way, or when it could not be had. */
  catalog: PreparedCatalog | null;
  /** Entries left out — the visualizer's own list already shows them (its other packs' search). */
  exclude?: ReadonlySet<string>;
}

export interface FoundLabels {
  /** The row under a capped visualizer: "Pokaż jeszcze {count}". */
  more(count: number): string;
  /** The note while catalogs are still on their way. */
  loading: string;
}

export interface FoundRows {
  rows: PickerRow[];
  /** Presets found in all the visualizers, the ones not listed too. */
  matches: number;
}

function foundRow(catalog: PreparedCatalog, index: number): PickerOption {
  let row = catalog.rows[index];
  if (!row) {
    const group = catalog.groups[index]!;
    row = { kind: "option", value: foundValue(catalog.visualizer, catalog.ids[index]!), label: catalog.labels[index]!, grouped: true };
    if (group) row.detail = group;
    catalog.rows[index] = row;
  }
  return row;
}

/**
 * The rows below the list's own matches: for each visualizer with any (in the order given), its
 * name as a heading and its matches, the heading each has in its own list beside it; under a capped
 * one, a row that lists the rest. While catalogs are still on their way, a note says so at the end.
 */
export function foundRows(
  sources: readonly FoundSource[],
  words: readonly string[],
  options: { expanded?: ReadonlySet<string>; pending?: boolean; labels: FoundLabels; limit?: number; slack?: number }
): FoundRows {
  const rows: PickerRow[] = [];
  let matches = 0;
  if (words.length === 0) return { rows, matches };
  const limit = options.limit ?? FOREIGN_LIMIT;
  const slack = options.slack ?? FOREIGN_SLACK;
  for (const source of sources) {
    const catalog = source.catalog;
    if (!catalog) continue;
    const expanded = options.expanded?.has(source.visualizer) ?? false;
    const found = matchCatalog(catalog, words, expanded ? Number.POSITIVE_INFINITY : limit + slack, source.exclude);
    if (found.total === 0) continue;
    matches += found.total;
    const listed = listedCount(found.total, expanded, limit, slack);
    const heading: PickerHeading = { kind: "heading", label: source.label, section: true };
    rows.push(heading);
    for (let at = 0; at < listed; at += 1) rows.push(foundRow(catalog, found.shown[at]!));
    if (listed < found.total) {
      rows.push({ kind: "option", value: moreValue(source.visualizer), label: options.labels.more(found.total - listed), grouped: true, action: true });
    }
  }
  if (options.pending) rows.push({ kind: "note", label: options.labels.loading });
  return { rows, matches };
}

/**
 * At most `max` of the tasks handed over running at once; the others start in the order given as
 * places free up. A task that fails frees its place as one that succeeds does.
 */
export function concurrencyLimit(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    running -= 1;
    waiting.shift()?.();
  };
  return <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const start = (): void => {
      running += 1;
      let pending: Promise<T>;
      try {
        pending = task();
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(resolve, reject).finally(release);
    };
    if (running < limit) start();
    else waiting.push(start);
  });
}
