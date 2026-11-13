import { el } from "./dom";
import { icon } from "./icons";
import { t } from "./i18n";
import { openModal } from "./modal";
import { dismiss } from "./motion";

export interface ConfirmOptions {
  title: string;
  /** What will happen, in a sentence. Shown under the title. */
  message: string;
  /** The button that goes ahead; "Potwierdź" when not named. */
  confirmLabel?: string;
  /** Draws the button as destructive and puts the first focus on "Anuluj". */
  danger?: boolean;
  /**
   * For what cannot be undone: a field where the given text has to be typed
   * (an account's name before it is deleted); the button stays off until it
   * matches exactly, and the first focus is the field.
   */
  typeToConfirm?: { label: string; expected: string };
}

let sequence = 0;

/**
 * "Are you sure?", asked by the application rather than by the browser.
 *
 * `window.confirm` was the last piece of the interface the browser drew itself:
 * a grey system box in the system's language, naming the server's address,
 * which on a phone covers the page it is asking about — and which a browser may
 * silently stop showing ("prevent this page from creating additional dialogs"),
 * after which every delete button did nothing at all. This is an ordinary dialog
 * of this application: same look, same language, modal, Escape and the backdrop
 * mean "no".
 *
 * Resolves true only when the confirming button was pressed.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = `confirm-dialog-${++sequence}`;
    const confirm = el(
      "button",
      { className: `button ${options.danger ? "button--danger" : "button--primary"}`, attrs: { type: "button" } },
      icon(options.danger ? "trash" : "check"),
      options.confirmLabel ?? t("Potwierdź")
    );
    const cancel = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Anuluj"));
    const close = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
    const backdrop = el("button", { className: "dialog__backdrop", attrs: { type: "button", tabindex: "-1", "aria-label": t("Zamknij") } });
    const typed = options.typeToConfirm
      ? el("input", { className: "input", attrs: { type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "off" } }) as HTMLInputElement
      : null;
    const typedField = typed && options.typeToConfirm
      ? el("label", { className: "field" }, el("span", { className: "field__label", text: options.typeToConfirm.label }), typed)
      : null;
    if (typed && options.typeToConfirm) {
      const expected = options.typeToConfirm.expected;
      const matches = (): boolean => typed.value.trim() === expected;
      (confirm as HTMLButtonElement).disabled = true;
      typed.addEventListener("input", () => { (confirm as HTMLButtonElement).disabled = !matches(); });
      typed.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && matches()) {
          event.preventDefault();
          (confirm as HTMLButtonElement).click();
        }
      });
    }
    const dialog = el(
      "div",
      {
        className: "dialog dialog--confirm",
        attrs: { role: "alertdialog", "aria-modal": "true", "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-text` }
      },
      backdrop,
      el(
        "section",
        { className: "dialog__panel dialog__panel--compact" },
        el("header", { className: "dialog__header" }, el("h2", { text: options.title, attrs: { id: `${id}-title` } }), close),
        el(
          "div",
          { className: "dialog__body" },
          el("p", { text: options.message, attrs: { id: `${id}-text` } }),
          typedField,
          el("div", { className: "dialog__actions" }, cancel, confirm)
        )
      )
    );
    let release: () => void = () => undefined;
    let settled = false;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      release();
      dismiss(dialog);
      resolve(answer);
    };
    confirm.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    close.addEventListener("click", () => finish(false));
    backdrop.addEventListener("click", () => finish(false));
    // A page that is going away takes its question with it.
    document.addEventListener("media:route-will-change", () => finish(false), { once: true });
    document.body.append(dialog);
    release = openModal(dialog, { onEscape: () => finish(false), initialFocus: typed ?? (options.danger ? cancel : confirm) });
  });
}
