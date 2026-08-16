import { defineConfig } from "vite";

export default defineConfig({
  base: "/media-next/",
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

