import { DURATION, EASE_EXIT, EASE_OUT, flipInvert, flipTransform } from "./motion-math";

/**
 * Motion driven from script: the cases a stylesheet cannot describe, because
 * the start or the end of the movement is only known once the page has changed.
 *
 * Three rules hold for everything here, the same three as in styles/motion.css:
 *
 * - only `opacity` and `transform` (and their individual forms) are animated —
 *   both run on the compositor, neither lays the page out again;
 * - nothing moves for somebody who asked the system for less motion: each
 *   helper then does its job at once, with no animation at all;
 * - an animation never holds the work back. The change it decorates has already
 *   happened by the time it runs, so one that is interrupted, skipped or never
 *   supported leaves the page exactly right.
 */

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The kinds of whole-page change the stylesheet times differently (`html[data-vt]`). */
export type TransitionKind = "page" | "swap" | "theme";

export interface StartedTransition {
  /** Resolves when the page has been changed (not when the animation ends). */
  updated: Promise<void>;
  /** Resolves when the old and new pictures are about to start moving; never rejects. */
  ready: Promise<boolean>;
}

let transitionToken = 0;

/**
 * Change the page inside a view transition: the browser keeps a picture of the
 * page as it was, runs `update`, and cross-fades to the page as it is
 * (styles/motion.css). The picture of the new page is live, so anything that
 * arrives or animates during the fade simply shows.
 *
 * Where the browser has no view transitions, or the reader asked for reduced
 * motion, `update` runs directly — the same change, without the fade.
 */
export function startTransition(kind: TransitionKind, update: () => void | Promise<void>): StartedTransition {
  const root = document.documentElement;
  // A transition already in flight is not interrupted by another: starting one
  // would skip the first — a page change cut short because the new page's data
  // happened to arrive during it. The change is simply made; the picture of the
  // new state is live, so it shows inside the transition that is running.
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion() || document.visibilityState !== "visible"
      || root.dataset.vt !== undefined) {
    const updated = Promise.resolve().then(update);
    return { updated, ready: Promise.resolve(false) };
  }
  const token = ++transitionToken;
  // Before the browser takes its picture of the old page: the stylesheet names
  // parts of the page by this (the title, in a page change).
  root.dataset.vt = kind;
  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(() => update());
  } catch {
    delete root.dataset.vt;
    return { updated: Promise.resolve().then(update), ready: Promise.resolve(false) };
  }
  const clear = (): void => {
    if (token === transitionToken) delete root.dataset.vt;
  };
  // A transition that is skipped (another one began, the tab went to the
  // background) rejects these two; the page was changed all the same.
  void transition.finished.then(clear, clear);
  return {
    updated: transition.updateCallbackDone,
    ready: transition.ready.then(() => true, () => false)
  };
}

/** `startTransition` for a change that is one synchronous step; resolves when it has been made. */
export function viewTransition(update: () => void | Promise<void>, kind: TransitionKind = "swap"): Promise<void> {
  return startTransition(kind, update).updated;
}

/**
 * A new page's content rises into place (the content only: the sidebar, the
 * header and the player stay where they are). With `fade` it also fades in —
 * for a browser without view transitions, where nothing else does.
 */
export function pageRise(content: HTMLElement, fade: boolean): void {
  if (typeof content.animate !== "function" || prefersReducedMotion()) return;
  for (const running of content.getAnimations()) {
    if (running instanceof Animation && running.id === "page-rise") running.cancel();
  }
  const animation = content.animate(
    [
      { opacity: fade ? 0 : 1, transform: "translateY(0.5rem)" },
      { opacity: 1, transform: "translateY(0)" }
    ],
    { duration: 280, easing: EASE_OUT }
  );
  animation.id = "page-rise";
}

/**
 * FLIP: let `element` travel from where it is now to where `mutate` leaves it.
 *
 * `mutate` changes the page (a class, a move in the DOM); the element is then
 * drawn where it used to be and released to its new place. Returns the
 * animation, or null when nothing moved or motion is reduced.
 */
export function flip(element: HTMLElement, mutate: () => void, options: { duration?: number; easing?: string } = {}): Animation | null {
  if (prefersReducedMotion() || typeof element.animate !== "function") {
    mutate();
    return null;
  }
  const first = element.getBoundingClientRect();
  mutate();
  return flipFrom(element, first, options);
}

/** The second half of `flip`, for a caller that had to measure before a change it does not make itself. */
export function flipFrom(element: HTMLElement, first: DOMRect, options: { duration?: number; easing?: string } = {}): Animation | null {
  if (prefersReducedMotion() || typeof element.animate !== "function" || !element.isConnected) return null;
  const delta = flipInvert(first, element.getBoundingClientRect());
  if (!delta) return null;
  return element.animate(
    [{ transformOrigin: "0 0", transform: flipTransform(delta) }, { transformOrigin: "0 0", transform: "none" }],
    { duration: options.duration ?? DURATION.slow, easing: options.easing ?? EASE_OUT }
  );
}

/**
 * Take one child out of a list: it shrinks a little and fades, and the ones
 * after it close the gap by sliding rather than jumping. `removed` runs once
 * the child is out of the page.
 */
export function removeFromList(child: HTMLElement, removed?: () => void): void {
  const parent = child.parentElement;
  const finish = (): void => {
    const siblings = parent ? Array.from(parent.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== child) : [];
    const before = new Map(siblings.map((node) => [node, node.getBoundingClientRect()]));
    child.remove();
    removed?.();
    if (prefersReducedMotion()) return;
    for (const [node, first] of before) flipFrom(node, first, { duration: 240 });
  };
  if (prefersReducedMotion() || typeof child.animate !== "function") {
    finish();
    return;
  }
  // Out of reach at once: a second press on a card that is leaving must do nothing.
  child.inert = true;
  const leaving = child.animate(
    [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.96)" }],
    { duration: 160, easing: EASE_EXIT, fill: "forwards" }
  );
  leaving.finished.then(finish, finish);
}

/** A CSS time ("150ms", "0.26s") in milliseconds; zero for anything else. */
function cssTime(value: string): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  return value.trim().endsWith("ms") ? amount : amount * 1000;
}

/**
 * Close a dialog that is taken out of the page when it closes.
 *
 * The stylesheet animates the closing of anything hidden with `aria-hidden`
 * (styles/motion.css) and says how long that takes in `--dialog-exit` — a fade
 * on a wide screen, a sheet sliding away on a phone. The element is removed
 * when that time is up; at once under reduced motion. An element that has been
 * opened again by then is left where it is.
 */
export function dismiss(element: HTMLElement): void {
  element.setAttribute("aria-hidden", "true");
  const wait = prefersReducedMotion() || !element.isConnected
    ? 0
    : cssTime(getComputedStyle(element).getPropertyValue("--dialog-exit"));
  if (wait <= 0) {
    element.remove();
    return;
  }
  window.setTimeout(() => {
    if (element.getAttribute("aria-hidden") === "true") element.remove();
  }, wait + 30);
}

/** One short keyed animation on an element (a heart that pops): restarts when asked again mid-way. */
export function pulse(element: HTMLElement, className: string, duration: number): void {
  if (prefersReducedMotion()) return;
  element.classList.remove(className);
  // Reading a layout property between the two makes the browser see them as two states.
  void element.offsetWidth;
  element.classList.add(className);
  window.setTimeout(() => element.classList.remove(className), duration + 40);
}
