import "./styles/index.css";

import { appBase, appUrl } from "./shared/config";
import { installOfflineShell } from "./shared/pwa";

type PageModule = { mount: () => Promise<void> };

const routeModule = async (pathname: string): Promise<PageModule> => {
  const relative = pathname.slice(appBase.length).replace(/^\/+|\/+$/g, "");
  if (relative === "music") return import("./pages/music");
  if (relative === "movies") return import("./pages/movies");
  if (relative === "collections") return import("./pages/collections");
  if (relative === "admin") return import("./pages/admin");
  if (relative === "account" || relative.startsWith("account/")) return import("./pages/account");
  return import("./pages/home");
};

let navigation = Promise.resolve();
let revision = 0;

/**
 * The tab was open across a deployment.
 *
 * Every chunk name carries a hash of its contents, so a new build writes new
 * names and removes the old ones. A tab that has been sitting open still holds
 * the previous names — it asks for `account-DC_o8-DN.js`, gets a 404, and the
 * page it was trying to open never mounts. Nothing in the tab can fix that:
 * the file it wants no longer exists. A full load does, because it fetches the
 * HTML again and that names the chunks the server actually has.
 *
 * Guarded by a timestamp so a genuinely broken deployment cannot turn into a
 * reload loop: if this already happened moments ago, the failure is reported
 * instead of being answered with another reload.
 */
const RELOAD_KEY = "media-stale-build-reload";
const RELOAD_QUIET_MS = 15000;

function reloadForNewBuild(target: string): boolean {
  const previous = Number(sessionStorage.getItem(RELOAD_KEY) ?? "0");
  if (Number.isFinite(previous) && Date.now() - previous < RELOAD_QUIET_MS) return false;
  try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* pamięć może być niedostępna */ }
  window.location.assign(target);
  return true;
}

// Vite raises this for any failed dynamic import, including the ones this file
// does not make itself (the player's visualisers, the tag editor). Preventing
// the default keeps it from also throwing into the console when we have already
// dealt with it.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewBuild(window.location.href)) event.preventDefault();
});

function render(url: URL): Promise<void> {
  const request = ++revision;
  navigation = navigation
    .then(async () => {
      if (request !== revision) return;
      document.documentElement.classList.add("is-soft-navigating");
      try {
        document.dispatchEvent(new CustomEvent("media:route-will-change"));
        let page: PageModule;
        try {
          page = await routeModule(url.pathname);
        } catch (error) {
          // Loading the page's code failed, which in practice means the build
          // changed underneath this tab. Go there the hard way rather than
          // leaving the reader on a page whose links have stopped working.
          if (reloadForNewBuild(url.href)) return;
          throw error;
        }
        if (request !== revision) return;
        await page.mount();
        if (url.hash) document.querySelector(url.hash)?.scrollIntoView({ block: "start" });
        else window.scrollTo({ top: 0, behavior: "auto" });
      } finally {
        if (request === revision) document.documentElement.classList.remove("is-soft-navigating");
      }
    })
    // A page that fails to mount must not poison the chain: every later navigation
    // is chained onto this promise, so a rejection here would silently disable all
    // in-app links until a hard reload. Log it and let the next navigation proceed.
    .catch((error: unknown) => {
      console.error("Nawigacja nie powiodła się:", error);
    });
  return navigation;
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
  if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith(appBase) || url.pathname === appUrl("login/")) return;
  event.preventDefault();
  if (url.href !== window.location.href) window.history.pushState({}, "", url);
  void render(url);
});

window.addEventListener("popstate", () => void render(new URL(window.location.href)));

await render(new URL(window.location.href));

// After the first page is on screen, never before it.
installOfflineShell();
