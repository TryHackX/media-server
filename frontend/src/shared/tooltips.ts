let installed = false;

export function installFloatingTooltips(): void {
  if (installed) return;
  installed = true;
  document.documentElement.classList.add("has-floating-tooltips");
  const tooltip = document.createElement("div");
  tooltip.className = "floating-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  document.body.append(tooltip);
  let active: HTMLElement | null = null;
  let positionRule: CSSStyleRule | null = null;
  let frame = 0;
  const findPositionRule = (rules: CSSRuleList): CSSStyleRule | null => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText === ".floating-tooltip") return rule;
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) {
        const match = findPositionRule(nested);
        if (match) return match;
      }
    }
    return null;
  };
  const resolvePositionRule = (): CSSStyleRule | null => {
    if (positionRule) return positionRule;
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        positionRule = findPositionRule(sheet.cssRules);
        if (positionRule) return positionRule;
      } catch { /* an external stylesheet may not expose its rules */ }
    }
    return null;
  };
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

  const position = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (stranded()) { hide(); return; }
      if (!active || tooltip.getAttribute("aria-hidden") === "true") return;
      const anchor = active.getBoundingClientRect();
      const bounds = tooltip.getBoundingClientRect();
      const margin = 10;
      const centered = anchor.left + anchor.width / 2 - bounds.width / 2;
      const left = Math.min(window.innerWidth - bounds.width - margin, Math.max(margin, centered));
      const above = anchor.top - bounds.height - margin;
      const top = above >= margin ? above : Math.min(window.innerHeight - bounds.height - margin, anchor.bottom + margin);
      const rule = resolvePositionRule();
      if (!rule) return;
      rule.style.left = `${Math.round(left)}px`;
      rule.style.top = `${Math.round(top)}px`;
    });
  };
  const show = (target: HTMLElement): void => {
    const copy = target.dataset.tooltip?.trim();
    if (!copy) return;
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
    if (target) show(target);
  });
  document.addEventListener("focusout", (event) => hide(targetFor(event)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
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
