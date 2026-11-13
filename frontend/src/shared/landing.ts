/**
 * Where a sign-in may send the reader on: the `next` it was given, only when that is a page of
 * this application on this origin.
 *
 * `next` arrives in the address bar, which anybody can write. Until 11.11.2026 the check was
 * "starts with the application's base and not with //" — with base `/`, `/\host` passed, and
 * browsers read the backslash as a slash: `//host`, another origin (open redirect, audit SEC-01).
 * Now the value is resolved exactly as the browser will resolve it, and kept only when the
 * result stays on this origin, under the base, and is not the sign-in page itself.
 */
export function safeLanding(next: string | null, origin: string, base: string, signInPath: string, home: string): string {
  if (!next) return home;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return home;
  }
  if (url.origin !== origin || !url.pathname.startsWith(base) || url.pathname === signInPath) return home;
  return url.pathname + url.search + url.hash;
}
