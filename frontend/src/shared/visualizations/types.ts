export interface VisualizerFrame {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  analyser: AnalyserNode;
  frequency: Uint8Array<ArrayBuffer>;
  waveform: Uint8Array<ArrayBuffer>;
  /**
   * The rate `frequency` and `waveform` are at: the context's at 44.1/48 kHz, and the same
   * 44.1/48 kHz on a faster device, whose analyser is read down to it (audio-rate.ts).
   */
  sampleRate: number;
  width: number;
  height: number;
  time: number;
  delta: number;
}

export interface VisualizerPlugin {
  id: string;
  label: string;
  fftSize?: number;
  smoothing?: number;
  render(frame: VisualizerFrame): void;
  reset?(): void;
  /**
   * A visualizer with a WebGL canvas of its own (MilkDrop through butterchurn).
   * The engine mounts it in place of the shared 2D canvas; `render` is unused.
   */
  external?: (analyser: AnalyserNode, options?: ExternalOptions) => Promise<ExternalVisualizer>;
  /**
   * Every preset the visualizer can play, as its own list shows them where it lists everything
   * (every pack), under its headings — for the panel's search across the visualizers
   * (preset-catalogs.ts): asked the first time a search needs it, never when the panel opens, and
   * kept for the page's life. Absent: its presets are not searched from the others' lists.
   */
  catalog?: (fetchJson: CatalogFetch) => Promise<readonly PresetGroup[]>;
  /**
   * The catalog changes while the page is open (Geiss: the presets the listener saves), so it is
   * asked again for every search instead of being kept.
   */
  catalogLive?: boolean;
}

/** One preset of a visualizer's catalog, as the search keeps it: its id, its name in the list, the heading over it. */
export interface PresetCatalogEntry {
  id: string;
  label: string;
  /** The heading it is listed under in the visualizer's widest list (pack · category), if any. */
  group?: string;
}

/** Fetches a catalog's JSON (a pack's index), within the search's limit on fetches at once. */
export type CatalogFetch = (url: string) => Promise<unknown>;

/** What the engine knows before an external visualizer starts. */
export interface ExternalOptions {
  /**
   * "Auto" over these presets only (the listener's favourites), from the first one it deals:
   * set after the start, the first preset came from the whole list and showed for a moment.
   */
  autoFilter?: readonly string[] | null;
  /**
   * Start on this preset, chosen, instead of the saved choice — "Ulubione" opens a visualizer on
   * one favourite, the panel's search across visualizers on the preset found. A preset the
   * visualizer does not have leaves it on its own choice; one outside the pack it plays from
   * makes it start in a pack that has it (MilkDrop, AVS: the preset's own; Shadery: every source).
   */
  preset?: string;
  /**
   * False: nothing chosen in this instance is remembered as the visualizer's choice (its preset
   * or pack), so "Ulubione" playing a MilkDrop favourite leaves MilkDrop's own choice alone.
   */
  persist?: boolean;
  /** For "Ulubione" only: the visualizers the panel offers, whose favourites it plays. */
  sources?: readonly VisualizerPlugin[];
  /**
   * Where the track playing stands: position and length in seconds (AVS's gettime(-1) and
   * gettime(-2), which asked Winamp). Missing outside the player.
   */
  playback?: () => { position: number; duration: number } | null;
}

/** One entry of the panel's preset list. */
export interface PresetOption {
  id: string;
  label: string;
}

/** Presets under one heading of the list; with an empty label they stand without one. */
export interface PresetGroup {
  label: string;
  presets: readonly PresetOption[];
}

/** A pack, or a part of one, that the list and "Auto" take their presets from. */
export interface PresetPool {
  id: string;
  label: string;
  /** The heading it is listed under, if any. */
  group?: string;
}

/** What an external visualizer gives the engine and the panel. */
export interface ExternalVisualizer {
  /**
   * What the engine places beside its 2D canvas: the visualizer's WebGL canvas, or a box
   * holding its canvases (VoltViz mounts each of its visualizations into one).
   */
  canvas: HTMLElement;
  render(time: number): void;
  resize(width: number, height: number): void;
  destroy(): void;
  /** Preset names, in the order the panel lists them. */
  presets(): readonly string[];
  /** "auto", or the preset the listener pinned. */
  chosen(): string;
  /** The preset on screen right now. */
  current(): string;
  choose(id: string): void;
  /** Move on now: auto deals the next preset, a pinned one steps to the next in the list. */
  next(): void;
  /** Told when the visualizer changed its own state (a preset failed and was dropped). */
  setListener(listener: (() => void) | null): void;
  /** The track title, shown the way MilkDrop shows it. */
  announce(text: string): void;
  /** The list under headings; absent or null, and the panel lists `presets()` as they are. */
  presetGroups?(): readonly PresetGroup[] | null;
  /** Packs to choose between; fewer than two, and the panel offers no choice. */
  pools?(): readonly PresetPool[];
  /** The pack the list and "Auto" are taken from. */
  pool?(): string;
  choosePool?(id: string): void;
  /** The choice's name where it is not packs of presets (Geiss: its colour depth). */
  poolsLabel?(): string;
  /**
   * "Auto" deals only these presets (the listener's favourites); null or none of
   * them available, and it deals from the whole list again.
   */
  setAutoFilter?(ids: readonly string[] | null): void;
  /**
   * "Ulubione" only: the visualizer and preset an entry of its list stands for — the star on it
   * takes that preset out of that visualizer's favourites.
   */
  favoriteOf?(id: string): { visualizer: string; preset: string; label: string } | null;
  /**
   * Changes when a preset's name changes under the same id (Geiss: a slot saved over), so the
   * panel redraws its list, which it otherwise does only when the list's length changes.
   */
  presetsRevision?(): number;
  /**
   * The presets the panel's random › picks from: those its own › steps through (VoltViz: Halftone
   * Pulse's choices only from one of them). Absent, `presets()`.
   */
  randomPool?(): readonly string[];
}
