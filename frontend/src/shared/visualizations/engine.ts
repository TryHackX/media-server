import { decimate, rateFactor, scaledFftSize } from "./audio-rate";
import {
  autoFavoritesOnly, favoriteEntries, favoritePresets, loadFavorites, nameFavorites, onFavoritesChange, setAutoFavoritesOnly,
  toggleFavoritePreset
} from "./favorites";
import { FAVORITES_VISUALIZER } from "./favorites-plugin";
import { canonicalVisualizerId } from "./internal-plugin";
import { RANDOM_NEXT_KEY, randomPreset } from "./random-next";
import type { ExternalVisualizer, PresetGroup, PresetPool, VisualizerPlugin } from "./types";

const STORAGE_KEY = "media-visualizer-mode";

/** What the panel's preset list shows for a WebGL visualizer, or null for the 2D ones. */
export interface PresetState {
  pluginId: string;
  presets: readonly string[];
  /** The list under headings, or null for `presets` as a plain list. */
  groups: readonly PresetGroup[] | null;
  chosen: string;
  /** The preset on screen right now (in "Auto", the one it dealt). */
  current: string;
  /** The listener's favourite presets of this visualizer, in the order added. */
  favorites: readonly string[];
  /** "Auto" deals the favourites only. */
  autoFavorites: boolean;
  /** "Ulubione": every entry is a favourite already, so no favourites group and no "Auto — favourites only". */
  favoritesList: boolean;
  /** Packs to choose between (MilkDrop with vendor packs); fewer than two, no choice. */
  pools: readonly PresetPool[];
  pool: string;
  /** The choice's name where it is not packs (Geiss: colour depth); absent, it is packs. */
  poolsLabel?: string;
  /** Still fetching the engine and its presets. */
  loading: boolean;
  /** WebGL 2 missing, or WebAssembly refused by the page's policy. */
  failed: boolean;
  /** The panel's ‹ has a preset to go back to. */
  canGoBack: boolean;
  /** › (and a double click) picks a preset at random, not the next one in the list. */
  randomNext: boolean;
  /** Changes when the list's names change under the same ids (presetsRevision). */
  revision: number;
}

/** How many shown presets the panel's ‹ remembers per visualizer. */
const SHOWN_LIMIT = 100;

export class VisualizerEngine {
  private frame = 0;
  private running = false;
  private previousTime = performance.now();
  private frequency = new Uint8Array(new ArrayBuffer(1));
  private waveform = new Uint8Array(new ArrayBuffer(1));
  /** What the analyser gives at a rate above 48 kHz, before it is read down (audio-rate.ts). */
  private rawFrequency = new Uint8Array(new ArrayBuffer(1));
  private rawWaveform = new Uint8Array(new ArrayBuffer(1));
  private readonly rate: number;
  private pluginIndex = 0;
  private readonly context: CanvasRenderingContext2D | null;
  /** The mounted WebGL visualizer, while the current plugin is one. */
  private external: { id: string; renderer: ExternalVisualizer | null; failed: boolean } | null = null;
  private presetListener: ((state: PresetState | null) => void) | null = null;
  /** What the panel was last told is on screen, to tell it when that changes. */
  private shownPreset = "";
  /**
   * The presets each visualizer showed, like a browser's history: ‹ goes back, › forward, and a
   * new preset after going back drops what lay ahead. autoBefore: ‹ left "Auto" (the preset it
   * goes back to stays chosen); › past the end turns Auto on again. awaiting: the preset ‹ or ›
   * went to over the history, until it is on screen — a visualizer that crossfades (VoltViz)
   * still shows the one being left for a moment, which is not something newly shown.
   */
  private shown = new Map<string, { list: string[]; at: number; autoBefore: boolean; awaiting: string | null }>();
  /**
   * The preset a visualizer is to start on (the panel's search across visualizers found it there),
   * until that visualizer is mounted: handed to it as it starts, so it never shows its saved one.
   */
  private startPreset: { plugin: string; preset: string } | null = null;
  /** The player's track position and length, handed to the visualizers that ask (AVS). */
  private playback: (() => { position: number; duration: number } | null) | null = null;
  /** The panel's "random next": › picks a preset at random (random-next.ts), kept per browser. */
  private randomNext = ((): boolean => {
    try {
      return localStorage.getItem(RANDOM_NEXT_KEY) === "1";
    } catch {
      return false;
    }
  })();

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly analyser: AnalyserNode,
    private readonly plugins: VisualizerPlugin[],
    /** The visualizers the panel offers (enabled): "Ulubione" plays the favourites of these. */
    private readonly offered: readonly string[] = plugins.map((plugin) => plugin.id)
  ) {
    // An alpha channel is what lets a visualiser fade old frames with
    // "destination-out" instead of painting translucent black over them. Blending
    // towards black never quite arrives in eight bits, so it leaves a coloured
    // haze; removing alpha instead reaches full transparency and the panel
    // background shows through cleanly. Every plugin paints an opaque backdrop,
    // so nothing else changes.
    this.context = canvas.getContext("2d", { alpha: true });
    this.rate = rateFactor(analyser.context.sampleRate);
    const stored = localStorage.getItem(STORAGE_KEY);
    const index = plugins.findIndex((plugin) => plugin.id === canonicalVisualizerId(stored ?? ""));
    if (index >= 0) this.pluginIndex = index;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelFrame();
      else if (this.running) this.schedule();
    });
    this.configurePlugin();
    // The account's favourites, once; a star, a refused save or the first load redraws the list.
    onFavoritesChange(() => {
      this.applyAutoFilter();
      this.notifyPresets();
    });
    void loadFavorites();
  }

  public current(): VisualizerPlugin | undefined { return this.plugins[this.pluginIndex]; }

  /** Another visualizer; with `preset`, started on that preset of it (chosen, as the list would choose it). */
  public select(id: string, preset?: string): void {
    const index = this.plugins.findIndex((plugin) => plugin.id === id);
    if (index < 0) return;
    if (index === this.pluginIndex) {
      if (preset === undefined) return;
      const renderer = this.external?.id === id ? this.external.renderer : null;
      // A preset of a pack the list is not on (the search's "inne paczki"): the visualizer starts
      // again on it, and its start finds the pack, as when it is chosen from another visualizer.
      if (renderer && !renderer.presets().includes(preset)) {
        this.startPreset = { plugin: id, preset };
        this.unmountExternal();
        this.prepareExternal();
        this.notifyPresets();
        return;
      }
      this.choosePreset(preset);
      return;
    }
    this.startPreset = preset !== undefined ? { plugin: id, preset } : null;
    this.current()?.reset?.();
    this.pluginIndex = index;
    localStorage.setItem(STORAGE_KEY, id);
    this.configurePlugin();
    // A WebGL context per visualizer is a scarce thing (browsers allow about
    // sixteen), so the one being left is released, not parked.
    if (this.external && this.external.id !== id) this.unmountExternal();
    this.prepareExternal();
    this.notifyPresets();
    if (this.running) this.schedule();
  }

  /** Start fetching a WebGL visualizer as soon as it is chosen, not on its first frame. */
  private prepareExternal(): void {
    const plugin = this.current();
    if (this.running && plugin?.external && this.external?.id !== plugin.id) this.mountExternal(plugin);
  }

  /** Told whenever the preset list changes: a WebGL visualizer mounted, failed, or left. */
  public onPresets(listener: ((state: PresetState | null) => void) | null): void {
    this.presetListener = listener;
    this.notifyPresets();
  }

  public choosePreset(id: string): void {
    this.external?.renderer?.choose(id);
    this.notifyPresets();
  }

  public choosePool(id: string): void {
    this.external?.renderer?.choosePool?.(id);
    this.notifyPresets();
  }

  public nextPreset(): void {
    this.external?.renderer?.next();
  }

  /** The source of the track's position and length (the player's audio element). */
  public setPlayback(source: (() => { position: number; duration: number } | null) | null): void {
    this.playback = source;
  }

  /** ‹: the preset shown before this one, chosen (it stays until something else is chosen). */
  public previousPreset(): void {
    const plugin = this.current();
    const renderer = this.external?.renderer;
    const history = plugin ? this.shown.get(plugin.id) : undefined;
    if (!plugin?.external || !renderer || !history || history.at <= 0) return;
    if (renderer.chosen() === "auto") history.autoBefore = true;
    history.at -= 1;
    history.awaiting = history.list[history.at]!;
    renderer.choose(history.awaiting);
    this.notifyPresets();
  }

  /**
   * ›: forward over what ‹ went back across; past the end, what "next preset" always did (in
   * "Auto" the next one is dealt now, otherwise the next one in the list) — with Auto turned on
   * again first when ‹ had left it. With "random next" on, a pinned preset gives way to one picked
   * at random (Auto deals at random anyway): from the pack or category the list shows, among the
   * favourites while "Auto — tylko ulubione" is on, never the one on screen.
   */
  public stepPresetForward(): void {
    const plugin = this.current();
    const renderer = this.external?.renderer;
    if (!plugin?.external || !renderer) return;
    const history = this.shown.get(plugin.id);
    if (history && history.at < history.list.length - 1) {
      history.at += 1;
      history.awaiting = history.list[history.at]!;
      renderer.choose(history.awaiting);
      this.notifyPresets();
      return;
    }
    if (history?.autoBefore) {
      history.autoBefore = false;
      renderer.choose("auto");
    }
    const chosen = renderer.chosen();
    if (this.randomNext && chosen !== "auto") {
      const pick = randomPreset(renderer.randomPool?.() ?? renderer.presets(), {
        current: renderer.current(), chosen, favorites: this.autoFilterFor(plugin.id)
      });
      if (pick) {
        renderer.choose(pick);
        this.notifyPresets();
        return;
      }
    }
    renderer.next();
    this.notifyPresets();
  }

  /** "Random next" on or off; the panel's toggle. */
  public setRandomNext(on: boolean): void {
    this.randomNext = on;
    try {
      localStorage.setItem(RANDOM_NEXT_KEY, on ? "1" : "0");
    } catch { /* pamięć przeglądarki może być niedostępna */ }
    this.notifyPresets();
  }

  public isRandomNext(): boolean {
    return this.randomNext;
  }

  /** The preset on screen joins the history (unless it is where the history stands). */
  private recordShown(pluginId: string, preset: string, chosen: string): void {
    if (!preset) return;
    let history = this.shown.get(pluginId);
    if (!history) {
      history = { list: [], at: -1, autoBefore: false, awaiting: null };
      this.shown.set(pluginId, history);
    }
    // Still on the way to where ‹ or › went (and still chosen): what shows is the one being left.
    if (history.awaiting !== null && preset !== history.awaiting && chosen === history.awaiting) return;
    history.awaiting = null;
    if (history.list[history.at] === preset) return;
    history.list = history.list.slice(0, history.at + 1);
    history.list.push(preset);
    if (history.list.length > SHOWN_LIMIT) history.list.shift();
    history.at = history.list.length - 1;
  }

  /** Keep what "Auto" is showing: it becomes the chosen preset. */
  public keepCurrentPreset(): void {
    const renderer = this.external?.renderer;
    const current = renderer?.current();
    if (!renderer || !current) return;
    this.setAutoFavorites(false, false);
    renderer.choose(current);
    this.notifyPresets();
  }

  /** The preset on screen into the favourites, or out of them. */
  public toggleFavoritePreset(): void {
    const plugin = this.current();
    const renderer = this.external?.renderer;
    const current = renderer?.current();
    if (!plugin?.external || !renderer || !current) return;
    // "Ulubione": the entry stands for a preset of another visualizer.
    const favorite = renderer.favoriteOf?.(current);
    if (favorite) toggleFavoritePreset(favorite.visualizer, favorite.preset, favorite.label);
    else if (plugin.id !== FAVORITES_VISUALIZER) toggleFavoritePreset(plugin.id, current, presetLabel(renderer, current));
    this.applyAutoFilter();
    this.notifyPresets();
  }

  /** "Auto" over the favourites only (on), or over the whole list (off). */
  public setAutoFavorites(on: boolean, chooseAuto = true): void {
    const plugin = this.current();
    if (!plugin?.external) return;
    setAutoFavoritesOnly(plugin.id, on);
    if (chooseAuto) this.external?.renderer?.choose("auto");
    this.applyAutoFilter();
    this.notifyPresets();
  }

  private applyAutoFilter(): void {
    const plugin = this.current();
    const renderer = this.external?.renderer;
    if (!plugin || !renderer?.setAutoFilter) return;
    renderer.setAutoFilter(this.autoFilterFor(plugin.id));
  }

  /** The favourites "Auto" deals from, or null for the whole list. */
  private autoFilterFor(pluginId: string): readonly string[] | null {
    if (pluginId === FAVORITES_VISUALIZER) return null;
    // One favourite is not a choice to deal from: Auto takes the whole list then.
    const favorites = favoritePresets(pluginId);
    return autoFavoritesOnly(pluginId) && favorites.length >= 2 ? favorites : null;
  }

  /** The new track's title, for a visualizer that shows one (MilkDrop does). */
  public announce(text: string): void {
    if (this.running) this.external?.renderer?.announce(text);
  }

  public next(direction: 1 | -1): VisualizerPlugin | undefined {
    if (!this.plugins.length) return undefined;
    const index = (this.pluginIndex + direction + this.plugins.length) % this.plugins.length;
    this.select(this.plugins[index]!.id);
    return this.current();
  }

  public start(): void {
    this.running = true;
    this.previousTime = performance.now();
    this.prepareExternal();
    this.schedule();
  }

  public stop(): void {
    this.running = false;
    this.cancelFrame();
  }

  public resize(reset = false): void {
    if (reset) this.current()?.reset?.();
    this.paint(performance.now());
  }

  private configurePlugin(): void {
    const plugin = this.current();
    if (!plugin) return;
    // The window a plugin asked for, at 44.1/48 kHz; a faster context gets an
    // analyser as many times longer, read down to the same samples and bins.
    const nominal = plugin.fftSize ?? 2048;
    this.analyser.fftSize = scaledFftSize(nominal, this.rate);
    this.analyser.smoothingTimeConstant = plugin.smoothing ?? 0.85;
    const samples = this.analyser.fftSize / this.rate;
    this.frequency = new Uint8Array(new ArrayBuffer(samples / 2));
    this.waveform = new Uint8Array(new ArrayBuffer(samples));
    this.rawFrequency = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.rawWaveform = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
  }

  private schedule(): void {
    if (!this.running || document.hidden || this.frame) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = 0;
      // One bad frame must not end the animation: an exception here used to
      // skip the line below, and nothing ever scheduled another frame.
      try {
        this.paint(time);
      } catch (error) {
        console.warn("Visualizer frame failed", error);
      }
      this.schedule();
    });
  }

  private cancelFrame(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private mountExternal(plugin: VisualizerPlugin): void {
    const factory = plugin.external;
    if (!factory) return;
    this.unmountExternal();
    const slot: { id: string; renderer: ExternalVisualizer | null; failed: boolean } = { id: plugin.id, renderer: null, failed: false };
    this.external = slot;
    this.notifyPresets();
    const sources = plugin.id === FAVORITES_VISUALIZER
      ? this.plugins.filter((candidate) => candidate.id !== FAVORITES_VISUALIZER && this.offered.includes(candidate.id))
      : undefined;
    const playback = this.playback ? { playback: () => this.playback?.() ?? null } : {};
    const start = this.startPreset?.plugin === plugin.id ? this.startPreset.preset : undefined;
    this.startPreset = null;
    void factory(this.analyser, {
      autoFilter: this.autoFilterFor(plugin.id), ...(sources ? { sources } : {}), ...playback, ...(start !== undefined ? { preset: start } : {})
    })
      .then((renderer) => {
        if (this.external !== slot) {
          renderer.destroy();
          return;
        }
        slot.renderer = renderer;
        // The preset it was started on, chosen through the visualizer itself (before its first
        // frame, so nothing is shown twice): that is what remembers it as the visualizer's choice,
        // and what moves one that ignored `preset` onto it. A preset it no longer offers (failed
        // here before) leaves it on its own choice.
        if (start !== undefined && renderer.presets().includes(start)) renderer.choose(start);
        renderer.setListener(() => this.notifyPresets());
        this.canvas.after(renderer.canvas);
        this.applyAutoFilter();
        this.notifyPresets();
      })
      .catch((error: unknown) => {
        if (this.external !== slot) return;
        slot.failed = true;
        console.warn("WebGL visualizer unavailable", error);
        this.notifyPresets();
      });
  }

  private unmountExternal(): void {
    this.external?.renderer?.destroy();
    this.external = null;
    this.canvas.hidden = false;
  }

  private notifyPresets(): void {
    if (!this.presetListener) return;
    const plugin = this.current();
    if (!plugin?.external) {
      this.presetListener(null);
      return;
    }
    const slot = this.external?.id === plugin.id ? this.external : null;
    const renderer = slot?.renderer ?? null;
    this.shownPreset = renderer?.current() ?? "";
    if (renderer) this.recordShown(plugin.id, this.shownPreset, renderer.chosen());
    const history = this.shown.get(plugin.id);
    const favoritesList = plugin.id === FAVORITES_VISUALIZER;
    // Favourites moved from the browser have no names yet: this visualizer's list has them.
    if (renderer && !favoritesList && favoriteEntries(plugin.id).some((favorite) => !favorite.label)) {
      const groups = renderer.presetGroups?.() ?? [];
      nameFavorites(plugin.id, new Map(groups.flatMap((group) => group.presets.map((preset) => [preset.id, preset.label] as const))));
    }
    this.presetListener({
      pluginId: plugin.id,
      presets: renderer?.presets() ?? [],
      groups: renderer?.presetGroups?.() ?? null,
      chosen: renderer?.chosen() ?? "auto",
      current: this.shownPreset,
      // In "Ulubione" every entry is a favourite: the star there takes one out.
      favorites: favoritesList ? renderer?.presets() ?? [] : favoritePresets(plugin.id),
      autoFavorites: !favoritesList && autoFavoritesOnly(plugin.id),
      favoritesList,
      pools: renderer?.pools?.() ?? [],
      pool: renderer?.pool?.() ?? "",
      poolsLabel: renderer?.poolsLabel?.(),
      loading: !renderer && !slot?.failed,
      failed: slot?.failed ?? false,
      canGoBack: Boolean(renderer && history && history.at > 0),
      randomNext: this.randomNext,
      revision: renderer?.presetsRevision?.() ?? 0
    });
  }

  private paint(time: number): void {
    const plugin = this.current();
    if (!plugin) return;
    if (plugin.external) {
      this.paintExternal(plugin, time);
      return;
    }
    this.canvas.hidden = false;
    const context = this.context;
    if (!context) return;
    // Measure the container, not the canvas. A canvas contributes its pixel
    // buffer as intrinsic size, so sizing the buffer from the canvas's own box
    // lets a layout feed its previous frame back in and stay stretched after the
    // panel shrinks. The canvas fills its parent, so the parent's content box is
    // the same rectangle without that loop.
    const host = this.canvas.parentElement;
    const bounds = this.canvas.getBoundingClientRect();
    const measuredWidth = host?.clientWidth || bounds.width;
    const measuredHeight = host?.clientHeight || bounds.height;
    const width = Math.max(1, Math.floor(measuredWidth));
    const height = Math.max(1, Math.floor(measuredHeight));
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.floor(width * scale);
    const pixelHeight = Math.floor(height * scale);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    if (this.rate === 1) {
      this.analyser.getByteFrequencyData(this.frequency);
      this.analyser.getByteTimeDomainData(this.waveform);
    } else {
      this.analyser.getByteFrequencyData(this.rawFrequency);
      this.frequency.set(this.rawFrequency.subarray(0, this.frequency.length));
      this.analyser.getByteTimeDomainData(this.rawWaveform);
      decimate(this.rawWaveform, this.rate, this.waveform);
    }
    plugin.render({ canvas: this.canvas, context, analyser: this.analyser, frequency: this.frequency,
      waveform: this.waveform, sampleRate: this.analyser.context.sampleRate / this.rate,
      width, height, time, delta: Math.min(80, Math.max(0, time - this.previousTime)) });
    this.previousTime = time;
  }

  private paintExternal(plugin: VisualizerPlugin, time: number): void {
    if (this.external?.id !== plugin.id) this.mountExternal(plugin);
    const renderer = this.external?.renderer;
    // The 2D canvas makes way only once the WebGL one is there to take its place.
    this.canvas.hidden = Boolean(renderer);
    if (!renderer) return;
    const host = this.canvas.parentElement;
    const width = Math.max(1, Math.floor(host?.clientWidth || 1));
    const height = Math.max(1, Math.floor(host?.clientHeight || 1));
    renderer.resize(width, height);
    renderer.render(time);
    this.previousTime = time;
    // "Auto" moved on (or a preset failed): the panel shows what is on screen.
    if (renderer.current() !== this.shownPreset) this.notifyPresets();
  }
}

/** The name a visualizer's list shows for a preset, kept with the favourite for "Ulubione". */
function presetLabel(renderer: ExternalVisualizer, id: string): string {
  for (const group of renderer.presetGroups?.() ?? []) {
    const found = group.presets.find((preset) => preset.id === id);
    if (found) return found.label;
  }
  return id;
}
