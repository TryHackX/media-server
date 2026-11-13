import { el } from "./dom";
import { icon } from "./icons";
import { t } from "./i18n";

export type ToastKind = "info" | "success" | "error";

/** How long a message stays; an error a little longer, it is the one worth reading twice. */
const LIFETIME_MS: Record<ToastKind, number> = { info: 4000, success: 4000, error: 6500 };
const MAX_VISIBLE = 3;

let region: HTMLElement | null = null;

/**
 * The region the messages are read from. It lives on whatever is on top: the
 * element shown full screen when there is one (anything on <body> is invisible
 * under it), otherwise <body>. `data-modal-exempt` keeps `openModal()` from
 * making it inert — a message about a dialog's own action has to be heard while
 * that dialog is open.
 */
function host(): HTMLElement {
  if (!region) {
    region = el("div", {
      className: "toast-region",
      attrs: { role: "status", "aria-live": "polite", "aria-atomic": "false" },
      dataset: { modalExempt: "true" }
    });
  }
  const parent = document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : document.body;
  if (region.parentElement !== parent) parent.append(region);
  return region;
}

/**
 * A short message that needs no answer: it appears at the top of the screen
 * (where neither the dock nor a phone's keyboard covers it), is read out by a
 * screen reader, and leaves by itself.
 *
 * This is what `window.alert` was being used for ("Nie udało się przygotować
 * pobierania") — a system box that stopped the music's interface dead until it
 * was dismissed, to say something nobody had to decide about.
 */
export function showToast(text: string, kind: ToastKind = "info"): void {
  const message = text.trim();
  if (!message) return;
  const list = host();
  // The same sentence twice in a row is one message, shown afresh.
  for (const shown of Array.from(list.children)) {
    if (shown instanceof HTMLElement && shown.dataset.text === message) shown.remove();
  }
  while (list.childElementCount >= MAX_VISIBLE) list.firstElementChild?.remove();

  const close = el("button", { className: "toast__close", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
  // How much of its time the message has left, as a line along its bottom edge.
  const life = el("span", { className: "toast__life", attrs: { "aria-hidden": "true" } });
  life.style.setProperty("--toast-life", `${LIFETIME_MS[kind]}ms`);
  const toast = el(
    "div",
    // An error interrupts politely but at once; the rest waits its turn.
    { className: `toast toast--${kind}`, attrs: kind === "error" ? { role: "alert" } : {}, dataset: { text: message } },
    icon(kind === "error" ? "info" : kind === "success" ? "check" : "info"),
    el("p", { className: "toast__text", text: message }),
    close,
    life
  );
  let timer = 0;
  const dismiss = (): void => {
    window.clearTimeout(timer);
    toast.classList.add("is-leaving");
    // Removed after the exit transition, or at once where there is none.
    window.setTimeout(() => toast.remove(), 160);
  };
  const hold = (): void => {
    window.clearTimeout(timer);
    toast.classList.add("is-held");
  };
  const arm = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(dismiss, LIFETIME_MS[kind]);
    // The line starts over with the time it measures.
    toast.classList.remove("is-held");
    life.classList.remove("is-running");
    void life.offsetWidth;
    life.classList.add("is-running");
  };
  close.addEventListener("click", dismiss);
  // A message being read (pointer over it, or focus inside it) does not vanish mid-sentence.
  toast.addEventListener("pointerenter", hold);
  toast.addEventListener("pointerleave", arm);
  toast.addEventListener("focusin", hold);
  toast.addEventListener("focusout", arm);
  list.append(toast);
  arm();
}
