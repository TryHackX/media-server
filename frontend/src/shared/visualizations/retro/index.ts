import { t } from "../../i18n";
import { presetDeck } from "../milkdrop";
import type { ExternalOptions, ExternalVisualizer, PresetGroup } from "../types";
import { RetroAudioFeed } from "./audio";
import { retroPresetGroups, retroPresets, type RetroPreset } from "./catalog";
import { PixelPresenter } from "./presenter";
import type { RetroScene, RetroTrack } from "./types";

/**
 * Klasyka retro (Retro classics): the looks of the first music visualizers, recreated — the
 * Atari Video Music of 1977, the screens of the music trackers of the Amiga and DOS and, when the
 * owner added the port to frontend/vendor/cthugha, Cthugha — each one a preset of one visualizer.
 *
 * Every preset is a scene (types.ts) that draws its original's low-resolution picture; the
 * presenter scales it to the panel with sharp, even pixels. "Auto" deals the presets like a
 * shuffled deck, a new one every 30 seconds, and the next fades in over the one on screen
 * (the .internal-stage layers, 1.2 s); a chosen one stays. The panel's favourites, lock and
 * "next" work on them as on Internal's. A scene's code is a chunk of its own, fetched the first
 * time it is shown; one that will not start drops out of the list for the visit.
 */

const AUTO = "auto";
const AUTO_SECONDS = 30;
/** The fade between two presets (panels.css, .internal-stage__layer). */
const FADE_MS = 1200;
const STORAGE_KEY = "media-visualizer-preset:retro";

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

/** The track as the browser's media session names it, for a visualizer opened mid-track. */
function sessionTitle(): string {
  const metadata = "mediaSession" in navigator ? navigator.mediaSession.metadata : null;
  return [metadata?.title, metadata?.artist].filter(Boolean).join(" — ");
}

/** One preset on screen, or coming. */
interface Layer {
  preset: RetroPreset;
  scene: RetroScene;
  presenter: PixelPresenter;
  /** Seconds it has run, and the time of its last frame (ms, 0 before the first). */
  clock: number;
  previous: number;
  /** When it began to fade in (ms); 0 before. */
  fadeAt: number;
}

export async function createRetro(analyser: AnalyserNode, options: ExternalOptions = {}): Promise<ExternalVisualizer> {
  const presets = retroPresets();
  if (!presets.length) throw new Error("No retro presets");
  const all = new Map<string, RetroPreset>(presets.map((preset) => [preset.id, preset]));
  const ids = presets.map((preset) => preset.id);
  /** Presets whose scene would not start here: out of the list for this visit. */
  const failed = new Set<string>();
  const offered = (id: string): boolean => all.has(id) && !failed.has(id);
  const feed = new RetroAudioFeed(analyser);

  const stage = document.createElement("div");
  stage.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl internal-stage";

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
  /** The preset whose scene is being fetched, and the ticket that tells a stale one apart. */
  let loading: string | null = null;
  let ticket = 0;
  let switchAt = 0;
  let width = 0;
  let height = 0;
  let audioTime = 0;
  let announced = "";
  let destroyed = false;

  const drop = (layer: Layer): void => {
    try {
      layer.scene.dispose?.();
    } catch (error) {
      console.warn("Klasyka retro: disposing failed", layer.preset.id, error);
    }
    layer.presenter.dispose();
  };

  /** Out of the list for this visit (its scene would not start); Auto deals on. */
  const fail = (id: string, error: unknown): void => {
    console.warn("Klasyka retro: preset unavailable", id, error);
    failed.add(id);
    if (chosen === id) {
      chosen = AUTO;
      if (persist) write(STORAGE_KEY, chosen);
    }
    switchAt = 0;
    listener?.();
  };

  /** The incoming preset takes the screen; the one under it goes. */
  const settle = (layer: Layer, now: number): void => {
    layer.presenter.canvas.classList.add("is-visible");
    if (base && base !== layer) drop(base);
    base = layer;
    incoming = null;
    shown = layer.preset.id;
    switchAt = now + AUTO_SECONDS * 1000;
  };

  /** Show a preset once its scene is there: at once when nothing is on screen, else fading in. */
  const show = (id: string): void => {
    const preset = all.get(id);
    if (!preset || destroyed || !offered(id)) return;
    const mine = ++ticket;
    loading = id;
    preset.create().then((scene) => {
      if (destroyed || mine !== ticket) {
        scene.dispose?.();
        return;
      }
      loading = null;
      const presenter = new PixelPresenter("internal-stage__layer");
      scene.resize?.(width, height);
      presenter.resize(width, height);
      stage.append(presenter.canvas);
      const layer: Layer = { preset, scene, presenter, clock: 0, previous: 0, fadeAt: 0 };
      const now = performance.now();
      if (incoming) {
        // A change cut short: what already fades in stays, what is still unseen goes.
        if (incoming.fadeAt) settle(incoming, now);
        else drop(incoming);
        incoming = null;
      }
      if (!base) {
        settle(layer, now);
        listener?.();
        return;
      }
      incoming = layer;
    }).catch((error: unknown) => {
      if (mine === ticket) loading = null;
      if (!destroyed) fail(id, error);
    });
  };

  const track = (): RetroTrack => {
    const playback = options.playback?.() ?? null;
    return {
      title: announced || sessionTitle(),
      position: playback && Number.isFinite(playback.position) ? playback.position : 0,
      duration: playback && Number.isFinite(playback.duration) ? playback.duration : 0
    };
  };

  /** One frame of one preset: the scene draws its picture, the presenter shows it. */
  const paint = (layer: Layer, now: number, info: RetroTrack): boolean => {
    const dt = layer.previous ? Math.min(0.1, Math.max(0, (now - layer.previous) / 1000)) : 1 / 60;
    layer.previous = now;
    layer.clock += dt;
    try {
      const image = layer.presenter.frame(layer.scene.width, layer.scene.height);
      layer.scene.render({ audio: feed.analysis, track: info, time: layer.clock, dt }, image);
      layer.presenter.present(layer.scene);
      return true;
    } catch (error) {
      // One bad frame must not end the picture; the engine does the same for the others.
      console.warn("Klasyka retro: frame failed", layer.preset.id, error);
      return false;
    }
  };

  const groups = (): readonly PresetGroup[] => retroPresetGroups(presets, offered, t);

  return {
    canvas: stage,
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
      else if (width && chosen !== shown && chosen !== incoming?.preset.id && chosen !== loading) show(chosen);
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
      if (width) show(chosen);
      listener?.();
    },
    announce(text: string): void {
      announced = text;
    },
    render(time: number): void {
      if (destroyed || !width) return;
      // The music is read once a frame, whichever presets are drawing.
      feed.update(audioTime ? Math.min(0.1, Math.max(0, (time - audioTime) / 1000)) : 1 / 60);
      audioTime = time;
      if (loading === null) {
        if (!base && !incoming) {
          if (time >= switchAt) {
            const first = chosen !== AUTO && offered(chosen) ? chosen : draw();
            if (first) show(first);
            else switchAt = time + 5000;
          }
        } else if (chosen === AUTO && !incoming && time >= switchAt) {
          const next = draw();
          if (next && next !== shown) show(next);
          else switchAt = time + AUTO_SECONDS * 1000;
        } else if (chosen !== AUTO && offered(chosen) && chosen !== shown && chosen !== incoming?.preset.id) {
          show(chosen);
        }
      }
      const info = track();
      const current = base as Layer | null;
      if (current && !paint(current, time, info) && !incoming && chosen === AUTO) switchAt = 0;
      const coming = incoming as Layer | null;
      if (coming) {
        const firstFrame = coming.previous === 0;
        if (!paint(coming, time, info)) {
          drop(coming);
          incoming = null;
        } else if (!coming.fadeAt && !firstFrame) {
          // Drawn once above the one on screen, unseen: now it fades in. The class goes on a
          // frame after the canvas came in — added in the same task, the fade would be a cut.
          coming.fadeAt = time;
          coming.presenter.canvas.classList.add("is-visible");
          shown = coming.preset.id;
        } else if (coming.fadeAt && time - coming.fadeAt >= FADE_MS) {
          settle(coming, time);
        }
      }
    },
    resize(nextWidth: number, nextHeight: number): void {
      if (nextWidth === width && nextHeight === height) {
        // The same size in CSS pixels; devicePixelRatio may still have changed (zoom).
        for (const layer of [base, incoming]) layer?.presenter.resize(width, height);
        return;
      }
      width = nextWidth;
      height = nextHeight;
      for (const layer of [base, incoming]) {
        if (!layer) continue;
        layer.scene.resize?.(width, height);
        layer.presenter.resize(width, height);
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      listener = null;
      ticket += 1;
      for (const layer of [base, incoming]) if (layer) drop(layer);
      base = null;
      incoming = null;
      feed.dispose();
      stage.remove();
    }
  };
}
