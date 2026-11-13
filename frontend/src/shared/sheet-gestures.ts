import { prefersReducedMotion } from "./motion";
import { sheetOffset, sheetShouldClose } from "./motion-math";

/**
 * A sheet can be pulled down to close it.
 *
 * On a phone a dialog stands on the bottom edge of the screen (styles: the
 * `34rem` rules of library.css and motion.css), and something that came up from
 * the bottom is expected to go back down under a thumb. The pull starts on the
 * sheet's own top — its handle and its header — never on its content, which has
 * to stay scrollable, and never on a control.
 *
 * What "close" means is the sheet's own business: every dialog here closes on a
 * press of its backdrop, so a pull that goes far enough presses the backdrop.
 * One listener for every sheet there is or will be; nothing to register.
 *
 * The player's own sheet (the open player on a phone) names its closing control
 * itself: an element with `data-sheet` is a sheet, and `data-sheet-close` inside
 * it (or the backdrop beside it) is what a pull presses. While that press is
 * being handled the sheet carries `data-pulled-by` — how many pixels down the
 * finger left it — for a sheet that animates its own closing and should start
 * it from there, not from its resting place.
 */

const SHEET = ".dialog__panel, [data-sheet]";
/** Where a pull may start: the top strip of the sheet, as tall as the handle and a header. */
const GRIP_HEIGHT = 72;
const PHONE = "(max-width: 34rem)";

interface Pull {
  sheet: HTMLElement;
  startY: number;
  startX: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  moved: boolean;
}

let installed = false;

function closeControl(sheet: HTMLElement): HTMLElement | null {
  const named = sheet.querySelector<HTMLElement>("[data-sheet-close]");
  if (named) return named;
  const dialog = sheet.closest<HTMLElement>(".dialog");
  return dialog?.querySelector<HTMLElement>(".dialog__backdrop") ?? null;
}

function isSheetNow(sheet: HTMLElement): boolean {
  // A dialog is a sheet only at phone width; an element that says it is one decides for itself.
  return sheet.matches("[data-sheet]") ? sheet.dataset.sheet !== "false" : window.matchMedia(PHONE).matches;
}

export function installSheetGestures(): void {
  if (installed) return;
  installed = true;
  let pull: Pull | null = null;

  const release = (close: boolean): void => {
    if (!pull) return;
    const { sheet } = pull;
    const offset = Math.max(0, Math.round(sheetOffset(pull.lastY - pull.startY)));
    pull = null;
    sheet.classList.remove("is-dragging");
    // Back to the stylesheet's own value: from where the finger left it, the
    // sheet travels home, or on to the bottom edge if it is closing.
    sheet.style.removeProperty("translate");
    if (!close) return;
    sheet.dataset.pulledBy = String(offset);
    try {
      closeControl(sheet)?.click();
    } finally {
      delete sheet.dataset.pulledBy;
    }
  };

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
    const sheet = event.target.closest<HTMLElement>(SHEET);
    if (!sheet || !isSheetNow(sheet)) return;
    // A control is pressed, not pulled; so is anything inside a scrolled list.
    if (event.target.closest("button, a, input, select, textarea, [role='slider'], [data-no-pull]")) return;
    const touch = event.touches[0]!;
    if (touch.clientY - sheet.getBoundingClientRect().top > GRIP_HEIGHT) return;
    pull = { sheet, startY: touch.clientY, startX: touch.clientX, lastY: touch.clientY, lastTime: event.timeStamp, velocity: 0, moved: false };
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!pull) return;
    const touch = event.touches[0];
    if (!touch) return;
    const distance = touch.clientY - pull.startY;
    if (!pull.moved) {
      // Sideways, or not yet far enough to be a pull: leave it to the browser.
      if (Math.abs(touch.clientX - pull.startX) > Math.abs(distance) + 4) {
        pull = null;
        return;
      }
      if (Math.abs(distance) < 6) return;
      pull.moved = true;
      pull.sheet.classList.add("is-dragging");
    }
    const elapsed = Math.max(1, event.timeStamp - pull.lastTime);
    pull.velocity = (touch.clientY - pull.lastY) / elapsed;
    pull.lastY = touch.clientY;
    pull.lastTime = event.timeStamp;
    if (!prefersReducedMotion()) pull.sheet.style.translate = `0 ${sheetOffset(distance)}px`;
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!pull) return;
    const distance = pull.lastY - pull.startY;
    release(pull.moved && sheetShouldClose(distance, pull.sheet.getBoundingClientRect().height, pull.velocity));
  }, { passive: true });

  document.addEventListener("touchcancel", () => release(false), { passive: true });
}
