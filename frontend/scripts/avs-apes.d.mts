import type { Plugin } from "vite";

/** The port modules and data files of a vendor folder. */
export declare function findApePorts(directory: string): { ports: string[]; files: { name: string; path: string }[] };

/**
 * `virtual:avs-apes`: a loader for the ports of AVS plug-ins in `directory` (relative to the Vite
 * root, frontend/, unless absolute), or null without them.
 */
export declare function avsApes(options: { directory: string }): Plugin;
