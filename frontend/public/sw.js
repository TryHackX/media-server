/*
 * Offline shell, and nothing more.
 *
 * The point of this worker is that the application opens on a phone with no
 * signal and says so, instead of showing the browser's dinosaur. It caches the
 * shell — the pages, the scripts, the stylesheet, the icons — and deliberately
 * caches nothing else.
 *
 * Three rules, each of them load-bearing:
 *
 * 1. **Documents go to the network first.** Every chunk name carries a hash of
 *    its contents, so a new build writes new names; a cached page would keep
 *    naming the files it was built against, which a deployment has already
 *    deleted. That is exactly the failure this project spent an evening fixing,
 *    and a service worker is the one thing that could bring it back for good.
 *    The cached copy is a fallback for being offline, never a shortcut.
 *
 * 2. **Hashed assets are cached for ever.** They can be: the name changes when
 *    the contents do, so a stale one is impossible by construction.
 *
 * 3. **Media and the API are never cached.** A film is gigabytes and belongs to
 *    the server's own range machinery; an API answer describes a moment. Both
 *    pass straight through, and the cache never sees a byte of either.
 */

const VERSION = "shell-v2";
const SHELL_CACHE = `tryhackx-media-${VERSION}`;

/*
 * Where the application lives, taken from where this worker was served.
 *
 * This used to be written here by hand, and stopped being true the moment the
 * application moved from `/media-next/` to the root. Nothing broke loudly:
 * every rule below is anchored to this value, so a wrong base simply makes the
 * worker ignore every request there is — an offline shell that installs,
 * activates and does nothing. `sw.js` is a public asset, so no build step
 * rewrites it; reading the worker's own URL is the one version that cannot
 * drift, and it covers a subdirectory install (`MEDIA_APP_BASE=/media-next/`)
 * without a second variable to keep in step.
 */
const BASE = new URL("./", self.location.href).pathname;

/** The pages worth having when there is no network. Everything else is asked for. */
const SHELL = [
  BASE,
  `${BASE}music/`,
  `${BASE}movies/`,
  `${BASE}collections/`,
  `${BASE}account/`,
  `${BASE}manifest.json`,
  `${BASE}icon-192.png`
];

const OFFLINE_PAGE = `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brak połączenia · TryHackX Media</title>
<style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#0b0f14;color:#e6edf3;
font:16px/1.5 system-ui,sans-serif;text-align:center;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0;color:#9fb0c0}</style></head><body><div><h1>Brak połączenia z serwerem</h1>
<p>Biblioteka jest dostępna tylko wtedy, gdy serwer domowy jest w zasięgu.</p></div></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // A missing page must not fail the whole install: the shell is a
      // convenience, and half of it is better than none of it.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith("tryhackx-media-") && name !== SHELL_CACHE)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

function isImmutableAsset(url) {
  // Built files carry a content hash in the name, so the name is the version.
  return url.pathname.startsWith(`${BASE}assets/`) || url.pathname.endsWith(".woff2");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The API answers about right now, and media is streamed with byte ranges the
  // Cache API would have to reassemble. Neither belongs here.
  if (!url.pathname.startsWith(BASE)) return;

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
    return;
  }

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)
          .then((hit) => hit ?? caches.match(BASE))
          .then((hit) => hit ?? new Response(OFFLINE_PAGE, {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          })))
    );
  }
});
