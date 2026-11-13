import "./stage.css";

import { t } from "../../i18n";
import { decimate, rateFactor, scaledFftSize } from "../audio-rate";
import { pcmTopByte, winampSpectrum } from "../avs/winamp-visdata";
import type { ExternalOptions, ExternalVisualizer, PresetGroup, PresetPool } from "../types";
import { PictureBudget } from "./budget";
import { GEISS_MAPS, geissMap, geissMapId, mapRatings } from "./maps";
import { MESSAGES_KEY, messageText, readMessages, readSyncColour, SYNC_COLOUR_KEY, writeMessages, writeSyncColour } from "./messages";
import { geissBox } from "./overlay";
import { geissPresetGroups, presetMapName } from "./catalog";
import { PRESETS_KEY, presetId, presetSlot, readPresets, writePresets } from "./presets";
import { DEFAULT_MODE_RATINGS, GeissSim, presentFrame, WINAMP_SAMPLES, type GeissDepth, type GeissPreset, type WinampFrame } from "./sim";
import { rasteriseTitle } from "./title-font";

/**
 * Geiss (Winamp): Ryan Geiss's Winamp plug-in, its own code ported (sim.ts), in the panel.
 *
 * The plug-in drew its picture into memory and let the video card show it — through a palette at
 * 8 bits, each byte doubled at 16/32 bits; here sim.ts draws the same bytes and presentFrame()
 * puts them on a 2D canvas, which the browser scales to the panel. The picture is as big as the
 * panel in device pixels, at most 1280 × 720 (the CPU walks every pixel of it each frame), which
 * the plug-in also took as it came — "whatever your desktop is at". Its frames follow the screen
 * with its own clock, as Geiss 4.25+ did (it slows its motion for more than 30 fps).
 *
 * Presets are the 25 maps. "Auto" is Geiss's own choice: maps picked by its stars, the next one
 * built while the current one plays and put in on a beat. A pinned map keeps coming back with new
 * parameters, waveform and effects, as if every other map had no stars; favourites are the only
 * maps "Auto" picks. The colour depth is the panel's pack choice, named "Głębia koloru" here
 * (poolsLabel): 32 bits as Geiss 4.30 starts, 16 bits, or the 8-bit palette of the earlier
 * versions. The track title pops up and melts into the picture, as in Winamp. Winamp's sound
 * bytes are the AVS port's (avs/winamp-visdata.ts): the top byte of each 16-bit sample and
 * Winamp's own spectrum.
 *
 * The listener's own presets are Geiss's GEISS.INI presets (`]##` saves the map on screen,
 * `[##` loads it; sim.ts savePreset/loadPreset), 100 slots kept per browser (presets.ts). They
 * follow the maps in the list as "preset-07"…; one chosen is loaded and kept on screen, as `[##`
 * and Geiss's lock (L) would. The box over the picture (overlay.ts) saves, loads and deletes them,
 * and keeps GEISS.INI's custom messages too (messages.ts), each shown as `m##` showed it — popped
 * up like a title and burnt into the picture — and the config panel's wave colours from the music.
 * Titles and messages are drawn as GDI drew them (title-font.ts).
 */

const AUTO = "auto";
const STORAGE_KEY = "media-visualizer-preset:geiss-classic";
/** The colour depth, kept where MilkDrop keeps its pack. */
const DEPTH_KEY = "media-visualizer-pack:geiss-classic";
/** The depths the panel offers (Polish source text for t()); the first is Geiss 4.30's. */
const DEPTHS: readonly { id: string; depth: GeissDepth; label: string }[] = [
  { id: "32", depth: 32, label: "Kolor 32-bitowy (domyślny)" },
  { id: "16", depth: 16, label: "Kolor 16-bitowy" },
  { id: "8", depth: 8, label: "Paleta 8-bitowa (klasyczna)" }
];
/**
 * Geiss draws a frame per screen refresh up to this rate and every second (third…) refresh
 * above it: 60 or 75 Hz every refresh, 120 Hz 60 and 144 Hz 72 frames a second. Its fade is per
 * frame, so at 144 frames a second its trails would last half as long as on a 60 Hz screen.
 */
const MAX_RATE = 80;
/** A gap longer than this (a hidden tab) does not count on Geiss's clock. */
const PAUSE_MS = 250;
const MAX_PIXELS = 1280 * 720;
const MAX_PIXELS_TOUCH = 800 * 450;
/** The smallest the picture is shrunk to on a slow machine. */
const MIN_PIXELS = 400 * 300;
/** The analysers' samples per channel; Winamp's 576 are the newest of them. */
const TAP_SAMPLES = 1024;

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

/** The browser's storage, where it can be had (a private window may refuse it). */
function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The track playing now as the player announces it ("title — artist"), or "" without one. */
function playingTitle(): string {
  const session = typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession.metadata : null;
  return session ? [session.title, session.artist].filter(Boolean).join(" — ") : "";
}

interface StereoTap {
  left: AnalyserNode;
  right: AnalyserNode;
  disconnect(): void;
}

/**
 * Left and right of the player's node at full float precision (Winamp took the top byte of its
 * 16-bit samples, which bytes from getByteTimeDomainData are not). A mono track goes to both
 * channels, as Winamp gave it; null where the node cannot be split.
 */
function stereoTap(node: AnalyserNode, factor: number): StereoTap | null {
  const context = node.context;
  try {
    const mix = context.createGain();
    mix.channelCount = 2;
    mix.channelCountMode = "explicit";
    mix.channelInterpretation = "speakers";
    const splitter = context.createChannelSplitter(2);
    const channel = (): AnalyserNode => {
      const analyser = context.createAnalyser();
      analyser.fftSize = scaledFftSize(TAP_SAMPLES, factor);
      analyser.smoothingTimeConstant = 0;
      return analyser;
    };
    const left = channel();
    const right = channel();
    node.connect(mix);
    mix.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    return {
      left,
      right,
      disconnect(): void {
        try {
          node.disconnect(mix);
        } catch { /* już odłączony */ }
        mix.disconnect();
        splitter.disconnect();
      }
    };
  } catch {
    return null;
  }
}

export async function createGeiss(analyser: AnalyserNode, options: ExternalOptions = {}): Promise<ExternalVisualizer> {
  // The stage: the picture, and the presets box over it.
  const stage = document.createElement("div");
  stage.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl geiss-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "geiss-stage__picture";
  stage.append(canvas);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas 2D is not available");

  // Winamp's data each frame: the newest 576 samples of each channel as the top bytes of 16-bit
  // PCM (−128…127) and Winamp's 576-byte spectrum of them, read at 44.1/48 kHz on a faster
  // context (audio-rate.ts).
  const factor = rateFactor(analyser.context.sampleRate);
  const tap = stereoTap(analyser, factor);
  const audio: WinampFrame = { wave: new Int16Array(WINAMP_SAMPLES * 2), spectrum: new Uint8Array(WINAMP_SAMPLES * 2) };
  const samples = [new Float32Array(WINAMP_SAMPLES), new Float32Array(WINAMP_SAMPLES)];
  const top = new Int16Array(WINAMP_SAMPLES);
  const spectrum = new Uint8Array(WINAMP_SAMPLES);
  let raw = new Float32Array(TAP_SAMPLES);
  const fill = (source: AnalyserNode, out: Float32Array): void => {
    if (raw.length !== source.fftSize) raw = new Float32Array(source.fftSize);
    source.getFloatTimeDomainData(raw);
    decimate(raw, factor, out);
  };
  const listen = (): void => {
    fill(tap?.left ?? analyser, samples[0]!);
    if (tap) fill(tap.right, samples[1]!);
    else samples[1]!.set(samples[0]!);
    for (let channel = 0; channel < 2; channel += 1) {
      const from = samples[channel]!;
      for (let index = 0; index < WINAMP_SAMPLES; index += 1) top[index] = pcmTopByte(from[index]!);
      audio.wave.set(top, channel * WINAMP_SAMPLES);
      winampSpectrum(top, spectrum);
      audio.spectrum.set(spectrum, channel * WINAMP_SAMPLES);
    }
  };

  const ids = GEISS_MAPS.map((map) => map.id);
  /** The listener's presets by slot (GEISS.INI's [PRESET ##]), read again when another tab saves. */
  let saved = readPresets(storage());
  /** The messages by slot (GEISS.INI's [CUSTOM MESSAGES]), and the wave colours from the music. */
  let messages = readMessages(storage());
  let syncColour = readSyncColour(storage());
  /** Bumped when a slot's preset changes under the same id (the list's names change). */
  let revision = 0;
  const savedPreset = (id: string): GeissPreset | undefined => {
    const slot = presetSlot(id);
    return slot === null ? undefined : saved.get(slot);
  };
  const listed = (id: string): boolean => Boolean(geissMap(id) || savedPreset(id));
  const allIds = (): string[] => [...ids, ...[...saved.keys()].map(presetId)];
  const mapName = presetMapName;
  const persist = options.persist !== false;
  const stored = (options.preset !== undefined && listed(options.preset) ? options.preset : null) ?? read(STORAGE_KEY);
  let chosen = stored !== null && (stored === AUTO || listed(stored)) ? stored : AUTO;
  let autoFilter: Set<string> | null = options.autoFilter?.length ? new Set(options.autoFilter) : null;
  /** The map a pinned map or preset keeps Auto's stars on (a preset is held by the lock anyway). */
  const pinnedMode = (): number | null => (chosen === AUTO ? null : geissMap(chosen)?.mode ?? savedPreset(chosen)?.mode ?? null);
  const ratings = (): number[] => mapRatings(DEFAULT_MODE_RATINGS, pinnedMode(), chosen === AUTO ? autoFilter : null);
  // The depth chosen before, also where nothing is remembered ("Ulubione" shows it as it is set).
  let depth = DEPTHS.find((entry) => entry.id === read(DEPTH_KEY)) ?? DEPTHS[0]!;

  let sim: GeissSim | null = null;
  let image: ImageData | null = null;
  let pixels: Uint32Array | null = null;
  let listener: (() => void) | null = null;
  /**
   * The song's title. Geiss read Winamp's window title every frame, so started in the middle of
   * a song it showed that title at once (and took its colour); the player announces only a new
   * track, so a Geiss started later reads the one playing from the media session, in the
   * player's "title — artist".
   */
  let title = playingTitle();
  let destroyed = false;
  /** Geiss's clock() runs from its start, without the pauses of a hidden page. */
  let clockStart = -1;
  let lastStep = -Infinity;
  /** The screen's refresh interval (ms), measured, and the refreshes since the last frame. */
  let refresh = 1000 / 60;
  let lastRefresh = 0;
  let refreshes = 0;
  /** The size the picture should be, and when it may be rebuilt to it. */
  let wanted = { width: 0, height: 0 };
  let rebuildAt = 0;
  /** Shrinks the picture when frames are too slow and grows it back when they are cheap (budget.ts). */
  const budget = new PictureBudget({
    max: window.matchMedia?.("(pointer: coarse)").matches ? MAX_PIXELS_TOUCH : MAX_PIXELS,
    min: MIN_PIXELS
  });
  /** The panel's size (CSS pixels) last measured. */
  let panel = { width: 0, height: 0 };

  /** The panel's size in device pixels, before any budget. */
  const panelPixels = (width: number, height: number): number => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    return width * ratio * height * ratio;
  };

  const pictureSize = (width: number, height: number): { width: number; height: number } => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    let w = width * ratio;
    let h = height * ratio;
    if (w * h > budget.budget) {
      const scale = Math.sqrt(budget.budget / (w * h));
      w *= scale;
      h *= scale;
    }
    // A multiple of 16 wide: the 32-bit copy to the screen took 16 pixels a turn.
    return { width: Math.max(320, Math.round(w / 16) * 16), height: Math.max(200, Math.round(h / 4) * 4) };
  };

  const build = (): void => {
    const previous = sim;
    // A pinned preset is loaded at the new size or depth as `[##` would load it there.
    const preset = savedPreset(chosen);
    const next = new GeissSim(wanted.width, wanted.height, (Math.random() * 0x7fffffff) | 0, {
      titles: rasteriseTitle, ratings: ratings(), depth: depth.depth, ...(previous ? { from: previous } : {}), ...(preset ? { preset } : {})
    });
    if (preset) next.locked = true;
    next.syncColorToSound = syncColour;
    if (!previous && title) next.announce(title);
    sim = next;
    budget.restart();
    canvas.width = next.width;
    canvas.height = next.height;
    image = context.createImageData(next.width, next.height);
    pixels = new Uint32Array(image.data.buffer);
    listener?.();
  };

  /** The frame on the canvas, as the video card showed it, with the title popup over it. */
  const present = (current: GeissSim): void => {
    if (!image || !pixels) return;
    presentFrame(current, pixels);
    context.putImageData(image, 0, 0);
  };

  const remember = (): void => {
    if (persist) write(STORAGE_KEY, chosen);
  };

  /**
   * What is on screen becomes `id`: a map (new parameters, by the stars), Auto, or a preset loaded
   * and kept (Geiss's `[##`, then its lock, so Auto does not move on).
   */
  const show = (id: string): void => {
    if (!sim) return;
    sim.setRatings(ratings());
    sim.locked = false;
    const preset = savedPreset(id);
    if (preset) {
      sim.loadPreset(preset);
      sim.locked = true;
    } else if (id === AUTO) sim.rushRandom();
    else sim.selectMode(geissMap(id)!.mode);
  };

  /** The GEISS.INI box over the picture: presets, messages, the wave colours' option. */
  const box = geissBox({
    presets: () => saved,
    shown: () => presetSlot(chosen),
    mapName,
    save(slot: number): boolean {
      const preset = sim?.savePreset();
      if (!preset) return false;
      const next = new Map(saved);
      const replaced = next.has(slot);
      next.set(slot, preset);
      if (!writePresets(storage(), next)) return false;
      saved = next;
      if (replaced) revision += 1;
      listener?.();
      return true;
    },
    load(slot: number): void {
      if (!saved.has(slot)) return;
      chosen = presetId(slot);
      remember();
      show(chosen);
      box.refresh();
      listener?.();
    },
    remove(slot: number): void {
      const next = new Map(saved);
      next.delete(slot);
      if (!writePresets(storage(), next)) return;
      // The preset on screen goes from the list; its map stays, pinned, as it is.
      if (chosen === presetId(slot)) {
        chosen = sim && sim.mode >= 1 ? geissMapId(sim.mode) : AUTO;
        remember();
        if (sim) {
          sim.locked = false;
          sim.setRatings(ratings());
          sim.restartNext();
        }
      }
      saved = next;
      revision += 1;
      box.refresh();
      listener?.();
    },
    messages: () => messages,
    saveMessage(slot: number, value: string): boolean {
      const next = new Map(messages);
      next.set(slot, value);
      if (!writeMessages(storage(), next)) return false;
      messages = next;
      return true;
    },
    removeMessage(slot: number): void {
      const next = new Map(messages);
      next.delete(slot);
      if (!writeMessages(storage(), next)) return;
      messages = next;
      box.refresh();
    },
    showMessage(slot: number): void {
      // `m##`: what LoadCustomMsg() reads of the slot ("" for none, which Geiss popped up too).
      sim?.showMessage(messageText(messages.get(slot) ?? ""));
    },
    syncColour: () => syncColour,
    setSyncColour(on: boolean): void {
      syncColour = on;
      writeSyncColour(storage(), on);
      if (sim) sim.syncColorToSound = on;
    }
  });
  stage.append(box.element);

  // Saved in another tab: the list and the box follow.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === MESSAGES_KEY || event.key === SYNC_COLOUR_KEY) {
      messages = readMessages(storage());
      syncColour = readSyncColour(storage());
      if (sim) sim.syncColorToSound = syncColour;
      box.refresh();
    }
    if (event.key !== null && event.key !== PRESETS_KEY) return;
    saved = readPresets(storage());
    revision += 1;
    if (savedPreset(chosen) === undefined && presetSlot(chosen) !== null) {
      chosen = sim && sim.mode >= 1 ? geissMapId(sim.mode) : AUTO;
      if (sim) sim.locked = false;
    }
    box.refresh();
    listener?.();
  };
  window.addEventListener("storage", onStorage);

  return {
    canvas: stage,
    presets: allIds,
    presetGroups: (): readonly PresetGroup[] => geissPresetGroups(saved),
    presetsRevision: () => revision,
    pools: (): readonly PresetPool[] => DEPTHS.map((entry) => ({ id: entry.id, label: t(entry.label) })),
    pool: () => depth.id,
    choosePool(id: string): void {
      const next = DEPTHS.find((entry) => entry.id === id);
      if (!next || next === depth) return;
      depth = next;
      if (persist) write(DEPTH_KEY, depth.id);
      // Another depth is another video mode: the picture goes on in it from the next frame.
      if (sim) rebuildAt = performance.now();
      listener?.();
    },
    poolsLabel: () => t("Głębia koloru"),
    chosen: () => chosen,
    // A pinned preset is what is on screen (the lock keeps it); otherwise the map.
    current: () => (savedPreset(chosen) ? chosen : sim ? geissMapId(sim.mode) : chosen === AUTO ? "" : chosen),
    setListener(next: (() => void) | null): void {
      listener = next;
    },
    setAutoFilter(favourites: readonly string[] | null): void {
      const filter = favourites ? new Set(favourites.filter((id) => geissMap(id))) : null;
      const next = filter && filter.size ? filter : null;
      // Told on every change of the favourites: the map being prepared stays if Auto's choice does.
      const unchanged = next === null ? autoFilter === null : autoFilter !== null && next.size === autoFilter.size && [...next].every((id) => autoFilter!.has(id));
      autoFilter = next;
      if (unchanged || chosen !== AUTO || !sim) return;
      sim.setRatings(ratings());
      // Showing a map outside the new choice: Auto moves on now; otherwise the next one obeys it.
      if (autoFilter && !autoFilter.has(geissMapId(sim.mode))) sim.rushRandom();
      else sim.restartNext();
    },
    choose(id: string): void {
      chosen = id === AUTO || listed(id) ? id : AUTO;
      remember();
      show(chosen);
      box.refresh();
    },
    next(): void {
      if (chosen === AUTO) {
        sim?.rushNext();
        return;
      }
      // Pinned: the next map or preset in the list, pinned in its turn.
      const list = allIds();
      chosen = list[(list.indexOf(chosen) + 1) % list.length]!;
      remember();
      show(chosen);
      box.refresh();
      listener?.();
    },
    announce(text: string): void {
      title = text;
      sim?.announce(text);
    },
    render(time: number): void {
      if (destroyed) return;
      if ((!sim && wanted.width) || (sim && rebuildAt && time >= rebuildAt)) {
        rebuildAt = 0;
        build();
      }
      const current = sim;
      const delta = time - lastRefresh;
      lastRefresh = time;
      if (delta > 2 && delta < 100) refresh += (delta - refresh) * 0.05;
      refreshes += 1;
      if (!current || refreshes < Math.ceil(1000 / refresh / MAX_RATE)) return;
      refreshes = 0;
      if (clockStart < 0) clockStart = time;
      else if (time - lastStep > PAUSE_MS) clockStart += time - lastStep - 1000 / 60;
      lastStep = time;
      const started = performance.now();
      listen();
      current.frame(Math.floor(time - clockStart), audio);
      present(current);
      // A machine that cannot keep up gets a smaller picture rather than a slideshow, and the
      // full one back once it can again.
      const width = panel.width || stage.clientWidth;
      const height = panel.height || stage.clientHeight;
      const pixels = current.width * current.height;
      const full = width && height ? panelPixels(width, height) : pixels;
      if (budget.observe(performance.now() - started, time, pixels, full)) {
        const size = width && height ? pictureSize(width, height) : wanted;
        if (size.width !== wanted.width || size.height !== wanted.height) {
          wanted = size;
          if (size.width !== current.width || size.height !== current.height) rebuildAt = time;
        }
      }
    },
    resize(width: number, height: number): void {
      // A hidden panel measures 1 × 1: the picture keeps its size until it is shown again.
      if (width < 64 || height < 64) return;
      panel = { width, height };
      const size = pictureSize(width, height);
      if (size.width === wanted.width && size.height === wanted.height) return;
      wanted = size;
      // Back to the picture's size: nothing to rebuild, unless another depth is waiting.
      if (sim && sim.width === size.width && sim.height === size.height) {
        if (sim.depth === depth.depth) rebuildAt = 0;
        return;
      }
      // Every map is built for one size; a new size waits until the resizing is over.
      if (sim) rebuildAt = performance.now() + 250;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      listener = null;
      sim = null;
      tap?.disconnect();
      window.removeEventListener("storage", onStorage);
      stage.remove();
    }
  };
}
