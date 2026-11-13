/**
 * Font Awesome Pro, for an owner who has a licence for it.
 *
 * The interface draws Font Awesome Free (solid) and always will; that is what a
 * fresh clone builds with, and what every visitor sees unless the administrator
 * picks something else. An owner with a Pro licence can put the package — the
 * "web" download, unchanged — in `frontend/vendor/fontawesome-pro/`, and the
 * administration panel then offers its styles (light, thin, duotone, sharp…).
 *
 * The package never enters the repository: its licence allows use on the
 * owner's own server, not redistribution, and the repository is public. The
 * folder is in .gitignore, and nothing here copies Pro files anywhere but the
 * build output, which is ignored as well.
 *
 * What the build takes from the package is deliberately small. Not the 155 kB
 * `fontawesome.css` with every icon in it — the interface already has its own
 * list (src/styles/icons.css), and the code points are the same in Free and Pro.
 * Only the font files of the styles on offer, and a generated stylesheet that
 * declares them and maps each style to two variables the glyph rule reads. A
 * style is on offer only when it has every icon the interface draws, checked
 * against the package's own metadata: a style missing one would show an empty
 * square somewhere, and nobody would know why.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * The styles the panel can offer — the four families that carry the whole Pro
 * set, in each of their four weights. (Font Awesome 7 has newer families too —
 * chisel, jelly, slab and others — but each of them lacks a third of the icons
 * this interface uses, so none of them could be offered whole.)
 *
 * The ids are a contract: integrations/php/CatalogActions.php accepts exactly
 * these, and src/shared/icon-styles.ts lists them for the panel.
 */
export const ICON_STYLES = [
  ["classic", "Font Awesome 7 Pro", [["solid", 900, "fa-solid-900"], ["regular", 400, "fa-regular-400"], ["light", 300, "fa-light-300"], ["thin", 100, "fa-thin-100"]]],
  ["duotone", "Font Awesome 7 Duotone", [["solid", 900, "fa-duotone-900"], ["regular", 400, "fa-duotone-regular-400"], ["light", 300, "fa-duotone-light-300"], ["thin", 100, "fa-duotone-thin-100"]]],
  ["sharp", "Font Awesome 7 Sharp", [["solid", 900, "fa-sharp-solid-900"], ["regular", 400, "fa-sharp-regular-400"], ["light", 300, "fa-sharp-light-300"], ["thin", 100, "fa-sharp-thin-100"]]],
  ["sharp-duotone", "Font Awesome 7 Sharp Duotone", [["solid", 900, "fa-sharp-duotone-solid-900"], ["regular", 400, "fa-sharp-duotone-regular-400"], ["light", 300, "fa-sharp-duotone-light-300"], ["thin", 100, "fa-sharp-duotone-thin-100"]]]
].flatMap(([family, font, weights]) => weights.map(([weight, value, file]) => ({
  id: `${family}-${weight}`,
  family,
  weight,
  font,
  value,
  file: `${file}.woff2`,
  duotone: family.endsWith("duotone")
})));

const VIRTUAL_ID = "virtual:icon-packs";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** `.fa-play { --fa: "\f04b"; }` → Map { "play" → "f04b" }, from the interface's own list. */
export function usedIcons(iconsCss) {
  const found = new Map();
  const plain = iconsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of plain.matchAll(/\.fa-([a-z0-9-]+)\s*\{\s*--fa:\s*"\\([0-9a-f]+)"/g)) {
    found.set(match[1], match[2]);
  }
  return found;
}

/**
 * What an installed Pro package can offer this interface, or null without one.
 *
 * `missing` explains every style left out, so a build log can say why the panel
 * shows fewer styles than the package has.
 */
export function detectProPack(vendorDir, icons) {
  const manifestPath = join(vendorDir, "manifest.json");
  const metadataDir = join(vendorDir, "metadata");
  if (!existsSync(manifestPath) || !existsSync(metadataDir)) return null;
  const version = String(JSON.parse(readFileSync(manifestPath, "utf8")).version ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const metadataFile = readdirSync(metadataDir).find((name) => /^icons(-search)?(-v[\d.]+)?\.json$/.test(name));
  if (!metadataFile) return null;
  const metadata = JSON.parse(readFileSync(join(metadataDir, metadataFile), "utf8"));
  const styles = [];
  const missing = [];
  for (const style of ICON_STYLES) {
    if (!existsSync(join(vendorDir, "webfonts", style.file))) {
      missing.push(`${style.id}: no webfonts/${style.file}`);
      continue;
    }
    const absent = [...icons].filter(([name, codePoint]) => {
      const entry = metadata[name];
      return !entry || String(entry.unicode).toLowerCase() !== codePoint
        || !(entry.families?.[style.family] ?? []).includes(style.weight);
    }).map(([name]) => name);
    if (absent.length > 0) missing.push(`${style.id}: ${absent.join(", ")}`);
    else styles.push(style);
  }
  return styles.length > 0 ? { version, styles, missing } : null;
}

/** The generated stylesheet: one @font-face per font file, one rule per style. */
export function proStylesheet(pack) {
  const fonts = new Map();
  for (const style of pack.styles) fonts.set(style.file, style);
  // A filled mark (an active favourite) asks its family for weight 900, so each
  // family's solid font is declared whenever any of its weights is offered.
  for (const style of ICON_STYLES) {
    if (style.weight === "solid" && pack.styles.some((offered) => offered.family === style.family)) fonts.set(style.file, style);
  }
  const faces = [...fonts.values()].map((style) =>
    `@font-face{font-family:"${style.font}";font-style:normal;font-weight:${style.value};font-display:block;src:url(webfonts/${style.file}) format("woff2")}`);
  const rules = pack.styles.map((style) =>
    `[data-icon-style="${style.id}"]{--icon-family:"${style.font}";--icon-weight:${style.value};--icon-duotone:${style.duotone ? "block" : "none"}}`);
  return [
    "/*!",
    ` * Font Awesome Pro ${pack.version} by @fontawesome - https://fontawesome.com`,
    " * License - https://fontawesome.com/license (Commercial License)",
    " * Copyright Fonticons, Inc. Used under the server owner's licence; not for redistribution.",
    " * Generated by frontend/scripts/icon-packs.mjs from frontend/vendor/fontawesome-pro.",
    " */",
    ...faces,
    ...rules,
    ""
  ].join("\n");
}

/**
 * The Vite side: a virtual module the interface imports to learn what exists,
 * and — when a package is installed — the stylesheet and fonts in the output.
 */
export function iconPacks(options) {
  let vendorDir = "";
  let base = "/";
  let pack = null;
  let directory = "";
  let stylesheet = "";
  let fileName = "";
  const files = new Set();
  return {
    name: "tryhackx-icon-packs",
    configResolved(config) {
      const resolve = (path) => (isAbsolute(path) ? path : join(config.root, path));
      vendorDir = resolve(options.vendorDir);
      base = config.base;
      pack = existsSync(vendorDir) ? detectProPack(vendorDir, usedIcons(readFileSync(resolve(options.iconsCss), "utf8"))) : null;
      if (!pack) return;
      directory = `${config.build.assetsDir}/iconpacks/fontawesome-pro-${pack.version}`;
      stylesheet = proStylesheet(pack);
      fileName = `pro-${createHash("sha256").update(stylesheet).digest("hex").slice(0, 10)}.css`;
      for (const line of stylesheet.matchAll(/url\(webfonts\/([^)]+)\)/g)) files.add(line[1]);
      config.logger.info(`Font Awesome Pro ${pack.version}: ${pack.styles.length} styles on offer`
        + (pack.missing.length ? ` (left out — ${pack.missing.join("; ")})` : ""));
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const pro = pack
        ? { version: pack.version, href: `${base}${directory}/${fileName}`, styles: pack.styles.map((style) => style.id) }
        : null;
      return `export default ${JSON.stringify({ pro })};`;
    },
    generateBundle() {
      if (!pack) return;
      this.emitFile({ type: "asset", fileName: `${directory}/${fileName}`, source: stylesheet });
      for (const file of files) {
        this.emitFile({ type: "asset", fileName: `${directory}/webfonts/${file}`, source: readFileSync(join(vendorDir, "webfonts", file)) });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!pack) return next();
        const path = (request.url ?? "").split("?")[0];
        const prefix = `${base}${directory}/`;
        if (!path.startsWith(prefix)) return next();
        const rest = path.slice(prefix.length);
        if (rest === fileName) {
          response.setHeader("Content-Type", "text/css; charset=utf-8");
          return response.end(stylesheet);
        }
        const font = rest.startsWith("webfonts/") ? rest.slice("webfonts/".length) : "";
        if (!files.has(font)) return next();
        response.setHeader("Content-Type", "font/woff2");
        return response.end(readFileSync(join(vendorDir, "webfonts", font)));
      });
    }
  };
}
