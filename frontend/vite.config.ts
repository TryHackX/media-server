import { defineConfig } from "vite";

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
  plugins: [applyBase],
  build: {
    outDir: "../public/assets/build",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
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
