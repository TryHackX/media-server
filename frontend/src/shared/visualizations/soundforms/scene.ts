import type { AudioFeed } from "./audio";
import type { Pipeline } from "./pipeline";

/** What a scene gets every frame. */
export interface FrameInfo {
  gl: WebGL2RenderingContext;
  /** Drawing-buffer pixels of the picture, and its shape. */
  width: number;
  height: number;
  aspect: number;
  /** Seconds since the scene came on screen, and since its last frame. */
  time: number;
  dt: number;
  audio: AudioFeed;
  /** Pixels per pixel of a 1080p picture: lines and dots keep their look at any size. */
  px: number;
  /** The largest point the GPU draws, in pixels. */
  maxPoint: number;
}

/** One preset on screen. */
export interface Scene {
  draw(frame: FrameInfo): void;
  dispose(): void;
}

export type SceneFactory<S> = (pipeline: Pipeline, settings: S) => Scene;

/** Additive light: what a scene draws adds up, the way glowing lines and dots do. */
export function additive(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE);
}
