import { el } from "./dom";
import { formatCount } from "./format";
import { icon } from "./icons";
import { t } from "./i18n";

export interface CollapsibleFilters {
  /** Goes where the panel used to be appended; it holds the panel. */
  wrapper: HTMLElement;
  /** The "Filters" switch. CSS shows it only on narrow screens. */
  toggle: HTMLButtonElement;
  /** How many filters differ from their default — shown on the switch. */
  setActiveCount(count: number): void;
}

let sequence = 0;

/**
 * Fold a panel of filters away on a phone.
 *
 * Every library page opened with its filters spread out in full: six selects on
 * the film library, five on music, four on collections. On a desktop that is a
 * strip under the toolbar; on a phone it was the entire first screen, so the
 * page showed controls for a list without showing one item of the list.
 *
 * On narrow screens the panel now starts folded behind a "Filters" switch that
 * counts how many filters are set, so a filtered view never looks unfiltered.
 * On wide screens the CSS ignores the folded state and the switch is not shown,
 * so nothing changes there.
 *
 * The fold animates its height — `grid-template-rows` from `0fr` to `1fr`, the
 * one height transition that needs no measuring — and the folded content is
 * `visibility: hidden` once it has closed, which also takes it out of the tab
 * order, so a keyboard never lands in a select nobody can see.
 */
export function collapsibleFilters(panel: HTMLElement): CollapsibleFilters {
  const id = panel.id || `filter-panel-${++sequence}`;
  panel.id = id;
  const wrapper = el(
    "div",
    { className: "filter-fold", dataset: { collapsed: "true" } },
    el("div", { className: "filter-fold__inner" }, panel)
  );
  const badge = el("span", { className: "filter-toggle__badge hidden", attrs: { "aria-hidden": "true" } });
  const label = el("span", { className: "filter-toggle__label", text: t("Filtry") });
  const toggle = el(
    "button",
    {
      className: "button button--secondary filter-toggle",
      attrs: { type: "button", "aria-expanded": "false", "aria-controls": id }
    },
    icon("filter"),
    label,
    badge
  );
  toggle.addEventListener("click", () => {
    const opening = wrapper.dataset.collapsed === "true";
    wrapper.dataset.collapsed = String(!opening);
    toggle.setAttribute("aria-expanded", String(opening));
  });
  return {
    wrapper,
    toggle,
    setActiveCount(count: number): void {
      badge.textContent = count > 0 ? formatCount(count) : "";
      badge.classList.toggle("hidden", count === 0);
      toggle.classList.toggle("is-active", count > 0);
      // The number is decoration for the eye; the name says it for everyone else.
      toggle.setAttribute("aria-label", count > 0 ? t("Filtry (aktywne: {count})", { count }) : t("Filtry"));
    }
  };
}
