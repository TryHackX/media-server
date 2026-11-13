import { el } from "../../shared/dom";
import { formatCount } from "../../shared/format";
import { t } from "../../shared/i18n";
import type { Previews } from "./previews";

/** How many cards are on the page at once, and how far the window moves when it runs out. */
const WINDOW_SIZE = 240;
const WINDOW_STEP = 96;

export interface GridWindowOptions {
  grid: HTMLElement;
  previews: Previews;
  /** What an empty listing says. */
  emptyText: () => string;
  /** Whether the server has more of this listing than the cards held here. */
  hasMore: () => boolean;
  /** Ask for the next part of the listing; settles when its cards have been added. */
  loadNextPage: () => Promise<void>;
}

export interface GridWindow {
  /**
   * Every card of the listing, drawn or not. The page fills it, adds to it and
   * may reorder it; `draw` then shows the part the window stands on.
   */
  cards: HTMLElement[];
  /** The first card that is drawn. */
  start: number;
  /** Put the window on the page; with a key, keep that card where it was on screen. */
  draw(preserveKey?: string, preserveTop?: number): void;
  dispose(): void;
}

/** Name a card, so the window can find it again after it has redrawn. */
export function markCard(card: HTMLElement, key: string): HTMLElement {
  card.dataset.windowKey = key;
  return card;
}

/**
 * The part of a long listing that is on the page.
 *
 * A folder of twelve thousand tracks is not twelve thousand cards in the
 * document: 240 are, and a control at either end moves the window — pressed by
 * hand, or by itself when it scrolls near (an observer presses it). Moving it
 * keeps the card under the reader's eye where it was.
 */
export function createGridWindow(options: GridWindowOptions): GridWindow {
  const { grid, previews } = options;
  let busy = false;
  const cardKey = (card: HTMLElement, fallback: number): string => card.dataset.windowKey ?? `card:${fallback}`;
  const observer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    if (busy) return;
    const target = entries.find((entry) => entry.isIntersecting)?.target;
    if (target instanceof HTMLButtonElement) target.click();
  }, { rootMargin: "700px 0px" }) : null;

  const self: GridWindow = {
    cards: [],
    start: 0,
    draw(preserveKey = "", preserveTop = 0): void {
      observer?.disconnect();
      for (const card of Array.from(grid.querySelectorAll<HTMLElement>(".media-card"))) previews.setActivity(card, false);
      if (self.cards.length === 0) {
        grid.replaceChildren(el("div", { className: "empty-state" }, el("p", { text: options.emptyText() })));
        return;
      }
      const maxStart = Math.max(0, self.cards.length - WINDOW_SIZE);
      self.start = Math.max(0, Math.min(self.start, maxStart));
      const end = Math.min(self.cards.length, self.start + WINDOW_SIZE);
      const fragment = document.createDocumentFragment();
      let topControl: HTMLButtonElement | null = null;
      let bottomControl: HTMLButtonElement | null = null;
      if (self.start > 0) {
        topControl = el("button", {
          className: "media-grid__window-control",
          attrs: { type: "button" },
          text: t("Pokaż wcześniejsze pozycje ({count})", { count: formatCount(self.start) })
        });
        topControl.addEventListener("click", () => shift(Math.max(0, self.start - WINDOW_STEP)));
        fragment.append(topControl);
      }
      self.cards.slice(self.start, end).forEach((card) => {
        previews.setActivity(card, true);
        fragment.append(card);
      });
      if (end < self.cards.length || options.hasMore()) {
        bottomControl = el("button", {
          className: "media-grid__window-control",
          attrs: { type: "button" },
          text: end < self.cards.length ? t("Pokaż kolejne pozycje") : t("Wczytaj kolejną część katalogu")
        });
        bottomControl.addEventListener("click", () => {
          if (busy) return;
          if (end < self.cards.length) {
            shift(Math.min(maxStart, self.start + WINDOW_STEP));
            return;
          }
          if (!options.hasMore()) return;
          busy = true;
          void options.loadNextPage().then(() => {
            busy = false;
            shift(Math.min(Math.max(0, self.cards.length - WINDOW_SIZE), self.start + WINDOW_STEP));
          }).finally(() => {
            busy = false;
          });
        });
        fragment.append(bottomControl);
      }
      grid.replaceChildren(fragment);
      if (preserveKey) {
        window.requestAnimationFrame(() => {
          const anchor = Array.from(grid.querySelectorAll<HTMLElement>(".media-card")).find((card, index) => cardKey(card, index) === preserveKey);
          if (anchor) window.scrollBy({ top: anchor.getBoundingClientRect().top - preserveTop });
        });
      }
      if (topControl) observer?.observe(topControl);
      if (bottomControl) observer?.observe(bottomControl);
    },
    dispose(): void {
      observer?.disconnect();
    }
  };

  const shift = (nextStart: number): void => {
    if (nextStart === self.start) return;
    const overlapIndex = Math.max(self.start, nextStart);
    const anchorCard = self.cards[overlapIndex];
    const key = anchorCard ? cardKey(anchorCard, overlapIndex) : "";
    const visibleAnchor = key
      ? Array.from(grid.querySelectorAll<HTMLElement>(".media-card")).find((card, index) => cardKey(card, index) === key)
      : null;
    const top = visibleAnchor?.getBoundingClientRect().top ?? 0;
    self.start = nextStart;
    self.draw(key, top);
  };

  return self;
}
