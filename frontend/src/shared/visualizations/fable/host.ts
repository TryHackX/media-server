import "./stage.css";

import { decimate, rateFactor, scaledFftSize } from "../audio-rate";
import { fablePreset, presetMismatch, type FableEntry } from "./catalog";
import { AdaptiveScale } from "./core/adaptive";
import { AudioAnalysis, FFT_SIZE, MAX_DECIBELS, MIN_DECIBELS, SMOOTHING } from "./core/audio";
import { compiling, Kit, type Program, type Target } from "./core/kit";
import { Post } from "./core/post";
import { Source } from "./core/source";
import type { FvInstance } from "./core/types";
import type { FablePicture } from "./overlay";

export { pictureOverlay } from "./overlay";

/**
 * The Fable presets' side of Internal: one WebGL 2 canvas and context for all of them.
 *
 * A preset is fetched (its visualization's chunk) and its programs compiled while the picture
 * on screen goes on — in the background where the browser can (KHR_parallel_shader_compile) —
 * and only then shown: at once when nothing is drawn yet, else mixed in over the one drawn, in
 * GL, both drawing for the length of the fade. Fades to and from Internal's 2D presets are the
 * stage's own (CSS opacity on this canvas).
 *
 * The music comes from an AnalyserNode of the host's own behind the player's (fftSize 2048,
 * smoothing 0.5, -90…-10 dB — core/audio.ts says why), read at 44.1/48 kHz on a faster device
 * as audio-rate.ts explains. The picture some presets work on is the track's cover, looked up
 * as VoltViz looks it up, or the listener's own image or video; with neither, the painting
 * core/source.ts draws. The working resolution follows the frame time (core/adaptive.ts).
 */

/** How often the track's cover is looked up. */
const COVER_POLL_MS = 1000;
/** A picture or a video that has not loaded by then is not shown. */
const LOAD_TIMEOUT_MS = 15_000;
/** The picture is drawn at the device's pixel ratio up to 2, and no larger than 1440p (as VoltViz's and MilkDrop's). */
const MAX_PIXEL_RATIO = 2;
const MAX_PIXELS = 2560 * 1440;

const MIX = /* glsl */ `
uniform sampler2D uOld, uNew;
uniform float uLevel;
void main() { fragColor = vec4(mix(texture(uOld, vUv).rgb, texture(uNew, vUv).rgb, uLevel), 1.0); }
`;

/**
 * The picture the listener chose in place of the cover: an object URL of the file, so it never
 * leaves the browser — not sent, not stored. It stays while the page is open (another preset
 * dealt, the panel closed and opened), until "back to the cover".
 */
let picked: { url: string; video: boolean } | null = null;

/**
 * The cover of the track playing. The player does not hand its track to visualizers, so it is
 * read where it is: the Media Session's artwork, else the picture in the player's dock
 * (voltviz/index.ts reads the same two places).
 */
function trackCover(): string | null {
  const session = "mediaSession" in navigator ? navigator.mediaSession.metadata : null;
  const artwork = session?.artwork.find((entry) => entry.src)?.src;
  if (artwork) return artwork;
  const image = document.querySelector<HTMLImageElement>(".audio-dock__artwork.has-image .audio-dock__artwork-image");
  return image?.currentSrc || image?.src || null;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("timed out")), ms);
    promise.then((value) => {
      window.clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      window.clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** One preset being prepared or drawn. */
interface Slot {
  id: string;
  entry: FableEntry;
  instance: FvInstance | null;
  post: Post;
  state: "loading" | "compiling" | "ready";
  /** The analysis clock at its first frame, and how many frames it has drawn. */
  began: number;
  frames: number;
  /** When its fade over the one drawn began (ms); 0 before. */
  fadeAt: number;
}

export interface FableHost {
  /** The canvas every Fable preset is drawn on; the stage places and fades it. */
  readonly canvas: HTMLCanvasElement;
  /** The listener's own picture, for the overlay. */
  readonly picture: FablePicture;
  /** Begin showing a preset of the list (catalog.ts ids). */
  show(id: string): void;
  /** The preset on screen — the incoming one from the moment its fade begins; "" before the first frame. */
  shown(): string;
  /** The preset being fetched or compiled, not yet seen; "" when none. */
  pending(): string;
  /** Draws a frame of what is shown; false when there is nothing to draw yet (or any more). */
  render(time: number, width: number, height: number): boolean;
  /** The presets that could not be fetched, compiled or drawn since this was last asked. */
  takeFailures(): string[];
  /** The context is gone (the driver reset, too many contexts): nothing more can be drawn. */
  lost(): boolean;
  /** Everything shown or prepared is let go; the canvas and its context stay for the next one. */
  clear(): void;
  destroy(): void;
}

export function createFableHost(analyser: AnalyserNode, fadeMs: number): FableHost {
  const canvas = document.createElement("canvas");
  canvas.className = "internal-stage__layer";
  const context = canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance", preserveDrawingBuffer: false
  });
  if (!context) throw new Error("WebGL 2 is not available");
  const gl: WebGL2RenderingContext = context;
  const kit = new Kit(gl);
  if (!kit.hdr) throw new Error("No float colour buffers");
  const mix: Program = kit.program(MIX);
  const source = new Source(gl);
  source.reseed(Math.random());
  const analysis = new AudioAnalysis();
  const adaptive = new AdaptiveScale(window.matchMedia("(pointer: coarse)").matches ? 1000 / 30 : 1000 / 60);
  // Whoever asks the system for less motion gets every preset in its flash-safe mode.
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const factor = rateFactor(analyser.context.sampleRate);
  const node = analyser.context.createAnalyser();
  node.fftSize = scaledFftSize(FFT_SIZE, factor);
  node.smoothingTimeConstant = SMOOTHING;
  node.minDecibels = MIN_DECIBELS;
  node.maxDecibels = MAX_DECIBELS;
  analyser.connect(node);
  const frequency = new Uint8Array(new ArrayBuffer(FFT_SIZE / 2));
  const waveform = new Uint8Array(new ArrayBuffer(FFT_SIZE));
  const rawFrequency = new Uint8Array(new ArrayBuffer(node.frequencyBinCount));
  const rawWaveform = new Uint8Array(new ArrayBuffer(node.fftSize));

  let current: Slot | null = null;
  let incoming: Slot | null = null;
  const spare: Post[] = [];
  const failures: string[] = [];
  let older: Target | null = null;
  let newer: Target | null = null;
  let previous = 0;
  let gpuMs: number | null = null;
  let settledAt = 0;
  let contextLost = false;
  let destroyed = false;

  // The picture: the listener's own, else the track's cover, else the painting.
  let video: HTMLVideoElement | null = null;
  let cover: string | null | undefined;
  let coverAt = -COVER_POLL_MS;
  let loads = 0;

  const dropVideo = (): void => {
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video = null;
  };

  /** A picture or a video into the source; false when the browser cannot show it. */
  const load = async (url: string, isVideo: boolean): Promise<boolean> => {
    const turn = ++loads;
    try {
      if (isVideo) {
        const element = document.createElement("video");
        element.muted = true;
        element.loop = true;
        element.playsInline = true;
        element.preload = "auto";
        await within(new Promise<void>((resolve, reject) => {
          element.addEventListener("loadeddata", () => resolve(), { once: true });
          element.addEventListener("error", () => reject(new Error("unreadable")), { once: true });
          element.src = url;
        }), LOAD_TIMEOUT_MS);
        if (turn !== loads || destroyed) return false;
        dropVideo();
        video = element;
        source.setVideo(element);
        void element.play().catch(() => undefined);
      } else {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        image.src = url;
        await within(image.decode(), LOAD_TIMEOUT_MS);
        if (turn !== loads || destroyed) return false;
        dropVideo();
        source.setImage(image);
      }
      return source.kind !== "none";
    } catch {
      return false;
    }
  };

  /** Once a second, while a preset that works on a picture is shown: the cover as it is now. */
  const followCover = (time: number): void => {
    if (picked || time - coverAt < COVER_POLL_MS) return;
    coverAt = time;
    const url = trackCover();
    if (url === cover) return;
    cover = url;
    if (!url) {
      loads += 1;
      dropVideo();
      source.clear();
      return;
    }
    void load(url, false).then((ok) => {
      // A cover that cannot be read (another origin without CORS, a broken file): the painting.
      if (!ok && cover === url && !picked && !destroyed) source.clear();
    });
  };

  const picture: FablePicture = {
    chosen: () => picked !== null,
    async choose(file: File): Promise<boolean> {
      const url = URL.createObjectURL(file);
      const isVideo = file.type.startsWith("video/");
      if (!(await load(url, isVideo))) {
        URL.revokeObjectURL(url);
        // What was shown before stands; the cover is looked up again in case this displaced it.
        cover = undefined;
        return false;
      }
      if (picked) URL.revokeObjectURL(picked.url);
      picked = { url, video: isVideo };
      return true;
    },
    clear(): void {
      if (picked) URL.revokeObjectURL(picked.url);
      picked = null;
      loads += 1;
      dropVideo();
      source.clear();
      cover = undefined;
      coverAt = -COVER_POLL_MS;
    }
  };
  if (picked) {
    const mine = picked;
    void load(mine.url, mine.video).then((ok) => {
      if (!ok && picked === mine) picture.clear();
    });
  }

  const discard = (slot: Slot): void => {
    try {
      slot.instance?.destroy();
    } catch { /* its context may be gone */ }
    slot.instance = null;
    spare.push(slot.post);
  };

  const fail = (slot: Slot, error: unknown): void => {
    console.warn("Fable preset failed", slot.id, error);
    failures.push(slot.id);
    if (incoming === slot) incoming = null;
    if (current === slot) current = null;
    discard(slot);
  };

  /** The incoming preset takes the screen; the one under it goes. */
  const settle = (time: number): void => {
    if (!incoming) return;
    if (current) discard(current);
    current = incoming;
    current.fadeAt = 0;
    incoming = null;
    settledAt = time;
  };

  const paint = (slot: Slot, dt: number, scale: number, out: Target | null): boolean => {
    if (!slot.instance) return false;
    if (!slot.frames) slot.began = analysis.features.time;
    try {
      slot.instance.render({
        time: analysis.features.time - slot.began, dt, width: canvas.width, height: canvas.height, scale,
        audio: analysis, out, gentle: slot.entry.gentle || calm
      });
    } catch (error) {
      fail(slot, error);
      return false;
    }
    slot.frames += 1;
    return true;
  };

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
  });

  return {
    canvas,
    picture,
    show(id: string): void {
      const found = fablePreset(id);
      if (!found || destroyed || contextLost) {
        failures.push(id);
        return;
      }
      if (incoming) {
        // A change cut short: what already fades in stays, what is still unseen goes.
        if (incoming.fadeAt) settle(performance.now());
        else {
          discard(incoming);
          incoming = null;
        }
      }
      const post = spare.pop() ?? new Post(gl);
      post.reset();
      const slot: Slot = { id, entry: found.entry, instance: null, post, state: "loading", began: 0, frames: 0, fadeAt: 0 };
      incoming = slot;
      found.entry.load().then(({ definition }) => {
        // Superseded while it was fetched.
        if (incoming !== slot || destroyed) return;
        const odd = presetMismatch(found.entry, definition);
        if (odd.length) console.warn("Fable list and module disagree", found.entry.id, odd);
        try {
          // A seed of its own each time, so "Auto" coming back to a preset does not repeat it.
          slot.instance = definition.create({ gl, post, source }, found.preset.id, 1 + Math.floor(Math.random() * 0x7fffffff));
          slot.state = "compiling";
        } catch (error) {
          fail(slot, error);
        }
      }, (error: unknown) => {
        if (incoming === slot) fail(slot, error);
      });
    },
    shown: () => (incoming?.fadeAt ? incoming.id : current?.id ?? ""),
    pending: () => (incoming && !incoming.fadeAt ? incoming.id : ""),
    takeFailures: () => failures.splice(0),
    lost: () => contextLost,
    render(time: number, width: number, height: number): boolean {
      if (destroyed || contextLost || !width || !height) return false;
      let ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const pixels = width * height * ratio * ratio;
      if (pixels > MAX_PIXELS) ratio *= Math.sqrt(MAX_PIXELS / pixels);
      const pixelWidth = Math.max(1, Math.floor(width * ratio));
      const pixelHeight = Math.max(1, Math.floor(height * ratio));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const delta = previous ? Math.min(250, Math.max(1, time - previous)) : 1000 / 60;
      previous = time;
      const dt = Math.min(0.1, delta / 1000);

      if (factor === 1) {
        node.getByteFrequencyData(frequency);
        node.getByteTimeDomainData(waveform);
      } else {
        node.getByteFrequencyData(rawFrequency);
        frequency.set(rawFrequency.subarray(0, frequency.length));
        node.getByteTimeDomainData(rawWaveform);
        decimate(rawWaveform, factor, waveform);
      }
      const features = analysis.update(frequency, waveform, analyser.context.sampleRate / factor, dt);
      // The host's kit owns the audio texture: this call comes before any visualization's.
      analysis.uniforms(kit);
      const pictured = Boolean(current?.entry.usesSource || incoming?.entry.usesSource);
      if (pictured) {
        followCover(time);
        source.update(features.time, features.level * features.presence);
      }
      // The listener's video runs only while a preset shows it.
      if (video && video.paused === pictured) {
        if (pictured) void video.play().catch(() => undefined);
        else video.pause();
      }

      if (incoming?.state === "compiling") {
        try {
          if (!compiling(gl)) incoming.state = "ready";
        } catch (error) {
          fail(incoming, error);
        }
      }
      if (incoming?.state === "ready" && !incoming.fadeAt) {
        // Nothing drawn yet: it takes the screen at once. Else it begins to fade in.
        if (current) incoming.fadeAt = time;
        else settle(time);
      }
      if (!current) {
        // The first preset is still on its way: black, not the last picture of another.
        if (incoming) kit.clear(null, 0, 0, 0, 1);
        return false;
      }

      kit.pollTimers();
      const fading = incoming !== null && incoming.fadeAt > 0;
      // The frame time during a fade is two presets' and says nothing of either.
      const steady = !fading && time - settledAt > 500;
      const scale = steady ? adaptive.update(delta, gpuMs) : adaptive.scale;
      gpuMs = null;
      if (steady) kit.timeBegin();
      let drawn: boolean;
      if (fading && incoming) {
        older = kit.fit(older, pixelWidth, pixelHeight, "rgba8");
        newer = kit.fit(newer, pixelWidth, pixelHeight, "rgba8");
        const coming = incoming;
        const under = paint(current, dt, scale, older);
        const over = paint(coming, dt, scale, newer);
        if (under && over) {
          const level = Math.min(1, (time - coming.fadeAt) / fadeMs);
          kit.draw(mix, null, { uOld: older, uNew: newer, uLevel: level * level * (3 - 2 * level) });
          if (level >= 1) settle(time);
          drawn = true;
        } else if (over) {
          // The one under it failed: the new one alone.
          settle(time);
          drawn = paint(coming, dt, scale, null);
        } else drawn = under && current !== null && paint(current, dt, scale, null);
      } else drawn = paint(current, dt, scale, null);
      if (steady) void kit.timeEnd().then((ms) => { if (ms !== null) gpuMs = ms; });
      return drawn;
    },
    clear(): void {
      for (const slot of [current, incoming]) if (slot) discard(slot);
      current = null;
      incoming = null;
      previous = 0;
    },
    destroy(): void {
      if (destroyed) return;
      this.clear();
      destroyed = true;
      loads += 1;
      dropVideo();
      try {
        analyser.disconnect(node);
      } catch { /* już odłączony */ }
      for (const post of spare) post.destroy();
      spare.length = 0;
      analysis.release(kit);
      source.destroy();
      kit.destroy();
      // The context is given back now, not when the canvas is collected: browsers allow only so many.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    }
  };
}
