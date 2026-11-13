import assert from "node:assert/strict";
import test from "node:test";

import { english } from "./i18n-en.ts";
import { DEFAULT_LANGUAGE, currentLanguage, isLanguage, provideDictionary, setLanguage, t, tn } from "./i18n.ts";

test("English is not there until it is handed over — and reads as Polish meanwhile", () => {
  setLanguage("en");
  assert.equal(t("Kontynuuj oglądanie"), "Kontynuuj oglądanie");
  provideDictionary("en", english);
  assert.equal(t("Kontynuuj oglądanie"), "Continue watching");
  setLanguage("pl");
});

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

const FILES = { one: "{count} plik", few: "{count} pliki", many: "{count} plików" };

test("tn picks the Polish form the way Polish counts, teens included", () => {
  setLanguage("pl");
  const form = (count: number): string => tn(count, FILES);
  assert.equal(form(1), "1 plik");
  for (const count of [2, 3, 4, 22, 23, 24, 102]) assert.equal(form(count), `${count} pliki`, String(count));
  // 12–14 end in 2–4 but take the genitive, and 21 ends in 1 but is not singular.
  for (const count of [0, 5, 11, 12, 13, 14, 21, 25, 111]) assert.equal(form(count), `${count} plików`, String(count));
});

test("tn in English uses only the singular and the plural, never the Polish few form", () => {
  setLanguage("en");
  assert.equal(tn(1, FILES), "1 file");
  assert.equal(tn(2, FILES), "2 files");
  assert.equal(tn(0, FILES), "0 files");
  assert.equal(tn(22, FILES), "22 files");
  setLanguage("pl");
});

test("tn groups the number the way the interface language does", () => {
  setLanguage("pl");
  // Polish groups thousands with a no-break space, never a comma — and the form
  // follows the last digits however large the number: "12 982 pliki", not
  // "plików", which is what the library header used to say.
  assert.match(tn(12982, FILES), /^12\s982 pliki$/u);
  assert.match(tn(12985, FILES), /^12\s985 plików$/u);
  setLanguage("en");
  assert.equal(tn(12982, FILES), "12,982 files");
  setLanguage("pl");
});

test("tn keeps other placeholders and lets the caller override the count", () => {
  setLanguage("pl");
  const forms = { one: "{count} plik · {size}", few: "{count} pliki · {size}", many: "{count} plików · {size}" };
  assert.equal(tn(3, forms, { size: "1 GB" }), "3 pliki · 1 GB");
  assert.equal(tn(1, FILES, { count: "jeden" }), "jeden plik");
});
