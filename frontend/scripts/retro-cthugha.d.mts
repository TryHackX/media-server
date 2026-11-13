import type { Plugin } from "vite";

/**
 * `virtual:retro-cthugha`: the Cthugha port in `directory` (relative to the Vite root, frontend/,
 * unless absolute) — its catalog and a loader for its engine — or null without it.
 */
export declare function retroCthugha(options: { directory: string }): Plugin;
