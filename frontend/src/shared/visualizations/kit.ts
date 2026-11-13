/**
 * What the visualizer panel needs and the dock does not: the registry of
 * plug-ins (and with it every plug-in's description and preset index), the
 * engine that runs them, and the search across their presets.
 *
 * One module, so the player can ask for all of it with a single dynamic import
 * the first time the panel is opened (audio-player.ts, `loadVisualizers`). The
 * player used to import the three statically, and every page loads the player:
 * the preset names and plug-in tables arrived with the start page, for a panel
 * most visits never open.
 */
export { VisualizerEngine } from "./engine";
export { PresetSearch } from "./preset-catalogs";
export { orderedVisualizerPlugins } from "./registry";
