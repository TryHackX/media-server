import { t } from "../i18n";
import { favoriteEntries, onFavoritesChange } from "./favorites";
import { presetDeck } from "./milkdrop";
import type { ExternalOptions, ExternalVisualizer, PresetGroup, VisualizerPlugin } from "./types";

/**
 * "Ulubione": the favourite presets of every visualizer the panel offers, played in turn.
 *
 * An entry is a visualizer and one of its presets. Playing one opens that visualizer the way the
 * panel would — its own factory, its own renderer — on that preset, remembering nothing of it as
 * the visualizer's choice (ExternalOptions.preset and persist). The next favourite of the same
 * visualizer is that visualizer's own change (MilkDrop blends, AVS fades); one of another
 * visualizer loads above the one on screen, unseen, and fades in once it has drawn. A favourite
 * the visualizer no longer has (a pack taken away), or a visualizer that will not start, is
 * passed over for this visit.
 */

const AUTO = "auto";
const AUTO_SECONDS = 30;
/** The fade between two visualizers (panels.css, .favorites-stage__layer). */
const FADE_MS = 1000;
/** Between the visualizer and the preset in an entry's id; neither may hold a control character. */
const SEPARATOR = "\u001f";
const STORAGE_KEY = "media-visualizer-preset:favorites";

interface Entry {
  id: string;
  visualizer: string;
  preset: string;
  label: string;
}

/** One visualizer playing favourites of its own. */
interface Engine {
  plugin: VisualizerPlugin;
  layer: HTMLDivElement;
  renderer: ExternalVisualizer | null;
  /** The entry it was opened for, or last asked to play. */
  entry: string;
  /** It has drawn a frame since it was ready (a fade may start). */
  drawn: boolean;
  fadeAt: number;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* pamięć przeglądarki może być niedostępna */ }
}

export function entryId(visualizer: string, preset: string): string {
  return visualizer + SEPARATOR + preset;
}

export async function createFavorites(analyser: AnalyserNode, options: ExternalOptions = {}): Promise<ExternalVisualizer> {
  const sources = (options.sources ?? []).filter((plugin) => plugin.external);
  const stage = document.createElement("div");
  stage.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl favorites-stage";
  const empty = document.createElement("p");
  empty.className = "favorites-stage__empty";
  empty.textContent = t("Brak ulubionych presetów. Dodaj je gwiazdką w dowolnej wizualizacji — tutaj zagrają wszystkie po kolei.");
  stage.append(empty);

  /** Visualizers that would not start, and favourites they no longer have: passed over. */
  const unavailable = new Set<string>();
  let entries: Entry[] = [];
  let byId = new Map<string, Entry>();
  let deal = presetDeck([]);
  let stale = true;
  const refresh = (): void => {
    if (!stale) return;
    stale = false;
    entries = sources.flatMap((plugin) => unavailable.has(plugin.id) ? [] : favoriteEntries(plugin.id)
      .map((favorite) => ({
        id: entryId(plugin.id, favorite.id), visualizer: plugin.id, preset: favorite.id,
        label: favorite.label || favorite.id
      }))
      .filter((entry) => !unavailable.has(entry.id)));
    byId = new Map(entries.map((entry) => [entry.id, entry]));
    deal = presetDeck(entries.map((entry) => entry.id));
    empty.hidden = entries.length > 0;
  };

  let chosen = read(STORAGE_KEY) ?? AUTO;
  let shown = "";
  let active: Engine | null = null;
  let coming: Engine | null = null;
  let switchAt = 0;
  let width = 0;
  let height = 0;
  let announced = "";
  let destroyed = false;
  let listener: (() => void) | null = null;
  const unsubscribe = onFavoritesChange(() => {
    stale = true;
    listener?.();
  });

  const draw = (): Entry | undefined => {
    refresh();
    for (let attempt = 0; attempt < entries.length * 2; attempt += 1) {
      const entry = byId.get(deal());
      if (entry && entry.id !== shown) return entry;
    }
    return entries[0];
  };

  const drop = (engine: Engine): void => {
    try {
      engine.renderer?.destroy();
    } catch (error) {
      console.warn("Ulubione: closing a visualizer failed", engine.plugin.id, error);
    }
    engine.layer.remove();
  };

  /** Passed over for this visit: a favourite that will not play, or a whole visualizer. */
  const passOver = (key: string): void => {
    unavailable.add(key);
    stale = true;
    if (chosen === key || chosen.startsWith(key + SEPARATOR)) chosen = AUTO;
    switchAt = 0;
    listener?.();
  };

  const settle = (engine: Engine, now: number): void => {
    engine.layer.classList.add("is-visible");
    if (active && active !== engine) drop(active);
    active = engine;
    coming = null;
    shown = engine.entry;
    switchAt = now + AUTO_SECONDS * 1000;
  };

  /** Play one favourite: the visualizer on screen changes preset, any other one is opened. */
  const play = (entry: Entry, now: number): void => {
    if (destroyed) return;
    if (!coming && active?.renderer && active.plugin.id === entry.visualizer) {
      active.renderer.choose(entry.preset);
      active.entry = entry.id;
      shown = entry.id;
      switchAt = now + AUTO_SECONDS * 1000;
      listener?.();
      return;
    }
    if (coming) {
      // A change cut short: what already fades in stays, what is still loading goes.
      if (coming.fadeAt) settle(coming, now);
      else drop(coming);
      coming = null;
    }
    const plugin = sources.find((candidate) => candidate.id === entry.visualizer);
    if (!plugin?.external) {
      passOver(entry.visualizer);
      return;
    }
    const layer = document.createElement("div");
    layer.className = "favorites-stage__layer";
    stage.append(layer);
    const engine: Engine = { plugin, layer, renderer: null, entry: entry.id, drawn: false, fadeAt: 0 };
    coming = engine;
    plugin.external(analyser, {
      preset: entry.preset, persist: false, autoFilter: null, ...(options.playback ? { playback: options.playback } : {})
    }).then((renderer) => {
      if (coming !== engine || destroyed) {
        renderer.destroy();
        return;
      }
      // Opened on its own choice instead: it does not have this favourite any more.
      if (renderer.chosen() !== entry.preset) {
        renderer.destroy();
        layer.remove();
        coming = null;
        passOver(entry.id);
        return;
      }
      engine.renderer = renderer;
      layer.append(renderer.canvas);
      // A favourite that failed in there falls back to that visualizer's own Auto: move on.
      renderer.setListener(() => {
        if (engine.renderer && engine.renderer.chosen() === AUTO) passOver(engine.entry);
        else listener?.();
      });
      if (width) renderer.resize(width, height);
      if (announced) renderer.announce(announced);
      if (!active) settle(engine, performance.now());
    }, (error: unknown) => {
      console.warn("Ulubione: visualizer unavailable", plugin.id, error);
      if (coming !== engine) return;
      layer.remove();
      coming = null;
      passOver(plugin.id);
    });
  };

  return {
    canvas: stage,
    presets: () => {
      refresh();
      return entries.map((entry) => entry.id);
    },
    presetGroups: (): readonly PresetGroup[] => {
      refresh();
      return sources
        .map((plugin) => ({
          label: plugin.label,
          presets: entries.filter((entry) => entry.visualizer === plugin.id).map((entry) => ({ id: entry.id, label: entry.label }))
        }))
        .filter((group) => group.presets.length > 0);
    },
    chosen: () => chosen,
    current: () => shown,
    setListener(next: (() => void) | null): void {
      listener = next;
    },
    favoriteOf(id: string) {
      refresh();
      const entry = byId.get(id);
      return entry ? { visualizer: entry.visualizer, preset: entry.preset, label: entry.label } : null;
    },
    choose(id: string): void {
      refresh();
      chosen = id === AUTO || byId.has(id) ? id : AUTO;
      write(STORAGE_KEY, chosen);
      if (chosen === AUTO) switchAt = 0;
      else if (width && chosen !== shown && chosen !== coming?.entry) play(byId.get(chosen)!, performance.now());
    },
    next(): void {
      refresh();
      if (chosen === AUTO) {
        switchAt = 0;
        return;
      }
      const following = entries[(entries.findIndex((entry) => entry.id === chosen) + 1) % Math.max(1, entries.length)];
      if (!following) return;
      chosen = following.id;
      write(STORAGE_KEY, chosen);
      if (width) play(following, performance.now());
      listener?.();
    },
    announce(text: string): void {
      announced = text;
      active?.renderer?.announce(text);
      coming?.renderer?.announce(text);
    },
    render(time: number): void {
      if (destroyed || !width) return;
      refresh();
      if (chosen !== AUTO && !byId.has(chosen)) chosen = AUTO;
      if (!entries.length) return;
      if (!active && !coming) {
        const first = chosen !== AUTO ? byId.get(chosen) : draw();
        if (first) play(first, time);
      } else if (!coming && (chosen === AUTO ? time >= switchAt : chosen !== shown && Boolean(byId.get(chosen)))) {
        const next = chosen === AUTO ? draw() : byId.get(chosen);
        if (next && next.id !== shown) play(next, time);
        else switchAt = time + AUTO_SECONDS * 1000;
      }
      const incoming = coming as Engine | null;
      if (incoming?.renderer && active !== incoming) {
        if (!incoming.fadeAt && incoming.drawn) {
          incoming.fadeAt = time;
          incoming.layer.classList.add("is-visible");
          shown = incoming.entry;
          listener?.();
        } else if (incoming.fadeAt && time - incoming.fadeAt >= FADE_MS) {
          settle(incoming, time);
        }
      }
      const current = active as Engine | null;
      if (current?.renderer) current.renderer.render(time);
      const next = coming as Engine | null;
      if (next?.renderer && next !== current) {
        next.renderer.render(time);
        next.drawn = true;
      }
    },
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth;
      height = nextHeight;
      for (const engine of [active, coming]) engine?.renderer?.resize(width, height);
    },
    destroy(): void {
      destroyed = true;
      listener = null;
      unsubscribe();
      for (const engine of [active, coming]) if (engine) drop(engine);
      active = null;
      coming = null;
      stage.remove();
    }
  };
}
