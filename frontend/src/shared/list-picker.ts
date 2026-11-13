import { el } from "./dom";
import { formatCount } from "./format";
import { t } from "./i18n";
import { icon, type IconName } from "./icons";
import {
  countOptions, filterRows, foldText, governingHeading, indexOfValue, isMoveKey, moveActive, optionOrdinals, revealScrollTop,
  visibleRange, type PickerRow
} from "./list-picker-model";

export type { PickerHeading, PickerOption, PickerRow } from "./list-picker-model";

/** What opened the list or made the choice; it decides where the focus goes. */
export type PickerInput = "pointer" | "touch" | "keyboard";

export interface ListPickerOptions {
  /** The control's name (what the select's aria-label was): read with its value, names the list. */
  label: string;
  /** Classes of the root beside `list-picker` (the panel's sizes and `hidden`). */
  className?: string;
  /** The search field's placeholder and name. */
  searchLabel: string;
  /** How many options the list holds, said in the search field while nothing is searched. */
  countLabel?(count: number): string;
  /** A search field from this many options up; a shorter list is read faster than searched. */
  searchFrom?: number;
  /** The width the list opens at, at least (rem); the trigger's own when that is wider. */
  minWidth?: number;
  /** A choice, only when it differs from the current value — as a select's `change`. */
  onChoose(value: string, input: PickerInput): void;
  /** Marks of an option, asked as a row is drawn (only the rows on screen are). */
  marks?(value: string): { favorite?: boolean; playing?: boolean } | null;
  /** The list is in use (scrolled, searched): the panel keeps its toolbar up. */
  onActivity?(): void;
  /**
   * Rows a search finds beyond the list itself (the other visualizers' presets), drawn below its
   * own matches: asked at every change of the search and by `refreshSearch()`; null for none.
   * `matches` is how many they found, said beside the list's own count.
   */
  searchMore?(query: string): { rows: readonly PickerRow[]; matches: number } | null;
  /** An `action` row taken: the list stays open and is searched again, the highlight where it was. */
  onAction?(value: string): void;
  /** The list closed. */
  onClose?(): void;
}

interface RowNode {
  element: HTMLDivElement;
  label: HTMLSpanElement;
  /** An option's `detail`, after its label. */
  detail: HTMLSpanElement;
  /** The row of `shown` drawn, -1 for none. */
  index: number;
  row: PickerRow | null;
}

/** Phones open the list as a sheet from the bottom edge (player.css's phone layout starts here too). */
const SHEET_QUERY = "(max-width: 46rem)";
/** The tallest a list opens on a larger screen, in rem. */
const MAX_HEIGHT_REM = 36;
const EDGE = 8;
const GAP = 6;
let pickers = 0;

function printable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function mark(name: IconName, kind: string): HTMLSpanElement {
  const glyph = icon(name);
  glyph.classList.add("list-picker__mark", `list-picker__mark--${kind}`);
  return glyph;
}

/**
 * A select for long lists: a button that shows the value and opens the list over the page — in the
 * top layer (popover), so no panel clips it and it stays above a full-screen element — with a
 * search field over it.
 *
 * Only the rows in view exist: a fixed row height turns the scroll position into the first row
 * drawn, and a few dozen row elements are filled again as the list scrolls (`render`). Opening
 * 16 900 MilkDrop presets draws about thirty rows; a native select built all 16 900 options
 * into its popup first, and froze the page for two to three seconds doing it.
 *
 * Keyboard: the trigger is a combobox (↓ ↑ or a letter open it, a letter starting the search);
 * open, the focus is in the search field (a combobox too) and `aria-activedescendant` names the
 * highlighted option of the listbox — ↓ ↑ Page Up/Down Home End move it, Enter chooses, Escape
 * empties the search and then closes, Tab closes. On a touch screen the focus goes to the list,
 * not the field, so the keyboard does not cover the list until the field is tapped.
 */
export class ListPicker {
  public readonly element: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly valueText: HTMLSpanElement;
  private readonly popover: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly searchBox: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly clear: HTMLButtonElement;
  private readonly count: HTMLSpanElement;
  private readonly list: HTMLDivElement;
  private readonly space: HTMLDivElement;
  private readonly sticky: HTMLDivElement;
  private readonly empty: HTMLParagraphElement;
  private readonly id: string;
  /** Every row, and what the search leaves of them. */
  private rows: readonly PickerRow[] = [];
  private shown: readonly PickerRow[] = [];
  private ordinals: Int32Array = new Int32Array(0);
  private matches = 0;
  private total = 0;
  /** What `searchMore` found beyond the list. */
  private moreMatches = 0;
  /** Options shown, shortcuts too: what a screen reader counts (aria-setsize). */
  private optionsShown = 0;
  /** The unsearched list's figures, kept for its rows: opening 16 900 presets counts nothing again. */
  private whole: { rows: readonly PickerRow[]; total: number; ordinals: Int32Array; optionsShown: number; headings: boolean } | null = null;
  private headings = false;
  /** Folded labels, kept per row object: a list keeps its rows, so each label is folded once. */
  private readonly folded = new WeakMap<PickerRow, string>();
  private readonly fold = (row: PickerRow): string => {
    let text = this.folded.get(row);
    if (text === undefined) {
      text = foldText(row.label);
      this.folded.set(row, text);
    }
    return text;
  };
  private value = "";
  private query = "";
  private active = -1;
  private opened = false;
  /** What opened the list (a touch screen's Enter only puts its keyboard away). */
  private input: PickerInput = "pointer";
  private searching = false;
  private rowHeight = 36;
  private viewport = 0;
  private overscan = 8;
  private nodes: RowNode[] = [];
  private pointerType = "mouse";
  private activityAt = 0;
  private typed = "";
  private typedAt = 0;
  private release: (() => void) | null = null;

  public constructor(private readonly options: ListPickerOptions) {
    this.id = `list-picker-${++pickers}`;
    const listId = `${this.id}-list`;
    this.valueText = el("span", { className: "list-picker__value" });
    const chevron = icon("chevron");
    chevron.classList.add("list-picker__chevron");
    this.trigger = el("button", {
      className: "input input--compact list-picker__trigger",
      attrs: {
        type: "button", role: "combobox", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": listId,
        "aria-label": options.label
      }
    }, this.valueText, chevron);
    this.search = el("input", {
      className: "list-picker__search",
      attrs: {
        type: "search", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "true", "aria-controls": listId,
        autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "done",
        placeholder: options.searchLabel, "aria-label": options.searchLabel
      }
    });
    this.clear = el("button", {
      className: "list-picker__clear",
      attrs: { type: "button", tabindex: "-1", "aria-label": t("Wyczyść wyszukiwanie"), hidden: true }
    }, icon("close"));
    this.count = el("span", { className: "list-picker__count", attrs: { "aria-live": "polite" } });
    this.searchBox = el("div", { className: "list-picker__search-box" }, icon("search"), this.search, this.count, this.clear);
    this.head = el("div", { className: "list-picker__head" },
      el("span", { className: "list-picker__grip", attrs: { "aria-hidden": "true" } }), this.searchBox);
    this.sticky = el("div", { className: "list-picker__sticky", attrs: { "aria-hidden": "true" } });
    this.space = el("div", { className: "list-picker__space" });
    this.list = el("div", {
      className: "list-picker__list",
      attrs: { id: listId, role: "listbox", tabindex: "-1", "aria-label": options.label }
    }, this.sticky, this.space);
    this.empty = el("p", { className: "list-picker__empty", attrs: { hidden: true } });
    this.popover = el("div", { className: "list-picker__popover", attrs: { popover: "manual" } }, this.head, this.list, this.empty);
    this.element = el("div", { className: `list-picker ${options.className ?? ""}`.trim() }, this.trigger, this.popover);

    this.trigger.addEventListener("pointerdown", (event) => {
      this.pointerType = event.pointerType || "mouse";
    });
    this.trigger.addEventListener("click", (event) => {
      if (this.opened) {
        this.close(event.detail === 0);
        return;
      }
      this.open(event.detail === 0 ? "keyboard" : this.pointerType === "mouse" ? "pointer" : "touch");
    });
    this.trigger.addEventListener("keydown", (event) => {
      if (this.opened || this.trigger.disabled) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.open("keyboard");
      } else if (printable(event)) {
        event.preventDefault();
        this.open("keyboard", event.key);
      }
    });
    this.popover.addEventListener("keydown", (event) => this.key(event));
    this.search.addEventListener("input", () => this.setQuery(this.search.value, false));
    this.clear.addEventListener("click", () => {
      this.setQuery("");
      this.search.focus({ preventScroll: true });
    });
    this.list.addEventListener("scroll", () => {
      this.render();
      this.activity();
    }, { passive: true });
    this.list.addEventListener("pointerdown", (event) => {
      this.pointerType = event.pointerType || "mouse";
    });
    this.space.addEventListener("click", (event) => {
      const index = this.rowAt(event.target);
      if (index >= 0) this.choose(index, this.pointerType === "mouse" ? "pointer" : "touch");
    });
    // The mouse highlights what it is over, as in a select; Enter then takes that one.
    this.space.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse") return;
      const index = this.rowAt(event.target);
      if (index >= 0 && index !== this.active) this.setActive(index, null);
    });
    // The browser can hide the list itself (entering full screen hides every popover).
    this.popover.addEventListener("toggle", (event) => {
      if ((event as ToggleEvent).newState === "closed" && this.opened && !this.popover.matches(":popover-open")) this.close();
    });
  }

  public isOpen(): boolean {
    return this.opened;
  }

  /** The list's rows. Kept as given: the same row objects keep their folded labels. */
  public setRows(rows: readonly PickerRow[]): void {
    if (rows === this.rows) return;
    this.rows = rows;
    if (!this.opened) return;
    const activeRow = this.shown[this.active];
    const scrollTop = this.list.scrollTop;
    this.refilter();
    const keep = activeRow?.kind === "option" ? indexOfValue(this.shown, activeRow.value) : -1;
    this.list.scrollTop = scrollTop;
    this.setActive(keep >= 0 ? keep : this.firstActive(), null);
    this.render(true);
  }

  /** The chosen value and what the trigger says for it. */
  public setValue(value: string, display: string): void {
    const changed = value !== this.value;
    this.value = value;
    if (this.valueText.textContent !== display) this.valueText.textContent = display;
    if (changed) this.refresh();
  }

  public setLabel(label: string): void {
    this.trigger.setAttribute("aria-label", label);
    this.list.setAttribute("aria-label", label);
  }

  public setTitle(title: string): void {
    if (title) this.trigger.title = title;
    else this.trigger.removeAttribute("title");
  }

  public setDisabled(disabled: boolean): void {
    this.trigger.disabled = disabled;
    if (disabled) this.close();
  }

  /** Redraws the rows on screen (their marks changed). */
  public refresh(): void {
    if (this.opened) this.render(true);
  }

  public open(input: PickerInput = "pointer", typed = ""): void {
    if (this.opened || this.trigger.disabled || !this.element.isConnected) return;
    this.opened = true;
    this.input = input;
    this.total = this.wholeList().total;
    this.searching = this.total >= (this.options.searchFrom ?? 12);
    this.searchBox.hidden = !this.searching;
    this.popover.classList.toggle("is-searchable", this.searching);
    this.query = this.searching ? typed : "";
    this.search.value = this.query;
    this.clear.hidden = !this.query;
    try {
      this.popover.showPopover();
    } catch {
      // No popover support: the same box, fixed over the page.
      this.popover.classList.add("is-open");
    }
    this.trigger.setAttribute("aria-expanded", "true");
    this.place();
    this.refilter();
    const chosen = this.query.trim() ? -1 : indexOfValue(this.shown, this.value);
    this.active = chosen >= 0 ? chosen : this.firstActive();
    this.list.scrollTop = revealScrollTop({
      index: this.active, rowHeight: this.rowHeight, scrollTop: 0, viewport: this.viewport, count: this.shown.length, mode: "center"
    });
    this.render(true);
    this.setActive(this.active, null);
    // On a touch screen the field would raise the keyboard over the list: the list takes the focus.
    const target = this.searching && input !== "touch" ? this.search : this.list;
    target.focus({ preventScroll: true });
    if (target === this.search && this.query) this.search.setSelectionRange(this.query.length, this.query.length);
    if (typed && !this.searching) this.typeAhead(typed);
    this.listen();
    this.activity();
  }

  /** Closes the list; `returnFocus` puts the focus back on the trigger (keyboard use). */
  public close(returnFocus = false): void {
    if (!this.opened) return;
    this.opened = false;
    this.release?.();
    this.release = null;
    const focused = document.activeElement;
    const hadFocus = focused instanceof HTMLElement && this.popover.contains(focused);
    try {
      this.popover.hidePopover();
    } catch { /* hidden already (the browser did it) or no popover support */ }
    this.popover.classList.remove("is-open");
    this.trigger.setAttribute("aria-expanded", "false");
    this.query = "";
    this.search.value = "";
    this.active = -1;
    this.search.removeAttribute("aria-activedescendant");
    this.list.removeAttribute("aria-activedescendant");
    this.options.onClose?.();
    if (returnFocus) {
      this.trigger.focus({ preventScroll: true });
    } else if (hadFocus) {
      // Chosen with the pointer: nothing keeps the focus (the browser may have handed it to the trigger).
      const now = document.activeElement;
      if (now instanceof HTMLElement && (now === this.trigger || this.popover.contains(now))) now.blur();
    }
  }

  /** Document and window listeners, only while the list is open. */
  private listen(): void {
    const outside = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && this.trigger.contains(target)) return;
      if (target && this.popover.contains(target) && this.within(event)) return;
      this.close();
      // The press that closes the list does nothing else, as with a select's popup.
      const swallow = (click: Event): void => {
        click.preventDefault();
        click.stopPropagation();
      };
      document.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => document.removeEventListener("click", swallow, true), 700);
    };
    const reposition = (): void => {
      if (!this.opened) return;
      this.place();
      this.render(true);
    };
    const leave = (): void => this.close();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    document.addEventListener("fullscreenchange", leave);
    this.release = () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      document.removeEventListener("fullscreenchange", leave);
    };
  }

  /** A press on the popover element itself may be on its ::backdrop (the phone's sheet): outside. */
  private within(event: PointerEvent): boolean {
    const box = this.popover.getBoundingClientRect();
    return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  }

  /** Size and place: under the trigger (above it when there is more room there), or a sheet on a phone. */
  private place(): void {
    const sheet = window.matchMedia(SHEET_QUERY).matches;
    this.popover.classList.toggle("is-sheet", sheet);
    const style = this.popover.style;
    // The row height comes from the stylesheet (larger for a finger), measured on the pinned heading.
    this.rowHeight = this.sticky.offsetHeight || this.rowHeight;
    this.overscan = window.matchMedia("(pointer: coarse)").matches ? 14 : 8;
    const listStyle = getComputedStyle(this.list);
    const padding = parseFloat(listStyle.paddingTop) + parseFloat(listStyle.paddingBottom);
    const frame = this.popover.offsetHeight - this.popover.clientHeight;
    // As tall as the whole list wants (not what a search leaves): typing does not resize it.
    const wanted = this.head.offsetHeight + Math.max(1, this.rows.length) * this.rowHeight + padding + frame;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const viewport = window.visualViewport;
    if (sheet) {
      // Above the on-screen keyboard, when the search field has raised it.
      const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const lifted = Math.max(0, Math.round(window.innerHeight - visibleBottom));
      const room = visibleBottom - (viewport?.offsetTop ?? 0);
      style.left = "";
      style.width = "";
      style.top = "auto";
      style.bottom = `${lifted}px`;
      style.height = `${Math.round(Math.min(wanted, room * 0.82, room - 3 * rem))}px`;
    } else {
      const box = this.trigger.getBoundingClientRect();
      const width = Math.min(document.documentElement.clientWidth - 2 * EDGE, Math.max(box.width, (this.options.minWidth ?? 0) * rem));
      const left = Math.max(EDGE, Math.min(box.left, document.documentElement.clientWidth - EDGE - width));
      const below = window.innerHeight - box.bottom - GAP - EDGE;
      const above = box.top - GAP - EDGE;
      const tallest = Math.min(wanted, MAX_HEIGHT_REM * rem);
      const downward = below >= Math.min(tallest, 20 * rem) || below >= above;
      const height = Math.max(Math.min(tallest, downward ? below : above), Math.min(tallest, 10 * rem));
      style.left = `${Math.round(left)}px`;
      style.width = `${Math.round(width)}px`;
      style.height = `${Math.round(height)}px`;
      style.bottom = "auto";
      style.top = `${Math.round(downward ? box.bottom + GAP : Math.max(EDGE, box.top - GAP - height))}px`;
    }
    this.viewport = this.list.clientHeight;
  }

  /** The figures of the whole list, worked out once for its rows. */
  private wholeList(): NonNullable<ListPicker["whole"]> {
    if (this.whole?.rows !== this.rows) {
      const ordinals = optionOrdinals(this.rows);
      this.whole = {
        rows: this.rows,
        total: countOptions(this.rows),
        ordinals,
        optionsShown: ordinals.reduce((most, ordinal) => Math.max(most, ordinal), 0),
        headings: this.rows.some((row) => row.kind === "heading")
      };
    }
    return this.whole;
  }

  private refilter(): void {
    const searched = this.query.trim() !== "";
    this.moreMatches = 0;
    if (searched) {
      const result = filterRows(this.rows, this.query, this.fold);
      const more = this.options.searchMore?.(this.query) ?? null;
      this.shown = more?.rows.length ? result.rows.concat(more.rows) : result.rows;
      this.moreMatches = more?.matches ?? 0;
      this.matches = result.matches;
      this.total = result.total;
      this.ordinals = optionOrdinals(this.shown);
      this.optionsShown = this.ordinals.reduce((most, ordinal) => Math.max(most, ordinal), 0);
      this.headings = this.shown.some((row) => row.kind === "heading");
    } else {
      const whole = this.wholeList();
      this.shown = this.rows;
      this.matches = whole.total;
      this.total = whole.total;
      this.ordinals = whole.ordinals;
      this.optionsShown = whole.optionsShown;
      this.headings = whole.headings;
    }
    this.space.style.height = `${this.shown.length * this.rowHeight}px`;
    if (this.searching) {
      const counted = { count: formatCount(this.matches), total: formatCount(this.total) };
      this.count.textContent = !searched
        ? this.options.countLabel?.(this.total) ?? formatCount(this.total)
        : this.moreMatches > 0
          ? t("{count} z {total} + {other} w innych", { ...counted, other: formatCount(this.moreMatches) })
          : t("{count} z {total}", counted);
    }
    const none = searched && this.shown.length === 0;
    this.empty.hidden = !none;
    if (none) this.empty.textContent = t("Nic nie pasuje do „{query}”.", { query: this.query.trim() });
  }

  private setQuery(query: string, write = true): void {
    if (write) this.search.value = query;
    this.query = query;
    this.clear.hidden = !query;
    if (!this.opened) return;
    this.refilter();
    // A new search starts at its first match; an emptied one at the chosen value.
    const searched = query.trim() !== "";
    const chosen = searched ? -1 : indexOfValue(this.shown, this.value);
    const active = chosen >= 0 ? chosen : this.firstActive();
    this.list.scrollTop = searched ? 0 : revealScrollTop({
      index: active, rowHeight: this.rowHeight, scrollTop: 0, viewport: this.viewport, count: this.shown.length, mode: "center"
    });
    this.render(true);
    this.setActive(active, null);
    this.activity();
  }

  /**
   * The search run again where it stands — `searchMore` has more to say (catalogs arrived, a group
   * expanded): the scroll stays, and the highlight on its row, else on the option at `at` (or the
   * one before it).
   */
  public refreshSearch(at = -1): void {
    if (!this.opened || !this.searching || this.query.trim() === "") return;
    const activeRow = this.shown[this.active];
    const scrollTop = this.list.scrollTop;
    this.refilter();
    let keep = activeRow?.kind === "option" ? indexOfValue(this.shown, activeRow.value) : -1;
    if (keep < 0 && at >= 0) keep = this.shown[at]?.kind === "option" ? at : moveActive(this.shown, at, "ArrowUp", 1);
    this.list.scrollTop = scrollTop;
    this.render(true);
    this.setActive(keep >= 0 ? keep : this.firstActive(), at >= 0 ? "nearest" : null);
  }

  private firstActive(): number {
    return moveActive(this.shown, -1, "Home", 1);
  }

  private pageRows(): number {
    return Math.max(1, Math.floor(this.viewport / this.rowHeight) - 1);
  }

  private key(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const key = event.key;
    if (isMoveKey(key)) {
      // Shift+Home/End still select in the field.
      if ((key === "Home" || key === "End") && event.shiftKey) return;
      event.preventDefault();
      this.setActive(moveActive(this.shown, this.active, key, this.pageRows()), "nearest");
      return;
    }
    if (key === "Enter" && this.input === "touch" && event.target === this.search) {
      // The on-screen keyboard's "done": the keyboard goes, the list with what it found stays.
      event.preventDefault();
      this.list.focus({ preventScroll: true });
      return;
    }
    if (key === "Enter" || (key === " " && event.target !== this.search)) {
      // Space on the list would otherwise reach the player's play/pause.
      event.preventDefault();
      if (this.active >= 0) this.choose(this.active, "keyboard");
      return;
    }
    if (key === "Escape") {
      // Not the panel's Escape (it would close the visualizer): the list's own.
      event.preventDefault();
      event.stopPropagation();
      if (this.query) {
        this.setQuery("");
        if (this.searching) this.search.focus({ preventScroll: true });
      } else {
        this.close(true);
      }
      return;
    }
    if (key === "Tab") {
      // The focus goes on from the trigger, to the control before or after it.
      this.close(true);
      return;
    }
    if (event.target === this.search || !(printable(event) || key === "Backspace")) return;
    if (this.searching) {
      // Typed on the list: into the search field (focused now, the key lands there).
      this.search.focus({ preventScroll: true });
      return;
    }
    if (printable(event)) this.typeAhead(event.key);
  }

  /** A short list without a field: letters jump to the option they start, as in a select. */
  private typeAhead(letter: string): void {
    const now = performance.now();
    this.typed = now - this.typedAt > 800 ? letter : this.typed + letter;
    this.typedAt = now;
    const prefix = foldText(this.typed);
    const count = this.shown.length;
    // The same letter again moves on to the next such option; a longer prefix may stay.
    const start = this.typed.length > 1 ? Math.max(0, this.active) : this.active + 1;
    for (let step = 0; step < count; step += 1) {
      const index = (start + step) % count;
      const row = this.shown[index]!;
      if (row.kind === "option" && this.fold(row).startsWith(prefix)) {
        this.setActive(index, "nearest");
        return;
      }
    }
  }

  private choose(index: number, input: PickerInput): void {
    const row = this.shown[index];
    if (row?.kind !== "option") return;
    if (row.action) {
      this.options.onAction?.(row.value);
      this.refreshSearch(index);
      this.activity();
      return;
    }
    this.close(input === "keyboard");
    if (row.value === this.value) return;
    this.value = row.value;
    this.valueText.textContent = row.label;
    this.options.onChoose(row.value, input);
  }

  private activity(): void {
    const now = performance.now();
    if (now - this.activityAt < 400) return;
    this.activityAt = now;
    this.options.onActivity?.();
  }

  private optionId(index: number): string {
    return `${this.id}-o${index}`;
  }

  private rowAt(target: EventTarget | null): number {
    const element = target instanceof Element ? target.closest<HTMLElement>(".list-picker__option") : null;
    return element?.dataset.index ? Number(element.dataset.index) : -1;
  }

  /** Moves the highlight; with `reveal`, scrolls it into view first. */
  private setActive(index: number, reveal: "nearest" | "center" | null): void {
    const previous = this.active;
    this.active = index;
    if (reveal && index >= 0) {
      const reserved = this.headings && governingHeading(this.shown, index) >= 0 ? this.rowHeight : 0;
      const next = revealScrollTop({
        index, rowHeight: this.rowHeight, scrollTop: this.list.scrollTop, viewport: this.viewport, count: this.shown.length, mode: reveal, reserved
      });
      if (next !== this.list.scrollTop) {
        this.list.scrollTop = next;
        this.render();
      }
    }
    for (const node of this.nodes) {
      if (node.index === previous || node.index === index) node.element.classList.toggle("is-active", node.index === index);
    }
    this.describeActive();
  }

  /** `aria-activedescendant` names the highlighted row while it is drawn (scrolled away, it is not). */
  private describeActive(): void {
    const drawn = this.active >= 0 && this.nodes.some((node) => node.index === this.active);
    const id = drawn ? this.optionId(this.active) : "";
    for (const owner of [this.search, this.list]) {
      if (!id) owner.removeAttribute("aria-activedescendant");
      else if (owner.getAttribute("aria-activedescendant") !== id) owner.setAttribute("aria-activedescendant", id);
    }
  }

  /** Draws the rows in view: the row elements, in order, filled again where their row changed. */
  private render(force = false): void {
    if (!this.opened) return;
    const scrollTop = this.list.scrollTop;
    const { start, end } = visibleRange(scrollTop, this.viewport, this.rowHeight, this.shown.length, this.overscan);
    const needed = end - start;
    while (this.nodes.length < needed) {
      const label = el("span", { className: "list-picker__label" });
      const detail = el("span", { className: "list-picker__detail", attrs: { hidden: true } });
      const element = el("div", {}, label, detail, mark("visualizer", "playing"), mark("star", "favorite"), mark("check", "selected"));
      this.nodes.push({ element, label, detail, index: -1, row: null });
      this.space.append(element);
    }
    this.nodes.forEach((node, slot) => {
      if (slot >= needed) {
        if (node.index !== -1) {
          node.element.hidden = true;
          node.index = -1;
          node.row = null;
          node.element.removeAttribute("id");
        }
        return;
      }
      const index = start + slot;
      if (force || node.index !== index || node.row !== this.shown[index]) this.fill(node, index);
    });
    this.pin(scrollTop);
    this.describeActive();
  }

  private fill(node: RowNode, index: number): void {
    const row = this.shown[index]!;
    const element = node.element;
    node.index = index;
    node.row = row;
    element.hidden = false;
    element.dataset.index = String(index);
    element.style.transform = `translateY(${index * this.rowHeight}px)`;
    node.label.textContent = row.label;
    const detail = row.kind === "option" ? row.detail ?? "" : "";
    if (node.detail.textContent !== detail) node.detail.textContent = detail;
    node.detail.hidden = !detail;
    if (row.kind !== "option") {
      // A heading, or a note ("Szukanie w innych wizualizacjach…"): text in the list, never a choice.
      element.className = row.kind === "note" ? "list-picker__note" : row.section ? "list-picker__heading is-section" : "list-picker__heading";
      element.setAttribute("role", "presentation");
      for (const name of ["id", "aria-selected", "aria-posinset", "aria-setsize", "aria-label", "title"]) element.removeAttribute(name);
      return;
    }
    const marks = row.aside || row.action ? null : this.options.marks?.(row.value) ?? null;
    const selected = !row.action && row.value === this.value;
    let className = "list-picker__option";
    if (row.action) className += " is-action";
    if (row.grouped) className += " is-grouped";
    if (selected) className += " is-selected";
    if (index === this.active) className += " is-active";
    if (marks?.favorite) className += " is-favorite";
    if (marks?.playing) className += " is-playing";
    element.className = className;
    element.id = this.optionId(index);
    element.setAttribute("role", "option");
    element.setAttribute("aria-selected", String(selected));
    element.setAttribute("aria-posinset", String(this.ordinals[index] ?? 0));
    element.setAttribute("aria-setsize", String(this.optionsShown));
    // Read as one: the name, then where it comes from (spans in a row may be read run together).
    const whole = detail ? `${row.label} — ${detail}` : row.label;
    if (detail) element.setAttribute("aria-label", whole);
    else element.removeAttribute("aria-label");
    // A long name is cut short in the row; the whole of it on hover.
    if (whole.length > 36) element.title = whole;
    else element.removeAttribute("title");
  }

  /** The heading of the group at the top stays pinned over the list while its rows scroll under it. */
  private pin(scrollTop: number): void {
    const top = Math.floor(scrollTop / this.rowHeight);
    const heading = this.headings ? governingHeading(this.shown, top) : -1;
    const show = heading >= 0 && scrollTop > heading * this.rowHeight;
    this.sticky.classList.toggle("is-shown", show);
    const row = show ? this.shown[heading] : undefined;
    const label = row?.label ?? "";
    if (show && this.sticky.textContent !== label) this.sticky.textContent = label;
    this.sticky.classList.toggle("is-section", row?.kind === "heading" && Boolean(row.section));
  }
}
