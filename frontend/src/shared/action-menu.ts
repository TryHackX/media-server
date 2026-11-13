import { el } from "./dom";
import { icon, type IconName } from "./icons";
import { dismiss } from "./motion";
import { placeMenu } from "./action-menu-place";

export interface MenuAction {
  label: string;
  icon: IconName;
  /** Runs when the entry is chosen; the menu has closed by then. */
  run: () => void;
  /** Said of an entry that is a state as well as an action (a favourite that is one already). */
  active?: boolean;
  /** The glyph turned to point up or down (the icon set has a chevron, and it points right). */
  turn?: "up" | "down";
}

export interface ActionMenuOptions {
  /** What the menu is of, for a screen reader ("Więcej: Ritual"). */
  label: string;
  actions: MenuAction[];
  /** Something to stand above the entries: a card too small for its stars carries them here. */
  header?: HTMLElement | null;
}

let closeOpenMenu: (() => void) | null = null;

/**
 * A short menu that opens at the control that asked for it: the rest of what
 * can be done with a card, behind its "⋯".
 *
 * It is laid on <body>, not inside the card — a card clips what it holds — and
 * placed beside its button: below and flush with it where there is room, above
 * where there is not, never past the edge of the screen. One at a time; a press
 * anywhere else, Escape, a scroll or a page change closes it. The arrow keys
 * walk the entries, Home and End jump, Tab leaves and closes.
 *
 * Returns the function that closes it; `onClose` hears of it however it closed.
 */
export function openActionMenu(anchor: HTMLElement, options: ActionMenuOptions, onClose?: () => void): () => void {
  closeOpenMenu?.();
  const menu = el("div", { className: "action-menu", attrs: { role: "menu", "aria-label": options.label, "aria-hidden": "false" } });
  const events = new AbortController();
  let closed = false;
  const close = (returnFocus = false): void => {
    if (closed) return;
    closed = true;
    closeOpenMenu = null;
    events.abort();
    anchor.setAttribute("aria-expanded", "false");
    if (returnFocus) anchor.focus({ preventScroll: true });
    dismiss(menu);
    onClose?.();
  };

  if (options.header) menu.append(el("div", { className: "action-menu__header" }, options.header));
  const entries: HTMLButtonElement[] = options.actions.map((action) => {
    const entry = el(
      "button",
      {
        className: "action-menu__item" + (action.active ? " is-active" : ""),
        attrs: { type: "button", role: "menuitem", tabindex: "-1" },
        ...(action.turn ? { dataset: { turn: action.turn } } : {})
      },
      icon(action.icon),
      el("span", { text: action.label })
    ) as HTMLButtonElement;
    entry.addEventListener("click", () => {
      close(true);
      action.run();
    });
    return entry;
  });
  menu.append(...entries);
  document.body.append(menu);

  // Beside the button that opened it, inside the screen.
  const place = (): void => {
    const position = placeMenu(anchor.getBoundingClientRect(), { width: menu.offsetWidth, height: menu.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    menu.dataset.side = position.above ? "above" : "below";
  };
  place();
  anchor.setAttribute("aria-expanded", "true");
  (entries[0] ?? menu).focus({ preventScroll: true });

  const { signal } = events;
  document.addEventListener("pointerdown", (event) => {
    // A press on the button itself is the button's to answer (it closes what it opened).
    if (!(event.target instanceof Node) || menu.contains(event.target) || anchor.contains(event.target)) return;
    close();
  }, { signal, capture: true });
  menu.addEventListener("keydown", (event) => {
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number): void => {
      event.preventDefault();
      entries[(to + entries.length) % entries.length]?.focus({ preventScroll: true });
    };
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close();
    } else if (entries.length === 0) {
      return;
    } else if (event.key === "ArrowDown") {
      move(index + 1);
    } else if (event.key === "ArrowUp") {
      move(index < 0 ? entries.length - 1 : index - 1);
    } else if (event.key === "Home") {
      move(0);
    } else if (event.key === "End") {
      move(entries.length - 1);
    }
  }, { signal });
  // It stands at a fixed place on the screen: when what it belongs to moves away, it goes.
  window.addEventListener("scroll", (event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    close();
  }, { signal, capture: true, passive: true });
  window.addEventListener("resize", () => close(), { signal });
  document.addEventListener("media:route-will-change", () => close(), { signal });

  closeOpenMenu = close;
  return () => close();
}

/**
 * Make a button open a menu: pressed, it opens; pressed again, it closes. The
 * entries are asked for each time, so they say what is true at that moment.
 */
export function attachActionMenu(anchor: HTMLElement, options: () => ActionMenuOptions): void {
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "false");
  let close: (() => void) | null = null;
  anchor.addEventListener("click", (event) => {
    event.stopPropagation();
    if (close) {
      close();
      return;
    }
    close = openActionMenu(anchor, options(), () => { close = null; });
  });
}
