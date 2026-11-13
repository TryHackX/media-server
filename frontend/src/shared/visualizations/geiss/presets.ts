/**
 * The listener's own Geiss presets, GEISS.INI per browser: Geiss 4.30 saved a preset with `]##`
 * into section [PRESET ##] of GEISS.INI and loaded it with `[##` (SavePreset/LoadPreset in
 * Effects.h, ported in sim.ts). Here the 100 slots (00–99, Geiss's two digits) live in the
 * browser's storage under one key, each slot the section's keys and values (GeissPreset).
 *
 * Pure functions over a Storage-like object, so the tests run them without a browser. No imports
 * but types, so the tests read it as it is.
 */
import type { GeissPreset } from "./sim";

/** Where the slots are kept: {"07": {x_center: …, mode: …, …}, …}. */
export const PRESETS_KEY = "media-visualizer-geiss-presets";
/** Slots 00–99, as Geiss's `[##` / `]##`. */
export const PRESET_SLOTS = 100;

/** The keys every saved preset has (the palette's only at 8 bits, all seven or none). */
const REQUIRED: readonly (keyof GeissPreset)[] = [
  "x_center", "y_center", "mode", "damping", "wave", "magic", "volpos", "shift", "gamma",
  "t1", "t2", "s1", "s2", "f1", "f2", "f3", "f4",
  "effect_chasers", "effect_bar", "effect_dots", "effect_solar", "effect_grid", "effect_nuclide", "effect_shadebobs",
  "effect_spectral", "spectrum"
];
const PALETTE: readonly (keyof GeissPreset)[] = [
  "pal_lo_band", "pal_hi_band", "pal_bFX", "pal_FXpalnum", "pal_curve_id_1", "pal_curve_id_2", "pal_curve_id_3"
];

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem" | "removeItem">;

/** The slot's two digits, "07". */
export function slotName(slot: number): string {
  return String(slot).padStart(2, "0");
}

/** The panel's id for a saved preset: "preset-07". */
export function presetId(slot: number): string {
  return `preset-${slotName(slot)}`;
}

/** The slot an id names (0–99), or null. */
export function presetSlot(id: string): number | null {
  const match = /^preset-(\d\d)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** A stored value that is a preset Geiss can load, as one (only its own keys); else null. */
export function validPreset(value: unknown): GeissPreset | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const number = (key: string): boolean => typeof record[key] === "number" && Number.isFinite(record[key]);
  if (!REQUIRED.every(number)) return null;
  const mode = record["mode"] as number;
  if (!Number.isInteger(mode) || mode < 1 || mode > 25) return null;
  const palette = PALETTE.filter(number).length;
  if (palette !== 0 && palette !== PALETTE.length) return null;
  const preset = {} as Record<string, number>;
  for (const key of [...REQUIRED, ...(palette ? PALETTE : [])]) preset[key] = record[key] as number;
  return preset as unknown as GeissPreset;
}

/** The saved presets by slot, in slot order; what cannot be read is left out. */
export function readPresets(storage: ReadStorage | null): Map<number, GeissPreset> {
  const presets = new Map<number, GeissPreset>();
  let stored: unknown = null;
  try {
    stored = JSON.parse(storage?.getItem(PRESETS_KEY) ?? "null");
  } catch {
    return presets;
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return presets;
  const slots = Object.entries(stored as Record<string, unknown>)
    .filter(([name]) => /^\d\d$/.test(name))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [name, value] of slots) {
    const preset = validPreset(value);
    if (preset) presets.set(Number(name), preset);
  }
  return presets;
}

/** All the slots written back (none left: the key goes). False when the storage refused. */
export function writePresets(storage: WriteStorage | null, presets: ReadonlyMap<number, GeissPreset>): boolean {
  if (!storage) return false;
  try {
    if (!presets.size) {
      storage.removeItem(PRESETS_KEY);
      return true;
    }
    const slots: Record<string, GeissPreset> = {};
    for (const slot of [...presets.keys()].sort((left, right) => left - right)) slots[slotName(slot)] = presets.get(slot)!;
    storage.setItem(PRESETS_KEY, JSON.stringify(slots));
    return true;
  } catch {
    return false;
  }
}

/** The first slot without a preset, from 01 (Geiss's keys have no 00 to prefer); null when full. */
export function freeSlot(presets: ReadonlyMap<number, unknown>): number | null {
  for (let step = 0; step < PRESET_SLOTS; step += 1) {
    const slot = (step + 1) % PRESET_SLOTS;
    if (!presets.has(slot)) return slot;
  }
  return null;
}
