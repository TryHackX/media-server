/*
 * Offline shell, and nothing more.
 *
 * The point of this worker is that the application opens on a phone with no
 * signal and says so, instead of showing the browser's dinosaur. It caches the
 * shell — the pages, the scripts, the stylesheet, the icons — and deliberately
 * caches nothing else.
 *
 * Four rules, each of them load-bearing:
 *
 * 1. **Documents go to the network first.** Every chunk name carries a hash of
 *    its contents, so a new build writes new names; a cached page would keep
 *    naming the files it was built against, which a deployment has already
 *    deleted. That is exactly the failure this project spent an evening fixing,
 *    and a service worker is the one thing that could bring it back for good.
 *    The cached copy is a fallback for being offline, never a shortcut.
 *
 * 2. **Offline, a page is answered with its own cached copy or with the offline
 *    page — never with another page's.** The start page used to stand in for
 *    anything that was not cached. Served at the sign-in address it ran the
 *    application there, the application found no session and sent the browser
 *    to sign in, which was the address it was already at: a reload loop on a
 *    phone with no signal. A page's copy is kept under its path alone, so
 *    `/music/?collection=3` is answered by the copy of `/music/`.
 *
 * 3. **Hashed assets are cached until the build they belong to is replaced.**
 *    The name changes when the contents do, so a stale one is impossible by
 *    construction — and an old one is never asked for again, which is why they
 *    used to pile up: every build left its twelve megabytes of visualizer
 *    chunks behind for good. A page that arrives naming different files than it
 *    did last time is a new build; the assets of the old one go.
 *
 * 4. **Media and the API are never cached.** A film is gigabytes and belongs to
 *    the server's own range machinery; an API answer describes a moment. Both
 *    pass straight through, and the cache never sees a byte of either.
 */

const VERSION = "shell-v3";
const SHELL_CACHE = `tryhackx-media-${VERSION}`;
const ASSET_CACHE = `tryhackx-media-assets-${VERSION}`;
/** A ceiling for the asset cache whatever else happens (one build is about 210 files). */
const ASSET_LIMIT = 700;

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
        names.filter((name) => name.startsWith("tryhackx-media-") && name !== SHELL_CACHE && name !== ASSET_CACHE)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

/*
 * The bridge and the transfer service. They are siblings of the application
 * when it lives under a path, and sit *inside* its address space when it lives
 * at the root — where "starts with the base" is true of every address there is.
 * A download is a navigation too: without this the worker answered for it, and
 * tried to keep a film as if it were a page.
 */
const OUTSIDE = ["/media-next-api", "/media-transfer"];

function isOutside(url) {
  return OUTSIDE.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

function isImmutableAsset(url) {
  // Built files carry a content hash in the name, so the name is the version.
  if (url.pathname.startsWith(`${BASE}assets/`) || url.pathname.endsWith(".woff2")) return true;
  // The theme's boot script carries its hash in the query instead (the build
  // writes the tag: scripts/theme-boot.mjs). Every page loads it before its
  // first paint, so offline it has to come from here like any other script.
  return url.pathname === `${BASE}theme-boot.js` && url.searchParams.has("v");
}

/**
 * The address a page's copy is kept under: its path, without the query. Every
 * profile (`account/<name>/`) is the one account page.
 */
function pageKey(url) {
  const account = `${BASE}account/`;
  return url.origin + (url.pathname.startsWith(account) ? account : url.pathname);
}

/** Which built files a page names — the build's signature, as far as that page can tell. */
function buildSignature(html) {
  return Array.from(new Set(html.match(/assets\/[\w.~-]+\.(?:js|css)/g) ?? [])).sort().join(" ");
}

/**
 * Keep a page that just arrived from the network, and notice a new build.
 *
 * The signature the page had last time is stored beside it. A different one
 * means the server has been rebuilt: the old build's assets will never be asked
 * for again, so they are dropped — all of them; what the new pages need is
 * fetched again as they ask for it (and usually still sits in the HTTP cache).
 */
async function keepPage(url, response) {
  const key = pageKey(url);
  const cache = await caches.open(SHELL_CACHE);
  const signature = buildSignature(await response.clone().text());
  const noteKey = `${key}?build-signature`;
  const known = await cache.match(noteKey);
  const previous = known ? await known.text() : "";
  await cache.put(key, response);
  if (signature === "" || signature === previous) return;
  await cache.put(noteKey, new Response(signature));
  if (previous !== "") await caches.delete(ASSET_CACHE);
}

async function keepAsset(request, response) {
  const cache = await caches.open(ASSET_CACHE);
  await cache.put(request, response);
  const keys = await cache.keys();
  // Oldest first is the order the Cache API lists them in.
  if (keys.length > ASSET_LIMIT) await Promise.all(keys.slice(0, keys.length - ASSET_LIMIT).map((key) => cache.delete(key)));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The API answers about right now, and media is streamed with byte ranges the
  // Cache API would have to reassemble. Neither belongs here.
  if (!url.pathname.startsWith(BASE) || isOutside(url)) return;

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
        if (response.ok) void keepAsset(request, response.clone()).catch(() => undefined);
        return response;
      }))
    );
    return;
  }

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // A page, and only a page: anything else that was navigated to (a file
          // somebody opened in a tab) passes through untouched and unkept.
          const html = (response.headers.get("Content-Type") ?? "").startsWith("text/html");
          if (response.ok && html) void keepPage(url, response.clone()).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match(pageKey(url))
          .then((hit) => hit ?? new Response(OFFLINE_PAGE, {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          })))
    );
  }
});
