import type { PresetGroup } from "../types";
import type { FvDefinition } from "./core/types";

/**
 * The Fable visualizations as Internal lists them: ten visualizations drawn with WebGL 2, each
 * with its presets, each in a chunk of its own that is fetched when one of its presets is
 * first shown. This module is the list alone — names, order, what each needs — so the panel's
 * list and its search can be made without fetching any of them.
 *
 * Names are in Polish, the interface's source language; the English ones are in i18n.ts.
 * A preset's id in Internal is `<visualization>--<preset>`.
 */

export interface FablePreset {
  id: string;
  label: string;
}

export interface FableEntry {
  id: string;
  label: string;
  /** Works on the track's cover, or on a picture or a video the listener picks. */
  usesSource: boolean;
  /** Drawn in its flash-safe mode. */
  gentle: boolean;
  presets: readonly FablePreset[];
  load(): Promise<{ definition: FvDefinition }>;
}

export const FABLE: readonly FableEntry[] = [
  {
    id: "liquid-silk", label: "Płynny jedwab", usesSource: false, gentle: false,
    presets: [
      { id: "oil", label: "Oliwa na wodzie" }, { id: "opal", label: "Opal" },
      { id: "ember", label: "Żar" }, { id: "abyss", label: "Głębia" }
    ],
    load: () => import("./vis/01-liquid-silk")
  },
  {
    id: "aurora-lake", label: "Zorza nad jeziorem", usesSource: false, gentle: false,
    presets: [
      { id: "polar", label: "Zieleń polarna" }, { id: "violet", label: "Fiolet i róż" },
      { id: "ice", label: "Lodowy błękit" }, { id: "crown", label: "Czerwona korona" }
    ],
    load: () => import("./vis/02-aurora-lake")
  },
  {
    id: "nebula", label: "Mgławica miliona iskier", usesSource: false, gentle: false,
    presets: [
      { id: "galaxy", label: "Galaktyka spiralna" }, { id: "emission", label: "Mgławica emisyjna" },
      { id: "medusa", label: "Meduza" }, { id: "twin", label: "Bliźniacze wiry" }
    ],
    load: () => import("./vis/03-nebula")
  },
  {
    id: "crystal-cathedral", label: "Kryształowa katedra", usesSource: false, gentle: false,
    presets: [
      { id: "amethyst", label: "Ametyst" }, { id: "emerald", label: "Szmaragd" },
      { id: "ice", label: "Lód" }, { id: "amber", label: "Bursztyn" }
    ],
    load: () => import("./vis/04-crystal-cathedral")
  },
  {
    id: "ocean-of-light", label: "Ocean światła", usesSource: false, gentle: false,
    presets: [
      { id: "lagoon", label: "Laguna" }, { id: "golden", label: "Złota godzina" },
      { id: "plankton", label: "Bioluminescencja" }, { id: "prism", label: "Pryzmat" }
    ],
    load: () => import("./vis/05-ocean-of-light")
  },
  {
    id: "breathing-walls", label: "Oddychające ściany", usesSource: true, gentle: true,
    presets: [
      { id: "breath", label: "Oddech" }, { id: "melt", label: "Roztopy" },
      { id: "tracers", label: "Smugi" }, { id: "geometry", label: "Geometria" }
    ],
    load: () => import("./vis/06-breathing-walls")
  },
  {
    id: "droste", label: "Spirala Droste", usesSource: true, gentle: true,
    presets: [
      { id: "spiral", label: "Spirala" }, { id: "kaleidoscope", label: "Kalejdoskop" },
      { id: "helix", label: "Podwójna helisa" }, { id: "window", label: "Okno w oknie" }
    ],
    load: () => import("./vis/07-droste")
  },
  {
    id: "living-patterns", label: "Żywe wzory", usesSource: true, gentle: true,
    presets: [
      { id: "coral", label: "Koral" }, { id: "pearls", label: "Perły" },
      { id: "filigree", label: "Filigran" }, { id: "lace", label: "Koronka" }
    ],
    load: () => import("./vis/08-living-patterns")
  },
  {
    id: "fractal-flames", label: "Fraktalne płomienie", usesSource: true, gentle: true,
    presets: [
      { id: "gossamer", label: "Pajęczyna" }, { id: "mandala", label: "Mandala" },
      { id: "galaxy", label: "Galaktyka" }, { id: "wings", label: "Skrzydła" }
    ],
    load: () => import("./vis/09-fractal-flames")
  },
  {
    id: "hyper-tunnel", label: "Tunel hiperprzestrzeni", usesSource: true, gentle: true,
    presets: [
      { id: "neon", label: "Neon {7,3}" }, { id: "glass", label: "Witraż {5,4}" },
      { id: "apeirogon", label: "Apeirogon {∞,3}" }, { id: "crystal", label: "Kryształ {4,5}" }
    ],
    load: () => import("./vis/10-hyper-tunnel")
  }
];

const SEPARATOR = "--";

/** A preset's id in Internal's list. */
export function fablePresetId(visualization: string, preset: string): string {
  return `${visualization}${SEPARATOR}${preset}`;
}

/** Every preset's id, in the order of the list. */
export function fablePresetIds(entries: readonly FableEntry[] = FABLE): string[] {
  return entries.flatMap((entry) => entry.presets.map((preset) => fablePresetId(entry.id, preset.id)));
}

/** The visualization and the preset an id of the list stands for; null for anything else. */
export function fablePreset(id: string, entries: readonly FableEntry[] = FABLE): { entry: FableEntry; preset: FablePreset } | null {
  const at = id.indexOf(SEPARATOR);
  if (at <= 0) return null;
  const entry = entries.find((candidate) => candidate.id === id.slice(0, at));
  const preset = entry?.presets.find((candidate) => candidate.id === id.slice(at + SEPARATOR.length));
  return entry && preset ? { entry, preset } : null;
}

/**
 * The list's headings: one per visualization, its presets under it — as Internal's list shows
 * them and as the panel's search finds them. `translate` is i18n's t().
 */
export function fablePresetGroups(translate: (text: string) => string, entries: readonly FableEntry[] = FABLE): PresetGroup[] {
  return entries.map((entry) => ({
    label: translate(entry.label),
    presets: entry.presets.map((preset) => ({ id: fablePresetId(entry.id, preset.id), label: translate(preset.label) }))
  }));
}

/**
 * What a visualization's module says of itself against what the list says: the names of the
 * presets the two do not share (none when they agree).
 */
export function presetMismatch(entry: FableEntry, definition: Pick<FvDefinition, "id" | "presets">): string[] {
  const listed = new Set(entry.presets.map((preset) => preset.id));
  const defined = new Set(definition.presets.map((preset) => preset.id));
  const odd = [...listed].filter((id) => !defined.has(id)).concat([...defined].filter((id) => !listed.has(id)));
  return definition.id === entry.id ? odd : [`id:${definition.id}`, ...odd];
}
