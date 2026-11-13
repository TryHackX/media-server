import type { Plugin } from "vite";

export const THEME_BOOT_MARK: string;
export function themeBootTag(base: string, source: string | Uint8Array): string;
export function themeBoot(options?: { file?: string; base?: string }): Plugin;
