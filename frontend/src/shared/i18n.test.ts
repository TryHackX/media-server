import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LANGUAGE, currentLanguage, isLanguage, setLanguage, t } from "./i18n.ts";

test("Polish is the default, and anything unrecognised falls back to it", () => {
  assert.equal(DEFAULT_LANGUAGE, "pl");
  assert.equal(setLanguage("en"), "en");
  assert.equal(setLanguage("de"), "pl");
  assert.equal(setLanguage(undefined), "pl");
  assert.equal(currentLanguage(), "pl");
  assert.equal(isLanguage("pl"), true);
  assert.equal(isLanguage("de"), false);
});

test("Polish returns the source text untouched — it is the key", () => {
  setLanguage("pl");
  assert.equal(t("Kontynuuj oglądanie"), "Kontynuuj oglądanie");
  assert.equal(t("Zdanie, którego nikt nie tłumaczył"), "Zdanie, którego nikt nie tłumaczył");
});

test("English translates what the dictionary knows and keeps the rest in Polish", () => {
  setLanguage("en");
  assert.equal(t("Kontynuuj oglądanie"), "Continue watching");
  // A half-filled dictionary must degrade into "some English", never into a raw key.
  assert.equal(t("Zdanie, którego nikt nie tłumaczył"), "Zdanie, którego nikt nie tłumaczył");
  setLanguage("pl");
});

test("placeholders are filled in both languages", () => {
  setLanguage("pl");
  assert.equal(t("{hours} g {minutes} min", { hours: 1, minutes: 12 }), "1 g 12 min");
  setLanguage("en");
  assert.equal(t("{hours} g {minutes} min", { hours: 1, minutes: 12 }), "1 h 12 min");
  assert.equal(
    t("{percent}% · pozostało {remaining}", { percent: 42, remaining: "19 min" }),
    "42% · 19 min left"
  );
  setLanguage("pl");
});

test("a placeholder with no value stays visible instead of becoming undefined", () => {
  // A visible {remaining} is a bug report; "undefined" in the interface is not.
  assert.equal(t("{percent}% · pozostało {remaining}", { percent: 42 }), "42% · pozostało {remaining}");
});

test("text without values is returned as-is even when it contains braces", () => {
  assert.equal(t("{hours} g"), "{hours} g");
});
