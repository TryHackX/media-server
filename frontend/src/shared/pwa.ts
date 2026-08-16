import { appUrl } from "./config";

/**
 * Install the offline shell, once, quietly.
 *
 * The worker is what makes the application installable on a phone: with it the
 * icon on the home screen opens a window with no address bar, and opening it
 * out of range says so instead of showing the browser's error page. It caches
 * the shell and nothing else — no films, no API answers (see `public/sw.js`).
 *
 * Registration is deliberately late and deliberately silent. Late, because a
 * worker registering during start-up competes with the first screen for the
 * network; silent, because a browser that refuses (no secure context, private
 * window, a policy) has not broken anything — the application works exactly as
 * it did before, and telling somebody about it would be noise.
 */
export function installOfflineShell(): void {
  if (!("serviceWorker" in navigator)) return;
  // A worker needs a secure context. Localhost counts as one, which is why this
  // works today; over the network it will wait for the HTTPS of M7.
  if (!window.isSecureContext) return;
  const register = (): void => {
    void navigator.serviceWorker
      // `updateViaCache: "none"` is the reason this works behind a server that
      // serves every .js as immutable for a year: the browser is told to fetch
      // the worker itself past the HTTP cache, so a new shell is picked up on
      // the next visit rather than next year.
      .register(appUrl("sw.js"), { scope: appUrl(), updateViaCache: "none" })
      .catch(() => undefined);
  };
  if (document.readyState === "complete") window.setTimeout(register, 1200);
  else window.addEventListener("load", () => window.setTimeout(register, 1200), { once: true });
}
