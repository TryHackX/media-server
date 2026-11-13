import type { Plugin } from "vite";

/** The non-MIT voltviz visualizations an owner may add, by voltviz's file name. */
export declare const EXTRA_VISUALIZATIONS: Record<string, { id: string; name: string }>;
/**
 * Moss Ball and Flame from `directory` (relative to the Vite root, frontend/, unless absolute),
 * their imports resolved in `impl` (the vendored voltviz's visualizers/impl).
 */
export declare function voltvizExtra(options: { directory: string; impl: string }): Plugin;
