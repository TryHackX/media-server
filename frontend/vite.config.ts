import { defineConfig } from "vite";

import { avsApes } from "./scripts/avs-apes.mjs";
import { avsPresets } from "./scripts/avs-presets.mjs";
import { butterchurnPatches } from "./scripts/butterchurn-patches.mjs";
import { iconPacks } from "./scripts/icon-packs.mjs";
import { milkdropPresets } from "./scripts/milkdrop-presets.mjs";
import { retroCthugha } from "./scripts/retro-cthugha.mjs";
import { shaderVisualizers } from "./scripts/shader-visualizers.mjs";
import { themeBoot } from "./scripts/theme-boot.mjs";
import { voltvizExtra } from "./scripts/voltviz-extra.mjs";
import { voltvizLogos } from "./scripts/voltviz-logos.mjs";

// Ten plik wykonuje Node, ale projekt nie ma (i nie potrzebuje) @types/node —
// jedna deklaracja jest tańsza niż zależność dla jednej zmiennej środowiskowej.
declare const process: { env: Record<string, string | undefined> };

/**
 * Where the application lives on the host.
 *
 * A dedicated server wants it at the root — that is what somebody typing the
 * bare address expects to reach. An installation sharing a host with something
 * else wants it under a path, so this stays overridable at build time:
 *
 *     MEDIA_APP_BASE=/media-next/ npm run build
 *
 * The value ends up in three places that must agree: the URLs Vite writes into
 * the built HTML, the `media-app-base` meta every page carries (which is what
 * `appUrl()` reads at runtime), and the service worker's scope. Keeping it in
 * one variable is the only reason they cannot drift apart.
 */
const base = (process.env.MEDIA_APP_BASE || "/").replace(/\/*$/, "/");

/** Put the same base into the pages, so nothing has to be edited by hand. */
const applyBase = {
  name: "tryhackx-app-base",
  transformIndexHtml(html: string) {
    return html.replaceAll("%APP_BASE%", base);
  },
};

export default defineConfig({
  base,
  plugins: [
    applyBase,
    // The theme of the last visit, on <html> before the first paint: the tag for
    // public/theme-boot.js, written where each page says <!--theme-boot-->.
    themeBoot({ base }),
    // Font Awesome Pro when the owner has put a licensed copy in vendor/ (never
    // committed); without it the interface uses Font Awesome Free alone.
    iconPacks({ vendorDir: "vendor/fontawesome-pro", iconsCss: "src/styles/icons.css" }),
    // Winamp AVS presets the owner put in vendor/ (never committed); none, no AVS.
    // The AVI effect's clips from the same packs (frame atlases) in vendor/avs-videos, never committed.
    avsPresets({ directory: "vendor/avs-presets", resources: "src/shared/visualizations/avs/webvs-resources", videos: "vendor/avs-videos" }),
    // Ports of AVS plug-ins without published source (APEs, Sonique plug-ins) in vendor/, never
    // committed; without them AVS skips those effects, as AVS did without the DLL.
    avsApes({ directory: "vendor/avs-apes" }),
    // More MilkDrop packs (projectM's, or any .milk folders) in vendor/, never
    // committed; MilkDrop offers them beside its own presets. None, none offered.
    // The textures presets name (projectM's texture pack) likewise; none, clouds2.
    milkdropPresets({ directory: "vendor/milkdrop-presets", textures: "vendor/milkdrop-textures" }),
    // butterchurn (MIT) patched as it loads: eel-wasm read as MilkDrop reads equations, and the
    // engine's MilkDrop 2 / BeatDrop / MilkDrop 3 additions — the list in the script.
    butterchurnPatches(),
    // voltviz's Moss Ball and Flame (CC BY-NC shaders) in vendor/, never committed;
    // without them VoltViz offers the vendored MIT ones only.
    voltvizExtra({ directory: "vendor/voltviz-extra", impl: "src/shared/visualizations/voltviz/visualizers/impl" }),
    // The owner's logos for voltviz's Your Logo in vendor/ (never committed); none, no Your Logo.
    voltvizLogos({ directory: "vendor/voltviz-logos" }),
    // Monkey Hi Hat's and music_visualizer's shaders in vendor/ (never committed: Shadertoy's
    // CC BY-NC-SA adaptations and GPL-3); converted for WebGL 2. None there, none offered.
    shaderVisualizers({ directory: "vendor/shader-visualizers" }),
    // A port of Cthugha-L for "Klasyka retro" in vendor/ (never committed: its licence allows
    // no commercial use); without it the visualizer offers its own presets only.
    retroCthugha({ directory: "vendor/cthugha" })
  ],
  build: {
    outDir: "../public/assets/build",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    // MilkDrop's preset packs (shared/visualizations/milkdrop.ts) are single
    // chunks of up to 1.3 MB — fetched only when that visualizer is opened.
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      input: {
        home: "index.html",
        login: "login/index.html",
        music: "music/index.html",
        movies: "movies/index.html",
        collections: "collections/index.html",
        account: "account/index.html",
        admin: "admin/index.html",
        // A page for people with no account: one shared folder or playlist.
        guest: "guest/index.html"
      }
    }
  }
});
