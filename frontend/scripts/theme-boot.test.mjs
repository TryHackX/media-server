import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { THEME_BOOT_MARK, themeBoot, themeBootTag } from "./theme-boot.mjs";

/*
 * The boot script is served as immutable for a year, like every other .js, and
 * its name never changes. The hash in its address is what makes a new version
 * reach a browser that has the old one — so the hash has to follow the contents,
 * and nothing else.
 */

test("the address of the boot script changes when its contents do, and only then", () => {
  const one = themeBootTag("/", "var a = 1;");
  assert.match(one, /^<script src="\/theme-boot\.js\?v=[0-9a-f]{10}"><\/script>$/);
  assert.equal(themeBootTag("/", "var a = 1;"), one);
  assert.notEqual(themeBootTag("/", "var a = 2;"), one);
});

test("the tag is a plain blocking script under the application's base", () => {
  const tag = themeBootTag("/media-next/", "x");
  assert.ok(tag.startsWith('<script src="/media-next/theme-boot.js?v='));
  assert.doesNotMatch(tag, /\b(async|defer|type=)/);
});

test("the plugin writes the tag where a page marks the place, and leaves other pages alone", () => {
  const directory = mkdtempSync(join(tmpdir(), "theme-boot-"));
  try {
    writeFileSync(join(directory, "boot.js"), "var theme = 1;");
    const plugin = themeBoot({ file: "boot.js", base: "/app/" });
    plugin.configResolved({ root: directory });
    const html = `<head><meta name="theme-color" content="#000">\n    ${THEME_BOOT_MARK}\n</head>`;
    const built = plugin.transformIndexHtml(html);
    assert.ok(!built.includes(THEME_BOOT_MARK));
    assert.ok(built.includes(themeBootTag("/app/", "var theme = 1;")));
    // After the meta the script rewrites, which is why the mark stands where it does.
    assert.ok(built.indexOf("theme-color") < built.indexOf("theme-boot.js"));
    assert.equal(plugin.transformIndexHtml("<head></head>"), "<head></head>");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every page of the application marks the place, after its theme-color meta", async () => {
  const { readFileSync } = await import("node:fs");
  const pages = ["index.html", ...["login", "music", "movies", "collections", "account", "admin", "guest"].map((name) => `${name}/index.html`)];
  for (const page of pages) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const meta = html.indexOf('name="theme-color"');
    const mark = html.indexOf(THEME_BOOT_MARK);
    assert.ok(meta > 0, `${page} has a theme-color meta`);
    assert.ok(mark > meta, `${page} marks the boot script after the meta`);
    assert.ok(mark < html.indexOf("</head>"), `${page} marks it inside <head>`);
  }
});
