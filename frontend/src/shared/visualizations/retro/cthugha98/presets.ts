import type { RetroScene } from "../types";
import type { Cthugha98Settings } from "./scene";

/**
 * Cthugha98's presets: the program as it came (everything at random), leaning to one part of it
 * (flames and waves, translation tables, particle scenes, the kaleidoscope), and the 3dfx build's
 * 3D views. The names are the program's own terms, so the list keeps them as they are.
 */
function c98(id: string, name: string, settings: Cthugha98Settings): { id: string; name: string; translate: boolean; create(): Promise<RetroScene> } {
  return { id, name, translate: false, create: async () => (await import("./scene")).createCthugha98(settings) };
}

export const C98_PRESETS: readonly { id: string; name: string; translate: boolean; create(): Promise<RetroScene> }[] = [
  c98("c98-auto", "Cthugha98", { build: "standard", focus: "all" }),
  c98("c98-flames", "Cthugha98 · Flame & Wave", { build: "standard", focus: "flames" }),
  c98("c98-tables", "Cthugha98 · Translate", { build: "standard", focus: "tables" }),
  c98("c98-particles", "Cthugha98 · Particles", { build: "standard", focus: "particles" }),
  c98("c98-kaleido", "Cthugha98 · Kaleidoscope", { build: "standard", focus: "all", display: "kaleido" }),
  c98("c98-3dfx", "Cthugha98 3Dfx", { build: "3dfx", focus: "all" }),
  c98("c98-3dfx-low", "Cthugha98 3Dfx · Landscape", { build: "3dfx", focus: "all", view: "low" }),
  c98("c98-3dfx-points", "Cthugha98 3Dfx · Points", { build: "3dfx", focus: "all", view: "points" })
];
