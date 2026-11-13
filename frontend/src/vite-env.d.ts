/// <reference types="vite/client" />


/** What frontend/scripts/icon-packs.mjs found at build time; `pro` is null without a licensed package. */
declare module "virtual:icon-packs" {
  const packs: {
    pro: { version: string; href: string; styles: string[] } | null;
  };
  export default packs;
}

/** butterchurn 3 (MilkDrop in WebGL 2) — only what shared/visualizations/milkdrop.ts uses. */
declare module "butterchurn" {
  interface ButterchurnVisualizer {
    connectAudio(node: AudioNode): void;
    disconnectAudio(node: AudioNode): void;
    loadPreset(preset: object, blendTime?: number): Promise<void> | void;
    setRendererSize(width: number, height: number, options?: { pixelRatio?: number; meshWidth?: number; meshHeight?: number }): void;
    /** With `audioLevels`, these samples (1024 each, 0–255) instead of its own analysers'. */
    render(options?: { audioLevels?: { timeByteArray: Uint8Array; timeByteArrayL: Uint8Array; timeByteArrayR: Uint8Array } }): void;
    launchSongTitleAnim?(text: string): void;
    loseGLContext?(): void;
    /** The WebGL 2 context it draws with (on a canvas of its own). */
    gl?: WebGL2RenderingContext | null;
  }
  const butterchurn: {
    createVisualizer(context: BaseAudioContext, canvas: HTMLCanvasElement, options: Record<string, unknown>): ButterchurnVisualizer;
  };
  export default butterchurn;
}

/** The preset packs of butterchurn-presets 3: a map of preset name to preset. */
declare module "butterchurn-presets/dist/*" {
  const presets: unknown;
  export default presets;
}

/**
 * MilkDrop packs frontend/scripts/milkdrop-presets.mjs converted at build time
 * from vendor/milkdrop-presets/; null without any. Each pack's `index` is the
 * URL of its list of presets (shared/visualizations/milkdrop-packs.ts reads it).
 */
declare module "virtual:milkdrop-presets" {
  const presets: {
    packs: {
      id: string;
      /** The folder's name, for packs the interface has no name of its own for. */
      name: string;
      count: number;
      index: string;
      categories: { name: string; count: number }[];
    }[];
    /**
     * The textures presets name, from vendor/milkdrop-textures (and the packs'
     * own folders): files under `base`, `[name, file, width, height, pool]` each
     * (shared/visualizations/milkdrop-textures.ts reads it); null without any.
     */
    textures?: { base: string; list: [string, string, number, number, number][] } | null;
  } | null;
  export default presets;
}

/**
 * voltviz visualizations that are not MIT (Moss Ball, Flame), from vendor/voltviz-extra by
 * scripts/voltviz-extra.mjs; none without the folder.
 */
declare module "virtual:voltviz-extra" {
  const entries: readonly { id: string; name: string; load: () => Promise<unknown> }[];
  export default entries;
}

/**
 * The owner's logos for voltviz's Your Logo, from vendor/voltviz-logos by
 * scripts/voltviz-logos.mjs (served as files); none without the folder.
 */
declare module "virtual:voltviz-logos" {
  const logos: readonly { id: string; name: string; kind: "svg" | "image"; url: string }[];
  export default logos;
}

/**
 * What frontend/scripts/avs-presets.mjs built: the packs (vendor/avs-presets' folders, and
 * mscopes' presets, which every build has) and the URL of the one index listing their presets
 * (shared/visualizations/avs/packs.ts reads it); null without any preset.
 */
declare module "virtual:avs-presets" {
  const presets: {
    index: string;
    count: number;
    packs: readonly { id: string; name: string; count: number; categories: readonly { name: string; count: number }[] }[];
  } | null;
  export default presets;
  /** Where webvs's bitmap resources are served from. */
  export const resources: string;
  /** Images that came with the preset packs, served with them (names as in the packs). */
  export const images: readonly string[];
}

/**
 * Shader visualizations frontend/scripts/shader-visualizers.mjs converted at build time from
 * vendor/shader-visualizers/ (Monkey Hi Hat's Volt's Laboratory, music_visualizer); null without
 * them. `index` is the URL of the list (shared/visualizations/shaders/types.ts, ShaderIndex).
 */
declare module "virtual:shader-visualizers" {
  const info: { index: string; count: number; sources: readonly string[] } | null;
  export default info;
}

/**
 * Cthugha for "Klasyka retro": the port frontend/scripts/retro-cthugha.mjs found in
 * vendor/cthugha (never committed; Cthugha's licence allows no commercial use) — its presets and
 * a loader for its engine; null without it.
 */
declare module "virtual:avs-apes" {
  /** Loads the owner's ports of AVS plug-ins (vendor/avs-apes), or null without them. */
  const load: (() => Promise<{
    apes: readonly unknown[];
    svps: readonly unknown[];
    files: Readonly<Record<string, string>>;
  }>) | null;
  export default load;
}

declare module "virtual:retro-cthugha" {
  const cthugha: {
    /** `group`: another heading than "Cthugha" (its own presets there then make way). */
    presets: readonly { id: string; name: string; group?: string }[];
    load: () => Promise<{
      createCthughaScene(id: string): import("./shared/visualizations/retro/types").RetroScene | Promise<import("./shared/visualizations/retro/types").RetroScene>;
    }>;
  } | null;
  export default cthugha;
}
