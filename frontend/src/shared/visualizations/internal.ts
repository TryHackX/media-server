import { t } from "../i18n";
import { decimate, rateFactor, scaledFftSize } from "./audio-rate";
import { classicVisualizers } from "./classic";
import { fablePreset, fablePresetGroups, fablePresetIds } from "./fable/catalog";
import type { FableHost } from "./fable/host";
import type { MountedOverlay } from "./fable/overlay";
import { fableSupported } from "./fable/support";
import { fieldVisualizers } from "./fields";
import { INTERNAL_ORDER } from "./internal-plugin";
import { presetDeck } from "./milkdrop";
import { psychedelicVisualizers } from "./psychedelic";
import { radialVisualizers } from "./radial";
import { showcaseVisualizers } from "./showcase";
import { spectrumVisualizers } from "./spectrum";
import type { ExternalOptions, ExternalVisualizer, PresetGroup, VisualizerPlugin } from "./types";

/**
 * Internal: the player's own visualizations as the presets of one visualizer.
 *
 * The 2D ones draw as they always did — each on a canvas of its own with the analyser settings
 * it was made for (its fftSize and smoothing, on an AnalyserNode of its own behind the
 * player's, read at 44.1/48 kHz on a faster device as audio-rate.ts explains).
 *
 * The Fable ones (fable/: ten visualizations, four presets each) are drawn with WebGL 2 on one
 * canvas they all share, by a host that fetches a visualization the first time one of its
 * presets is shown. They are listed where the browser can draw them (fable/support.ts), under
 * a heading per visualization.
 *
 * "Auto" deals all of them like a shuffled deck, a new one every 30 seconds, and the next fades
 * in over the one on screen: between two Fable presets the host mixes the two pictures itself;
 * every other way round the incoming canvas fades in over the one under it. A chosen one stays.
 * The panel's favourites, lock and "next" work on them as on MilkDrop's.
 */

const AUTO = "auto";
const AUTO_SECONDS = 30;
/** The fade between two visualizations (panels.css, .internal-stage__layer; the Fable host's mix). */
const FADE_MS = 1200;
const STORAGE_KEY = "media-visualizer-preset:internal";
/** Where the panel kept its choice when these were visualizers of their own. */
const FORMER_CHOICE_KEY = "media-visualizer-mode";
const MAX_SCALE = 2;

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

interface LayerBase {
  /** The preset it shows (the Fable canvas: the one its host shows now). */
  id: string;
  canvas: HTMLCanvasElement;
  /** Time of its last frame (ms), 0 before the first. */
  previous: number;
  /** When it began to fade in; 0 before. */
  fadeAt: number;
}

/** One 2D visualization on screen: its canvas, its own analyser and the arrays it reads. */
interface FlatLayer extends LayerBase {
  kind: "2d";
  plugin: VisualizerPlugin;
  context: CanvasRenderingContext2D;
  node: AnalyserNode;
  frequency: Uint8Array<ArrayBuffer>;
  waveform: Uint8Array<ArrayBuffer>;
  rawFrequency: Uint8Array<ArrayBuffer>;
  rawWaveform: Uint8Array<ArrayBuffer>;
}

/** The Fable presets' shared canvas on screen. */
interface FableLayer extends LayerBase {
  kind: "fable";
  host: FableHost;
}

type Layer = FlatLayer | FableLayer;

/** A frame was drawn; nothing could be drawn yet (a Fable preset on its way); or it failed. */
type Painted = "drawn" | "waiting" | "failed";

/** The player's own 2D visualizations, by id. */
function visualizations(): Map<string, VisualizerPlugin> {
  const all = new Map<string, VisualizerPlugin>();
  for (const plugin of [
    ...spectrumVisualizers, ...radialVisualizers, ...fieldVisualizers,
    ...classicVisualizers, ...psychedelicVisualizers, ...showcaseVisualizers
  ]) all.set(plugin.id, plugin);
  return all;
}

/**
 * Internal's list — for the visualizer and for the panel's search across visualizers, which
 * therefore offer the same presets under the same names: the 2D visualizations in
 * INTERNAL_ORDER under their own names, without a heading, then the Fable visualizations, a
 * heading each with its presets, where the browser can draw them.
 */
export function internalPresetGroups(all: ReadonlyMap<string, VisualizerPlugin> = visualizations(), fable = fableSupported()): PresetGroup[] {
  const flat: PresetGroup = { label: "", presets: INTERNAL_ORDER.filter((id) => all.has(id)).map((id) => ({ id, label: all.get(id)?.label ?? id })) };
  return fable ? [flat, ...fablePresetGroups(t)] : [flat];
}

export async function createInternal(analyser: AnalyserNode, options: ExternalOptions = {}): Promise<ExternalVisualizer> {
  const all = visualizations();
  // The Fable presets' host comes with the list that offers them; a browser that cannot draw
  // them, or a chunk that cannot be fetched, leaves Internal as it was.
  const fable = fableSupported() ? await import("./fable/host").catch(() => null) : null;
  const fableIds = new Set(fable ? fablePresetIds() : []);
  const ids = [...INTERNAL_ORDER.filter((id) => all.has(id)), ...fableIds];
  if (!ids.length) throw new Error("No internal visualizations");
  const known = (id: string): boolean => all.has(id) || fableIds.has(id);
  const factor = rateFactor(analyser.context.sampleRate);

  const stage = document.createElement("div");
  stage.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl internal-stage";

  let shown = "";
  const deal = presetDeck(ids);
  /** Fable presets that could not be fetched, compiled or drawn on this visit: skipped. */
  const unavailable = new Set<string>();
  // "Auto" over the listener's favourites only, known before the first one is dealt.
  let autoFilter: Set<string> | null = options.autoFilter?.length ? new Set(options.autoFilter) : null;
  const dealable = (id: string): boolean => !unavailable.has(id) && (!autoFilter || autoFilter.has(id));
  const draw = (): string => {
    if (autoFilter && !ids.some(dealable)) autoFilter = null;
    for (let attempt = 0; attempt < ids.length * 2; attempt += 1) {
      const id = deal();
      if (dealable(id) && id !== shown) return id;
    }
    return ids.find(dealable) ?? ids[0]!;
  };

  // The choice: this visualizer's own, else the one the panel had when these were separate.
  const persist = options.persist !== false;
  const stored = (options.preset !== undefined && known(options.preset) ? options.preset : null)
    ?? read(STORAGE_KEY) ?? read(FORMER_CHOICE_KEY);
  let chosen = stored === AUTO || (stored !== null && known(stored)) ? stored : AUTO;
  let listener: (() => void) | null = null;
  let base: Layer | null = null;
  let incoming: Layer | null = null;
  let host: FableHost | null = null;
  let overlay: MountedOverlay | null = null;
  let switchAt = 0;
  let width = 0;
  let height = 0;
  let scale = 1;
  let destroyed = false;

  const makeLayer = (plugin: VisualizerPlugin): FlatLayer => {
    const canvas = document.createElement("canvas");
    canvas.className = "internal-stage__layer";
    // An alpha channel, as on the engine's own canvas: several visualizations fade old frames
    // out with "destination-out" and paint their backdrop themselves.
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas 2D is not available");
    const node = analyser.context.createAnalyser();
    node.fftSize = scaledFftSize(plugin.fftSize ?? 2048, factor);
    node.smoothingTimeConstant = plugin.smoothing ?? 0.85;
    analyser.connect(node);
    const samples = node.fftSize / factor;
    plugin.reset?.();
    stage.append(canvas);
    return {
      kind: "2d", id: plugin.id, plugin, canvas, context, node,
      frequency: new Uint8Array(new ArrayBuffer(samples / 2)),
      waveform: new Uint8Array(new ArrayBuffer(samples)),
      rawFrequency: new Uint8Array(new ArrayBuffer(node.frequencyBinCount)),
      rawWaveform: new Uint8Array(new ArrayBuffer(node.fftSize)),
      previous: 0,
      fadeAt: 0
    };
  };

  /** The Fable canvas brought onto the stage, above what is there, showing `id` once it can. */
  const makeFableLayer = (id: string): FableLayer | null => {
    if (!fable) return null;
    try {
      host ??= fable.createFableHost(analyser, FADE_MS);
    } catch (error) {
      // No context to be had (too many on the page, the driver refusing): none of them can be shown.
      console.warn("Fable presets cannot start", error);
      for (const each of fableIds) unavailable.add(each);
      return null;
    }
    host.canvas.classList.remove("is-visible");
    stage.append(host.canvas);
    host.show(id);
    return { kind: "fable", id, canvas: host.canvas, host, previous: 0, fadeAt: 0 };
  };

  const drop = (layer: Layer): void => {
    layer.canvas.remove();
    if (layer.kind === "fable") {
      layer.canvas.classList.remove("is-visible");
      layer.host.clear();
      return;
    }
    try {
      analyser.disconnect(layer.node);
    } catch { /* już odłączony */ }
  };

  /** The incoming visualization takes the screen; the one under it goes. */
  const settle = (layer: Layer, now: number): void => {
    layer.canvas.classList.add("is-visible");
    if (base && base !== layer) drop(base);
    base = layer;
    incoming = null;
    shown = layer.id;
    switchAt = now + AUTO_SECONDS * 1000;
  };

  /** Show a visualization: at once when nothing is on screen, else fading in over it. */
  const show = (id: string, now: number): void => {
    const plugin = all.get(id);
    if (destroyed || (!plugin && !fableIds.has(id))) return;
    if (incoming) {
      // A change cut short: what already fades in stays, what is still unseen goes.
      if (incoming.fadeAt) settle(incoming, now);
      else drop(incoming);
      incoming = null;
    }
    if (!plugin && base?.kind === "fable") {
      // From one Fable preset to another: their host mixes the two on the canvas it has.
      base.host.show(id);
      return;
    }
    const layer = plugin ? makeLayer(plugin) : makeFableLayer(id);
    if (!layer) {
      // It cannot be shown: Auto deals another, a chosen one leaves the picture as it is.
      if (chosen === AUTO) switchAt = 0;
      return;
    }
    if (!base) {
      settle(layer, now);
      listener?.();
      return;
    }
    incoming = layer;
  };

  /** One frame of a 2D visualization, read and drawn as the engine drew them. */
  const paintFlat = (layer: FlatLayer, time: number): Painted => {
    const pixelWidth = Math.max(1, Math.floor(width * scale));
    const pixelHeight = Math.max(1, Math.floor(height * scale));
    if (layer.canvas.width !== pixelWidth || layer.canvas.height !== pixelHeight) {
      layer.canvas.width = pixelWidth;
      layer.canvas.height = pixelHeight;
    }
    layer.context.setTransform(scale, 0, 0, scale, 0, 0);
    if (factor === 1) {
      layer.node.getByteFrequencyData(layer.frequency);
      layer.node.getByteTimeDomainData(layer.waveform);
    } else {
      layer.node.getByteFrequencyData(layer.rawFrequency);
      layer.frequency.set(layer.rawFrequency.subarray(0, layer.frequency.length));
      layer.node.getByteTimeDomainData(layer.rawWaveform);
      decimate(layer.rawWaveform, factor, layer.waveform);
    }
    try {
      layer.plugin.render({
        canvas: layer.canvas, context: layer.context, analyser: layer.node,
        frequency: layer.frequency, waveform: layer.waveform, sampleRate: layer.node.context.sampleRate / factor,
        width, height, time, delta: layer.previous ? Math.min(80, Math.max(0, time - layer.previous)) : 16
      });
    } catch (error) {
      // One bad frame must not end the picture; the engine did the same for these.
      console.warn("Internal visualization frame failed", layer.plugin.id, error);
      return "failed";
    }
    layer.previous = time;
    return "drawn";
  };

  /**
   * One frame of the Fable canvas, and what its host has to say: the preset it shows now (it
   * changes when the host's own fade begins), and those that failed.
   */
  const paintFable = (layer: FableLayer, time: number): Painted => {
    const drawn = layer.host.render(time, width, height);
    let failed = false;
    // The context gone, none of them can be drawn any more.
    if (layer.host.lost()) for (const id of fableIds) unavailable.add(id);
    for (const id of layer.host.takeFailures()) {
      unavailable.add(id);
      if (id === layer.id) failed = true;
      if (id === chosen) {
        // The chosen one cannot be shown: Auto takes over (the choice kept is not changed).
        chosen = AUTO;
        listener?.();
      }
      // What was to be shown could not be: another, now.
      if (chosen === AUTO) switchAt = 0;
    }
    const now = layer.host.shown();
    if (now && now !== layer.id) {
      layer.id = now;
      if (layer === base) {
        shown = now;
        switchAt = time + AUTO_SECONDS * 1000;
        listener?.();
      }
    }
    if (drawn) {
      layer.previous = time;
      return "drawn";
    }
    return layer.host.lost() || (failed && !layer.host.pending()) ? "failed" : "waiting";
  };

  const paint = (layer: Layer, time: number): Painted => (layer.kind === "fable" ? paintFable(layer, time) : paintFlat(layer, time));

  /** The picture control over the presets that work on one (fable/overlay.ts), and only over them. */
  const followOverlay = (): void => {
    const wanted = Boolean(fable && host && base?.kind === "fable" && fablePreset(shown)?.entry.usesSource);
    if (wanted && !overlay && fable && host) overlay = fable.pictureOverlay(stage, host.picture);
    else if (!wanted && overlay) {
      overlay.dispose();
      overlay = null;
    }
  };

  return {
    canvas: stage,
    presets: () => ids,
    presetGroups: (): readonly PresetGroup[] => internalPresetGroups(all, fable !== null),
    chosen: () => chosen,
    current: () => shown,
    setListener(next: (() => void) | null): void {
      listener = next;
    },
    setAutoFilter(favourites: readonly string[] | null): void {
      const filter = favourites ? new Set(favourites.filter(known)) : null;
      autoFilter = filter && filter.size ? filter : null;
      // Showing something outside the new choice: Auto moves on now.
      if (chosen === AUTO && autoFilter && shown && !autoFilter.has(shown)) switchAt = 0;
    },
    choose(id: string): void {
      chosen = id === AUTO || known(id) ? id : AUTO;
      if (persist) write(STORAGE_KEY, chosen);
      if (chosen === AUTO) switchAt = 0;
      // Before the first frame there is no size yet: the first frame shows the choice.
      else if (width && chosen !== shown && chosen !== incoming?.id && chosen !== host?.pending()) show(chosen, performance.now());
    },
    next(): void {
      if (chosen === AUTO) {
        switchAt = 0;
        return;
      }
      // Chosen: the next one in the list, chosen in its turn.
      chosen = ids[(ids.indexOf(chosen) + 1) % ids.length]!;
      if (persist) write(STORAGE_KEY, chosen);
      if (width) show(chosen, performance.now());
      listener?.();
    },
    announce: () => undefined,
    render(time: number): void {
      if (destroyed || !width) return;
      if (!base && !incoming) {
        show(chosen === AUTO ? draw() : chosen, time);
      } else if (chosen === AUTO && !incoming && !host?.pending() && time >= switchAt) {
        const next = draw();
        if (next !== shown) show(next, time);
        else switchAt = time + AUTO_SECONDS * 1000;
      }
      if (base && paint(base, time) === "failed" && incoming === null) {
        // The one on screen keeps failing: Auto moves on rather than show a frozen frame.
        if (chosen === AUTO) switchAt = 0;
      }
      const coming = incoming as Layer | null;
      if (coming) {
        const firstFrame = coming.previous === 0;
        const painted = paint(coming, time);
        if (painted === "failed") {
          drop(coming);
          incoming = null;
          if (chosen === AUTO) switchAt = 0;
        } else if (painted === "drawn") {
          if (!coming.fadeAt && !firstFrame) {
            // Drawn once above the one on screen, unseen: now it fades in. The class goes on a
            // frame after the canvas came in — added in the same task, the fade would be a cut.
            coming.fadeAt = time;
            coming.canvas.classList.add("is-visible");
            shown = coming.id;
          } else if (coming.fadeAt && time - coming.fadeAt >= FADE_MS) {
            settle(coming, time);
          }
        }
      }
      followOverlay();
    },
    resize(nextWidth: number, nextHeight: number): void {
      const nextScale = Math.min(window.devicePixelRatio || 1, MAX_SCALE);
      if (nextWidth === width && nextHeight === height && nextScale === scale) return;
      const first = !width;
      width = nextWidth;
      height = nextHeight;
      scale = nextScale;
      // Particles and trails laid out for the old size start again, as the engine had them.
      // (The Fable presets keep theirs: their buffers are resized with the picture in them.)
      if (!first) for (const layer of [base, incoming]) if (layer?.kind === "2d") layer.plugin.reset?.();
    },
    destroy(): void {
      destroyed = true;
      listener = null;
      overlay?.dispose();
      overlay = null;
      for (const layer of [base, incoming]) if (layer) drop(layer);
      base = null;
      incoming = null;
      host?.destroy();
      host = null;
      stage.remove();
    }
  };
}
