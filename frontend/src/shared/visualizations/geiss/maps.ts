/**
 * Geiss's 25 maps as the panel lists them: an id the favourites keep, the map's number in the
 * plug-in (its "##" keys, 01–25) and a name — Polish source text for t(), after Ryan Geiss's own
 * comments in GenerateChunkOfNewMap() ("terra-landing", "SUPER-perspective", "VORTEX THINGY",
 * "fuzzy", "ripples", "crazy-ass feedback", "sideways splitter", "black hole", "split-world warp",
 * "petals", "Crystal ball", "horz./vert. tunnel", "diced cube look", "phonic rings", "fast swirl",
 * "1/r scaling"…). No imports, so the tests read it as it is.
 */

export interface GeissMap {
  id: string;
  /** The plug-in's map number, 1–25. */
  mode: number;
  /** Polish source text of the name. */
  name: string;
}

const NAMES = [
  "Spirala", "Wir do środka", "Lądowanie", "Kula", "Superperspektywa",
  "Wiry", "Rozmyty zoom", "Fale", "Sprzężenie", "Wznoszenie",
  "Podwójny obrót", "Rozszczepienie", "Czarna dziura", "Rozdwojony świat", "Płatki",
  "Kryształowa kula", "Tunel poziomy", "Tunel pionowy", "Wir", "Horyzont",
  "Kostki", "Pierścienie dźwięku", "Pierścienie dźwięku II", "Szybki wir", "Głęboki zoom"
];

export const GEISS_MAPS: readonly GeissMap[] = NAMES.map((name, index) => ({
  id: `map-${String(index + 1).padStart(2, "0")}`,
  mode: index + 1,
  name
}));

/** The map an id names, or undefined. */
export function geissMap(id: string): GeissMap | undefined {
  return GEISS_MAPS.find((map) => map.id === id);
}

/** The id of map `mode` (1–25). */
export function geissMapId(mode: number): string {
  return GEISS_MAPS[mode - 1]?.id ?? "";
}

/**
 * The stars Auto picks by (sim.ts, FX_Pick_Random_Mode): the plug-in's own when it chooses
 * freely; only the pinned map; or only the favourites among them, each with at least one star.
 */
export function mapRatings(defaults: readonly number[], pinned: number | null, favourites: ReadonlySet<string> | null): number[] {
  const ratings = defaults.map((stars, mode) => {
    if (mode === 0) return 0;
    if (pinned !== null) return mode === pinned ? 1 : 0;
    if (favourites) return favourites.has(geissMapId(mode)) ? Math.max(1, stars) : 0;
    return stars;
  });
  return ratings.some((stars) => stars > 0) ? ratings : [...defaults];
}
