/**
 * Modal behaviour shared by every dialog that lives on document.body: while a
 * dialog is open the rest of the page is `inert` (unfocusable, unclickable, hidden
 * from assistive tech), focus moves into the dialog and returns to the invoking
 * element on close, and Escape closes it. Dialogs opt in with `openModal()` and
 * release with the returned function.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalOptions {
  /** Called on Escape (after leaving fullscreen, if any). */
  onEscape?: () => void;
  /** Element to focus first; defaults to the first focusable control, then the dialog itself. */
  initialFocus?: HTMLElement | null;
}

/** Open dialogs in stacking order, each with the siblings it made inert. */
const openDialogs = new Map<HTMLElement, HTMLElement[]>();

export function openModal(dialog: HTMLElement, options: ModalOptions = {}): () => void {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const madeInert = Array.from(document.body.children).filter(
    (node): node is HTMLElement =>
      node instanceof HTMLElement && node !== dialog && !openDialogs.has(node) && !node.inert
  );
  for (const node of madeInert) node.inert = true;
  openDialogs.set(dialog, madeInert);
  if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");

  const isTopmost = (): boolean => Array.from(openDialogs.keys()).pop() === dialog;
  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !isTopmost()) return;
    event.preventDefault();
    event.stopPropagation();
    // First Escape leaves fullscreen (the browser may swallow it there anyway); the
    // next one closes the dialog, which is what people expect from a video viewer.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    options.onEscape?.();
  };
  // Capture phase: nothing inside the dialog (or a stray stopPropagation) can eat it.
  document.addEventListener("keydown", keydown, true);

  const target = options.initialFocus ?? dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
  // Focus now (the dialog is already displayed) and again after layout, using a
  // timer rather than rAF so it also happens in a background tab.
  target.focus({ preventScroll: true });
  window.setTimeout(() => { if (!dialog.contains(document.activeElement)) target.focus({ preventScroll: true }); }, 0);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    document.removeEventListener("keydown", keydown, true);
    openDialogs.delete(dialog);
    const stillHeld = new Set(Array.from(openDialogs.values()).flat());
    for (const node of madeInert) {
      if (!stillHeld.has(node)) node.inert = false;
    }
    if (openDialogs.size === 0 && previouslyFocused?.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    }
  };
}
