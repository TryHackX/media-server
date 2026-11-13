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
  /**
   * Children of <body> that stay usable while the dialog is open: the player's
   * dock beside its queue, which sits above the queue's backdrop on purpose, and
   * that backdrop itself, which closes the panel on a click.
   */
  alsoActive?: readonly HTMLElement[];
}

/** Open dialogs in stacking order, each with the siblings it made inert. */
const openDialogs = new Map<HTMLElement, HTMLElement[]>();

/**
 * The page under an open dialog does not scroll (styles: base.css). Inert as it
 * is, it used to: a wheel or a finger over the dialog's header, its backdrop or
 * a body at its end went on to the page. `data-scrollbar` says the page showed a
 * scrollbar when the first dialog opened, whose place is then kept.
 */
function holdPage(held: boolean): void {
  const root = document.documentElement;
  if (held === root.classList.contains("has-open-dialog")) return;
  root.toggleAttribute("data-scrollbar", held && root.scrollHeight > root.clientHeight);
  root.classList.toggle("has-open-dialog", held);
}

export function openModal(dialog: HTMLElement, options: ModalOptions = {}): () => void {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const keep = new Set(options.alsoActive ?? []);
  // `data-modal-exempt` marks what belongs to no page and no dialog — the
  // tooltip, the region short messages are read from — and has to keep working
  // over both.
  const madeInert = Array.from(document.body.children).filter(
    (node): node is HTMLElement =>
      node instanceof HTMLElement && node !== dialog && !keep.has(node) && !openDialogs.has(node) && !node.inert
      && node.dataset.modalExempt === undefined
  );
  for (const node of madeInert) node.inert = true;
  openDialogs.set(dialog, madeInert);
  holdPage(true);
  // A dialog opened from inside another one may have been made inert by it,
  // along with the rest of the page: every dialog that lives on <body> from the
  // start (the tag editor, the playlist picker, the film viewer) was, the moment
  // the queue panel opened — and then appeared on top of it deaf to every click
  // and key. The one being opened is the one thing that must not be inert.
  dialog.inert = false;
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

  // Never a backdrop. Every dialog here opens with its full-screen backdrop as the
  // first button, so "the first focusable control" was that backdrop — and Space,
  // the key everyone presses to pause a film, "clicked" it and closed the viewer.
  // An element with a negative tabindex is not meant to be tabbed to either.
  const target = options.initialFocus
    ?? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
      (candidate) => candidate.tabIndex >= 0 && !/(^|\s|__)backdrop(\s|$)/.test(candidate.className)
    )
    ?? dialog;
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
    if (openDialogs.size === 0) holdPage(false);
    const stillHeld = new Set(Array.from(openDialogs.values()).flat());
    for (const node of madeInert) {
      if (!stillHeld.has(node)) node.inert = false;
    }
    // Closed again under a dialog that is still open: back among what that one holds.
    if (stillHeld.has(dialog)) dialog.inert = true;
    // Back to whatever had the focus when this dialog opened — also when another
    // dialog is still open underneath, where that element lives: a question
    // asked from inside the tag editor returns to the button that asked it. It
    // used to be restored only after the last dialog closed, so closing an inner
    // one dropped the focus on <body> and the outer dialog lost the keyboard.
    // An element that is gone, or inert under a dialog still open, is left alone.
    if (previouslyFocused?.isConnected && previouslyFocused.closest("[inert]") === null) {
      previouslyFocused.focus({ preventScroll: true });
    }
  };
}
