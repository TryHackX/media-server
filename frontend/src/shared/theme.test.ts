import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { DEFAULT_THEME, THEME_COLORS, THEME_STORAGE_KEY, THEMES, isTheme, normalizeTheme, resolveTheme } from "./theme.ts";

/**
 * Three files say what the themes are — this module, the stylesheet and the
 * boot script every page loads before its first paint — and nothing but these
 * tests makes them say the same thing. A theme added to one and not the others
 * would be a page that flashes the wrong colours, or a status bar in the colour
 * of the other theme.
 */

const boot = readFileSync(new URL("../../public/theme-boot.js", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

/** Run theme-boot.js against a page with one <meta name="theme-color"> and the given storage. */
function runBoot(storage: { value?: string | null; throws?: boolean; noMeta?: boolean }): { theme: string | null; color: string | null } {
  const attributes = new Map<string, string>();
  const meta = { content: "#0b0f14", setAttribute(name: string, value: string) { if (name === "content") this.content = value; } };
  const window = {
    localStorage: {
      getItem(key: string): string | null {
        if (storage.throws) throw new Error("SecurityError");
        return key === THEME_STORAGE_KEY ? storage.value ?? null : null;
      }
    }
  };
  const document = {
    documentElement: { setAttribute(name: string, value: string) { attributes.set(name, value); } },
    querySelector(selector: string) { return !storage.noMeta && selector === 'meta[name="theme-color"]' ? meta : null; }
  };
  vm.runInNewContext(boot, { window, document });
  return { theme: attributes.get("data-theme") ?? null, color: storage.noMeta ? null : meta.content };
}

/** The declarations of one block of tokens.css, by the text its selector ends with. */
function block(selectorEnd: string): string {
  const start = tokens.indexOf(`${selectorEnd} {`);
  assert.notEqual(start, -1, `tokens.css has no block for ${selectorEnd}`);
  const open = tokens.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index] === "{") depth += 1;
    else if (tokens[index] === "}" && --depth === 0) return tokens.slice(open + 1, index);
  }
  throw new Error(`unclosed block ${selectorEnd}`);
}

test("only the known themes are themes, and anything else is the default", () => {
  assert.deepEqual([...THEMES], ["emerald", "blue"]);
  assert.equal(DEFAULT_THEME, "emerald");
  for (const theme of THEMES) {
    assert.equal(isTheme(theme), true);
    assert.equal(normalizeTheme(theme), theme);
  }
  for (const junk of ["", "Blue", "pink", "emerald ", null, undefined, 7, {}, ["blue"], "constructor", "__proto__"]) {
    assert.equal(isTheme(junk), false, `${String(junk)} is not a theme`);
    assert.equal(normalizeTheme(junk), "emerald");
  }
});

test("the boot script puts the stored theme on the page before anything is drawn", () => {
  for (const theme of THEMES) {
    assert.deepEqual(runBoot({ value: theme }), { theme, color: THEME_COLORS[theme] });
  }
});

test("the boot script falls back to the default for anything it does not know", () => {
  const fallback = { theme: DEFAULT_THEME, color: THEME_COLORS[DEFAULT_THEME] };
  assert.deepEqual(runBoot({ value: null }), fallback);
  for (const junk of ["", "pink", "BLUE", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.deepEqual(runBoot({ value: junk }), fallback, `stored "${junk}"`);
  }
});

test("the boot script never throws: storage switched off, a page without the meta", () => {
  assert.deepEqual(runBoot({ throws: true }), { theme: DEFAULT_THEME, color: THEME_COLORS[DEFAULT_THEME] });
  assert.deepEqual(runBoot({ value: "blue", noMeta: true }), { theme: "blue", color: null });
  // No document at all (never the case in a browser): still no exception out of the file.
  assert.doesNotThrow(() => vm.runInNewContext(boot, { window: {}, document: {} }));
});

test("the boot script knows exactly the themes this module does, with the same colours", () => {
  const table = boot.match(/var colors = (\{[^}]+\});/);
  assert.ok(table, "theme-boot.js keeps its themes in `var colors = {…};`");
  const colors = vm.runInNewContext(`(${table[1]})`) as Record<string, string>;
  assert.deepEqual({ ...colors }, { ...THEME_COLORS });
});

test("the theme colour of each theme is that theme's canvas in the stylesheet", () => {
  const canvas = (css: string): string | undefined => css.match(/--color-canvas:\s*(#[0-9a-f]{6})\s*;/i)?.[1].toLowerCase();
  assert.equal(canvas(block('[data-theme="emerald"]')), THEME_COLORS.emerald);
  for (const theme of THEMES) {
    if (theme === DEFAULT_THEME) continue;
    assert.equal(canvas(block(`[data-theme="${theme}"]`)), THEME_COLORS[theme], `--color-canvas of ${theme}`);
  }
});

test("without a theme on the account, the browser's last choice is shown", () => {
  assert.deepEqual(resolveTheme({ account: undefined, stored: "blue", unsaved: false }), { theme: "blue", pushToAccount: false });
  assert.deepEqual(resolveTheme({ account: undefined, stored: "blue", unsaved: true }), { theme: "blue", pushToAccount: false });
  assert.deepEqual(resolveTheme({ account: null, stored: null, unsaved: false }), { theme: "emerald", pushToAccount: false });
  assert.deepEqual(resolveTheme({ account: "pink", stored: "junk", unsaved: true }), { theme: "emerald", pushToAccount: false });
});

test("the account's theme wins on every device", () => {
  assert.deepEqual(resolveTheme({ account: "blue", stored: "emerald", unsaved: false }), { theme: "blue", pushToAccount: false });
  assert.deepEqual(resolveTheme({ account: "emerald", stored: "blue", unsaved: false }), { theme: "emerald", pushToAccount: false });
  assert.deepEqual(resolveTheme({ account: "blue", stored: null, unsaved: false }), { theme: "blue", pushToAccount: false });
});

test("a choice made while the account could not keep it is handed over once", () => {
  assert.deepEqual(resolveTheme({ account: "emerald", stored: "blue", unsaved: true }), { theme: "blue", pushToAccount: true });
  // Nothing to hand over when they already agree, or when the mark is there without a choice.
  assert.deepEqual(resolveTheme({ account: "blue", stored: "blue", unsaved: true }), { theme: "blue", pushToAccount: false });
  assert.deepEqual(resolveTheme({ account: "blue", stored: null, unsaved: true }), { theme: "blue", pushToAccount: false });
});
