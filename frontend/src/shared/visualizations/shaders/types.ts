/**
 * What frontend/scripts/shader-visualizers.mjs writes at build time and the visualizer reads: an
 * index of presets, and per preset its program — passes, buffers, textures, audio.
 */

export type DrawMode = "Points" | "Lines" | "LineStrip" | "LineLoop" | "Triangles" | "TriangleStrip" | "TriangleFan";

/** A uniform's value: a number, or a range drawn from when the preset starts. */
export type UniformValue = number | [number, number];

export type Geometry =
  /** A full-screen quad (Monkey Hi Hat's VertexQuad). */
  | { type: "quad" }
  /** `count` vertices, each with its index as the `vertexId` attribute (VertexIntegerArray). */
  | { type: "array"; count: number; mode: DrawMode }
  /** `vertices` vertices drawn `instances` times; music_visualizer's geometry stage. */
  | { type: "instanced"; mode: DrawMode; vertices: number; instances: number };

export interface PassInput {
  /** The sampler it is bound to (`input0`, `inputB`, `iA`). */
  uniform: string;
  buffer: number;
  /** The buffer's previous frame (Monkey Hi Hat's letters). */
  previous?: boolean;
  /** The buffer's most recent drawing, this frame's or the last (music_visualizer). */
  latest?: boolean;
}

export interface Pass {
  draw: number;
  inputs: PassInput[];
  vertex?: string;
  fragment?: string;
  /** Initial values the shader gave its uniforms. */
  defaults?: Record<string, number | number[]>;
  geometry?: Geometry;
  /** A pass drawn by another visualizer's .conf brings that .conf's uniforms. */
  uniforms?: Record<string, UniformValue>;
  /** RGBA the buffer is cleared to before the pass; transparent black when absent. */
  clear?: [number, number, number, number];
  /** A buffer of a fixed size (music_visualizer); the picture's size when absent. */
  size?: [number, number] | null;
  /** An effect's pass 0: the visualization it works on. */
  primary?: boolean;
}

export type AudioName = "eyecandyShadertoy" | "eyecandyFreqDB" | "eyecandyWebAudio";

export interface TextureSpec {
  uniform: string;
  /** One is chosen at random each time the preset starts. */
  files: string[];
  clamp: boolean;
  cube: boolean;
  video?: boolean;
}

export interface MvAudioOptions {
  fftSync: boolean;
  xcorrSync: boolean;
  fftSmooth: number;
  waveSmooth: number;
}

export interface Program {
  passes: Pass[];
  buffers: number;
  /** Buffers kept for the next frame (read through letters). */
  previous: number[];
  /** The buffer the picture is in at the end of a frame. */
  output: number;
  /**
   * "frame": a buffer read as it was last frame has a second texture, swapped when the frame
   * ends (Monkey Hi Hat). "draw": every buffer has two, swapped each time it is drawn
   * (music_visualizer).
   */
  swap: "frame" | "draw";
  /** The longer side of the picture at most (RenderResolutionLimit); 0 for none. */
  limit: number;
  /** The limit while an effect asks for it (FXResolutionLimit). */
  fxLimit?: number;
  /** Seconds added to the clock at random, up to this (RandomTimeOffset). */
  timeOffset?: number;
  /** Effects: the visualization under them is drawn at its FXResolutionLimit. */
  applyPrimaryLimit?: boolean;
  /** Effects: fade in over the plain visualization. */
  crossfade?: boolean;
  blend?: boolean;
  uniforms: Record<string, UniformValue>;
  /** A visualizer's values for the uniforms of effects drawn over it, by effect. */
  fxUniforms?: Record<string, Record<string, UniformValue>>;
  textures: TextureSpec[];
  /** Uniforms listing as many files as the first one with a choice take the same place in them (RandomTextureSync). */
  textureSync?: boolean;
  audio: { name: AudioName; uniform: string }[];
  mvUniforms?: Record<string, number[]>;
  mvAudio?: MvAudioOptions;
}

export interface ShaderEntry {
  id: string;
  source: "volts" | "mv";
  kind: "viz" | "fx";
  /** Where the list shows it: volts-audio, volts-vertex, volts-ambient, volts-fx, mv. */
  group: string;
  name: string;
  file: string;
  authors: string[];
  byline: string;
  description: string;
  /** It reads the music (an audio texture, or music_visualizer's). */
  audio: boolean;
  /** Effects that do not suit it (lowercase file names). */
  blacklist?: string[];
  /** "Double": Monkey Hi Hat plays it twice as long. */
  switchHint?: string;
  url: string;
  multipass: boolean;
}

export interface ShaderIndex {
  presets: ShaderEntry[];
  /** The crossfades' file, null without Volt's Laboratory. */
  crossfades: string | null;
  /** Image and video files the build carries, by the name a .conf gives them. */
  images: Record<string, string>;
}

export interface CrossfadeShader {
  name: string;
  fragment: string;
}

/** What `virtual:shader-visualizers` exports; null without content. */
export interface ShaderBuildInfo {
  index: string;
  count: number;
  sources: readonly string[];
}
