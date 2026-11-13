import "./stage.css";

import extraCatalog from "virtual:voltviz-extra";
import logoFiles from "virtual:voltviz-logos";

import { presetDeck } from "../milkdrop";
import { storedIds } from "../preset-search";
import type { ExternalOptions, ExternalVisualizer, PresetGroup } from "../types";
import { AudioEngine } from "./audio/AudioEngine";
import type { AudioFrame } from "./audio/types";
import { voltvizCatalog, type VoltVizEntry } from "./catalog";
import { halftoneStyle, halftoneVariants, type HalftoneLook, type HalftoneVariant } from "./halftone";
import dummyCover from "./images/dummycover.jpg";
import { FAILED_KEY, HALFTONE, halftoneListed, logoListed, voltvizGroups, voltvizListing, webgpuAvailable } from "./listing";
import { traceLogo, type TracedPath } from "./logo";
import { halftoneOverlay, iconsOverlay, type HalftonePicture, type MountedOverlay } from "./overlays";
import type { VisualizerSettings } from "./types";
import type { ServerStateMetadata, VisualizerInstance, VisualizerModule } from "./visualizers/runtime/types";

/**
 * VoltViz: the visualizations of voltviz (MIT, vendored in this folder, see
 * LICENSE-voltviz.txt), each one a preset of this visualizer, driven frame by frame by the
 * panel's engine.
 *
 * The vendored files are upstream's `src/` (audio/, visualizers/, types.ts, data/) and
 * `images/`, changed only where they say "Fork:", besides import paths: no `.ts` extensions,
 * Sendspin's metadata type from visualizers/runtime/types.ts, `images/` inside this folder.
 *
 * Audio: voltviz's own audio engine, attached to the player's AnalyserNode
 * (audio/AudioEngine.ts, `attach`). The node's output feeds voltviz's analysis (onsets, tempo,
 * the beat grid) in an AudioWorklet, which is a script of its own from this origin as the
 * page's policy wants, and voltviz's pool of display analysers, so every visualization reads the
 * spectrum, waveform, bands and beats it was tuned on. Nothing is added to what is heard.
 *
 * "Auto" deals the visualizations like a shuffled deck, a new one every 30 seconds. The next
 * one draws unseen for a moment (first frames, shader compilation) and then fades in over the
 * one on screen, as voltviz crossfades its own. The four raw WebGPU ones draw with WebGPU where
 * the browser hands out an adapter and with their WebGL 2 translation elsewhere
 * (visualizers/lib/webgl2.ts); their names say which.
 *
 * Your Logo is offered once per logo the build found in vendor/voltviz-logos
 * (scripts/voltviz-logos.mjs), a picture traced into outlines (logo.ts); for Auto they are one
 * card, and when it comes up one of the logos is picked at random.
 *
 * Halftone Pulse is followed by the choices its React overlay offers in voltviz (halftone.ts):
 * neon colours, each mode, each shape. Auto deals Halftone Pulse itself, the choices only when
 * they are among the favourites it deals from.
 *
 * Icons and Halftone Pulse also have voltviz's overlays, as plain DOM in their layer
 * (overlays.ts), resting with the panel's toolbar. Halftone Pulse's (Style: mode, shape, colours
 * at once) sets "your style", the look plain Halftone Pulse opens in from then on, kept per
 * browser; changed over one of the presets, what is on screen becomes Halftone Pulse in that style.
 */

const AUTO = "auto";
const AUTO_SECONDS = 30;
/** How long an incoming visualization draws unseen, and how long it fades in (stage.css). */
const WARMUP_MS = 300;
const FADE_MS = 500;
/** A visualization that has not started by then is skipped for this visit. */
const MOUNT_TIMEOUT_MS = 15_000;
/** Visualizations tried in a row after failures before Auto waits a while. */
const MAX_ATTEMPTS = 6;
/** How often the track (title, artist, cover) is looked up. */
const TRACK_POLL_MS = 1000;
/** Without a frame for this long (panel closed, tab hidden), the analysis is paused. */
const IDLE_MS = 3000;
/**
 * voltviz renders at the device's pixel ratio up to 2; the panel can be a 4K screen, so the
 * picture is also capped at 1440p, as MilkDrop's is.
 */
const MAX_PIXEL_RATIO = 2;
const MAX_PIXELS = 2560 * 1440;
const STORAGE_KEY = "media-visualizer-preset:voltviz";
/** Halftone Pulse's look chosen in its overlay ("your style"), for plain Halftone Pulse. */
const HALFTONE_STYLE_KEY = "media-visualizer-voltviz-halftone";
/** Pictures are traced at most this size (the longer side); Your Logo needs no more detail. */
const LOGO_SIDE = 1024;
/** voltviz's default settings; its Settings panel is not part of the player. */
const SETTINGS: VisualizerSettings = { sensitivity: 1, speed: 1, hueShift: 0, scale: 1 };

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


/**
 * The cover the player's dock shows, once it has loaded. The player does not hand its track
 * to visualizers, and its Media Session entry carries no artwork, so it is read where it is.
 */
function dockCover(): string | null {
  const image = document.querySelector<HTMLImageElement>(".audio-dock__artwork.has-image .audio-dock__artwork-image");
  return image?.currentSrc || image?.src || null;
}

/** The track playing now, in the shape voltviz's visualizations read (Sendspin's metadata). */
function readTrack(announced: string): ServerStateMetadata | null {
  const session = "mediaSession" in navigator ? navigator.mediaSession.metadata : null;
  let title = session?.title ?? "";
  let artist = session?.artist ?? "";
  if (!title && announced) {
    const [first = "", second = ""] = announced.split(" — ");
    title = first;
    artist = second;
  }
  const cover = session?.artwork.find((artwork) => artwork.src)?.src ?? dockCover();
  if (!title && !artist && !cover) return null;
  return { title: title || null, artist: artist || null, album: session?.album || null, artwork_url: cover };
}

function sameTrack(left: ServerStateMetadata | null, right: ServerStateMetadata | null): boolean {
  return (left?.title ?? null) === (right?.title ?? null)
    && (left?.artist ?? null) === (right?.artist ?? null)
    && (left?.artwork_url ?? null) === (right?.artwork_url ?? null);
}

/** A logo's pixels, as the browser decodes its file (at most LOGO_SIDE on the longer side). */
async function logoPixels(url: string): Promise<ImageData> {
  // The load event, not decode(): decode() waits for the page to paint, which a page in the
  // background does not do.
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Logo ${url} could not be loaded`));
    image.src = url;
  });
  const scale = Math.min(1, LOGO_SIDE / Math.max(1, image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas for the logo");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

type LogoShape = { svg: string } | { paths: TracedPath[] };

/** What Your Logo draws for each logo, fetched (and traced) once a page. */
const logoShapes = new Map<string, Promise<LogoShape>>();

/**
 * Your Logo with one of the owner's logos. The file is fetched, and a picture traced, while the
 * visualization loads, so a logo that cannot be had is skipped for the visit like a chunk that
 * cannot be fetched.
 */
function logoEntry(logo: { id: string; name: string; kind: "svg" | "image"; url: string }): VoltVizEntry {
  const shape = (): Promise<LogoShape> => {
    let pending = logoShapes.get(logo.id);
    if (!pending) {
      pending = logo.kind === "svg"
        ? fetch(logo.url).then(async (response): Promise<LogoShape> => {
          if (!response.ok) throw new Error(`Logo ${logo.url}: HTTP ${response.status}`);
          return { svg: await response.text() };
        })
        : logoPixels(logo.url).then((pixels): LogoShape => ({ paths: traceLogo(pixels) }));
      // A failure is not kept: the next try fetches again.
      pending.catch(() => logoShapes.delete(logo.id));
      logoShapes.set(logo.id, pending);
    }
    return pending;
  };
  return {
    ...logoListed(logo),
    load: async (): Promise<VisualizerModule> => {
      const [module, drawn] = await Promise.all([import("./visualizers/impl/YourLogo"), shape()]);
      return {
        default: async (context) => {
          const instance = await module.default(context);
          const api = instance.api as unknown as { loadSvg(svg: string): boolean; loadPaths(paths: TracedPath[]): boolean };
          if (!("svg" in drawn ? api.loadSvg(drawn.svg) : api.loadPaths(drawn.paths))) {
            instance.dispose();
            throw new Error(`Logo ${logo.name}: nothing to draw`);
          }
          return instance;
        }
      };
    }
  };
}

/**
 * Halftone Pulse with one of its overlay's choices: the adapter sets it as the overlay sets it
 * (setMode, setShape, setNeon) before the first frame (`look`, in mount), so it opens in that
 * look, and its overlay starts from it.
 */
function halftoneEntry(variant: HalftoneVariant): VoltVizEntry {
  return {
    ...halftoneListed(variant),
    load: () => import("./visualizers/impl/HalftonePulse"),
    overlay: "halftone",
    look: () => ({ ...variant.look })
  };
}

/** A failure of the browser (no WebGL or WebGPU context) rather than of the visualization. */
function environmental(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /webgl|webgpu|context/i.test(message);
}

/**
 * The picture the listener chose in Halftone Pulse's overlay (voltviz's "Upload Image") in place of
 * the track's cover: an object URL of the file, so it never leaves the browser — not sent, not
 * stored. voltviz kept it while its overlay lived; here it stays while the page is open (Auto
 * dealing another visualization, the panel closed and opened), until "back to the cover", and
 * every Halftone Pulse takes it.
 */
let halftoneImage: string | null = null;

/** One mounted visualization: voltviz's container and what its factory returned. */
interface Layer {
  id: string;
  element: HTMLDivElement;
  instance: VisualizerInstance | null;
  /** voltviz's overlay over it (Icons, Halftone Pulse), once it has started. */
  overlay: MountedOverlay | null;
  /** performance.now() when the instance was ready (0 while it loads), and of its last frame. */
  readyAt: number;
  lastTime: number;
  /** When it began to fade in; 0 before. */
  fadeAt: number;
}

export async function createVoltViz(analyser: AnalyserNode, options: ExternalOptions = {}): Promise<ExternalVisualizer> {
  const [engine, webgpu] = await Promise.all([
    AudioEngine.attach(analyser, { autoGain: false, neural: false }),
    webgpuAvailable()
  ]);
  // Halftone Pulse's choices, Moss Ball and Flame when the owner added them to vendor/
  // (scripts/voltviz-extra.mjs), and Your Logo once per logo in vendor/voltviz-logos
  // (scripts/voltviz-logos.mjs). The raw WebGPU ones: WebGPU where there is an adapter, their
  // WebGL 2 translation elsewhere. Alphabetical, each visualization followed by its choices in
  // their own order (listing.ts, which the panel's search reads too).
  const { entries, ids } = voltvizListing<VoltVizEntry>([
    ...voltvizCatalog, ...halftoneVariants().map(halftoneEntry),
    ...(extraCatalog as readonly VoltVizEntry[]), ...logoFiles.map(logoEntry)
  ], webgpu);
  // Halftone Pulse itself opens in the listener's style (its overlay sets it).
  const plainHalftone = entries.get(HALFTONE);
  if (plainHalftone) entries.set(HALFTONE, { ...plainHalftone, overlay: "halftone", look: () => halftoneStyle(read(HALFTONE_STYLE_KEY)) });
  const gpuBackend = webgpu ? "webgpu" : "webgl";
  const variantOf = (id: string): string | undefined => entries.get(id)?.variantOf;
  const failed = new Set<string>(storedIds(read(FAILED_KEY)));
  /** Could not be fetched, or started, on this visit: skipped, not remembered. */
  const unavailable = new Set<string>();
  const offered = (id: string): boolean => entries.has(id) && !failed.has(id) && !unavailable.has(id);
  if (!ids.some(offered)) {
    engine.dispose();
    throw new Error("No playable VoltViz visualizations");
  }

  const stage = document.createElement("div");
  stage.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl voltviz-stage";

  // Auto deals cards: a visualization, or a family of them (Your Logo's logos), one of which is
  // then picked at random. A visualization and its choices are one card too, and the choices are
  // dealt only from the favourites: without them, Halftone Pulse comes up as it always did.
  const family = (id: string): string => entries.get(id)?.family ?? variantOf(id) ?? id;
  const deal = presetDeck([...new Set(ids.map(family))]);
  // "Auto" over the listener's favourites only, known before the first one is dealt.
  let autoFilter: Set<string> | null = options.autoFilter?.length ? new Set(options.autoFilter) : null;
  const dealable = (id: string): boolean => offered(id) && (!autoFilter || autoFilter.has(id));
  const draw = (): string | undefined => {
    if (autoFilter && !ids.some(dealable)) autoFilter = null;
    for (let attempt = 0; attempt < ids.length * 2; attempt += 1) {
      const card = deal();
      const members = ids.filter((id) => family(id) === card && dealable(id) && id !== shown && (autoFilter || !variantOf(id)));
      if (members.length) return members[Math.floor(Math.random() * members.length)];
    }
    return ids.find(dealable);
  };

  const persist = options.persist !== false;
  let chosen = (options.preset !== undefined && offered(options.preset) ? options.preset : null)
    ?? read(STORAGE_KEY) ?? AUTO;
  if (chosen !== AUTO && !offered(chosen)) chosen = AUTO;
  /** The visualization on screen (the incoming one, once it fades in). */
  let shown = "";
  let base: Layer | null = null;
  let incoming: Layer | null = null;
  let listener: (() => void) | null = null;
  let switchAt = 0;
  let attempts = 0;
  let destroyed = false;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let announced = "";
  let track = readTrack("");
  let trackCheckAt = 0;
  let renderedAt = performance.now();
  const idle = window.setInterval(() => {
    if (performance.now() - renderedAt > IDLE_MS) engine.suspend();
  }, IDLE_MS);

  /** Out of the list: for good when it threw, for this visit when the browser or the network failed. */
  const fail = (id: string, error: unknown, forGood = !environmental(error)): void => {
    console.warn(forGood ? "VoltViz visualization failed" : "VoltViz visualization unavailable", id, error);
    if (forGood) {
      failed.add(id);
      write(FAILED_KEY, JSON.stringify([...failed].slice(-100)));
    } else {
      unavailable.add(id);
    }
    if (chosen === id) {
      chosen = AUTO;
      if (persist) write(STORAGE_KEY, chosen);
    }
    listener?.();
  };

  /** What to show next: the pinned visualization, or one dealt by Auto. */
  const wanted = (): string | undefined => (chosen !== AUTO && offered(chosen) ? chosen : draw());

  const drop = (layer: Layer): void => {
    layer.overlay?.dispose();
    layer.overlay = null;
    try {
      layer.instance?.dispose();
    } catch (error) {
      console.warn("VoltViz: disposing failed", layer.id, error);
    }
    layer.instance = null;
    layer.element.remove();
  };

  /**
   * The cover, for a visualization that takes an image but does not read the track (Blur
   * Image, which starts with voltviz's stand-in cover); those with a `metadata` hook find the
   * cover in the track themselves.
   */
  const feedCover = (layer: Layer, changed: boolean): void => {
    const instance = layer.instance;
    const cover = track?.artwork_url ?? (changed ? dummyCover : null);
    if (!instance || instance.metadata || !cover) return;
    const setImage = instance.api?.["setImage"] as unknown as ((url: string) => void) | undefined;
    if (typeof setImage !== "function") return;
    try {
      setImage(cover);
    } catch { /* obraz to ozdoba */ }
  };

  /** The incoming visualization takes the screen; the one under it goes. */
  const settle = (layer: Layer, now: number): void => {
    layer.element.classList.add("is-visible");
    if (base && base !== layer) drop(base);
    base = layer;
    incoming = null;
    shown = layer.id;
    attempts = 0;
    switchAt = now + AUTO_SECONDS * 1000;
  };

  /** Something else to show after a failure: Auto deals on, and waits a while after many. */
  const recover = (): void => {
    if (destroyed || incoming) return;
    if (attempts >= MAX_ATTEMPTS) {
      attempts = 0;
      switchAt = performance.now() + 5000;
      return;
    }
    const next = wanted();
    if (next) show(next);
  };

  const abandon = (layer: Layer): void => {
    if (incoming !== layer) return;
    drop(layer);
    incoming = null;
    recover();
  };

  /**
   * A look chosen in Halftone Pulse's overlay: from now on the listener's style, plain Halftone
   * Pulse's. Over one of its presets, what is on screen is that no longer: it becomes Halftone
   * Pulse (in the list, the choice and the star), without a new start.
   */
  const restyle = (layer: Layer, look: HalftoneLook): void => {
    write(HALFTONE_STYLE_KEY, JSON.stringify(look));
    if (layer.id === HALFTONE || !entries.has(HALFTONE)) return;
    const was = layer.id;
    layer.id = HALFTONE;
    if (shown === was) shown = HALFTONE;
    if (chosen === was) {
      chosen = HALFTONE;
      if (persist) write(STORAGE_KEY, chosen);
    }
    listener?.();
  };

  /** The listener's picture (or the cover again, null) to every Halftone Pulse on the stage. */
  const showPicture = (): void => {
    for (const layer of [base, incoming]) {
      if (!layer?.instance || entries.get(layer.id)?.overlay !== "halftone") continue;
      try {
        (layer.instance.api as unknown as { setImage(url: string | null): void }).setImage(halftoneImage);
      } catch { /* obraz to ozdoba */ }
      layer.overlay?.refresh?.();
    }
  };

  /** "Upload Image": the file as an object URL, once the browser has shown it can draw it. */
  const picture: HalftonePicture = {
    chosen: () => halftoneImage !== null,
    async choose(file: File): Promise<boolean> {
      const url = URL.createObjectURL(file);
      try {
        const test = new Image();
        test.src = url;
        await test.decode();
      } catch {
        URL.revokeObjectURL(url);
        return false;
      }
      const old = halftoneImage;
      halftoneImage = url;
      showPicture();
      if (old) URL.revokeObjectURL(old);
      return true;
    },
    clear(): void {
      const old = halftoneImage;
      halftoneImage = null;
      showPicture();
      if (old) URL.revokeObjectURL(old);
    }
  };

  /** voltviz's overlay over a visualization that has one, once it has started. */
  const overlayFor = (entry: VoltVizEntry, layer: Layer, instance: VisualizerInstance, look: HalftoneLook | null): MountedOverlay | null => {
    const api = instance.api as unknown;
    try {
      if (entry.overlay === "icons") return iconsOverlay(layer.element, api as Parameters<typeof iconsOverlay>[1]);
      if (entry.overlay === "halftone" && look) {
        return halftoneOverlay(layer.element, api as Parameters<typeof halftoneOverlay>[1], look, (next) => restyle(layer, next), picture);
      }
    } catch (error) {
      // The overlay is an extra: the visualization plays on without it.
      console.warn("VoltViz: overlay failed", layer.id, error);
    }
    return null;
  };

  const mount = async (entry: VoltVizEntry, layer: Layer): Promise<void> => {
    let module: VisualizerModule;
    try {
      module = await entry.load();
    } catch (error) {
      // The network, not the visualization: skipped for this visit only.
      fail(entry.id, error, false);
      abandon(layer);
      return;
    }
    if (incoming !== layer || destroyed) return;
    let instance: VisualizerInstance;
    let timedOut = false;
    let timer = 0;
    try {
      const started = Promise.resolve(module.default({
        container: layer.element, width, height, dpr, settings: SETTINGS, metadata: track, gpuBackend
      }));
      // One that starts after all, too late, is not left running unseen.
      started.then((late) => {
        if (timedOut) late.dispose();
      }, () => undefined);
      instance = await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => {
            timedOut = true;
            reject(new Error(`not started in ${MOUNT_TIMEOUT_MS} ms`));
          }, MOUNT_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      // A slow start says nothing for good either.
      fail(entry.id, error, timedOut ? false : undefined);
      abandon(layer);
      return;
    } finally {
      window.clearTimeout(timer);
    }
    if (incoming !== layer || destroyed) {
      try {
        instance.dispose();
      } catch { /* już zniszczony */ }
      layer.element.remove();
      return;
    }
    layer.instance = instance;
    let look: HalftoneLook | null = null;
    try {
      // Halftone Pulse's look, before its first frame: the one it opens in, and the listener's
      // picture over the cover when there is one.
      if (entry.look) {
        look = entry.look();
        const api = instance.api as unknown as { setMode(mode: string): void; setShape(shape: string): void; setNeon(on: boolean): void; setImage(url: string | null): void };
        api.setMode(look.mode);
        api.setShape(look.shape);
        api.setNeon(look.neon);
        if (halftoneImage) api.setImage(halftoneImage);
      }
      instance.resize?.(width, height, dpr);
    } catch (error) {
      fail(entry.id, error);
      abandon(layer);
      return;
    }
    feedCover(layer, false);
    layer.overlay = overlayFor(entry, layer, instance, look);
    layer.readyAt = performance.now();
    layer.lastTime = layer.readyAt;
  };

  /** Mount a visualization above the one on screen; it fades in once it has drawn a while. */
  const show = (id: string): void => {
    const entry = entries.get(id);
    if (!entry || destroyed) return;
    if (incoming) {
      // A change cut short: what is already fading in stays, what is still unseen goes.
      if (incoming.fadeAt) settle(incoming, performance.now());
      else drop(incoming);
    }
    const element = document.createElement("div");
    element.className = "voltviz-stage__layer";
    stage.append(element);
    const layer: Layer = { id, element, instance: null, overlay: null, readyAt: 0, lastTime: 0, fadeAt: 0 };
    incoming = layer;
    attempts += 1;
    void mount(entry, layer);
  };

  /** One frame of one visualization; one that throws is dropped and replaced. */
  const frame = (layer: Layer, audio: AudioFrame, now: number): void => {
    const instance = layer.instance;
    if (!instance || !layer.readyAt) return;
    const dt = Math.min(0.1, Math.max(0, (now - layer.lastTime) / 1000));
    layer.lastTime = Math.max(layer.lastTime, now);
    try {
      instance.frame({
        audio, settings: SETTINGS, metadata: track,
        time: Math.max(0, (now - layer.readyAt) / 1000), dt, width, height, dpr
      });
    } catch (error) {
      fail(layer.id, error);
      drop(layer);
      if (layer === base) base = null;
      if (layer === incoming) incoming = null;
      if (shown === layer.id) shown = "";
      recover();
    }
  };

  /** The track changed: every visualization that reads it is told. */
  const refreshTrack = (now: number): void => {
    if (now < trackCheckAt) return;
    trackCheckAt = now + TRACK_POLL_MS;
    const next = readTrack(announced);
    if (sameTrack(next, track)) return;
    const coverChanged = (next?.artwork_url ?? null) !== (track?.artwork_url ?? null);
    track = next;
    for (const layer of [base, incoming]) {
      if (!layer?.instance) continue;
      try {
        layer.instance.metadata?.(track);
      } catch (error) {
        console.warn("VoltViz: metadata failed", layer.id, error);
      }
      if (coverChanged) feedCover(layer, true);
    }
  };

  let size = "";
  return {
    canvas: stage,
    presets: () => ids.filter(offered),
    // One list without headings, but for the choices of a visualization (Halftone Pulse's modes
    // and shapes), each kind under its own.
    presetGroups: (): readonly PresetGroup[] => voltvizGroups(ids.filter(offered), entries),
    chosen: () => chosen,
    current: () => shown,
    // The panel's random ›: what › can reach, so Halftone Pulse's choices only from one of them.
    randomPool: (): readonly string[] => {
      const among = variantOf(chosen);
      return ids.filter((id) => offered(id) && (among !== undefined || !variantOf(id)));
    },
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
      else if (width && chosen !== shown && chosen !== incoming?.id) show(chosen);
    },
    next(): void {
      if (chosen === AUTO) {
        switchAt = 0;
        return;
      }
      // Pinned: the next one in the list, still pinned. A visualization's choices are stepped
      // through only from one of them: from anywhere else › goes past them.
      const list = ids.filter(offered);
      const from = list.indexOf(chosen);
      const among = variantOf(chosen);
      let following: string | undefined;
      for (let step = 1; step <= list.length && !following; step += 1) {
        const id = list[(Math.max(0, from) + step) % list.length]!;
        const choice = variantOf(id);
        if (!choice || (among !== undefined && choice === among)) following = id;
      }
      if (!following) return;
      chosen = following;
      if (persist) write(STORAGE_KEY, chosen);
      if (width) show(chosen);
      listener?.();
    },
    announce(text: string): void {
      announced = text;
      trackCheckAt = 0;
      // A new song: voltviz looks for its beat afresh instead of carrying the last one over.
      engine.notifySongChange();
    },
    render(time: number): void {
      if (destroyed || !width) return;
      renderedAt = performance.now();
      engine.resume();
      refreshTrack(time);
      if (!base && !incoming) {
        if (time >= switchAt) {
          const first = wanted();
          if (first) show(first);
          else switchAt = time + 5000;
        }
      } else if (chosen === AUTO && !incoming && time >= switchAt) {
        const next = draw();
        if (next && next !== shown) show(next);
        else switchAt = time + AUTO_SECONDS * 1000;
      }
      const coming = incoming;
      if (coming?.readyAt) {
        if (!coming.fadeAt && time - coming.readyAt >= WARMUP_MS) {
          coming.fadeAt = time;
          coming.element.classList.add("is-visible");
          shown = coming.id;
        } else if (coming.fadeAt && time - coming.fadeAt >= FADE_MS) {
          settle(coming, time);
        }
      }
      const audio = engine.frame(time);
      if (base) frame(base, audio, time);
      if (incoming) frame(incoming, audio, time);
    },
    resize(nextWidth: number, nextHeight: number): void {
      const ratio = Math.max(0.5, Math.min(
        MAX_PIXEL_RATIO,
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_PIXELS / Math.max(1, nextWidth * nextHeight))
      ));
      const key = `${nextWidth}x${nextHeight}@${ratio.toFixed(3)}`;
      if (key === size) return;
      size = key;
      width = nextWidth;
      height = nextHeight;
      dpr = ratio;
      for (const layer of [base, incoming]) {
        if (!layer?.instance) continue;
        try {
          layer.instance.resize?.(width, height, dpr);
        } catch (error) {
          console.warn("VoltViz: resize failed", layer.id, error);
        }
      }
    },
    destroy(): void {
      destroyed = true;
      listener = null;
      window.clearInterval(idle);
      for (const layer of [base, incoming]) if (layer) drop(layer);
      base = null;
      incoming = null;
      engine.dispose();
      stage.remove();
    }
  };
}
