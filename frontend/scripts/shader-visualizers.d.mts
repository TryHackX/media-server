import type { Plugin } from "vite";

/**
 * Monkey Hi Hat's (Volt's Laboratory) and music_visualizer's shaders from `directory` (relative to
 * the Vite root, frontend/, unless absolute), converted for WebGL 2 at build time; without them
 * the build has none and the visualizer is not offered.
 */
export declare function shaderVisualizers(options: { directory: string }): Plugin;
