/**
 * A random identifier: `bytes` random bytes as lowercase hex (32 characters by default).
 *
 * `crypto.randomUUID()` would be the obvious call, and it exists only in a secure
 * context — HTTPS or localhost. Opened over plain HTTP on the home network the
 * account page, the library and the film viewer each threw on their first line
 * that wanted a seed and never mounted. `getRandomValues` has no such condition,
 * and nothing here needs the dashes of a UUID: these are shuffle seeds and the
 * names of player sessions (`[A-Za-z0-9_-]{8,80}` on the transfer service).
 *
 * No imports on purpose, so `node --test` can load it as it is.
 */
export function randomId(bytes = 16): string {
  const values = crypto.getRandomValues(new Uint8Array(Math.max(1, Math.floor(bytes))));
  let text = "";
  for (const value of values) text += value.toString(16).padStart(2, "0");
  return text;
}
