/**
 * What this browser is called in the device list of the playback queue.
 *
 * The name read from the user agent ("Windows · Chrome") tells the desktop from
 * the phone, but not three browsers on one machine apart; a name chosen by hand
 * wins over it. The name is kept in this browser, not with the account: it
 * belongs to the device, which is the whole point of having it.
 *
 * No imports on purpose, so `node --test` can load it as it is. The translated
 * pieces come from the caller (`queue-sync.ts` composes the final name).
 */

const LABEL_KEY = "media-device-label";
/** What the bridge stores: `device_label` is checked with `strlen`, so 64 bytes, not characters. */
const LABEL_MAX_BYTES = 64;

const listeners = new Set<() => void>();

/**
 * A name as the bridge will take it: one line, single spaces, at most 64 bytes.
 *
 * The cut falls between characters, never inside one. A name over the limit
 * would be refused by the bridge, and a refused queue save is silent — that
 * device would simply stop showing up on the others.
 */
export function normaliseDeviceLabel(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const encoder = new TextEncoder();
  let fitted = "";
  let used = 0;
  for (const character of clean) {
    used += encoder.encode(character).length;
    if (used > LABEL_MAX_BYTES) break;
    fitted += character;
  }
  return fitted.trim();
}

/**
 * The name read from a user agent, coarse on purpose: anything finer would be
 * guesswork dressed up as fact. `unknownSystem` names a system it cannot tell.
 */
export function agentLabel(agent: string, unknownSystem: string): string {
  const system = /Android/i.test(agent) ? "Android"
    : /iPhone|iPad|iPod/i.test(agent) ? "iOS"
      : /Windows/i.test(agent) ? "Windows"
        : /Mac OS X/i.test(agent) ? "macOS"
          : /Linux/i.test(agent) ? "Linux"
            : unknownSystem;
  const browser = /Edg\//i.test(agent) ? "Edge"
    : /OPR\//i.test(agent) ? "Opera"
      : /Firefox\//i.test(agent) ? "Firefox"
        : /Chrome\//i.test(agent) ? "Chrome"
          : /Safari\//i.test(agent) ? "Safari"
            : "";
  return normaliseDeviceLabel(browser ? `${system} · ${browser}` : system);
}

/** The name somebody gave this browser, or "" when it has none of its own. */
export function ownDeviceLabel(): string {
  try {
    return normaliseDeviceLabel(localStorage.getItem(LABEL_KEY) ?? "");
  } catch {
    return "";
  }
}

/**
 * Rename this browser; an empty name gives it back the one read from its user agent.
 *
 * Returns the name now stored ("" for none). Whoever listens — the queue writer —
 * hears of it at once, so the other devices see the new name without waiting for
 * the next track change.
 */
export function setDeviceLabel(value: string): string {
  const own = normaliseDeviceLabel(value);
  try {
    if (own) localStorage.setItem(LABEL_KEY, own);
    else localStorage.removeItem(LABEL_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked site data). The rename
    // then does not stick, because there is nowhere to keep it.
  }
  for (const listener of listeners) listener();
  return ownDeviceLabel();
}

export function onDeviceLabelChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
