/**
 * The arithmetic of the list picker (list-picker.ts), kept apart from the DOM so it can be tested
 * on its own: what a search leaves of the list, which rows a scrolled window shows, where a key
 * moves the highlight. No imports, so `node --test` runs it as it is.
 *
 * A list is a flat run of rows: options, and headings above the options of their group (what an
 * `<optgroup>` was). An option outside any group (`grouped` false) ends the group before it.
 */

export interface PickerOption {
  kind: "option";
  value: string;
  label: string;
  /** Listed under the heading above it (indented); false or absent, it stands on its own. */
  grouped?: boolean;
  /**
   * A shortcut beside the list proper ("Auto", a favourite listed again on top): searchable and
   * choosable like any option, but not counted among the list's items and not marked.
   */
  aside?: boolean;
  /** Said after the label, dimmer: where the option comes from (another visualizer's pack). */
  detail?: string;
  /**
   * Not a value but a change to the list ("Pokaż jeszcze 260"): taking it leaves the list open
   * (list-picker.ts onAction). Reached and taken like an option; marked never.
   */
  action?: boolean;
}

export interface PickerHeading {
  kind: "heading";
  label: string;
  /** Heads a part of the list rather than a group: another visualizer's results, drawn stronger. */
  section?: boolean;
}

/** A line of text in the list, not an option ("Szukanie w innych wizualizacjach…"): skipped by the keys. */
interface PickerNote {
  kind: "note";
  label: string;
}

export type PickerRow = PickerOption | PickerHeading | PickerNote;

/** Letters that do not come apart into a base letter and a mark (NFD leaves "ł" whole). */
const SEPARATE_LETTERS: Readonly<Record<string, string>> = {
  "ł": "l", "đ": "d", "ð": "d", "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe", "ı": "i", "þ": "th"
};

/** Text as a search compares it: lower case, without diacritics ("Łódź" → "lodz"). */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[łđðøßæœıþ]/g, (letter) => SEPARATE_LETTERS[letter] ?? letter);
}

/** The words of a query, folded; every one of them has to be found. */
export function queryWords(query: string): string[] {
  return foldText(query).split(/\s+/u).filter(Boolean);
}

export interface FilteredRows {
  /** What the list shows: the matching options, each group's heading above its matches. */
  rows: readonly PickerRow[];
  /** Options among `rows`, the shortcuts (`aside`) left out. */
  matches: number;
  /** Options in the whole list, the shortcuts left out. */
  total: number;
}

/** The list's items: its options without the shortcuts (`aside`). */
export function countOptions(rows: readonly PickerRow[]): number {
  let count = 0;
  for (const row of rows) if (row.kind === "option" && !row.aside) count += 1;
  return count;
}

/**
 * The rows a query leaves. An option stays when each word of the query is in its label or in its
 * group's heading ("cream dancer" finds the presets of Dancer in Cream of the Crop, "dancer" all of
 * Dancer); a heading stays above the options of its group that stayed. An empty query leaves the
 * list as it is (the same array). `fold` gives a row's folded label — the picker keeps them, so a
 * long list is folded once, not at every key.
 */
export function filterRows(
  rows: readonly PickerRow[],
  query: string,
  fold: (row: PickerRow) => string = (row) => foldText(row.label)
): FilteredRows {
  const total = countOptions(rows);
  const words = queryWords(query);
  if (words.length === 0) return { rows, matches: total, total };
  const kept: PickerRow[] = [];
  let heading: PickerHeading | null = null;
  let headingText = "";
  let headingKept = false;
  let matches = 0;
  for (const row of rows) {
    if (row.kind === "heading") {
      heading = row;
      headingText = fold(row);
      headingKept = false;
      continue;
    }
    if (row.kind === "note") continue;
    if (!row.grouped) {
      heading = null;
      headingText = "";
    }
    const text = fold(row);
    if (!words.every((word) => text.includes(word) || headingText.includes(word))) continue;
    if (heading && !headingKept) {
      kept.push(heading);
      headingKept = true;
    }
    kept.push(row);
    if (!row.aside) matches += 1;
  }
  return { rows: kept, matches, total };
}

/** Each option's place among the options shown, shortcuts too (1-based, for aria-posinset); 0 for a heading. */
export function optionOrdinals(rows: readonly PickerRow[]): Int32Array {
  const ordinals = new Int32Array(rows.length);
  let count = 0;
  rows.forEach((row, index) => {
    if (row.kind === "option") ordinals[index] = ++count;
  });
  return ordinals;
}

/** The heading the row at `index` is listed under: its own index for a heading, -1 for none. */
export function governingHeading(rows: readonly PickerRow[], index: number): number {
  for (let at = Math.min(index, rows.length - 1); at >= 0; at -= 1) {
    const row = rows[at]!;
    if (row.kind === "heading") return at;
    if (row.kind === "note" || !row.grouped) return -1;
  }
  return -1;
}

/**
 * The rows a list scrolled to `scrollTop` has to draw, `overscan` more on each side so a quick
 * scroll does not show the gap before the next frame: [start, end).
 */
export function visibleRange(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan = 6
): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + Math.max(0, viewport)) / rowHeight);
  return {
    start: Math.min(count, Math.max(0, first - overscan)),
    end: Math.min(count, Math.max(0, last + overscan))
  };
}

export interface RevealRequest {
  index: number;
  rowHeight: number;
  scrollTop: number;
  viewport: number;
  count: number;
  /** "nearest" scrolls only as far as the row needs; "center" puts it in the middle. */
  mode?: "nearest" | "center";
  /** Height at the top covered by something else (the pinned heading). */
  reserved?: number;
}

/** Where to scroll so the row at `index` is in full view (clamped to the list). */
export function revealScrollTop({ index, rowHeight, scrollTop, viewport, count, mode = "nearest", reserved = 0 }: RevealRequest): number {
  const limit = Math.max(0, count * rowHeight - viewport);
  if (index < 0 || rowHeight <= 0) return Math.min(Math.max(0, scrollTop), limit);
  const top = index * rowHeight;
  let next = scrollTop;
  if (mode === "center") next = top - (viewport - rowHeight) / 2;
  else if (top - reserved < scrollTop) next = top - reserved;
  else if (top + rowHeight > scrollTop + viewport) next = top + rowHeight - viewport;
  return Math.min(Math.max(0, Math.round(next)), limit);
}

export type MoveKey = "ArrowDown" | "ArrowUp" | "PageDown" | "PageUp" | "Home" | "End";

export function isMoveKey(key: string): key is MoveKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "PageDown" || key === "PageUp" || key === "Home" || key === "End";
}

function optionFrom(rows: readonly PickerRow[], from: number, step: 1 | -1): number {
  for (let at = from; at >= 0 && at < rows.length; at += step) if (rows[at]!.kind === "option") return at;
  return -1;
}

/**
 * Where a key moves the highlight: always onto an option (headings are skipped), never past
 * either end (no wrapping). Nothing highlighted yet: ↓ and Page Down take the first option, ↑ and
 * Page Up the last. `page` is how many rows the list shows. -1 when the list has no options.
 */
export function moveActive(rows: readonly PickerRow[], active: number, key: MoveKey, page: number): number {
  const first = optionFrom(rows, 0, 1);
  if (first < 0) return -1;
  const last = optionFrom(rows, rows.length - 1, -1);
  const current = active >= 0 && active < rows.length && rows[active]!.kind === "option" ? active : -1;
  const step = Math.max(1, Math.floor(page));
  switch (key) {
    case "Home":
      return first;
    case "End":
      return last;
    case "ArrowDown":
      return current < 0 ? first : optionFrom(rows, current + 1, 1) >= 0 ? optionFrom(rows, current + 1, 1) : current;
    case "ArrowUp":
      return current < 0 ? last : optionFrom(rows, current - 1, -1) >= 0 ? optionFrom(rows, current - 1, -1) : current;
    case "PageDown": {
      if (current < 0) return first;
      const target = Math.min(rows.length - 1, current + step);
      const forward = optionFrom(rows, target, 1);
      return forward >= 0 ? forward : last;
    }
    case "PageUp": {
      if (current < 0) return last;
      const target = Math.max(0, current - step);
      const back = optionFrom(rows, target, -1);
      return back >= 0 ? back : first;
    }
  }
}

/** The first option with this value (a favourite stands twice: in "★ Ulubione" and in its group). */
export function indexOfValue(rows: readonly PickerRow[], value: string): number {
  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at]!;
    if (row.kind === "option" && row.value === value) return at;
  }
  return -1;
}
