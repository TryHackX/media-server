// Vendored from voltviz 0.35.1 (MIT, see LICENSE-voltviz.txt). Fork: no React overlays, and
// the track metadata is the player's (the fields of Sendspin's ServerStateMetadata the
// visualizers read) instead of Sendspin's own type; the raw WebGPU visualizers are told which
// GPU API to draw with (`gpuBackend`).
/**
 * The contract between the visualizer runtime and a visualizer. A visualizer is a plain
 * module (no React, no Web Audio): it receives a container to render into and, every frame,
 * the shared AudioFrame plus the current settings.
 */
import type { AudioFrame } from '../../audio/types';
import type { VisualizerSettings } from '../../types';

/** The track playing now: what the visualizers read of Sendspin's ServerStateMetadata. */
export interface ServerStateMetadata {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  /** The cover (same origin here, so it can be sampled). */
  artwork_url?: string | null;
}

export interface MountContext {
  /** Empty, absolutely-filled container. Append canvases / DOM here. */
  container: HTMLDivElement;
  /** Initial CSS size of the container and the capped device pixel ratio (<= 2). */
  width: number;
  height: number;
  dpr: number;
  settings: VisualizerSettings;
  metadata: ServerStateMetadata | null;
  /**
   * Fork: for the raw WebGPU visualizers (Pulsar, Oscilloscope, Daybreak, Blob Tracker): WebGPU,
   * or WebGL 2 where the browser has no WebGPU (lib/webgl2.ts). Not given: WebGPU, as upstream.
   */
  gpuBackend?: 'webgpu' | 'webgl';
}

export interface FrameContext {
  audio: AudioFrame;
  settings: VisualizerSettings;
  metadata: ServerStateMetadata | null;
  /** Seconds since this visualizer was mounted, and since the previous frame (<= 0.1). */
  time: number;
  dt: number;
  width: number;
  height: number;
  dpr: number;
}

export interface VisualizerInstance {
  frame(f: FrameContext): void;
  /** CSS size of the container changed (also called once right after mount). */
  resize?(width: number, height: number, dpr: number): void;
  /** Sendspin metadata changed (optional; it is also passed every frame). */
  metadata?(m: ServerStateMetadata | null): void;
  dispose(): void;
  /** Methods for the visualizer's optional Overlay (e.g. image upload). */
  api?: Record<string, (...args: never[]) => unknown>;
}

export type VisualizerFactory = (ctx: MountContext) => VisualizerInstance | Promise<VisualizerInstance>;

/** Shape of a visualizer module (visualizers/impl/<Name>.ts). */
export interface VisualizerModule {
  default: VisualizerFactory;
}
