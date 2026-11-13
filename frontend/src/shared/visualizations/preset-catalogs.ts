import { formatCount } from "../format";
import { t } from "../i18n";
import { foldText, queryWords, type PickerRow } from "../list-picker-model";
import { FAVORITES_VISUALIZER } from "./favorites-plugin";
import { catalogFromGroups, concurrencyLimit, foundRows, parseMoreValue, prepareCatalog, type PreparedCatalog } from "./preset-search";
import type { VisualizerPlugin } from "./types";

/**
 * The catalogs the panel's search across the visualizers looks in (preset-search.ts), fetched the
 * first time a search needs them — the first key typed in the preset list, never the panel opening
 * — all at once but at most FETCHES_AT_ONCE files at a time (MilkDrop's pack indexes, AVS's index,
 * Shadery's), and kept for the page's life: the next search, in any visualizer, starts with them.
 * A catalog that cannot be had lists nothing; the next search asks for it again.
 */

const FETCHES_AT_ONCE = 4;
const fetches = concurrencyLimit(FETCHES_AT_ONCE);

function fetchJson(url: string): Promise<unknown> {
  return fetches(async () => {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return (await response.json()) as unknown;
  });
}

/** Catalogs by visualizer, folded for searching, for the page's life. */
const kept = new Map<string, Promise<PreparedCatalog>>();

function catalogOf(plugin: VisualizerPlugin): Promise<PreparedCatalog> {
  const cached = plugin.catalogLive ? undefined : kept.get(plugin.id);
  if (cached) return cached;
  const read = plugin.catalog;
  const pending = read
    ? read(fetchJson).then((groups) => prepareCatalog(plugin.id, catalogFromGroups(groups), foldText))
    : Promise.reject(new Error(`No catalog: ${plugin.id}`));
  if (!plugin.catalogLive) {
    kept.set(plugin.id, pending);
    // Not kept when it failed: the next search asks again.
    pending.catch(() => {
      if (kept.get(plugin.id) === pending) kept.delete(plugin.id);
    });
  }
  return pending;
}

/** The visualizers a search looks in: those offered, with a catalog, but the one on screen and "Ulubione". */
export function searchedVisualizers(offered: readonly VisualizerPlugin[], current: string): VisualizerPlugin[] {
  return offered.filter((plugin) => plugin.catalog && plugin.external && plugin.id !== current && plugin.id !== FAVORITES_VISUALIZER);
}

/**
 * One list's search across the visualizers: the catalogs it has asked for and has, the visualizers
 * whose every match it lists, and the time the last keystroke cost (`lastMs`, for measuring).
 */
export class PresetSearch {
  /** Catalogs arrived (null: could not be had), by visualizer; absent while on their way. */
  private readonly found = new Map<string, PreparedCatalog | null>();
  private readonly asked = new Set<string>();
  private readonly expanded = new Set<string>();
  private timer = 0;
  public lastMs = 0;

  /** `onArrive`: catalogs came in, so the list should search again (batched, ~30 ms). */
  public constructor(private readonly onArrive: () => void) {}

  /** The rows below the list's own matches for `query`, or null for no search (nothing typed). */
  public rows(
    query: string,
    offered: readonly VisualizerPlugin[],
    current: string,
    own?: ReadonlySet<string>
  ): { rows: readonly PickerRow[]; matches: number } | null {
    const started = performance.now();
    const words = queryWords(query);
    if (words.length === 0) {
      this.expanded.clear();
      return null;
    }
    const searched = searchedVisualizers(offered, current);
    // The one on screen too, for what its own list does not show: the presets of its other packs
    // (MilkDrop on its built-in presets finds Cream of the Crop's). Only what is not listed above.
    const self = own ? offered.find((plugin) => plugin.id === current && plugin.catalog && plugin.external) : undefined;
    const sources = [...(self ? [self] : []), ...searched];
    for (const plugin of sources) this.ask(plugin);
    const result = foundRows(
      sources.map((plugin) => (plugin === self
        ? { visualizer: plugin.id, label: t("{name}: inne paczki", { name: plugin.label }), catalog: this.found.get(plugin.id) ?? null, exclude: own }
        : { visualizer: plugin.id, label: plugin.label, catalog: this.found.get(plugin.id) ?? null })),
      words,
      {
        expanded: this.expanded,
        pending: sources.some((plugin) => !this.found.has(plugin.id)),
        labels: {
          more: (count) => t("Pokaż jeszcze {count}", { count: formatCount(count) }),
          loading: t("Szukanie w innych wizualizacjach…")
        }
      }
    );
    this.lastMs = performance.now() - started;
    return result;
  }

  /** A "show the rest" row taken: that visualizer lists every match until the search is emptied. */
  public expand(value: string): boolean {
    const visualizer = parseMoreValue(value);
    if (!visualizer) return false;
    this.expanded.add(visualizer);
    return true;
  }

  /** The list closed: the next search starts with nothing expanded, and asks again for what failed or changes. */
  public end(): void {
    this.expanded.clear();
    window.clearTimeout(this.timer);
    this.timer = 0;
    for (const [visualizer, catalog] of [...this.found]) {
      const live = catalog === null || kept.get(visualizer) === undefined;
      if (live) {
        this.found.delete(visualizer);
        this.asked.delete(visualizer);
      }
    }
  }

  private ask(plugin: VisualizerPlugin): void {
    if (this.asked.has(plugin.id)) return;
    this.asked.add(plugin.id);
    const id = plugin.id;
    catalogOf(plugin).then(
      (catalog) => {
        if (this.asked.has(id)) this.found.set(id, catalog);
      },
      (error: unknown) => {
        console.warn("Visualizer search: catalog unavailable", id, error);
        if (this.asked.has(id)) this.found.set(id, null);
      }
    ).finally(() => this.arrived());
  }

  private arrived(): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.onArrive();
    }, 30);
  }
}
