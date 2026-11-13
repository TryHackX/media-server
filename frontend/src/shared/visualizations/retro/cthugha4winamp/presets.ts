import type { RetroScene } from "../types";
import type { C4wSettings } from "./scene";

/**
 * Cthugha-4-Winamp's presets: the plug-in as it came, with its scope or its analyzer only, with a
 * translation always on, and in its four-way display. The names are the plug-in's own terms, so
 * the list keeps them as they are.
 */
function c4w(id: string, name: string, settings: C4wSettings): { id: string; name: string; translate: boolean; create(): Promise<RetroScene> } {
  return { id, name, translate: false, create: async () => (await import("./scene")).createCthugha4Winamp(settings) };
}

export const C4W_PRESETS: readonly { id: string; name: string; translate: boolean; create(): Promise<RetroScene> }[] = [
  c4w("c4w-auto", "Cthugha-4-Winamp", { wave: "any" }),
  c4w("c4w-scope", "Cthugha-4-Winamp · Scope", { wave: "scope" }),
  c4w("c4w-analyzer", "Cthugha-4-Winamp · Analyzer", { wave: "analyzer" }),
  c4w("c4w-translate", "Cthugha-4-Winamp · Translate", { wave: "any", translate: true }),
  c4w("c4w-quad", "Cthugha-4-Winamp · Quad", { wave: "any", display: "quad" })
];
