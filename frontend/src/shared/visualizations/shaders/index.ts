import { t } from "../../i18n";
import { presetDeck } from "../milkdrop";
import type { ExternalOptions, ExternalVisualizer, PresetGroup, PresetPool } from "../types";
import { ShaderAudio } from "./audio";
import { CROSSFADE_SECONDS, CROSSFADE_VERTEX, type CompiledProgram, type FrameState, Gpu, Graph, limitSize, type Target, texturesAvailable } from "./runner";
import { FAILED_KEY, shaderListing, shaderPresetGroups } from "./listing";
import { TextureBank } from "./textures";
import type { AudioName, CrossfadeShader, Program, ShaderBuildInfo, ShaderEntry, ShaderIndex } from "./types";

/**
 * Shadery: the visualizations of Monkey Hi Hat (Volt's Laboratory) and of music_visualizer, as the
 * presets of one visualizer, drawn by this folder's WebGL 2 runner from what the build converted
 * (scripts/shader-visualizers.mjs, from frontend/vendor/shader-visualizers/).
 *
 * The list groups them by where they come from and what they are: Monkey Hi Hat's visualizers
 * that follow the music, its VertexShaderArt-style ones, those that do not listen, its effects,
 * and music_visualizer's. An effect is shown over a visualization drawn at random from those that
 * follow the music and do not exclude that effect, fading in over it as Monkey Hi Hat fades one in.
 *
 * "Auto" deals the presets of the chosen source like a shuffled deck — the ones that follow the
 * music, or the listener's favourites — a new one every 30 seconds (twice that for those Monkey Hi
 * Hat plays twice as long). The next one compiles while the one on screen plays on, and comes in
 * through one of Volt's Laboratory's crossfades over two seconds, a plain fade without them. The
 * favourites, the lock and "next" work as in the other visualizers.
 *
 * The picture is drawn at the screen's pixels (up to twice the CSS size, 1440p at most), at each
 * shader's own resolution limit, and smaller when the device cannot keep up; 60 frames a second at
 * most, as Monkey Hi Hat draws them. A shader this browser will not compile is left out for good
 * (until the build changes it); one that cannot be fetched, for this visit.
 */

const AUTO = "auto";
const AUTO_SECONDS = 30;
const STORAGE_KEY = "media-visualizer-preset:shaders";
const POOL_KEY = "media-visualizer-pack:shaders";
const ALL_POOL = "all";
const MAX_PIXEL_RATIO = 2;
const MAX_PIXELS = 2560 * 1440;
/** Monkey Hi Hat's FrameRateLimit: feedback shaders move per frame, not per second. */
const FRAME_MS = 1000 / 60;
/** A preset still not ready after this is skipped for this visit. */
const LOAD_TIMEOUT_MS = 20_000;
/** Presets tried in a row after failures before Auto waits a while. */
const MAX_ATTEMPTS = 6;
/** How long the picture may stay black while music plays before Auto moves on. */
const DARK_SECONDS = 6;
/** The picture may get this much smaller, side by side, when frames come too slowly. */
const MIN_SCALE = 0.35;

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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return (await response.json()) as T;
}

/** Fetching failed, or the browser lacks something: not the preset's fault. */
class Unavailable extends Error {}

interface Layer {
  entry: ShaderEntry;
  graph: Graph | null;
  /** An effect: the visualization it is drawn over. */
  under: ShaderEntry | null;
  startedAt: number;
  /** When it was ready (0 while it loads). */
  readyAt: number;
}

export async function createShaders(
  analyser: AnalyserNode,
  options: ExternalOptions = {},
  info: ShaderBuildInfo
): Promise<ExternalVisualizer> {
  const index = await fetchJson<ShaderIndex>(info.index);
  const canvas = document.createElement("canvas");
  canvas.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl";
  const created = canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
    preserveDrawingBuffer: false, powerPreference: "high-performance"
  });
  if (!created) throw new Error("WebGL 2 is not available");
  const gl: WebGL2RenderingContext = created;
  const crossfadeSources = index.crossfades
    ? await fetchJson<CrossfadeShader[]>(index.crossfades).catch((error: unknown) => {
        console.warn("Shaders: crossfades unavailable", error);
        return [] as CrossfadeShader[];
      })
    : [];

  let gpu = new Gpu(gl);
  let bank = new TextureBank(gl, { images: index.images });
  let audio = new ShaderAudio(gl, analyser);

  // ---- the list (listing.ts, which the panel's search reads too)
  const { entries, ordered } = shaderListing(index);
  const failed = new Set<string>(((): string[] => {
    try {
      const stored: unknown = JSON.parse(read(FAILED_KEY) ?? "[]");
      return Array.isArray(stored) ? stored.filter((url): url is string => typeof url === "string") : [];
    } catch {
      return [];
    }
  })());
  /** Could not be fetched or started on this visit: skipped, not remembered. */
  const unavailable = new Set<string>();
  const sources = [...new Set(ordered.map((entry) => entry.source))];
  const pools: PresetPool[] = sources.length > 1 ? [
    { id: ALL_POOL, label: t("Wszystkie źródła") },
    { id: "volts", label: "Monkey Hi Hat (Volt's Laboratory)" },
    { id: "mv", label: "music_visualizer" }
  ] : [];
  const persist = options.persist !== false;
  let pool = persist ? read(POOL_KEY) ?? ALL_POOL : ALL_POOL;
  if (!pools.some((candidate) => candidate.id === pool)) pool = ALL_POOL;
  const working = (entry: ShaderEntry): boolean => !failed.has(entry.url) && !unavailable.has(entry.id);
  const inPool = (entry: ShaderEntry): boolean => pool === ALL_POOL || entry.source === pool;
  const offered = (id: string): boolean => {
    const entry = entries.get(id);
    return Boolean(entry && working(entry) && inPool(entry));
  };
  const list = (): string[] => ordered.filter((entry) => working(entry) && inPool(entry)).map((entry) => entry.id);

  let autoFilter: Set<string> | null = options.autoFilter?.length ? new Set(options.autoFilter) : null;
  let deal = presetDeck(ordered.map((entry) => entry.id));
  /** Auto deals what follows the music, or the favourites. */
  const dealable = (id: string): boolean => {
    if (!offered(id)) return false;
    if (autoFilter) return autoFilter.has(id);
    return entries.get(id)!.audio;
  };

  // A favourite opens this visualizer on its preset; the saved choice otherwise.
  // One outside the source chosen (the panel's search found it there): every source, remembered as a
  // source chosen in the list would be.
  if (options.preset !== undefined && entries.has(options.preset) && !inPool(entries.get(options.preset)!)) {
    pool = ALL_POOL;
    if (persist) write(POOL_KEY, pool);
  }
  let chosen = (options.preset !== undefined && offered(options.preset) ? options.preset : null) ?? read(STORAGE_KEY) ?? AUTO;
  if (chosen !== AUTO && !offered(chosen)) chosen = AUTO;

  // ---- what is on screen
  let shown = "";
  let base: Layer | null = null;
  let incoming: Layer | null = null;
  let transition: { startedAt: number; program: CompiledProgram | null } | null = null;
  let listener: (() => void) | null = null;
  let switchAt = 0;
  let attempts = 0;
  let destroyed = false;
  let lost = false;
  let cssWidth = 0;
  let cssHeight = 0;
  let ratio = 1;
  let scale = 1;
  const scales = new Map<string, number>();
  let lastFrame = 0;
  const intervals: number[] = [];
  let adaptedAt = 0;
  const seed = Math.random();
  let darkSince = 0;
  let probedAt = 0;
  const samples = new Uint8Array(new ArrayBuffer(2048));
  const programs = new Map<string, Promise<Program>>();
  const fadeDeck = presetDeck(crossfadeSources.map((_, at) => String(at)));
  let nextFade: CompiledProgram | null = null;
  let nextFadeIndex = -1;
  const brokenFades = new Set<number>();
  const fadeRandom = { random: Math.random(), random4: [Math.random(), Math.random(), Math.random(), Math.random()] };
  let transitionFrame = 0;

  const notify = (): void => listener?.();

  const loadProgram = (url: string): Promise<Program> => {
    let pending = programs.get(url);
    if (!pending) {
      pending = fetchJson<Program>(url).catch((error: unknown) => {
        programs.delete(url);
        throw new Unavailable(error instanceof Error ? error.message : String(error));
      });
      programs.set(url, pending);
    }
    return pending;
  };

  const draw = (): string | undefined => {
    const ids = list();
    if (autoFilter && !ids.some(dealable)) autoFilter = null;
    for (let attempt = 0; attempt < ordered.length * 2; attempt += 1) {
      const id = deal();
      if (dealable(id) && id !== shown) return id;
    }
    return ids.find(dealable) ?? ids.find((id) => id !== shown);
  };

  const wanted = (): string | undefined => (chosen !== AUTO && offered(chosen) ? chosen : draw());

  /** Out of the list: for good when the browser would not compile it, for this visit otherwise. */
  const fail = (entry: ShaderEntry, error: unknown): void => {
    const forGood = !(error instanceof Unavailable);
    console.warn(forGood ? "Shader visualization failed" : "Shader visualization unavailable", entry.id, error);
    if (forGood) {
      failed.add(entry.url);
      write(FAILED_KEY, JSON.stringify([...failed].slice(-200)));
    } else {
      unavailable.add(entry.id);
    }
    if (chosen === entry.id) {
      chosen = AUTO;
      if (persist) write(STORAGE_KEY, chosen);
    }
    notify();
  };

  /** A visualization to put under an effect: one that follows the music and does not exclude it. */
  const underFor = (effect: ShaderEntry, avoid: ReadonlySet<string>): ShaderEntry | undefined => {
    const name = effect.file.toLowerCase();
    const candidates = ordered.filter((entry) => entry.source === "volts" && entry.kind === "viz" && entry.audio
      && working(entry) && !avoid.has(entry.id) && !(entry.blacklist ?? []).includes(name));
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  /** The sizes a layer draws at: the canvas's (made smaller by `scale`), within each shader's limit. */
  const resizeLayer = (layer: Layer): void => {
    const graph = layer.graph;
    if (!graph || !canvas.width) return;
    const width = canvas.width * scale;
    const height = canvas.height * scale;
    graph.resize(...limitSize(width, height, graph.program.limit));
    const under = graph.primary;
    if (under) {
      const limit = graph.program.applyPrimaryLimit && under.program.fxLimit ? under.program.fxLimit : under.program.limit;
      under.resize(...limitSize(width, height, limit));
    }
  };

  const build = async (layer: Layer): Promise<void> => {
    const entry = layer.entry;
    const program = await loadProgram(entry.url);
    if (!texturesAvailable(program, bank)) throw new Unavailable("textures this build does not have");
    if (layer !== incoming || destroyed) return;
    const graph = new Graph(gpu, program, bank);
    if (entry.kind === "fx") {
      const tried = new Set<string>();
      let under = layer.under;
      while (!under || tried.has(under.id)) {
        under = underFor(entry, tried) ?? null;
        if (!under) {
          graph.destroy();
          throw new Unavailable("no visualization to draw the effect over");
        }
      }
      tried.add(under.id);
      const underProgram = await loadProgram(under.url);
      if (layer !== incoming || destroyed) {
        graph.destroy();
        return;
      }
      graph.primary = new Graph(gpu, underProgram, bank);
      graph.setFxUniforms(underProgram.fxUniforms?.[entry.file.toLowerCase()]);
      layer.under = under;
    }
    layer.graph = graph;
    resizeLayer(layer);
  };

  const dropLayer = (layer: Layer | null): void => {
    layer?.graph?.destroy();
    if (layer) layer.graph = null;
  };

  /** Load a preset above the one on screen; it comes in once it has compiled. */
  const show = (id: string, now: number): void => {
    const entry = entries.get(id);
    if (!entry || destroyed || lost) return;
    if (incoming) {
      // A change cut short: what already comes in stays, what still loads goes.
      if (incoming.readyAt && transition) settle(now);
      else dropLayer(incoming);
      incoming = null;
    }
    const layer: Layer = { entry, graph: null, under: null, startedAt: now, readyAt: 0 };
    incoming = layer;
    attempts += 1;
    scale = scales.get(id) ?? 1;
    void build(layer).catch((error: unknown) => {
      if (layer !== incoming) return;
      dropLayer(layer);
      incoming = null;
      fail(entry, error);
      recover(performance.now());
    });
  };

  /** The incoming preset takes the screen; the one under it goes. */
  const settle = (now: number): void => {
    if (!incoming) return;
    if (base && base !== incoming) dropLayer(base);
    base = incoming;
    incoming = null;
    if (transition?.program) gpu.release(transition.program);
    transition = null;
    shown = base.entry.id;
    attempts = 0;
    const hint = base.entry.switchHint?.toLowerCase();
    switchAt = now + AUTO_SECONDS * 1000 * (hint === "double" ? 2 : 1);
    intervals.length = 0;
    prepareFade();
  };

  /** Something else after a failure: Auto deals on, and waits a while after many. */
  const recover = (now: number): void => {
    if (destroyed || incoming) return;
    if (attempts >= MAX_ATTEMPTS) {
      attempts = 0;
      switchAt = now + 5000;
      return;
    }
    const next = wanted();
    if (next) show(next, now);
  };

  /** The next crossfade, compiling while the preset on screen plays; none this browser refused. */
  const prepareFade = (): void => {
    if (nextFade || brokenFades.size >= crossfadeSources.length) return;
    for (let attempt = 0; attempt < crossfadeSources.length * 2; attempt += 1) {
      const at = Number(fadeDeck());
      const source = crossfadeSources[at];
      if (!source || brokenFades.has(at)) continue;
      nextFade = gpu.acquire(CROSSFADE_VERTEX, source.fragment);
      nextFadeIndex = at;
      return;
    }
  };

  /** One frame of a layer: the effect over its visualization, or the visualization. */
  const renderLayer = (layer: Layer, state: FrameState): Target | null => {
    const graph = layer.graph;
    if (!graph) return null;
    const under = graph.primary ? graph.primary.render(state, audio, null) : null;
    if (graph.primary && !under) return null;
    return graph.render(state, audio, under);
  };

  const audioNeeds = (): { eyecandy: Set<AudioName>; stereo: boolean } => {
    const eyecandy = new Set<AudioName>();
    let stereo = false;
    for (const layer of [base, incoming]) {
      for (const graph of [layer?.graph, layer?.graph?.primary]) {
        if (!graph || graph.state !== "ready") continue;
        for (const name of graph.eyecandy) eyecandy.add(name);
        stereo ||= graph.stereo;
      }
    }
    return { eyecandy, stereo };
  };

  /** Frames that come too slowly make the picture smaller; a long run of fast ones, larger again. */
  const adapt = (now: number): void => {
    if (!lastFrame) return;
    intervals.push(now - lastFrame);
    if (intervals.length > 90) intervals.shift();
    if (transition || incoming || now - adaptedAt < 1500 || intervals.length < 45) return;
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    let next = scale;
    if (median > 30 && scale > MIN_SCALE) next = Math.max(MIN_SCALE, scale * 0.8);
    else if (median < 19 && scale < 1 && intervals.length >= 90) next = Math.min(1, scale * 1.12);
    if (next === scale) return;
    scale = next;
    adaptedAt = now;
    intervals.length = 0;
    if (base) {
      scales.set(base.entry.id, scale);
      resizeLayer(base);
    }
  };

  /** Black while music plays: Auto moves on rather than wait out the preset's turn. */
  const watchForDark = (now: number, picture: Target): void => {
    if (chosen !== AUTO || now - probedAt < 1000) return;
    probedAt = now;
    const brightest = gpu.brightness(picture);
    analyser.getByteTimeDomainData(samples.subarray(0, Math.min(samples.length, analyser.fftSize)));
    let loudest = 0;
    for (const sample of samples) loudest = Math.max(loudest, Math.abs(sample - 128));
    if (brightest <= 2 && loudest > 6) {
      darkSince ||= now;
      if (now - darkSince > DARK_SECONDS * 1000) {
        darkSince = 0;
        switchAt = 0;
      }
    } else darkSince = 0;
  };

  const restore = (): void => {
    // A lost context took everything with it: start again from the preset that was on screen.
    lost = false;
    gpu = new Gpu(gl);
    bank = new TextureBank(gl, { images: index.images });
    audio.destroy();
    audio = new ShaderAudio(gl, analyser);
    nextFade = null;
    const again = shown || (chosen !== AUTO ? chosen : "");
    base = null;
    incoming = null;
    transition = null;
    if (again) show(again, performance.now());
  };
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    lost = true;
    for (const layer of [base, incoming]) if (layer) layer.graph = null;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    if (!destroyed) restore();
  });

  return {
    canvas,
    presets: list,
    presetGroups: (): readonly PresetGroup[] => shaderPresetGroups(ordered, new Set(list())),
    pools: () => pools,
    pool: () => pool,
    choosePool(id: string): void {
      if (!pools.some((candidate) => candidate.id === id) || id === pool) return;
      pool = id;
      if (persist) write(POOL_KEY, pool);
      deal = presetDeck(ordered.filter(inPool).map((entry) => entry.id));
      if (chosen !== AUTO && !offered(chosen)) {
        chosen = AUTO;
        if (persist) write(STORAGE_KEY, chosen);
      }
      // A new source shows itself at once.
      if (chosen === AUTO) switchAt = 0;
      notify();
    },
    chosen: () => chosen,
    current: () => shown,
    setListener(next: (() => void) | null): void {
      listener = next;
    },
    setAutoFilter(favourites: readonly string[] | null): void {
      const filter = favourites ? new Set(favourites.filter((id) => entries.has(id))) : null;
      autoFilter = filter && filter.size ? filter : null;
      // Showing something outside the new choice: Auto moves on now.
      if (chosen === AUTO && autoFilter && shown && !autoFilter.has(shown)) switchAt = 0;
    },
    choose(id: string): void {
      chosen = id === AUTO || offered(id) ? id : AUTO;
      if (persist) write(STORAGE_KEY, chosen);
      if (chosen === AUTO) switchAt = 0;
      // Before the first frame there is no size yet: the first frame shows the choice.
      else if (cssWidth && chosen !== shown && chosen !== incoming?.entry.id) show(chosen, performance.now());
    },
    next(): void {
      if (chosen === AUTO) {
        switchAt = 0;
        return;
      }
      // Pinned: the next one in the list, still pinned.
      const ids = list();
      const following = ids[(ids.indexOf(chosen) + 1) % ids.length];
      if (!following) return;
      chosen = following;
      if (persist) write(STORAGE_KEY, chosen);
      if (cssWidth) show(chosen, performance.now());
      notify();
    },
    announce: () => undefined,
    render(time: number): void {
      if (destroyed || lost || !cssWidth) return;
      // At most 60 frames a second: a faster display shows each frame for two of its own.
      if (lastFrame && time - lastFrame < FRAME_MS - 2) return;
      adapt(time);
      lastFrame = time;
      if (!base && !incoming) {
        if (time >= switchAt) {
          const first = wanted();
          if (first) show(first, time);
          else switchAt = time + 5000;
        }
      } else if (chosen === AUTO && !incoming && time >= switchAt) {
        const next = draw();
        if (next && next !== shown) show(next, time);
        else switchAt = time + AUTO_SECONDS * 1000;
      }
      // The incoming preset: compiled yet? Not after too long, and not if it failed.
      const coming = incoming;
      if (coming?.graph) {
        if (coming.graph.poll()) {
          if (!coming.readyAt) {
            coming.readyAt = time;
            if (!base) settle(time);
            else {
              transition = { startedAt: time, program: nextFade && gpu.poll(nextFade) && nextFade.state === "ready" ? nextFade : null };
              if (transition.program) nextFade = null;
              transitionFrame = 0;
              shown = coming.entry.id;
              notify();
            }
          }
        } else if (coming.graph.state === "failed") {
          const error = coming.graph.error;
          dropLayer(coming);
          incoming = null;
          // The visualization under an effect is what failed: that one goes, the effect is tried again.
          if (error.startsWith("under the effect") && coming.under) fail(coming.under, new Error(error));
          else fail(coming.entry, new Error(error));
          recover(time);
        }
      }
      if (incoming && !incoming.readyAt && time - incoming.startedAt > LOAD_TIMEOUT_MS) {
        const late = incoming;
        dropLayer(late);
        incoming = null;
        fail(late.entry, new Unavailable(`not ready in ${LOAD_TIMEOUT_MS} ms`));
        recover(time);
      }
      if (nextFade && gpu.poll(nextFade) && nextFade.state === "failed") {
        // A crossfade this browser will not compile: the next one in the deck instead.
        console.warn("Shader crossfade failed", crossfadeSources[nextFadeIndex]?.name, nextFade.error);
        brokenFades.add(nextFadeIndex);
        gpu.release(nextFade);
        nextFade = null;
        prepareFade();
      }
      const state: FrameState = { now: time, fxActive: base?.entry.kind === "fx", seed, randomNumber: Math.random() };
      audio.update(time, audioNeeds());
      const shownLayer = base;
      const older = shownLayer ? renderLayer(shownLayer, state) : null;
      if (transition && incoming?.readyAt) {
        const newer = renderLayer(incoming, { ...state, fxActive: incoming.entry.kind === "fx" });
        const level = (time - transition.startedAt) / (CROSSFADE_SECONDS * 1000);
        if (newer && older) {
          if (transition.program) {
            gpu.crossfade(transition.program, older.texture, newer.texture, level, {
              seconds: (time - transition.startedAt) / 1000, frame: transitionFrame, ...fadeRandom, seed, randomNumber: state.randomNumber
            }, canvas.width, canvas.height);
          } else if (!gpu.mixInto(null, older.texture, newer.texture, level, canvas.width, canvas.height)) {
            gpu.show(newer.texture, canvas.width, canvas.height);
          }
        } else if (newer) gpu.show(newer.texture, canvas.width, canvas.height);
        transitionFrame += 1;
        if (level >= 1) settle(time);
        return;
      }
      if (older) {
        gpu.show(older.texture, canvas.width, canvas.height);
        watchForDark(time, older);
      }
    },
    resize(width: number, height: number): void {
      const nextRatio = Math.max(0.5, Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1,
        Math.sqrt(MAX_PIXELS / Math.max(1, width * height))));
      if (width === cssWidth && height === cssHeight && nextRatio === ratio) return;
      cssWidth = width;
      cssHeight = height;
      ratio = nextRatio;
      // The canvas's own pixels: the CSS size times the device's ratio, so a phone is sharp too.
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      for (const layer of [base, incoming]) if (layer) resizeLayer(layer);
    },
    destroy(): void {
      destroyed = true;
      listener = null;
      dropLayer(base);
      dropLayer(incoming);
      base = null;
      incoming = null;
      if (nextFade) gpu.release(nextFade);
      if (transition?.program) gpu.release(transition.program);
      transition = null;
      bank.destroy();
      audio.destroy();
      gpu.destroy();
      // The context itself, at once: browsers allow only a few.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    }
  };
}
