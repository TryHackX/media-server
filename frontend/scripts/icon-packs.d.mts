import type { Plugin } from "vite";

export interface IconStyleDefinition {
  id: string;
  family: string;
  weight: string;
  font: string;
  value: number;
  file: string;
  duotone: boolean;
}

export interface ProPack {
  version: string;
  styles: IconStyleDefinition[];
  missing: string[];
}

export declare const ICON_STYLES: readonly IconStyleDefinition[];
export declare function usedIcons(iconsCss: string): Map<string, string>;
export declare function detectProPack(vendorDir: string, icons: Map<string, string>): ProPack | null;
export declare function proStylesheet(pack: Pick<ProPack, "version" | "styles">): string;
/** Paths are relative to the Vite root (frontend/) unless absolute. */
export declare function iconPacks(options: { vendorDir: string; iconsCss: string }): Plugin;
