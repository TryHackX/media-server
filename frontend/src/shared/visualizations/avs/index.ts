import loadApePorts from "virtual:avs-apes";
import presetsInfo from "virtual:avs-presets";

import { formatCount } from "../../format";
import { t } from "../../i18n";
import { presetDeck } from "../milkdrop";
import { chunkLoader, packPool, poolGroups, type PackInfo, type PackPreset } from "../milkdrop-packs";
import type { ExternalOptions, ExternalVisualizer, PresetGroup } from "../types";
import { NodeAnalyser } from "./analyser";
import { ALL_POOL, avsPackPresets, avsPool, avsPoolOptions, FAILED_KEY, storedFailures } from "./packs";
import Main from "./webvs/Main";
import { registerVendorPorts } from "./webvs/ape/apeHost";

/**
 * Winamp AVS through webvs (MIT), vendored in ./webvs with its expression
 * compiler replaced (./eel.ts), driven frame by frame from the visualizer
 * engine. Presets come from the build (scripts/avs-presets.mjs): an index of
 * every pack, and chunks of presets fetched when one of them is about to play.
 *
 * "Auto" deals the pack's presets like a shuffled deck and changes every 20
 * seconds through a short fade — AVS's own transitions blended two live
 * presets, which would mean running two renderers at once.
 */

const AUTO = "auto";
const AUTO_SECONDS = 20;
/** A chunk that did not arrive (the network): Auto tries again after this long. */
const RETRY_SECONDS = 5;
const FADE_MS = 260;
/**
 * AVS presets were made for windows a few hundred lines tall: blurs, edge
 * filters, scatter and water work pixel by pixel. Rendered at 4K those are a
 * fine dust; at up to 720 lines (scaled smoothly to the screen) they look as
 * meant, and lines and sprites are scaled by `avsScale` in the fork.
 */
const MAX_HEIGHT = 720;
/** Presets move a fixed step per frame; on a 120–144 Hz screen they raced. */
const FRAME_MS = 1000 / 60;
const STORAGE_KEY = "media-visualizer-preset:avs";
const POOL_KEY = "media-visualizer-pack:avs";

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

function fetchJson(url: string): Promise<unknown> {
  return fetch(url, { credentials: "same-origin" }).then((response) => {
    if (!response.ok) throw new Error(`AVS presets: HTTP ${response.status} ${url}`);
    return response.json() as Promise<unknown>;
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

let portsReady: Promise<void> | null = null;
/** The owner's ports of AVS plug-ins (vendor/avs-apes), registered once before any preset loads. */
function vendorPorts(): Promise<void> {
  if (!portsReady) {
    portsReady = loadApePorts
      ? loadApePorts().then((module) => registerVendorPorts(module as Parameters<typeof registerVendorPorts>[0]), () => undefined)
      : Promise.resolve();
  }
  return portsReady;
}

export async function createAvs(analyser: AnalyserNode, options: ExternalOptions = {}): Promise<ExternalVisualizer> {
  if (!presetsInfo) throw new Error("This build has no AVS presets");
  const indexUrl = presetsInfo.index;
  const packList: PackInfo[] = presetsInfo.packs.map((pack) => ({ ...pack, index: indexUrl }));
  const [index] = await Promise.all([fetchJson(indexUrl), vendorPorts()]);
  const loaded = avsPackPresets(packList, index, indexUrl);
  const byId = new Map<string, PackPreset>();
  for (const presets of loaded.values()) for (const preset of presets) byId.set(preset.id, preset);
  const failed = new Set<string>(storedFailures(read(FAILED_KEY)));
  const labels = {
    builtin: "",
    all: t("Wszystkie paczki"),
    allCategories: t("Wszystkie kategorie"),
    pack: (pack: PackInfo) => pack.name,
    count: formatCount
  };
  const pools = avsPoolOptions(packList, labels);
  const persist = options.persist !== false;
  // Not remembering (a favourite opened from "Ulubione"): every pack, the saved pack untouched.
  let pool = avsPool(persist ? read(POOL_KEY) : null, packList);
  let groups: PresetGroup[] = [];
  let members: string[] = [];
  let memberSet = new Set<string>();
  let failures = -1;
  const rebuild = (): void => {
    groups = poolGroups(pool, [], packList, loaded, labels, failed);
    members = groups.flatMap((group) => group.presets.map((preset) => preset.id));
    memberSet = new Set(members);
    failures = failed.size;
  };
  const current = (): void => {
    if (failures !== failed.size) rebuild();
  };
  rebuild();
  if (members.length === 0 && pool !== ALL_POOL) {
    pool = ALL_POOL;
    rebuild();
  }
  // A preset to start on that this pack does not have (the panel's search found it in another):
  // the pool becomes its pack, remembered as a pack chosen in the list would be.
  const wanted = options.preset !== undefined ? byId.get(options.preset) : undefined;
  if (wanted && !memberSet.has(wanted.id) && !failed.has(wanted.id)) {
    pool = avsPool(packPool(wanted.pack), packList);
    if (persist) write(POOL_KEY, pool);
    rebuild();
  }
  if (members.length === 0) throw new Error("No playable AVS presets");
  const chunk = chunkLoader(fetchJson, 8);
  const data = async (id: string): Promise<object> => {
    const preset = byId.get(id);
    if (!preset) throw new Error(`Unknown AVS preset ${id}`);
    const presets = await chunk(preset.chunk);
    const value = presets[preset.key];
    if (!value || typeof value !== "object") throw new Error(`AVS preset missing from its chunk: ${id}`);
    return value;
  };

  const canvas = document.createElement("canvas");
  canvas.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl";
  canvas.style.transition = `opacity ${FADE_MS}ms ease`;
  let pending: (() => void) | null = null;
  // Left and right for AVS come from taps on the player's node (analyser.ts); let go of them at the end.
  const nodeAnalyser = new NodeAnalyser(analyser);
  const main = new Main({
    canvas,
    analyser: nodeAnalyser,
    // The engine owns the animation loop: webvs asks for a frame, the engine's
    // next frame runs it.
    requestAnimationFrame: (callback: () => void) => {
      pending = callback;
      return 1;
    },
    cancelAnimationFrame: () => {
      pending = null;
    }
  });
  // The comparison and audit pages read the engine's state and step it frame by frame; nothing else sets this.
  if ((globalThis as { __avsExpose?: boolean }).__avsExpose) {
    const exposed = globalThis as { __avsMain?: unknown; __avsStep?: (time: number) => boolean };
    exposed.__avsMain = main;
    exposed.__avsStep = (time: number): boolean => {
      const frame = pending;
      pending = null;
      (main as unknown as { avsFrameTime: number }).avsFrameTime = time;
      frame?.();
      return Boolean(frame);
    };
  }
  // gettime(-1) / gettime(-2): the track's position and length (Echolot stops on pause by them).
  if (options.playback) main.setPlayback(options.playback);

  let deal = presetDeck(members);
  // "Auto" over the listener's favourites only, when any of them is in this pack.
  // The favourites Auto deals from are known before the first preset is drawn.
  let autoFilter: Set<string> | null = options.autoFilter?.length ? new Set(options.autoFilter) : null;
  const draw = (): string | undefined => {
    current();
    const dealable = (id: string): boolean => !failed.has(id) && (!autoFilter || autoFilter.has(id));
    const filter = autoFilter && members.some(dealable) ? autoFilter : null;
    const fits = (id: string): boolean => !failed.has(id) && (!filter || filter.has(id));
    for (let attempt = 0; attempt < members.length * 2; attempt += 1) {
      const id = deal();
      if (fits(id) && memberSet.has(id)) return id;
    }
    return members.find(fits);
  };
  let chosen = (options.preset !== undefined && memberSet.has(options.preset) ? options.preset : null)
    ?? read(STORAGE_KEY) ?? AUTO;
  if (chosen !== AUTO && !memberSet.has(chosen)) chosen = AUTO;
  let shown = "";
  let listener: (() => void) | null = null;
  let switchAt = 0;
  let fading = false;
  // A preset that threw mid-frame is not drawn again while its replacement fades in.
  let broken = false;

  const fail = (id: string): void => {
    if (!id || failed.has(id)) return;
    failed.add(id);
    write(FAILED_KEY, JSON.stringify([...failed].slice(-300)));
    if (chosen === id) {
      chosen = AUTO;
      if (persist) write(STORAGE_KEY, chosen);
    }
    switchAt = 0;
    listener?.();
  };

  /**
   * A frame that threw half-way can leave an off-screen target bound; every
   * preset after it drew there and the screen stayed white.
   */
  const resetGl = (): void => {
    const gl = canvas.getContext("webgl");
    if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(null);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  };

  /**
   * Put a preset on screen; false (and remembered) when webvs cannot build it. It starts on the
   * picture the preset before left, as in Winamp (webvs/Main.ts loadPreset).
   */
  const apply = (id: string, preset: object): boolean => {
    try {
      main.loadPreset(preset, { carryFrame: true });
      shown = id;
      main.stop();
      main.start();
      return true;
    } catch (error) {
      console.warn("AVS preset failed to load", id, error);
      fail(id);
      return false;
    }
  };

  /**
   * A preset whose chunk did not arrive: the network, not the preset, so it is
   * not remembered as broken. The picture stays as it was; Auto tries again soon.
   */
  const unavailable = (id: string, error: unknown): void => {
    console.warn("AVS preset unavailable", id, error);
    if (chosen === id) {
      chosen = AUTO;
      if (persist) write(STORAGE_KEY, chosen);
      listener?.();
    }
    switchAt = performance.now() + RETRY_SECONDS * 1000;
  };

  // A choice made while a preset is still on its way waits its turn; only the latest is kept.
  let changing: Promise<void> | null = null;
  let queued: string | null = null;

  /** Fade out while the preset's chunk arrives, swap, fade in: no hard cut. */
  const change = (id: string): void => {
    if (changing) {
      queued = id;
      return;
    }
    changing = (async () => {
      // Nobody sees a fade in a hidden tab, and its timer would be throttled there.
      let fade = Promise.resolve();
      if (!document.hidden) {
        fading = true;
        canvas.style.opacity = "0";
        fade = sleep(FADE_MS);
      }
      let next: string | undefined = id;
      for (let attempt = 0; attempt < 8 && next; attempt += 1) {
        let preset: object;
        try {
          preset = await data(next);
        } catch (error) {
          unavailable(next, error);
          break;
        }
        await fade;
        if (apply(next, preset)) {
          broken = false;
          break;
        }
        next = draw();
      }
      await fade;
      canvas.style.opacity = "1";
      fading = false;
    })().finally(() => {
      changing = null;
      const next = queued;
      queued = null;
      if (next && next !== shown) change(next);
    });
  };

  // The first preset is on screen before the visualizer counts as mounted.
  let first = chosen === AUTO ? draw() : chosen;
  for (let attempt = 0; attempt < 8 && first && !shown; attempt += 1) {
    try {
      if (apply(first, await data(first))) break;
    } catch (error) {
      console.warn("AVS preset unavailable", first, error);
    }
    first = draw();
  }
  if (!shown) throw new Error("No AVS preset could be built");
  if (chosen !== AUTO && chosen !== shown) chosen = AUTO;
  switchAt = chosen === AUTO ? performance.now() + AUTO_SECONDS * 1000 : 0;

  let size = "";
  let nextFrameAt = 0;
  return {
    canvas,
    presets: () => {
      current();
      return members;
    },
    presetGroups: () => {
      current();
      return groups;
    },
    pools: () => pools,
    pool: () => pool,
    choosePool(id: string): void {
      const next = avsPool(id, packList);
      if (next === pool) return;
      pool = next;
      if (persist) write(POOL_KEY, pool);
      rebuild();
      deal = presetDeck(members);
      if (chosen !== AUTO && !memberSet.has(chosen)) {
        chosen = AUTO;
        if (persist) write(STORAGE_KEY, chosen);
      }
      // A new pack shows itself at once.
      if (chosen === AUTO) switchAt = 0;
      listener?.();
    },
    chosen: () => chosen,
    current: () => shown,
    setListener(next: (() => void) | null): void {
      listener = next;
    },
    setAutoFilter(ids: readonly string[] | null): void {
      autoFilter = ids && ids.length ? new Set(ids) : null;
      // Showing something outside the new choice: Auto moves on now.
      if (chosen === AUTO && autoFilter && !autoFilter.has(shown) && members.some((id) => autoFilter!.has(id))) switchAt = 0;
    },
    choose(id: string): void {
      current();
      chosen = id === AUTO || (memberSet.has(id) && !failed.has(id)) ? id : AUTO;
      if (persist) write(STORAGE_KEY, chosen);
      if (chosen === AUTO) switchAt = 0;
      else if (chosen !== shown) change(chosen);
    },
    next(): void {
      if (chosen === AUTO) {
        switchAt = 0;
        return;
      }
      current();
      const following = members[(members.indexOf(chosen) + 1) % members.length];
      if (!following) return;
      chosen = following;
      if (persist) write(STORAGE_KEY, chosen);
      change(chosen);
      listener?.();
    },
    announce: () => undefined,
    render(time: number): void {
      if (chosen === AUTO && time >= switchAt && !fading && !changing) {
        switchAt = time + AUTO_SECONDS * 1000;
        const id = draw();
        if (id) change(id);
      }
      // At most 60 frames a second, on average, whatever the screen's rate — fewer when the
      // preset's Framerate Limiter ran in its last frame (webvs/trans/Extras.ts).
      if (time < nextFrameAt - 1) return;
      const interval = Math.max(FRAME_MS, Number((main as unknown as { avsFrameInterval?: number }).avsFrameInterval) || 0);
      nextFrameAt = time - nextFrameAt > interval * 3 ? time + interval : nextFrameAt + interval;
      const frame = pending;
      pending = null;
      if (!frame || broken) return;
      (main as unknown as { avsFrameTime: number }).avsFrameTime = time;
      try {
        frame();
      } catch (error) {
        // A component that throws mid-frame would end webvs's loop for good.
        console.warn("AVS frame failed", shown, error);
        broken = true;
        resetGl();
        fail(shown);
        const id = draw();
        if (id) change(id);
        main.stop();
        main.start();
      }
    },
    resize(width: number, height: number): void {
      const ratio = Math.min(1.5, window.devicePixelRatio || 1, MAX_HEIGHT / Math.max(1, height));
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      const key = `${pixelWidth}x${pixelHeight}`;
      if (key === size) return;
      size = key;
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      main.notifyResize();
    },
    destroy(): void {
      listener = null;
      try {
        main.stop();
        main.destroy();
      } catch { /* już zniszczony */ }
      nodeAnalyser.disconnect();
      canvas.remove();
    }
  };
}
