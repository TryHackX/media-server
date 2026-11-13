let installed = false;

/**
 * One tooltip for the whole application, moved to whatever is being pointed at.
 *
 * Any element with `data-tooltip` gets it. It is shown for a mouse resting on
 * the element and for keyboard focus, and for nothing else:
 *
 * - **Not for a tap.** A finger has no "resting on"; it presses. The press used
 *   to leave the button focused, `focusin` showed the tooltip, and nothing ever
 *   took it down again — it sat over the player until something else was tapped.
 *   Focus counts only when the browser itself would draw a focus ring for it
 *   (`:focus-visible`), which is exactly "arrived by keyboard".
 * - **Where it can be seen.** An element shown full screen covers everything on
 *   <body>, the tooltip included, so the tooltip moves into the full-screen
 *   element while there is one (the visualizer's toolbar has tooltips).
 */
export function installFloatingTooltips(): void {
  if (installed) return;
  installed = true;
  const tooltip = document.createElement("div");
  tooltip.className = "floating-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  // Never inert, never in the way: openModal() leaves it alone, and it takes no pointer.
  tooltip.dataset.modalExempt = "true";
  document.body.append(tooltip);
  let active: HTMLElement | null = null;
  let frame = 0;

  /**
   * A tooltip whose anchor is no longer reachable has nothing to explain.
   *
   * Opening a dialog makes the rest of the page `inert`, and an inert element
   * never receives `pointerout` — so the tooltip of the button that opened the
   * dialog stayed on screen, floating over it, and was still there after the
   * dialog closed.
   */
  const stranded = (): boolean =>
    !active || !active.isConnected || active.closest("[inert]") !== null;

  const place = (): void => {
    frame = 0;
    if (stranded()) { hide(); return; }
    if (!active) return;
    const anchor = active.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    const margin = 10;
    const centered = anchor.left + anchor.width / 2 - bounds.width / 2;
    const left = Math.min(window.innerWidth - bounds.width - margin, Math.max(margin, centered));
    const above = anchor.top - bounds.height - margin;
    const top = above >= margin ? above : Math.min(window.innerHeight - bounds.height - margin, anchor.bottom + margin);
    // `translate`, which composes with the `transform` the stylesheet animates;
    // the element itself stays at the top-left corner of the viewport.
    tooltip.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
  };
  /** Scroll and resize fire in bursts; with no tooltip on screen they cost nothing at all. */
  const position = (): void => {
    if (!active || frame) return;
    frame = requestAnimationFrame(place);
  };
  const show = (target: HTMLElement): void => {
    const copy = target.dataset.tooltip?.trim();
    if (!copy) return;
    const host = document.fullscreenElement instanceof HTMLElement && document.fullscreenElement.contains(target)
      ? document.fullscreenElement
      : document.body;
    if (tooltip.parentElement !== host) host.append(tooltip);
    active = target;
    tooltip.textContent = copy;
    tooltip.setAttribute("aria-hidden", "false");
    position();
  };
  const hide = (target?: HTMLElement | null): void => {
    if (target && active !== target) return;
    active = null;
    tooltip.setAttribute("aria-hidden", "true");
  };
  const targetFor = (event: Event): HTMLElement | null =>
    event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null;

  document.addEventListener("pointerover", (event) => {
    // A finger arriving is a press about to happen, not a question.
    if (event.pointerType === "touch") return;
    const target = targetFor(event);
    if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
    show(target);
  });
  document.addEventListener("pointerout", (event) => {
    const target = targetFor(event);
    if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
    hide(target);
  });
  // Pressing the control is the end of the tooltip's usefulness: the reader has
  // decided. This is also the only signal that arrives when the click opens a
  // dialog, because from that moment the button is inert and silent.
  document.addEventListener("pointerdown", (event) => {
    const target = targetFor(event);
    if (target) hide(target);
  }, { capture: true });
  document.addEventListener("focusin", (event) => {
    const target = targetFor(event);
    if (!target) return;
    let byKeyboard = true;
    try { byKeyboard = target.matches(":focus-visible"); } catch { /* an engine without the selector: as before */ }
    if (byKeyboard) show(target);
  });
  document.addEventListener("focusout", (event) => hide(targetFor(event)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  // Leaving full screen takes the full-screen element's children out of sight with it.
  document.addEventListener("fullscreenchange", () => hide());
  window.addEventListener("resize", position, { passive: true });
  window.addEventListener("scroll", position, { passive: true, capture: true });
  new MutationObserver(() => {
    if (!active) return;
    const copy = active.dataset.tooltip?.trim();
    if (!copy) hide();
    else {
      tooltip.textContent = copy;
      position();
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-tooltip"] });
}
