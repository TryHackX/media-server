import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ICON_STYLES, detectProPack, proStylesheet, usedIcons } from "./icon-packs.mjs";

const iconsCss = readFileSync(new URL("../src/styles/icons.css", import.meta.url), "utf8");
const vendor = new URL("../vendor/fontawesome-pro/", import.meta.url);
const vendorDir = decodeURIComponent(vendor.pathname).replace(/^\/([A-Za-z]:)/, "$1");

test("the interface's own icon list is what a style is checked against", () => {
  const icons = usedIcons(iconsCss);
  assert.ok(icons.size >= 40);
  assert.equal(icons.get("house"), "f015");
  assert.equal(icons.get("wand-magic-sparkles"), "e2ca");
});

test("no package, no Pro: a fresh clone builds with Free alone", () => {
  const empty = mkdtempSync(join(tmpdir(), "icon-packs-"));
  try {
    assert.equal(detectProPack(empty, usedIcons(iconsCss)), null);
    assert.equal(detectProPack(join(empty, "missing"), usedIcons(iconsCss)), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("sixteen styles, four families in four weights, ids the server knows", () => {
  assert.equal(ICON_STYLES.length, 16);
  assert.equal(new Set(ICON_STYLES.map((style) => style.id)).size, 16);
  assert.ok(ICON_STYLES.filter((style) => style.duotone).every((style) => style.font.includes("Duotone")));
});

test("an installed package offers only styles that have every icon", { skip: !existsSync(vendorDir) && "no Font Awesome Pro in vendor/ (expected on a fresh clone)" }, () => {
  const pack = detectProPack(vendorDir, usedIcons(iconsCss));
  assert.ok(pack, "the package in vendor/ was not recognised");
  assert.match(pack.version, /^\d+\.\d+\.\d+$/);
  const css = proStylesheet(pack);
  for (const style of pack.styles) {
    assert.ok(css.includes(`[data-icon-style="${style.id}"]`), style.id);
  }
  for (const match of css.matchAll(/url\(webfonts\/([^)]+)\)/g)) {
    assert.ok(existsSync(join(vendorDir, "webfonts", match[1])), match[1]);
  }
  // Nothing from the package's own CSS — only the generated declarations.
  assert.ok(!css.includes("--fa:"), "icon code points belong to src/styles/icons.css");
  assert.ok(css.startsWith("/*!"), "the licence banner stays at the top");
});
