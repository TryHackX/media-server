import packs from "virtual:icon-packs";

import { iconStyleFont, resolveIconStyle } from "./icon-styles";
import { primeIconFont } from "./icons";

/**
 * Switching the interface between Font Awesome Free and an installed Pro style.
 *
 * Nothing is re-rendered: every glyph reads its family and weight from two CSS
 * variables, and the Pro stylesheet sets them under `html[data-icon-style]`.
 * The attribute is set only once the stylesheet *and* the font have arrived, so
 * the icons change once, from Free to Pro, instead of blinking out while a font
 * downloads.
 *
 * The last style is remembered in this browser and applied as the page starts,
 * before the session answers — on a later visit the fonts come from the cache
 * and the switch lands before anyone sees Free.
 */

const STORAGE_KEY = "media-icon-style";

let stylesheet: Promise<boolean> | null = null;
let request = 0;

/** What this build can offer, or null when it was built without the Pro package. */
export function proIconPack(): { version: string; styles: readonly string[] } | null {
  return packs.pro ? { version: packs.pro.version, styles: packs.pro.styles } : null;
}

/** Load the Pro stylesheet once; false when there is none or it failed. */
export function ensureProStylesheet(): Promise<boolean> {
  const pro = packs.pro;
  if (!pro) return Promise.resolve(false);
  stylesheet ??= new Promise<boolean>((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = pro.href;
    link.dataset.iconPack = "pro";
    link.addEventListener("load", () => resolve(true), { once: true });
    link.addEventListener("error", () => resolve(false), { once: true });
    document.head.append(link);
  });
  return stylesheet;
}

function remember(style: string | null): void {
  try {
    if (style) localStorage.setItem(STORAGE_KEY, style);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* pamięć przeglądarki może być niedostępna */ }
}

/** Draw the interface in `style` (a Pro style id), or in Free for null. */
async function useIconStyle(style: string | null): Promise<void> {
  const current = ++request;
  remember(style);
  const root = document.documentElement;
  if (!style) {
    delete root.dataset.iconStyle;
    return;
  }
  if (root.dataset.iconStyle === style) return;
  if (!(await ensureProStylesheet()) || current !== request) return;
  const font = iconStyleFont(style);
  if (font && "fonts" in document) {
    // The family's solid weight too: an active favourite is drawn filled.
    await Promise.race([
      Promise.all([
        document.fonts.load(`${font.weight} 1em "${font.font}"`, ""),
        document.fonts.load(`900 1em "${font.font}"`, "")
      ]).catch(() => undefined),
      new Promise((resolve) => window.setTimeout(resolve, 3000))
    ]);
  }
  if (current === request) root.dataset.iconStyle = style;
}

/** The administrator's choice, from the session's settings. */
export function applyIconPack(settings: { icon_pack?: string; icon_style?: string }): void {
  void useIconStyle(resolveIconStyle(settings, proIconPack()?.styles ?? null));
}

/** The style this browser used last time, applied before the session arrives. */
export function primeIconPack(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch { stored = null; }
  const available = proIconPack()?.styles ?? [];
  if (stored && available.includes(stored)) void useIconStyle(stored);
  // No Pro style here last time: the icons will be Free's, so its font is asked for now.
  else primeIconFont();
}
