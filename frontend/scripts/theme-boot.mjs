/**
 * The tag that loads `public/theme-boot.js` — the few lines that put the theme
 * of the last visit on `<html>` before the first paint (the file says why it
 * exists).
 *
 * Every page marks the place with `<!--theme-boot-->` in its `<head>`, after the
 * `theme-color` meta the script rewrites and before the stylesheet the build
 * adds. This writes the real tag there, with a hash of the file in the address.
 *
 * The hash is the point of doing it in the build. The server sends every `.js`
 * as immutable for a year — right for the built chunks, whose names change with
 * their contents, and wrong for a file whose name never does: a browser that
 * had fetched `theme-boot.js` once would keep that copy whatever a later release
 * put in it. With the hash in the query the address changes when the file does,
 * and the year-long cache becomes exactly what is wanted.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const THEME_BOOT_MARK = "<!--theme-boot-->";

/** The tag for a given base path and file contents. */
export function themeBootTag(base, source) {
  const version = createHash("sha256").update(source).digest("hex").slice(0, 10);
  return `<script src="${base}theme-boot.js?v=${version}"></script>`;
}

export function themeBoot({ file = "public/theme-boot.js", base = "/" } = {}) {
  let root = process.cwd();
  return {
    name: "tryhackx-theme-boot",
    configResolved(config) {
      root = config.root;
    },
    transformIndexHtml(html) {
      if (!html.includes(THEME_BOOT_MARK)) return html;
      const source = readFileSync(isAbsolute(file) ? file : join(root, file));
      return html.replaceAll(THEME_BOOT_MARK, themeBootTag(base, source));
    }
  };
}
