import type { Plugin } from "vite";

/**
 * butterchurn's dist/butterchurn.js, patched as Vite loads it (the list and the reasons are in
 * butterchurn-patches.mjs); a patch that no longer fits the installed version stops the build.
 */
export declare function butterchurnPatches(): Plugin;
