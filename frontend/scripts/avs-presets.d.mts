import type { Plugin } from "vite";

export declare function findPresets(directory: string): string[];
export declare function convertPresets(directory: string, files?: string[]): { presets: Record<string, unknown>; failed: string[] };
/** mscopes' own presets (BSD-3, in the repository), named "<name> — mscopes". */
export declare function mscopesPresets(): Record<string, unknown>;
/**
 * `directory` is relative to the Vite root (frontend/) unless absolute; `videos` is the folder of
 * the AVI effect's clips (frame atlases mirroring the packs), if any.
 */
export declare function avsPresets(options: { directory: string; resources: string; videos?: string }): Plugin;
