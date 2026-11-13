import type { Plugin } from "vite";

export interface MilkdropChunkLimits {
  /** Bytes of preset JSON per chunk file, about. */
  maxBytes?: number;
  /** Presets per chunk file, at most. */
  maxPresets?: number;
}

/**
 * Packs of .milk presets in `directory` (relative to the Vite root, frontend/,
 * unless absolute), converted at build time; none there, and the build has none.
 * `textures`: a folder of the images presets name (`sampler_worms` is worms.jpg),
 * served beside them; none there, and presets get butterchurn's own as before.
 */
export declare function milkdropPresets(options: { directory: string; textures?: string; limits?: MilkdropChunkLimits; workers?: number }): Plugin;
