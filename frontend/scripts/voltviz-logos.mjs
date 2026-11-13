/**
 * The owner's logos for voltviz's Your Logo, from a git-ignored folder.
 *
 * voltviz's Your Logo draws a logo somebody uploads; the player has no upload, so the build takes
 * the logos from `frontend/vendor/voltviz-logos/` (git-ignored: a logo is the owner's, not part of
 * this repository) and VoltViz offers Your Logo once per logo. Each file is served as it is, from
 * the build's assets, and read only when its preset is shown: an SVG goes to Your Logo's own SVG
 * reader, a picture (PNG, WebP, JPEG, GIF) is traced into outlines in the browser
 * (src/shared/visualizations/voltviz/logo.ts). Without the folder, or with nothing in it that is a
 * logo, the build is as it was and Your Logo is not offered.
 *
 * Preset names come from the file names: `logo-2013.png` is "Logo 2013".
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const VIRTUAL_ID = "virtual:voltviz-logos";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const KINDS = { ".svg": "svg", ".png": "image", ".webp": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image" };
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The logos in `directory`: id, name and kind by file name, in name order. */
export function findLogos(directory) {
  if (!existsSync(directory)) return [];
  const seen = new Set();
  return readdirSync(directory)
    .filter((file) => {
      const dot = file.lastIndexOf(".");
      return dot > 0 && KINDS[file.slice(dot).toLowerCase()] && statSync(join(directory, file)).isFile();
    })
    .sort(collator.compare)
    .map((file) => {
      const dot = file.lastIndexOf(".");
      const stem = file.slice(0, dot);
      const words = stem.replace(/[-_.\s]+/g, " ").trim() || stem;
      const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "logo";
      let id = `yourlogo-${slug}`;
      for (let n = 2; seen.has(id); n += 1) id = `yourlogo-${slug}-${n}`;
      seen.add(id);
      return { file, id, name: words.charAt(0).toUpperCase() + words.slice(1), kind: KINDS[file.slice(dot).toLowerCase()] };
    });
}

/** `directory` is relative to the Vite root (frontend/) unless absolute. */
export function voltvizLogos(options) {
  let directory = "";
  let found = [];
  return {
    name: "tryhackx-voltviz-logos",
    configResolved(config) {
      directory = isAbsolute(options.directory) ? options.directory : join(config.root, options.directory);
      found = findLogos(directory);
      if (found.length) config.logger.info(`VoltViz: Your Logo with ${found.length} logo(s) from ${options.directory}`);
    },
    resolveId(source) {
      return source === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      // Served as files, never inlined: the page's policy reads no data: URLs with fetch().
      const imports = found.map((logo, index) =>
        `import logo${index} from ${JSON.stringify(`${join(directory, logo.file).replace(/\\/g, "/")}?url&no-inline`)};`);
      const entries = found.map((logo, index) =>
        `{ id: ${JSON.stringify(logo.id)}, name: ${JSON.stringify(logo.name)}, kind: ${JSON.stringify(logo.kind)}, url: logo${index} }`);
      return `${imports.join("\n")}\nexport default [${entries.join(", ")}];\n`;
    }
  };
}
