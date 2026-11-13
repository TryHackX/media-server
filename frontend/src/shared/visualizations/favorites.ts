import { getVisualizerFavorites, saveVisualizerFavorites, type VisualizerFavorite } from "../api";

/**
 * Favourite visualizer presets — the panel's star — kept with the account (migration 040,
 * `visualizer_favorites`), so they follow the listener to any browser and "Ulubione" can play
 * them from every visualizer. A guest, or an install that has not run the migration, keeps them
 * in this browser as before. "Auto — favourites only" stays a choice of this browser, like the
 * chosen preset.
 *
 * The panel reads them as it draws, so the account's list is fetched once (loadFavorites) and
 * kept here: a star changes it at once and is saved behind it; a save the server refuses is
 * undone by fetching the list again. What this browser had kept before goes to the account the
 * first time it is seen, then leaves the browser.
 */

const FAVORITES_KEY = "media-visualizer-favorites:";
const AUTO_FAVORITES_KEY = "media-visualizer-auto-favorites:";
/** As the server allows: more would only slow the list down. */
const LIMIT = 500;

/** The account's favourites by visualizer, when the account keeps them. */
let accountFavorites: Map<string, VisualizerFavorite[]> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode or full storage: the choice lasts for this page only */
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Told whenever the favourites change: loaded, starred, put back after a refused save. */
export function onFavoritesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What this browser keeps for one visualizer (identifiers only, as the star stored them). */
function browserFavorites(pluginId: string): string[] {
  const raw = read(FAVORITES_KEY + pluginId);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The visualizers this browser keeps favourites of. */
function browserPluginIds(): string[] {
  const ids: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(FAVORITES_KEY)) ids.push(key.slice(FAVORITES_KEY.length));
    }
  } catch { /* pamięć przeglądarki może być niedostępna */ }
  return ids;
}

async function fetchAccountFavorites(): Promise<boolean> {
  const answer = await getVisualizerFavorites();
  if (!answer.stored) return false;
  accountFavorites = new Map(Object.entries(answer.favorites));
  return true;
}

/**
 * The account's favourites, fetched once per page; what this browser kept before moves to the
 * account. Without an account that keeps them (a guest, no migration, a failed request) the
 * browser's own stay in use.
 */
export function loadFavorites(): Promise<void> {
  loading ??= (async () => {
    try {
      if (!(await fetchAccountFavorites())) return;
      for (const pluginId of browserPluginIds()) {
        const known = new Set((accountFavorites!.get(pluginId) ?? []).map((favorite) => favorite.id));
        const missing = browserFavorites(pluginId).filter((id) => !known.has(id)).slice(-LIMIT);
        try {
          if (missing.length) {
            const saved = await saveVisualizerFavorites(pluginId, missing.map((id) => ({ id, label: "", favorite: true })));
            accountFavorites!.set(pluginId, saved);
          }
          write(FAVORITES_KEY + pluginId, null);
        } catch (error) {
          // Kept in the browser; tried again on the next visit.
          console.warn("Visualizer favourites not moved to the account", pluginId, error);
        }
      }
    } catch (error) {
      console.warn("Visualizer favourites unavailable", error);
    } finally {
      notify();
    }
  })();
  return loading;
}

/** One visualizer's favourites, oldest first, with the names they were starred under. */
export function favoriteEntries(pluginId: string): readonly VisualizerFavorite[] {
  if (accountFavorites) return accountFavorites.get(pluginId) ?? [];
  return browserFavorites(pluginId).map((id) => ({ id, label: "" }));
}

/** The favourites of one visualizer, in the order they were added. */
export function favoritePresets(pluginId: string): string[] {
  return favoriteEntries(pluginId).map((favorite) => favorite.id);
}

/** Every visualizer that has favourites, and its list. */
export function allFavorites(): ReadonlyMap<string, readonly VisualizerFavorite[]> {
  if (accountFavorites) return accountFavorites;
  return new Map(browserPluginIds().map((pluginId) => [pluginId, favoriteEntries(pluginId)] as const));
}

/**
 * Adds the preset, or removes it if it is already there; returns whether it is a favourite now.
 * `label` is the name the panel shows for it, kept for "Ulubione".
 */
export function toggleFavoritePreset(pluginId: string, presetId: string, label = ""): boolean {
  const before = favoriteEntries(pluginId);
  const index = before.findIndex((favorite) => favorite.id === presetId);
  const favorite = index < 0;
  if (favorite && before.length >= LIMIT) return false;
  const after = favorite ? [...before, { id: presetId, label }] : before.filter((_, at) => at !== index);
  if (!accountFavorites) {
    write(FAVORITES_KEY + pluginId, JSON.stringify(after.map((entry) => entry.id)));
    notify();
    return favorite;
  }
  accountFavorites.set(pluginId, after);
  notify();
  saveVisualizerFavorites(pluginId, [{ id: presetId, label, favorite }]).then(
    (saved) => {
      accountFavorites?.set(pluginId, saved);
      notify();
    },
    (error: unknown) => {
      // Refused or lost: the account's list as it really is.
      console.warn("Visualizer favourite not saved", pluginId, presetId, error);
      fetchAccountFavorites().catch(() => accountFavorites?.set(pluginId, [...before])).finally(notify);
    }
  );
  return favorite;
}

/** Visualizers whose unnamed favourites are being named right now. */
const naming = new Set<string>();

/**
 * Names for favourites the account keeps without one — moved from the browser, which kept
 * identifiers only — taken from the visualizer's own list when it is shown, so "Ulubione" says
 * "Glow Sphere" rather than "glowsphere". Once per visualizer and page; nothing to do otherwise.
 */
export function nameFavorites(pluginId: string, labels: ReadonlyMap<string, string>): void {
  if (!accountFavorites || naming.has(pluginId)) return;
  const unnamed = (accountFavorites.get(pluginId) ?? []).filter((favorite) => !favorite.label && labels.get(favorite.id));
  if (!unnamed.length) return;
  naming.add(pluginId);
  accountFavorites.set(pluginId, (accountFavorites.get(pluginId) ?? []).map((favorite) =>
    favorite.label ? favorite : { id: favorite.id, label: labels.get(favorite.id) ?? "" }));
  notify();
  saveVisualizerFavorites(pluginId, unnamed.map((favorite) => ({ id: favorite.id, label: labels.get(favorite.id)!, favorite: true })))
    .then((saved) => {
      accountFavorites?.set(pluginId, saved);
      notify();
    }, (error: unknown) => console.warn("Visualizer favourites not named", pluginId, error));
}

export function autoFavoritesOnly(pluginId: string): boolean {
  return read(AUTO_FAVORITES_KEY + pluginId) === "1";
}

export function setAutoFavoritesOnly(pluginId: string, on: boolean): void {
  write(AUTO_FAVORITES_KEY + pluginId, on ? "1" : null);
}
