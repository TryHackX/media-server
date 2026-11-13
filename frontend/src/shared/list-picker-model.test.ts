import assert from "node:assert/strict";
import test from "node:test";

import {
  countOptions, filterRows, foldText, governingHeading, indexOfValue, isMoveKey, moveActive, optionOrdinals, queryWords,
  revealScrollTop, visibleRange, type PickerRow
} from "./list-picker-model.ts";

const option = (value: string, label = value, grouped = false, aside = false): PickerRow => ({ kind: "option", value, label, grouped, aside });
const heading = (label: string): PickerRow => ({ kind: "heading", label });
const labels = (rows: readonly PickerRow[]): string[] => rows.map((row) => (row.kind === "heading" ? `# ${row.label}` : row.label));

/** The preset list's shape: Auto on top, favourites under a heading, then the groups of a pack. */
const LIST: PickerRow[] = [
  option("auto", "Auto — płynne przejścia", false, true),
  heading("★ Ulubione"),
  option("a:flexi", "Flexi — Mindblob", true, true),
  heading("Cream of the Crop · Dancer"),
  option("c:1", "Martin — Łódź nocą", true),
  option("c:2", "Geiss — Feedback Ćwiczenie", true),
  option("a:flexi", "Flexi — Mindblob", true),
  heading("Cream of the Crop · Fractal"),
  option("f:1", "Żółw w ŚWIETLE", true),
  option("f:2", "Rovastar — Fractopia", true),
  option("loose", "Bez grupy: Straße")
];

test("folding: lower case, no diacritics, Polish ł and other letters NFD keeps whole", () => {
  assert.equal(foldText("Łódź Ćma ŻÓŁW źdźbło"), "lodz cma zolw zdzblo");
  assert.equal(foldText("Straße Ærø Œuvre ðþ"), "strasse aero oeuvre dth");
  assert.equal(foldText("Café — NAÏVE"), "cafe — naive");
  assert.deepEqual(queryWords("  ŁÓDŹ   noca "), ["lodz", "noca"]);
  assert.deepEqual(queryWords("   "), []);
});

test("an empty query leaves the list itself, counted without the shortcuts", () => {
  const result = filterRows(LIST, "  ");
  assert.equal(result.rows, LIST);
  // Auto and the favourite listed again on top are not items of the list.
  assert.equal(result.matches, 6);
  assert.equal(result.total, 6);
  assert.equal(countOptions(LIST), 6);
});

test("search: case and diacritics do not matter, either way round", () => {
  assert.deepEqual(labels(filterRows(LIST, "lodz").rows), ["# Cream of the Crop · Dancer", "Martin — Łódź nocą"]);
  assert.deepEqual(labels(filterRows(LIST, "ŁÓDŹ").rows), ["# Cream of the Crop · Dancer", "Martin — Łódź nocą"]);
  assert.deepEqual(labels(filterRows(LIST, "zolw swietle").rows), ["# Cream of the Crop · Fractal", "Żółw w ŚWIETLE"]);
  assert.deepEqual(labels(filterRows(LIST, "ćwicz").rows), ["# Cream of the Crop · Dancer", "Geiss — Feedback Ćwiczenie"]);
});

test("search: headings stay above their matches only, each once, and the count is of options", () => {
  const result = filterRows(LIST, "flexi");
  assert.deepEqual(labels(result.rows), ["# ★ Ulubione", "Flexi — Mindblob", "# Cream of the Crop · Dancer", "Flexi — Mindblob"]);
  // One preset, listed twice: counted once.
  assert.equal(result.matches, 1);
  assert.equal(result.total, 6);
  const none = filterRows(LIST, "nothing like this");
  assert.deepEqual(none.rows, []);
  assert.equal(none.matches, 0);
});

test("search: every word has to be found, in the label or in the group's heading", () => {
  // "fractal" is only in the heading: the whole group.
  assert.deepEqual(labels(filterRows(LIST, "fractal").rows), ["# Cream of the Crop · Fractal", "Żółw w ŚWIETLE", "Rovastar — Fractopia"]);
  // One word from the heading, one from the label.
  assert.deepEqual(labels(filterRows(LIST, "dancer geiss").rows), ["# Cream of the Crop · Dancer", "Geiss — Feedback Ćwiczenie"]);
  assert.deepEqual(filterRows(LIST, "dancer rovastar").rows, []);
  // A heading on its own is never listed.
  assert.deepEqual(filterRows(LIST, "ulubione zzz").rows, []);
});

test("search: an option outside any group is not taken for a member of the group above it", () => {
  // "Bez grupy" follows the Fractal group but does not belong to it.
  assert.deepEqual(labels(filterRows(LIST, "strasse").rows), ["Bez grupy: Straße"]);
  assert.deepEqual(labels(filterRows(LIST, "fractal strasse").rows), []);
  // A shortcut is found like any option, and counted as none.
  const auto = filterRows(LIST, "auto");
  assert.deepEqual(labels(auto.rows), ["Auto — płynne przejścia"]);
  assert.equal(auto.matches, 0);
});

test("search: the fold given is the one used (the picker's cache)", () => {
  let calls = 0;
  const fold = (row: PickerRow): string => {
    calls += 1;
    return foldText(row.label);
  };
  filterRows(LIST, "x", fold);
  assert.equal(calls, LIST.length);
});

test("ordinals count options only; the governing heading of a row", () => {
  assert.deepEqual([...optionOrdinals(LIST)], [1, 0, 2, 0, 3, 4, 5, 0, 6, 7, 8]);
  assert.equal(governingHeading(LIST, 0), -1);
  assert.equal(governingHeading(LIST, 1), 1);
  assert.equal(governingHeading(LIST, 2), 1);
  assert.equal(governingHeading(LIST, 6), 3);
  assert.equal(governingHeading(LIST, 9), 7);
  assert.equal(governingHeading(LIST, 10), -1);
  assert.equal(governingHeading(LIST, 99), -1);
  assert.equal(governingHeading([], 0), -1);
});

test("window: the rows in view and the overscan, clamped to the list", () => {
  // 36 px rows, 360 px of list: rows 0–9 in view, 6 more below.
  assert.deepEqual(visibleRange(0, 360, 36, 16900, 6), { start: 0, end: 16 });
  // Scrolled into the middle: a row half out at the top still counts.
  assert.deepEqual(visibleRange(36 * 1000 + 18, 360, 36, 16900, 6), { start: 994, end: 1017 });
  // The end of the list.
  assert.deepEqual(visibleRange(36 * 16890, 360, 36, 16900, 6), { start: 16884, end: 16900 });
  // Overscrolled (rubber band) and empty lists.
  assert.deepEqual(visibleRange(-50, 360, 36, 5, 6), { start: 0, end: 5 });
  assert.deepEqual(visibleRange(0, 360, 36, 0), { start: 0, end: 0 });
  assert.deepEqual(visibleRange(0, 360, 0, 10), { start: 0, end: 0 });
  // A list taller than its rows draws them all, never more.
  assert.deepEqual(visibleRange(0, 900, 44, 3, 8), { start: 0, end: 3 });
});

test("reveal: scroll only as far as needed, or centre; never past either end", () => {
  const base = { rowHeight: 36, viewport: 360, count: 1000 };
  // Already in view: no move.
  assert.equal(revealScrollTop({ ...base, index: 5, scrollTop: 0 }), 0);
  // Below: its bottom edge to the bottom of the list.
  assert.equal(revealScrollTop({ ...base, index: 20, scrollTop: 0 }), 21 * 36 - 360);
  // Above: to the top, under the pinned heading when there is one.
  assert.equal(revealScrollTop({ ...base, index: 10, scrollTop: 1000 }), 360);
  assert.equal(revealScrollTop({ ...base, index: 10, scrollTop: 1000, reserved: 36 }), 324);
  assert.equal(revealScrollTop({ ...base, index: 10, scrollTop: 360, reserved: 36 }), 324);
  // Centred, and clamped at both ends.
  assert.equal(revealScrollTop({ ...base, index: 500, scrollTop: 0, mode: "center" }), 500 * 36 - 162);
  assert.equal(revealScrollTop({ ...base, index: 1, scrollTop: 400, mode: "center" }), 0);
  assert.equal(revealScrollTop({ ...base, index: 999, scrollTop: 0, mode: "center" }), 1000 * 36 - 360);
  assert.equal(revealScrollTop({ ...base, index: -1, scrollTop: 99999 }), 1000 * 36 - 360);
  // A short list does not scroll at all.
  assert.equal(revealScrollTop({ ...base, count: 4, index: 3, scrollTop: 0, mode: "center" }), 0);
});

test("keys: arrows step over headings and stop at the ends", () => {
  assert.equal(moveActive(LIST, 0, "ArrowDown", 10), 2);
  assert.equal(moveActive(LIST, 2, "ArrowDown", 10), 4);
  assert.equal(moveActive(LIST, 6, "ArrowDown", 10), 8);
  assert.equal(moveActive(LIST, 10, "ArrowDown", 10), 10);
  assert.equal(moveActive(LIST, 4, "ArrowUp", 10), 2);
  assert.equal(moveActive(LIST, 2, "ArrowUp", 10), 0);
  assert.equal(moveActive(LIST, 0, "ArrowUp", 10), 0);
  // Nothing highlighted (or a heading): ↓ the first option, ↑ the last.
  assert.equal(moveActive(LIST, -1, "ArrowDown", 10), 0);
  assert.equal(moveActive(LIST, -1, "ArrowUp", 10), 10);
  assert.equal(moveActive(LIST, 3, "ArrowDown", 10), 0);
});

test("keys: Home, End, and pages that land on an option", () => {
  const list: PickerRow[] = [heading("A"), option("1", "1", true), option("2", "2", true), heading("B"), option("3", "3", true), option("4", "4", true), heading("C"), option("5", "5", true)];
  assert.equal(moveActive(list, 4, "Home", 3), 1);
  assert.equal(moveActive(list, 1, "End", 3), 7);
  // From 1 a page of 3 reaches row 4, an option.
  assert.equal(moveActive(list, 1, "PageDown", 3), 4);
  // From 1 a page of 2 reaches the heading at 3: the next option after it.
  assert.equal(moveActive(list, 1, "PageDown", 2), 4);
  // Past the end: the last option.
  assert.equal(moveActive(list, 5, "PageDown", 10), 7);
  // Back from 7 by 4 reaches the heading at 3: the option before it.
  assert.equal(moveActive(list, 7, "PageUp", 4), 2);
  assert.equal(moveActive(list, 4, "PageUp", 10), 1);
  // A page of less than one row still moves one.
  assert.equal(moveActive(list, 1, "PageDown", 0.4), 2);
  assert.equal(moveActive([heading("only")], 0, "ArrowDown", 3), -1);
  assert.equal(moveActive([], -1, "End", 3), -1);
});

test("keys the list answers to, and the first row of a value", () => {
  for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]) assert.equal(isMoveKey(key), true, key);
  for (const key of ["Enter", "Escape", "a", "Tab", " "]) assert.equal(isMoveKey(key), false, key);
  // A favourite is listed twice; the first is the one a native select chose too.
  assert.equal(indexOfValue(LIST, "a:flexi"), 2);
  assert.equal(indexOfValue(LIST, "f:2"), 9);
  assert.equal(indexOfValue(LIST, "missing"), -1);
});

test("the search across visualizers: a note is passed over by the keys and heads nothing; an action row is reached", () => {
  // The list's own match, then another visualizer's under its name, a row for the rest, the note.
  const rows: PickerRow[] = [
    option("own", "Own"),
    { kind: "heading", label: "MilkDrop", section: true },
    { kind: "option", value: "\u0000milkdrop\u0000a", label: "A", grouped: true, detail: "Cream of the Crop · Dancer" },
    { kind: "option", value: "\u0001milkdrop", label: "Pokaż jeszcze 12", grouped: true, action: true },
    { kind: "note", label: "Szukanie w innych wizualizacjach…" }
  ];
  assert.equal(moveActive(rows, 0, "ArrowDown", 1), 2);
  assert.equal(moveActive(rows, 2, "ArrowDown", 1), 3);
  // The note is not an option: the last option stays the last one reached.
  assert.equal(moveActive(rows, 3, "ArrowDown", 1), 3);
  assert.equal(moveActive(rows, -1, "End", 1), 3);
  assert.equal(moveActive(rows, 3, "PageDown", 5), 3);
  assert.equal(governingHeading(rows, 3), 1);
  assert.equal(governingHeading(rows, 4), -1);
  assert.deepEqual([...optionOrdinals(rows)], [1, 0, 2, 3, 0]);
  // A note in a list searched is never a match, and never holds a heading up.
  assert.deepEqual(labels(filterRows(rows, "szukanie").rows), []);
  assert.equal(countOptions(rows), 3);
});
