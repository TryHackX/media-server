import { el } from "./dom";
import { currentLanguage, t } from "./i18n";
import { pulse } from "./motion";
import { starFill } from "./player-state";
import { ratingAt, ratingStep } from "./rating-steps";

export function starVisual(rating: number, star: number): HTMLSpanElement {
  return el("span", {
    className: "rating-star-visual",
    attrs: { "aria-hidden": "true" },
    dataset: { fill: starFill(rating, star) }
  });
}

interface RatingPickerOptions {
  value: number;
  summary: string;
  ariaLabel: string;
  disabled?: boolean;
  onSelect: (value: number) => void | Promise<void>;
}

function formattedRating(value: number): string {
  // "4,5" in a Polish interface, "4.5" in an English one.
  const locale = currentLanguage() === "en" ? "en-GB" : "pl-PL";
  return value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** How long the arrow keys may rest before the value they stopped on is saved. */
const KEY_COMMIT_MS = 800;

/**
 * Five stars that take a rating in halves.
 *
 * One control, not ten. Each half star used to be a button of its own, so a
 * library page of fifty tracks put five hundred rating buttons in the tab order
 * — fourteen stops a card before the keyboard reached the next one — and each
 * was a target ten pixels wide, which no finger hits on purpose. The row is now
 * a single slider:
 *
 * - **pointer** — the place pressed along the row is the rating (the row is
 *   five equal stars, so the position is the value); a mouse sees it before
 *   pressing;
 * - **keyboard** — one tab stop; arrows move by half a star, Page Up/Down by a
 *   whole one, Home/End and the digits 1–5 jump; the value is saved when the
 *   keys rest, on Enter or Space at once, and Escape puts it back;
 * - **screen reader** — a slider named after the track, with its value read as
 *   "4,5 z 5".
 *
 * Choosing the rating already given clears it, as before — that is the caller's
 * rule (`onSelect` receives the value; it decides what the value means).
 */
export function ratingPicker(options: RatingPickerOptions): HTMLElement {
  const disabled = options.disabled === true;
  const visuals: HTMLSpanElement[] = [];
  for (let star = 1; star <= 5; star += 1) visuals.push(starVisual(options.value, star));
  const valueText = (value: number): string =>
    value > 0 ? t("{value} z 5", { value: formattedRating(value) }) : t("Brak oceny");
  const stars = el(
    "span",
    {
      className: "rating-picker__stars",
      attrs: {
        role: "slider",
        tabindex: disabled ? "-1" : "0",
        "aria-label": options.ariaLabel,
        "aria-valuemin": "0",
        "aria-valuemax": "5",
        "aria-valuenow": String(options.value),
        "aria-valuetext": valueText(options.value),
        ...(disabled ? { "aria-disabled": "true" } : {})
      }
    },
    ...visuals
  );
  const label = el("span", { className: "rating-picker__label", text: options.summary });

  let busy = false;
  /** A value chosen with the keys and not saved yet. */
  let pending: number | null = null;
  let keyTimer = 0;

  const paint = (value: number, preview = false): void => {
    visuals.forEach((visual, index) => {
      visual.dataset.fill = starFill(value, index + 1);
    });
    label.textContent = preview ? `${formattedRating(value)} / 5` : options.summary;
    stars.setAttribute("aria-valuenow", String(value));
    stars.setAttribute("aria-valuetext", valueText(value));
  };
  const restore = (): void => {
    window.clearTimeout(keyTimer);
    pending = null;
    paint(options.value);
  };
  const commit = (value: number): void => {
    window.clearTimeout(keyTimer);
    pending = null;
    if (disabled || busy) return;
    busy = true;
    stars.setAttribute("aria-busy", "true");
    // The stars given answer the press: they fill and lift one after another (styles/motion.css).
    pulse(stars, "is-filling", 520);
    paint(value, true);
    void Promise.resolve(options.onSelect(value))
      .catch(() => restore())
      // Ready again whatever the caller does next. It used to stay switched off
      // until the caller replaced the picker — and one that did not left a row
      // of stars that could be used exactly once.
      .finally(() => {
        busy = false;
        stars.removeAttribute("aria-busy");
      });
  };
  const fromPointer = (event: MouseEvent): number => {
    const box = stars.getBoundingClientRect();
    return ratingAt(event.clientX - box.left, box.width);
  };

  if (!disabled) {
    stars.addEventListener("pointermove", (event) => {
      // A finger's preview is its press; only a mouse hovers.
      if (event.pointerType === "mouse" && !busy) paint(fromPointer(event), true);
    });
    stars.addEventListener("pointerleave", () => {
      if (!busy && pending === null) paint(options.value);
    });
    stars.addEventListener("click", (event) => {
      event.stopPropagation();
      commit(fromPointer(event));
    });
    stars.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && pending !== null) {
        event.stopPropagation();
        restore();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        commit(pending ?? options.value);
        return;
      }
      const next = ratingStep(pending ?? options.value, event.key);
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      pending = next;
      paint(next, true);
      window.clearTimeout(keyTimer);
      keyTimer = window.setTimeout(() => { if (pending !== null) commit(pending); }, KEY_COMMIT_MS);
    });
    // Tabbing on with a value still pending saves it: it is what the stars show.
    stars.addEventListener("blur", () => {
      if (pending !== null) commit(pending);
    });
  }

  return el("div", { className: "rating-picker" }, stars, label);
}
