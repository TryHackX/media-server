/**
 * The interface's colour themes: which exist, which one a visit shows, and how
 * a choice travels between this browser and the account.
 *
 * A theme is a block of `styles/tokens.css` switched on by `data-theme` on
 * `<html>`. Three places have to agree about it, and this file is the one they
 * are checked against:
 *
 * - `public/theme-boot.js`, a few lines of classic script every page loads
 *   before its stylesheet, so the first frame is already in the right colours
 *   (the pages allow no inline script, and a module would run after the first
 *   paint). It cannot import this file, so `theme.test.ts` runs it and compares;
 * - the shell, which takes the account's choice once the session has answered;
 * - "Moje konto", where the choice is made.
 *
 * No imports and nothing run on load: the rules below are plain functions, so
 * they can be tested in Node, and the ones that touch the page do so only when
 * called.
 */

export const THEMES = ["emerald", "blue"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "emerald";

/** What the theme this browser used last is kept under (also read by theme-boot.js). */
export const THEME_STORAGE_KEY = "media-theme";

/**
 * Set while a choice has been made that the account does not hold: the bridge
 * of the day had nowhere to keep it. The first session that does carry a theme
 * gets that choice saved, so nobody has to choose twice.
 */
export const THEME_UNSAVED_KEY = "media-theme-unsaved";

/**
 * The page's canvas colour per theme, for `<meta name="theme-color">`: what a
 * phone paints its status bar and the task switcher with. The same two values
 * as `--color-canvas` in tokens.css (theme.test.ts reads the stylesheet).
 */
export const THEME_COLORS: Record<Theme, string> = {
  emerald: "#0b0f14",
  blue: "#060a14"
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Any stored or received value as a theme; what is unknown is the default. */
export function normalizeTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

export interface ThemeDecision {
  /** The theme to show. */
  theme: Theme;
  /** The browser holds a choice the account has not got: save it there. */
  pushToAccount: boolean;
}

/**
 * Which theme a signed-in visit shows.
 *
 * - The account names none (a bridge that does not store themes): this browser's
 *   own last choice, which is then a choice per device.
 * - The account names one: that one, on every device — except when this browser
 *   made its choice while the account could not keep it (`unsaved`). Then the
 *   browser's choice wins once and is handed to the account.
 */
export function resolveTheme(input: { account: unknown; stored: unknown; unsaved: boolean }): ThemeDecision {
  const local = isTheme(input.stored) ? input.stored : null;
  if (!isTheme(input.account)) return { theme: local ?? DEFAULT_THEME, pushToAccount: false };
  if (input.unsaved && local !== null && local !== input.account) return { theme: local, pushToAccount: true };
  return { theme: input.account, pushToAccount: false };
}

/** The theme this browser used last, or null when it never chose (or storage is unavailable). */
export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function hasUnsavedTheme(): boolean {
  try {
    return localStorage.getItem(THEME_UNSAVED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember the theme for the next visit's first frame; `unsaved` marks a choice the account does not hold. */
export function rememberTheme(theme: Theme, unsaved: boolean): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    if (unsaved) localStorage.setItem(THEME_UNSAVED_KEY, "1");
    else localStorage.removeItem(THEME_UNSAVED_KEY);
  } catch { /* pamięć przeglądarki może być niedostępna */ }
}

/** The theme the page is drawn in right now. */
export function currentTheme(): Theme {
  return normalizeTheme(document.documentElement.dataset.theme);
}

/**
 * Draw the page in a theme: the attribute the stylesheet switches on, and the
 * colour the browser paints its own chrome with. Nothing is re-rendered — every
 * colour on the page is a token.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && meta.content !== THEME_COLORS[theme]) meta.content = THEME_COLORS[theme];
}

/**
 * The theme of the last visit, applied as the script starts. `theme-boot.js`
 * has normally done this already, before the first paint; this is for the visit
 * on which that file did not arrive (offline, with the page served from the
 * service worker's copy).
 */
export function primeTheme(): void {
  applyTheme(storedTheme() ?? DEFAULT_THEME);
}
