/**
 * What the screen keeps from the page while somebody types on a phone.
 *
 * An on-screen keyboard comes up in one of two ways, depending on the browser
 * and its version. Either it is laid *over* the page — the page keeps its
 * height and its bottom edge is simply out of sight (iOS, Chrome on Android
 * since 108) — or the page is made shorter and everything fixed to the bottom
 * edge rides up on top of the keyboard. Neither is told to the stylesheet.
 *
 * This tells it, as two facts on `<html>`:
 *
 * - `--keyboard-inset`: how much of the bottom of the page is covered, in
 *   pixels (zero when nothing is, and in the second way always). A sheet that
 *   stands on the bottom edge adds it as padding and stays above the keyboard;
 * - the class `has-keyboard` while a keyboard is up in either way. The player's
 *   bar steps aside then: in the first way it is under the keyboard anyway, in
 *   the second it would sit between the keyboard and the field being typed in,
 *   on a screen that has a few centimetres left.
 */

const EDITABLE = 'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="file"]), textarea, [contenteditable=""], [contenteditable="true"]';

/** The tallest the page has been at each width: what it measures without a keyboard. */
const tallest = new Map<number, number>();

let installed = false;

export function trackKeyboard(): void {
  if (installed) return;
  installed = true;
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const coarse = window.matchMedia("(pointer: coarse)");
  let lastInset = -1;
  let lastOpen: boolean | null = null;
  const update = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    tallest.set(width, Math.max(tallest.get(width) ?? 0, height));
    // A page pinched larger also has a smaller visual viewport; that is not a keyboard.
    const zoomed = viewport ? Math.abs(viewport.scale - 1) > 0.01 : false;
    const covered = viewport && !zoomed ? Math.max(0, Math.round(height - viewport.height - viewport.offsetTop)) : 0;
    const inset = covered > 80 ? covered : 0;
    const shrunk = (tallest.get(width) ?? height) - height > 120;
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && active.matches(EDITABLE);
    const open = coarse.matches && typing && (inset > 0 || shrunk);
    if (inset !== lastInset) {
      lastInset = inset;
      root.style.setProperty("--keyboard-inset", `${inset}px`);
    }
    if (open !== lastOpen) {
      lastOpen = open;
      root.classList.toggle("has-keyboard", open);
    }
  };
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  // The keyboard follows the focus by a few frames; ask again once it has had time to move.
  const later = (): void => {
    update();
    window.setTimeout(update, 350);
  };
  document.addEventListener("focusin", later);
  document.addEventListener("focusout", later);
  update();
}
