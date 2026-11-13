import assert from "node:assert/strict";
import test from "node:test";

import { filterRows, foldText, queryWords, type PickerRow } from "../list-picker-model.ts";
import {
  catalogFromGroups, concurrencyLimit, FOREIGN_LIMIT, FOREIGN_SLACK, foundRows, foundValue, listedCount, matchCatalog, moreValue,
  parseFoundValue, parseMoreValue, prepareCatalog, storedIds, type FoundSource
} from "./preset-search.ts";
import { GROUPS, PRESETS, soundformsPresetGroups } from "./soundforms/catalog.ts";

const LABELS = { more: (count: number) => `+${count}`, loading: "Szukanie…" };

/** A catalog shaped as MilkDrop's "every pack" list: plain names, and packs' presets under "pack · category". */
const MILKDROP = prepareCatalog("milkdrop", [
  { id: "Geiss - Feedback", label: "Geiss - Feedback", group: "Wbudowane (butterchurn)" },
  { id: "Flexi - Łódź nocą", label: "Flexi - Łódź nocą", group: "Wbudowane (butterchurn)" },
  { id: "cream:Dancer/a", label: "Martin - Bloom", group: "Cream of the Crop · Dancer" },
  { id: "cream:Dancer/b", label: "Rovastar - Dancer in the dark", group: "Cream of the Crop · Dancer" },
  { id: "cream:Fractal/c", label: "Geiss - Dancer", group: "Cream of the Crop · Fractal" }
], foldText);

const labels = (rows: readonly PickerRow[]): string[] => rows.map((row) => (row.kind === "heading" ? `# ${row.label}` : row.kind === "note" ? `~ ${row.label}` : row.label));

test("a found preset's value names its visualizer and preset, and is never a preset id itself", () => {
  const value = foundValue("internal", "kaleidoscope");
  assert.notEqual(value, foundValue("voltviz", "kaleidoscope"));
  assert.notEqual(value, "kaleidoscope");
  assert.deepEqual(parseFoundValue(value), { visualizer: "internal", preset: "kaleidoscope" });
  // A preset id may hold anything, the separator's neighbours included.
  assert.deepEqual(parseFoundValue(foundValue("avs", "Name — Pack / 01: x")), { visualizer: "avs", preset: "Name — Pack / 01: x" });
  for (const own of ["auto", "auto:favorites", "map-01", "cream:Dancer/a", ""]) assert.equal(parseFoundValue(own), null);
  assert.equal(parseMoreValue(moreValue("milkdrop")), "milkdrop");
  assert.equal(parseMoreValue(value), null);
  assert.equal(parseFoundValue(moreValue("milkdrop")), null);
});

test("a visualizer's list becomes its catalog, each preset with the heading over it", () => {
  assert.deepEqual(catalogFromGroups([
    { label: "", presets: [{ id: "map-01", label: "1. Spirala" }] },
    { label: "Twoje presety (GEISS.INI)", presets: [{ id: "preset-07", label: "Preset 07: 3. Lądowanie" }] }
  ]), [
    { id: "map-01", label: "1. Spirala" },
    { id: "preset-07", label: "Preset 07: 3. Lądowanie", group: "Twoje presety (GEISS.INI)" }
  ]);
});

test("Formy dźwięku's list, as the visualizer and the search both take it, lists every preset once under its heading", () => {
  const groups = soundformsPresetGroups(() => true, (text) => `«${text}»`);
  assert.deepEqual(groups.map((group) => group.label), GROUPS.filter((group) => PRESETS.some((preset) => preset.group === group.id)).map((group) => `«${group.name}»`));
  const listed = groups.flatMap((group) => group.presets.map((preset) => preset.id));
  assert.deepEqual([...listed].sort(), PRESETS.map((preset) => preset.id).sort());
  assert.ok(groups.every((group) => group.presets.every((preset) => preset.label.startsWith("«"))));
  // What the visualizer leaves out (it failed here) is not listed, and an emptied heading goes.
  const first = GROUPS[0]!.id;
  const kept = soundformsPresetGroups((id) => PRESETS.find((preset) => preset.id === id)?.group !== first, (text) => text);
  assert.ok(!kept.some((group) => group.label === GROUPS[0]!.name));
});

test("a catalog is folded once; entries without an id or a name are left out, an id listed twice is listed once", () => {
  const catalog = prepareCatalog("x", [
    { id: "a", label: "Łódź" },
    { id: "a", label: "again" },
    { id: "", label: "nameless id" },
    { id: "b", label: "" },
    { id: "c", label: "Ćma", group: "Żuraw" },
    null as unknown as { id: string; label: string }
  ], foldText);
  assert.deepEqual(catalog.ids, ["a", "c"]);
  assert.deepEqual(catalog.foldedLabels, ["lodz", "cma"]);
  assert.deepEqual(catalog.groups, ["", "Żuraw"]);
  assert.deepEqual(catalog.foldedGroups, ["", "zuraw"]);
  assert.equal(catalog.rows.length, 2);
});

test("every word must be found, in the name or the heading over it, diacritics folded as the list's own search folds them", () => {
  const ids = (query: string): string[] => matchCatalog(MILKDROP, queryWords(query)).shown.map((index) => MILKDROP.ids[index]!);
  assert.deepEqual(ids("lodz"), ["Flexi - Łódź nocą"]);
  assert.deepEqual(ids("ŁÓDŹ"), ["Flexi - Łódź nocą"]);
  assert.deepEqual(ids("cream fractal"), ["cream:Fractal/c"]);
  assert.deepEqual(ids("geiss feedback"), ["Geiss - Feedback"]);
  assert.deepEqual(ids("geiss nothing"), []);
  // Found by name before found by heading: "Dancer" names two, and two more stand under "Dancer".
  assert.deepEqual(ids("dancer"), ["cream:Dancer/b", "cream:Fractal/c", "cream:Dancer/a"]);
});

test("the search across visualizers keeps exactly what the list's own search keeps of the same list", () => {
  const rows: PickerRow[] = [];
  for (let at = 0; at < MILKDROP.ids.length; at += 1) {
    const group = MILKDROP.groups[at]!;
    if (rows.findLast((row) => row.kind === "heading")?.label !== group) rows.push({ kind: "heading", label: group });
    rows.push({ kind: "option", value: MILKDROP.ids[at]!, label: MILKDROP.labels[at]!, grouped: true });
  }
  for (const query of ["dancer", "cream", "geiss", "lodz noca", "o", "cream dancer bloom", "fractal geiss", "zz"]) {
    const own = filterRows(rows, query).rows.flatMap((row) => (row.kind === "option" ? [row.value] : []));
    const found = matchCatalog(MILKDROP, queryWords(query)).shown.map((index) => MILKDROP.ids[index]!);
    assert.deepEqual([...found].sort(), [...own].sort(), query);
  }
});

test("the visualizer on screen is searched only for what its own list does not show (its other packs)", () => {
  // MilkDrop on its built-in presets: those are in its list already; Cream of the Crop's are not.
  const own = new Set(["Geiss - Feedback", "Flexi - Łódź nocą"]);
  const found = matchCatalog(MILKDROP, queryWords("geiss"), Number.POSITIVE_INFINITY, own);
  assert.deepEqual(found.shown.map((index) => MILKDROP.ids[index]), ["cream:Fractal/c"]);
  assert.equal(found.total, 1);
  const rows = foundRows([{ visualizer: "milkdrop", label: "MilkDrop: inne paczki", catalog: MILKDROP, exclude: own }], queryWords("geiss"), { labels: LABELS });
  assert.deepEqual(labels(rows.rows), ["# MilkDrop: inne paczki", "Geiss - Dancer"]);
  assert.equal(rows.matches, 1);
  // Nothing outside its list matches: no group at all.
  const none = foundRows([{ visualizer: "milkdrop", label: "MilkDrop: inne paczki", catalog: MILKDROP, exclude: own }], queryWords("łódź"), { labels: LABELS });
  assert.deepEqual(none.rows, []);
});

test("all matches are counted, at most the limit listed", () => {
  const big = prepareCatalog("avs", Array.from({ length: 500 }, (_, index) => ({ id: `p${index}`, label: `Preset ${index}` })), foldText);
  const found = matchCatalog(big, ["preset"], 50);
  assert.equal(found.total, 500);
  assert.equal(found.shown.length, 50);
  assert.deepEqual(found.shown.slice(0, 3), [0, 1, 2]);
  assert.equal(matchCatalog(big, ["499"]).total, 1);
  // 0–499 with a 9 in them: 50 end in it, 50 have it in the tens, five both.
  assert.equal(matchCatalog(big, ["9"]).total, 95);
});

test("a visualizer lists its matches whole up to the limit and its slack, else the limit; expanded, all", () => {
  assert.equal(listedCount(12, false), 12);
  assert.equal(listedCount(FOREIGN_LIMIT + FOREIGN_SLACK, false), FOREIGN_LIMIT + FOREIGN_SLACK);
  assert.equal(listedCount(FOREIGN_LIMIT + FOREIGN_SLACK + 1, false), FOREIGN_LIMIT);
  assert.equal(listedCount(16_900, false), FOREIGN_LIMIT);
  assert.equal(listedCount(16_900, true), 16_900);
});

test("the rows: each visualizer with matches under its name, capped with a row for the rest, a note while catalogs come", () => {
  const avs = prepareCatalog("avs", Array.from({ length: 80 }, (_, index) => ({ id: `a${index}`, label: `Dancer ${index}`, group: "Anthology" })), foldText);
  const sources: FoundSource[] = [
    { visualizer: "milkdrop", label: "MilkDrop", catalog: MILKDROP },
    { visualizer: "voltviz", label: "VoltViz", catalog: prepareCatalog("voltviz", [{ id: "pulsar", label: "Pulsar (WebGL)" }], foldText) },
    { visualizer: "shaders", label: "Shadery", catalog: null },
    { visualizer: "avs", label: "AVS (Winamp)", catalog: avs }
  ];
  const result = foundRows(sources, ["dancer"], { labels: LABELS, pending: true, limit: 2, slack: 1 });
  assert.equal(result.matches, 3 + 80);
  // MilkDrop's three are within the limit and its slack: all listed, no row for the rest.
  assert.deepEqual(labels(result.rows), [
    "# MilkDrop", "Rovastar - Dancer in the dark", "Geiss - Dancer", "Martin - Bloom",
    "# AVS (Winamp)", "Dancer 0", "Dancer 1", "+78",
    "~ Szukanie…"
  ]);
  const headings = result.rows.filter((row) => row.kind === "heading");
  assert.ok(headings.every((row) => row.kind === "heading" && row.section));
  const found = result.rows[1]!;
  assert.equal(found.kind, "option");
  if (found.kind === "option") {
    assert.deepEqual(parseFoundValue(found.value), { visualizer: "milkdrop", preset: "cream:Dancer/b" });
    assert.equal(found.detail, "Cream of the Crop · Dancer");
    assert.equal(found.grouped, true);
    assert.ok(!found.action);
  }
  const more = result.rows[7]!;
  assert.ok(more.kind === "option" && more.action && parseMoreValue(more.value) === "avs");
  // Expanded, a visualizer lists every match; the rest still capped. Rows are kept: the same objects again.
  const expanded = foundRows(sources, ["dancer"], { labels: LABELS, expanded: new Set(["avs"]), limit: 2, slack: 1 });
  assert.equal(expanded.rows.filter((row) => row.kind === "option" && row.value.includes("avs")).length, 80);
  assert.equal(expanded.rows.at(-1)!.kind, "option");
  assert.equal(expanded.rows[1], result.rows[1]);
  // Nothing typed: nothing; nothing found: no heading at all.
  assert.deepEqual(foundRows(sources, [], { labels: LABELS, pending: true }).rows, []);
  assert.deepEqual(labels(foundRows(sources, ["zzz"], { labels: LABELS }).rows), []);
});

test("at most so many tasks run at once, the rest in turn as places free up — failures free theirs too", async () => {
  const limit = concurrencyLimit(2);
  let running = 0;
  let most = 0;
  const started: number[] = [];
  const task = (index: number, fail = false) => async (): Promise<number> => {
    started.push(index);
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    if (fail) throw new Error(`task ${index}`);
    return index;
  };
  const results = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((index) => limit(task(index, index === 1))));
  assert.equal(most, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  // A task that throws before it returns a promise frees its place as well.
  const thrown = await Promise.allSettled([limit(() => { throw new Error("sync"); }), limit(async () => 7)]);
  assert.deepEqual(thrown.map((result) => result.status), ["rejected", "fulfilled"]);
});

test("the failures a visualizer keeps in storage are read as a list of ids, anything else as none", () => {
  assert.deepEqual(storedIds('["a", 3, "b"]'), ["a", "b"]);
  assert.deepEqual(storedIds(null), []);
  assert.deepEqual(storedIds("{not json"), []);
  assert.deepEqual(storedIds('{"a": 1}'), []);
});
