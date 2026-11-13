import { t } from "../../i18n";
import { presetDeck } from "../milkdrop";
import type { ExternalOptions, ExternalVisualizer, PresetGroup } from "../types";
import { AudioFeed } from "./audio";
import { PRESETS, soundformsPresetGroups, type PresetDef } from "./catalog";
import { createPlanet, createRings } from "./dots";
import { createLines } from "./lines";
import { createMesh } from "./mesh";
import { createParticles } from "./particles";
import { type Outputs, Pipeline } from "./pipeline";
import type { FrameInfo, Scene } from "./scene";
import { createSphere } from "./sphere";
import { createSpectrum } from "./spectrum";

/**
 * Formy dźwięku (Sound Forms): 3D music visualizations in plain WebGL 2 — spiked spheres, fields
 * and tunnels of lines, the spectrum as sheets and columns, grids of points, swarms, a dotted
 * planet, rings — each a preset of one visualizer (catalog.ts), as Internal's are.
 *
 * One canvas and one WebGL context for all of them. A preset draws into an off-screen picture that
 * the pipeline finishes (glow, lens, mirror, trails) into the preset's own output; the next preset
 * draws a frame unseen, then fades in over the one on screen for 1.2 s. "Auto" deals the presets
 * like a shuffled deck, a new one every 30 seconds; the panel's favourites, lock and "next" work
 * as on Internal's. A preset whose shaders this GPU will not compile drops out of the list for the
 * visit. No `eval`, no styles, nothing fetched: it runs under the page's strictest policy.
 */

const AUTO = "auto";
const AUTO_SECONDS = 30;
const FADE_MS = 1200;
const STORAGE_KEY = "media-visualizer-preset:soundforms";
/** The picture is the panel × devicePixelRatio, up to 2, and never above ~2.4 Mpx (fill rate). */
const MAX_PIXEL_RATIO = 2;
const MAX_PIXELS = 2048 * 1152;

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

function createScene(pipeline: Pipeline, preset: PresetDef): Scene {
  switch (preset.scene) {
    case "sphere": return createSphere(pipeline, preset.settings);
    case "lines": return createLines(pipeline, preset.settings);
    case "spectrum": return createSpectrum(pipeline, preset.settings);
    case "mesh": return createMesh(pipeline, preset.settings);
    case "particles": return createParticles(pipeline, preset.settings);
    case "dots": return createPlanet(pipeline, preset.settings);
    case "rings": return createRings(pipeline, preset.settings);
  }
}

/** One preset on screen, or coming. */
interface Layer {
  preset: PresetDef;
  scene: Scene;
  outputs: Outputs;
  /** Seconds it has run, and the time of its last frame (ms, 0 before the first). */
  clock: number;
  previous: number;
  /** When it began to fade in (ms); 0 before. */
  fadeAt: number;
}

export async function createSoundForms(analyser: AnalyserNode, options: ExternalOptions = {}): Promise<ExternalVisualizer> {
  const canvas = document.createElement("canvas");
  canvas.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl";
  const gl = canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false
  });
  if (!gl) throw new Error("WebGL 2 is not available");
  let pipeline = new Pipeline(gl);
  const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
  const maxPoint = Math.max(1, Math.min(256, pointRange?.[1] ?? 64));
  const feed = new AudioFeed(analyser);

  const all = new Map<string, PresetDef>(PRESETS.map((preset) => [preset.id, preset]));
  const ids = PRESETS.map((preset) => preset.id);
  /** Presets whose shaders failed here: out of the list for this visit. */
  const failed = new Set<string>();
  const offered = (id: string): boolean => all.has(id) && !failed.has(id);

  let shown = "";
  const deal = presetDeck(ids);
  // "Auto" over the listener's favourites only, known before the first one is dealt.
  let autoFilter: Set<string> | null = options.autoFilter?.length ? new Set(options.autoFilter) : null;
  const dealable = (id: string): boolean => offered(id) && (!autoFilter || autoFilter.has(id));
  const draw = (): string | undefined => {
    if (autoFilter && !ids.some(dealable)) autoFilter = null;
    for (let attempt = 0; attempt < ids.length * 2; attempt += 1) {
      const id = deal();
      if (dealable(id) && id !== shown) return id;
    }
    return ids.find(dealable);
  };

  const persist = options.persist !== false;
  const stored = (options.preset !== undefined && all.has(options.preset) ? options.preset : null) ?? read(STORAGE_KEY);
  let chosen = stored !== null && (stored === AUTO || all.has(stored)) ? stored : AUTO;
  let listener: (() => void) | null = null;
  let base: Layer | null = null;
  let incoming: Layer | null = null;
  let switchAt = 0;
  let width = 0;
  let size = "";
  let lost = false;
  let destroyed = false;
  let audioTime = 0;

  const drop = (layer: Layer): void => {
    try {
      layer.scene.dispose();
    } catch (error) {
      console.warn("Formy dźwięku: disposing failed", layer.preset.id, error);
    }
    pipeline.deleteOutputs(layer.outputs);
  };

  /** Out of the list for this visit (its shaders failed here); Auto deals on. */
  const fail = (id: string, error: unknown): void => {
    console.warn("Formy dźwięku: preset unavailable", id, error);
    failed.add(id);
    if (chosen === id) {
      chosen = AUTO;
      if (persist) write(STORAGE_KEY, chosen);
    }
    switchAt = 0;
    listener?.();
  };

  const makeLayer = (id: string): Layer | null => {
    const preset = all.get(id);
    if (!preset || !offered(id)) return null;
    try {
      return { preset, scene: createScene(pipeline, preset), outputs: pipeline.createOutputs(), clock: 0, previous: 0, fadeAt: 0 };
    } catch (error) {
      fail(id, error);
      return null;
    }
  };

  /** The incoming preset takes the screen; the one under it goes. */
  const settle = (layer: Layer, now: number): void => {
    if (base && base !== layer) drop(base);
    base = layer;
    incoming = null;
    shown = layer.preset.id;
    switchAt = now + AUTO_SECONDS * 1000;
  };

  /** Show a preset: at once when nothing is on screen, else fading in over it. */
  const show = (id: string, now: number): void => {
    if (destroyed || lost) return;
    if (incoming) {
      // A change cut short: what already fades in stays, what is still unseen goes.
      if (incoming.fadeAt) settle(incoming, now);
      else drop(incoming);
      incoming = null;
    }
    const layer = makeLayer(id);
    if (!layer) return;
    if (!base) {
      settle(layer, now);
      listener?.();
      return;
    }
    incoming = layer;
  };

  /** One frame of one preset: the scene, then the finish into its next output. */
  const paint = (layer: Layer, now: number): boolean => {
    const dt = layer.previous ? Math.min(0.1, Math.max(0, (now - layer.previous) / 1000)) : 1 / 60;
    layer.previous = now;
    layer.clock += dt;
    // A 1920×1080 picture is 1; a phone held upright, whose scenes are seen wider, gets thinner
    // lines than its height alone would give.
    const px = Math.max(0.5, Math.sqrt(pipeline.width * pipeline.height) / 1440);
    const frame: FrameInfo = {
      gl, width: pipeline.width, height: pipeline.height, aspect: pipeline.width / Math.max(1, pipeline.height),
      time: layer.clock, dt, audio: feed, px, maxPoint
    };
    try {
      pipeline.resizeOutputs(layer.outputs);
      pipeline.begin(layer.preset.background, layer.preset.pattern ?? false, px);
      layer.scene.draw(frame);
      pipeline.finish(layer.preset.post ?? {}, layer.preset.background, layer.outputs);
      return true;
    } catch (error) {
      // One bad frame must not end the picture; the engine does the same for the others.
      console.warn("Formy dźwięku: frame failed", layer.preset.id, error);
      gl.bindVertexArray(null);
      return false;
    }
  };

  /** A lost context (the GPU reset, too many contexts): everything is made again once it is back. */
  const onLost = (event: Event): void => {
    event.preventDefault();
    lost = true;
    base = null;
    incoming = null;
    shown = "";
  };
  const onRestored = (): void => {
    if (destroyed) return;
    try {
      pipeline = new Pipeline(gl);
      size = "";
      lost = false;
      switchAt = 0;
    } catch (error) {
      console.warn("Formy dźwięku: the restored context would not start", error);
    }
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  const groups = (): readonly PresetGroup[] => soundformsPresetGroups(offered, t);

  return {
    canvas,
    presets: () => ids.filter(offered),
    presetGroups: groups,
    chosen: () => chosen,
    current: () => shown,
    setListener(next: (() => void) | null): void {
      listener = next;
    },
    setAutoFilter(favourites: readonly string[] | null): void {
      const filter = favourites ? new Set(favourites.filter((id) => all.has(id))) : null;
      autoFilter = filter && filter.size ? filter : null;
      // Showing something outside the new choice: Auto moves on now.
      if (chosen === AUTO && autoFilter && shown && !autoFilter.has(shown)) switchAt = 0;
    },
    choose(id: string): void {
      chosen = id === AUTO || offered(id) ? id : AUTO;
      if (persist) write(STORAGE_KEY, chosen);
      if (chosen === AUTO) switchAt = 0;
      // Before the first frame there is no size yet: the first frame shows the choice.
      else if (width && chosen !== shown && chosen !== incoming?.preset.id) show(chosen, performance.now());
    },
    next(): void {
      if (chosen === AUTO) {
        switchAt = 0;
        return;
      }
      // Chosen: the next one in the list, chosen in its turn.
      const list = ids.filter(offered);
      const following = list[(list.indexOf(chosen) + 1) % list.length];
      if (!following) return;
      chosen = following;
      if (persist) write(STORAGE_KEY, chosen);
      if (width) show(chosen, performance.now());
      listener?.();
    },
    announce: () => undefined,
    render(time: number): void {
      if (destroyed || lost || !width || gl.isContextLost()) return;
      // The music is read once a frame, whichever presets are drawing.
      feed.update(audioTime ? Math.min(0.1, Math.max(0, (time - audioTime) / 1000)) : 1 / 60);
      audioTime = time;
      if (!base && !incoming) {
        if (time >= switchAt) {
          const first = chosen !== AUTO && offered(chosen) ? chosen : draw();
          if (first) show(first, time);
          else switchAt = time + 5000;
        }
      } else if (chosen === AUTO && !incoming && time >= switchAt) {
        const next = draw();
        if (next && next !== shown) show(next, time);
        else switchAt = time + AUTO_SECONDS * 1000;
      } else if (chosen !== AUTO && offered(chosen) && chosen !== shown && chosen !== incoming?.preset.id) {
        show(chosen, time);
      }
      const current = base as Layer | null;
      if (current && !paint(current, time) && !incoming && chosen === AUTO) switchAt = 0;
      const coming = incoming as Layer | null;
      let fade = 0;
      if (coming) {
        const firstFrame = coming.previous === 0;
        if (!paint(coming, time)) {
          drop(coming);
          incoming = null;
        } else if (!coming.fadeAt && !firstFrame) {
          // Drawn once unseen (shaders compiled, first frame done): now it fades in.
          coming.fadeAt = time;
          shown = coming.preset.id;
        } else if (coming.fadeAt) {
          const progress = (time - coming.fadeAt) / FADE_MS;
          if (progress >= 1) settle(coming, time);
          else fade = progress * progress * (3 - 2 * progress);
        }
      }
      const coming2 = incoming as Layer | null;
      pipeline.present(base ? (base as Layer).outputs : null, coming2?.fadeAt ? coming2.outputs : null, fade);
    },
    resize(nextWidth: number, nextHeight: number): void {
      const ratio = Math.max(0.5, Math.min(
        MAX_PIXEL_RATIO,
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_PIXELS / Math.max(1, nextWidth * nextHeight))
      ));
      const key = `${nextWidth}x${nextHeight}@${ratio.toFixed(3)}`;
      if (key === size || lost) return;
      size = key;
      width = nextWidth;
      const pixelWidth = Math.max(1, Math.round(nextWidth * ratio));
      const pixelHeight = Math.max(1, Math.round(nextHeight * ratio));
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      pipeline.resize(pixelWidth, pixelHeight);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      listener = null;
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (!lost && !gl.isContextLost()) {
        for (const layer of [base, incoming]) if (layer) drop(layer);
        pipeline.dispose();
      }
      base = null;
      incoming = null;
      feed.dispose();
      // Free the context now rather than whenever the collector comes (browsers allow few).
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    }
  };
}
