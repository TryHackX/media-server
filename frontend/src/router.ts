import "./styles/core.css";
import "./styles/app.css";

import { appBase, appUrl } from "./shared/config";
import { pageRise, startTransition } from "./shared/motion";
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
  // Storage can be switched off altogether (a profile that blocks site data throws
  // on the first touch, reading included). Then the page's own age is the guard:
  // a page a few seconds old was loaded from the very build that is failing, and
  // loading it again would only fetch the same thing.
  let previous = 0;
  let remembered = true;
  try { previous = Number(sessionStorage.getItem(RELOAD_KEY) ?? "0"); } catch { remembered = false; }
  if (Number.isFinite(previous) && Date.now() - previous < RELOAD_QUIET_MS) return false;
  try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { remembered = false; }
  if (!remembered && performance.now() < RELOAD_QUIET_MS) return false;
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

/**
 * The element a hash names, by id.
 *
 * `querySelector(url.hash)` read the hash as a selector, and many hashes are not
 * one: `#1990s`, `#a.b`, anything percent-encoded. Each of those threw, the throw
 * rejected the navigation after the page had mounted, and the router logged a
 * failed navigation for a page that was on screen. An id is looked up as an id.
 */
function hashTarget(hash: string): HTMLElement | null {
  if (hash.length < 2) return null;
  let id = hash.slice(1);
  try { id = decodeURIComponent(id); } catch { /* not percent-encoded: the text itself is the id */ }
  return document.getElementById(id);
}

/**
 * How long a page change waits for the new page before showing it as it is.
 *
 * The old page stays on screen, as a picture, until the new one has something
 * to show. A page whose data is already here (or arrives within this time) is
 * shown whole; a slower one is shown with its placeholders and fills in while
 * it is already on screen. Longer than this and the click would feel ignored.
 */
const FIRST_PAINT_GRACE_MS = 110;

/** Whether a page is on screen already — the first render of a visit has nothing to give way. */
let pageShown = false;

/**
 * Put the page of `url` on screen.
 *
 * The first page of a visit is simply mounted. Every later one is a change from
 * one page to another, and is made inside a view transition (shared/motion.ts,
 * styles/motion.css): the old page fades while the new one rises into its
 * place, the title slides, and the sidebar, the header and the player do not
 * move at all. Without view transitions (or with reduced motion) the same
 * change happens directly and the shell's own short rise is all there is.
 */
async function show(page: PageModule, url: URL): Promise<void> {
  const leave = (): void => { document.dispatchEvent(new CustomEvent("media:route-will-change")); };
  const settle = (): void => {
    const anchor = hashTarget(url.hash);
    if (anchor) anchor.scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0, behavior: "auto" });
  };
  if (!pageShown) {
    pageShown = true;
    leave();
    await page.mount();
    settle();
    return;
  }
  let mounted: Promise<void> = Promise.resolve();
  const transition = startTransition("page", async () => {
    leave();
    mounted = page.mount();
    // The new page as far as it has got: whole, or with its placeholders. A
    // mount that fails must not fail the transition — it is reported below.
    await Promise.race([
      mounted.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, FIRST_PAINT_GRACE_MS))
    ]);
    if (!url.hash) window.scrollTo({ top: 0, behavior: "auto" });
  });
  void transition.ready.then((animating) => {
    // Inside the fade the content also rises; without a transition the shell has done both itself.
    const content = document.querySelector<HTMLElement>(".page-content");
    if (animating && content) pageRise(content, false);
  });
  await transition.updated;
  await mounted;
  settle();
}

function render(url: URL): Promise<void> {
  const request = ++revision;
  navigation = navigation
    .then(async () => {
      if (request !== revision) return;
      document.documentElement.classList.add("is-soft-navigating");
      try {
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
        await show(page, url);
      } finally {
        if (request === revision) document.documentElement.classList.remove("is-soft-navigating");
      }
    })
    // A page that fails to mount must not poison the chain: every later navigation
    // is chained onto this promise, so a rejection here would silently disable all
    // in-app links until a hard reload. Log it and let the next navigation proceed.
    .catch((error: unknown) => {
      // Signed out is not a failure of the page: api.ts is already on its way to
      // the sign-in page, and a visit by somebody not signed in is no error to log.
      if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401) return;
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

// Back and forward. A page may keep history entries of its own — the library
// pushes one per folder — and then it is the page that knows how to go back to
// it: it answers `media:popstate` (preventDefault) and the router stays out.
// Unanswered, the address is rendered from scratch, as before.
window.addEventListener("popstate", () => {
  const unanswered = document.dispatchEvent(new CustomEvent("media:popstate", { cancelable: true }));
  if (unanswered) void render(new URL(window.location.href));
});

await render(new URL(window.location.href));

// After the first page is on screen, never before it.
installOfflineShell();
