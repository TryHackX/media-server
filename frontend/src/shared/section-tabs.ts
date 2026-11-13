import { el } from "./dom";
import { icon, type IconName } from "./icons";
import { flipFrom, prefersReducedMotion } from "./motion";

export interface SectionTab {
  id: string;
  label: string;
  glyph: IconName;
}

/**
 * A row of section buttons over one stage: a page that is really several pages.
 *
 * The administration panel split itself this way first, because one long page
 * hid everything below the fold; the account page had the same problem — the
 * sessions list and the import sat nine screens down — and now shares the
 * pattern and its styles. The open section is the URL hash, so a link or a
 * reload lands on it.
 *
 * On a phone the row does not fit and scrolls sideways. It used to say nothing
 * about that: icons without names, cut off at the edge of the screen, with
 * three sections of the panel and its refresh button out of sight. The names
 * stay now (small, under the icons), the open section is brought into view, and
 * the row tells the stylesheet which of its ends has more beyond it
 * (`data-more-start` / `data-more-end`), so that edge fades instead of ending
 * in half a button.
 *
 * The mark of the open section is one element that travels: it slides from the
 * section that was open to the one that is, instead of going out in one place
 * and coming on in another. Given the `stage`, what the section shows arrives
 * with a short rise — a change of section should read as one page turning, not
 * as the page being cut.
 */
export function sectionTabs(options: {
  label: string;
  tabs: readonly SectionTab[];
  onOpen: (id: string) => void;
  /** Something that travels with the tabs at the end of the row (the panel's refresh button). */
  trailing?: HTMLElement | null;
  /** Where `onOpen` puts the section; it arrives with a short rise after every change but the first. */
  stage?: HTMLElement | null;
}): { bar: HTMLElement; open: (id: string) => void } {
  // The mark of the open section. Decoration only: the buttons say which is
  // open (`aria-current`), and a browser without the mark shows the button's own.
  const pill = el("span", { className: "admin-subnav__pill", attrs: { "aria-hidden": "true" } });
  const nav = el("nav", { className: "admin-subnav", attrs: { "aria-label": options.label } }, pill);
  const bar = el("div", { className: "admin-subnav-bar" }, nav);
  let opened: string | null = null;

  const markOverflow = (): void => {
    const hidden = nav.scrollWidth - nav.clientWidth;
    bar.toggleAttribute("data-more-start", hidden > 1 && nav.scrollLeft > 1);
    bar.toggleAttribute("data-more-end", hidden > 1 && nav.scrollLeft < hidden - 1);
  };
  /** Put the mark on the open section's button; `travel` slides it there from where it was. */
  const placePill = (travel: boolean): void => {
    const active = nav.querySelector<HTMLElement>("button[data-section].is-active");
    if (!active || active.offsetWidth === 0) {
      pill.hidden = true;
      delete nav.dataset.pill;
      return;
    }
    const first = pill.hidden ? null : pill.getBoundingClientRect();
    pill.hidden = false;
    nav.dataset.pill = "true";
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.height = `${active.offsetHeight}px`;
    pill.style.translate = `${active.offsetLeft}px ${active.offsetTop}px`;
    if (travel && first && !prefersReducedMotion()) flipFrom(pill, first, { duration: 220 });
  };
  nav.addEventListener("scroll", markOverflow, { passive: true });
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      markOverflow();
      // The row wrapped differently, or its font arrived: the mark follows its button.
      placePill(false);
    }).observe(nav);
  }

  const open = (id: string): void => {
    const tab = options.tabs.find((entry) => entry.id === id) ?? options.tabs[0];
    if (!tab) return;
    for (const button of Array.from(nav.querySelectorAll<HTMLButtonElement>("button[data-section]"))) {
      const selected = button.dataset.section === tab.id;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
      // Sideways only, and only as far as needed: the page itself must not jump.
      if (selected && nav.scrollWidth > nav.clientWidth) {
        const left = button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2;
        nav.scrollTo({ left: Math.max(0, left), behavior: "auto" });
      }
    }
    markOverflow();
    const changed = opened !== null && opened !== tab.id;
    placePill(changed);
    opened = tab.id;
    if (window.location.hash.slice(1) !== tab.id) window.history.replaceState(null, "", `#${tab.id}`);
    options.onOpen(tab.id);
    const stage = options.stage;
    if (changed && stage && !prefersReducedMotion() && typeof stage.animate === "function") {
      stage.animate(
        [{ opacity: 0, transform: "translateY(0.35rem)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
      );
    }
  };
  for (const tab of options.tabs) {
    const button = el("button", {
      className: "admin-subnav__item",
      attrs: { type: "button" }
    }, icon(tab.glyph), el("span", { className: "admin-subnav__label", text: tab.label })) as HTMLButtonElement;
    button.dataset.section = tab.id;
    button.addEventListener("click", () => open(tab.id));
    nav.append(button);
  }
  // Inside the row, so it flows with the sections and takes the end of the last
  // line; in a column of its own it squeezed them into three rows.
  if (options.trailing) nav.append(options.trailing);
  return { bar, open };
}
