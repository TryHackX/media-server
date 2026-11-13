import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ICON_CLASSES } from "./icons.ts";

/**
 * The interface draws its icons from a trimmed stylesheet (styles/icons.css)
 * instead of Font Awesome's full one, which spent 71.6 kB of render-blocking CSS
 * on about two thousand icons to show thirty-eight. The cost of trimming is a
 * list that can fall out of step — an icon added to icons.ts without its line,
 * or a code point that changes in a Font Awesome upgrade. These tests are what
 * keeps that from reaching a screen as an empty square.
 */

const trimmed = readFileSync(new URL("../styles/icons.css", import.meta.url), "utf8");
const library = readFileSync(
  new URL("../../node_modules/@fortawesome/fontawesome-free/css/fontawesome.min.css", import.meta.url),
  "utf8"
);

/** `.fa-play { --fa: "\f04b"; }` and `.fa-a,.fa-b{--fa:"\f1de"}` alike, comments ignored. */
function codePoints(css: string): Map<string, string> {
  const found = new Map<string, string>();
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of plain.matchAll(/([^{}]+)\{\s*--fa:\s*([^;}]+?)\s*;?\s*\}/g)) {
    for (const name of rule[1].matchAll(/\.(fa-[a-z0-9-]+)/g)) found.set(name[1], rule[2].trim());
  }
  return found;
}

const local = codePoints(trimmed);
const installed = codePoints(library);

test("every icon the interface uses has a glyph in the trimmed stylesheet", () => {
  const missing = ICON_CLASSES.filter((name) => !local.has(name));
  assert.deepEqual(missing, [], `add to styles/icons.css: ${missing.map((name) => `.${name}`).join(", ")}`);
});

test("every glyph matches the Font Awesome that is installed", () => {
  for (const name of ICON_CLASSES) {
    assert.ok(installed.has(name), `${name} no longer exists in Font Awesome`);
    assert.equal(local.get(name), installed.get(name), `${name} has a different code point in Font Awesome now`);
  }
});

test("the trimmed stylesheet carries nothing the interface does not draw", () => {
  const unused = [...local.keys()].filter((name) => !ICON_CLASSES.includes(name));
  assert.deepEqual(unused, []);
});
