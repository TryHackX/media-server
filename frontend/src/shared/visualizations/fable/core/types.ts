import type { AudioAnalysis } from "./audio";
import type { Target } from "./kit";
import type { Post } from "./post";
import type { Source } from "./source";

/**
 * What a Fable visualization is to its host (the harness here; a WebGL 2 preset kind of
 * Internal later): a definition the panel can list, and instances that draw frames.
 */

export interface FvPreset {
  id: string;
  /** As the panel shows it. */
  labelPl: string;
  labelEn: string;
}

/** What every instance shares: one context, one post chain, the listener's picture. */
export interface FvEnvironment {
  gl: WebGL2RenderingContext;
  post: Post;
  source: Source;
}

export interface FvFrame {
  /** Seconds since the instance began. */
  time: number;
  /** Seconds since its last frame. */
  dt: number;
  /** The size of the picture asked for, in pixels. */
  width: number;
  height: number;
  /**
   * The share of that size to work at, 0.3–1: the host lowers it when frames run long
   * (adaptive resolution). The post chain brings the picture back to full size.
   */
  scale: number;
  audio: AudioAnalysis;
  /** Where the finished picture goes: null is the canvas. */
  out: Target | null;
  /** Photosensitive mode. */
  gentle: boolean;
}

export interface FvInstance {
  render(frame: FvFrame): void;
  destroy(): void;
}

export interface FvDefinition {
  id: string;
  /** Its place in the list, 1–10. */
  order: number;
  kind: "vivid" | "psychedelic";
  labelPl: string;
  labelEn: string;
  /** One line, as the owner will read it. */
  descriptionPl: string;
  /** Works on the cover or the listener's picture or video when there is one. */
  usesSource: boolean;
  /** Gentle mode is the default for it. */
  gentleByDefault: boolean;
  presets: readonly FvPreset[];
  /** `seed` varies what the preset leaves free, so "Auto" does not repeat itself. */
  create(environment: FvEnvironment, preset: string, seed: number): FvInstance;
}

/** A small seeded generator (mulberry32): the same seed, the same picture. */
export function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The working size for a frame: its size times its scale (and a factor of the visualization's own). */
export function workSize(frame: FvFrame, factor = 1): [number, number] {
  const scale = Math.min(1, Math.max(0.2, frame.scale * factor));
  return [Math.max(16, Math.round(frame.width * scale)), Math.max(16, Math.round(frame.height * scale))];
}
