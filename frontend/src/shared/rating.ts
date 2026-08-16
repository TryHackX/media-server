import { el } from "./dom";
import { currentLanguage, t } from "./i18n";
import { starFill } from "./player-state";

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

export function ratingPicker(options: RatingPickerOptions): HTMLElement {
  const visuals: HTMLSpanElement[] = [];
  const stars = el("span", { className: "rating-picker__stars" });
  for (let star = 1; star <= 5; star += 1) {
    const visual = starVisual(options.value, star);
    visuals.push(visual);
    stars.append(visual);
  }

  const label = el("span", {
    className: "rating-picker__label",
    text: options.summary,
    attrs: { "aria-live": "polite" }
  });
  const choices = el("span", { className: "rating-picker__choices" });

  const paint = (value: number, preview = false): void => {
    visuals.forEach((visual, index) => {
      visual.dataset.fill = starFill(value, index + 1);
    });
    label.textContent = preview ? `${formattedRating(value)} / 5` : options.summary;
  };
  const restore = (): void => paint(options.value);

  for (let step = 1; step <= 10; step += 1) {
    const value = step / 2;
    const choice = el("button", {
      className: "rating-picker__choice",
      attrs: {
        type: "button",
        "aria-label": t("Oceń na {value} z 5", { value: formattedRating(value) }),
        ...(options.disabled ? { disabled: true } : {})
      },
      dataset: { value }
    });
    choice.addEventListener("pointerenter", () => paint(value, true));
    choice.addEventListener("focus", () => paint(value, true));
    choice.addEventListener("click", (event) => {
      event.stopPropagation();
      if (options.disabled) return;
      choices.querySelectorAll("button").forEach((button) => { button.setAttribute("disabled", ""); });
      void Promise.resolve(options.onSelect(value)).catch(() => {
        choices.querySelectorAll("button").forEach((button) => { button.removeAttribute("disabled"); });
        restore();
      });
    });
    choices.append(choice);
  }

  stars.append(choices);
  const picker = el(
    "div",
    { className: "rating-picker", attrs: { role: "group", "aria-label": options.ariaLabel } },
    stars,
    label
  );
  picker.addEventListener("pointerleave", restore);
  picker.addEventListener("focusout", (event) => {
    if (!picker.contains(event.relatedTarget as Node | null)) restore();
  });
  return picker;
}
