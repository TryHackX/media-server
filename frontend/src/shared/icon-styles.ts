/**
 * The icon styles an administrator can choose, and which one applies.
 *
 * Kept free of the build's virtual module so the rules can be tested in Node;
 * shared/icon-pack.ts is the part that touches the page.
 */

export type IconFamily = "classic" | "duotone" | "sharp" | "sharp-duotone";
export type IconWeight = "solid" | "regular" | "light" | "thin";

const FAMILIES: readonly IconFamily[] = ["classic", "duotone", "sharp", "sharp-duotone"];
const WEIGHTS: readonly IconWeight[] = ["solid", "regular", "light", "thin"];

/** Every style id; the same list as scripts/icon-packs.mjs and CatalogActions::ICON_STYLES. */
export const ICON_STYLE_IDS: readonly string[] = FAMILIES.flatMap((family) => WEIGHTS.map((weight) => `${family}-${weight}`));

export const DEFAULT_ICON_STYLE = "classic-solid";

const FONTS: Record<IconFamily, string> = {
  classic: "Font Awesome 7 Pro",
  duotone: "Font Awesome 7 Duotone",
  sharp: "Font Awesome 7 Sharp",
  "sharp-duotone": "Font Awesome 7 Sharp Duotone"
};

const WEIGHT_VALUES: Record<IconWeight, number> = { solid: 900, regular: 400, light: 300, thin: 100 };

export function splitIconStyle(id: string): { family: IconFamily; weight: IconWeight } | null {
  const weight = WEIGHTS.find((candidate) => id.endsWith(`-${candidate}`));
  if (!weight) return null;
  const family = FAMILIES.find((candidate) => `${candidate}-${weight}` === id);
  return family ? { family, weight } : null;
}

/** The font a style draws with: what to ask `document.fonts` to load before switching. */
export function iconStyleFont(id: string): { font: string; weight: number } | null {
  const parts = splitIconStyle(id);
  return parts ? { font: FONTS[parts.family], weight: WEIGHT_VALUES[parts.weight] } : null;
}

/**
 * The style to draw, or null for Font Awesome Free.
 *
 * Pro only when the administrator chose it *and* this build has it. A setting
 * saved on a server with the package, then a rebuild without it, must not leave
 * every icon an empty square: it falls back to Free. A style the build does not
 * offer (the package was updated and lost one) falls back to Pro's own solid,
 * which is what Free looks like, before giving up on Pro.
 */
export function resolveIconStyle(
  settings: { icon_pack?: string; icon_style?: string },
  available: readonly string[] | null
): string | null {
  if (settings.icon_pack !== "pro" || !available || available.length === 0) return null;
  const wanted = settings.icon_style ?? DEFAULT_ICON_STYLE;
  if (available.includes(wanted)) return wanted;
  return available.includes(DEFAULT_ICON_STYLE) ? DEFAULT_ICON_STYLE : null;
}
