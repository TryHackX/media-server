import type { Plugin } from "vite";

/** A logo for voltviz's Your Logo: its file, the preset's id and name, and how it is read. */
export interface VoltVizLogo {
  file: string;
  id: string;
  name: string;
  kind: "svg" | "image";
}
/** The logos in `directory`, in name order. */
export declare function findLogos(directory: string): VoltVizLogo[];
/** Your Logo's logos from `directory` (relative to the Vite root, frontend/, unless absolute). */
export declare function voltvizLogos(options: { directory: string }): Plugin;
