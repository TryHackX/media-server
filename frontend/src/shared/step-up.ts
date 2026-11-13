/**
 * The step-up dialog: what a page shows when the bridge answers
 * `428 captcha_required` (integrations/php/StepUpGuard.php).
 *
 * The bridge names the challenge — proof of work inside the application, the
 * operator's provider on the sign-in page — and this dialog shows it, trades
 * the solution for a short-lived pass (`submit`, i.e. `captcha_pass`) and
 * closes; api.ts then repeats the request that was refused. Proof of work and
 * reCAPTCHA v3 need nothing from the person, so for them the dialog only says
 * what is happening and closes by itself; a widget waits for "Dalej".
 *
 * Kept free of api.ts (which calls it) so the two do not import each other.
 */
import { mountCaptcha } from "./captcha";
import { el } from "./dom";
import { t } from "./i18n";
import { icon } from "./icons";
import { openModal } from "./modal";
import { dismiss } from "./motion";

export interface StepUpChallenge {
  provider: string;
  site_key: string;
  action?: string;
}

class StepUpCancelled extends Error {
  public constructor() {
    super(t("Potwierdź, że nie jesteś robotem."));
  }
}

/** Resolves once a pass was granted; rejects with StepUpCancelled when the person closes the dialog. */
export function runStepUp(challenge: StepUpChallenge, submit: (token: string) => Promise<void>): Promise<void> {
  const widget = mountCaptcha(challenge.provider, challenge.site_key);
  if (!widget) return Promise.reject(new StepUpCancelled());
  const action = challenge.action ?? "step_up";

  return new Promise<void>((resolve, reject) => {
    const status = el("p", { className: "step-up__status", attrs: { role: "status", "aria-live": "polite" } });
    const proceed = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("check"), t("Dalej"));
    const cancel = el("button", { className: "button button--ghost", attrs: { type: "button" } }, t("Anuluj"));
    const close = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
    const dialog = el(
      "div",
      { className: "dialog dialog--step-up", attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": "step-up-title" } },
      el("div", { className: "dialog__backdrop" }),
      el("section", { className: "dialog__panel step-up" },
        el("header", { className: "dialog__header" }, el("h2", { text: t("Chwila sprawdzenia"), attrs: { id: "step-up-title" } }), close),
        el("div", { className: "step-up__body" },
          el("p", { className: "muted", text: widget.interactive
            ? t("Dużo się dzieje z tego konta lub adresu. Rozwiąż wyzwanie, a dokończymy to, co robisz.")
            : t("Dużo się dzieje z tego konta lub adresu. Przeglądarka rozwiązuje krótkie zadanie — dokończymy to, co robisz, za moment.") }),
          widget.element,
          status,
          el("div", { className: "step-up__actions" }, cancel, ...(widget.interactive ? [proceed] : []))
        )
      )
    );
    let finished = false;
    let release: () => void = () => undefined;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      release();
      dismiss(dialog);
      if (error) reject(error);
      else resolve();
    };
    // Proof of work and v3 have no button of their own; after a failure they get
    // one, so the person can try again instead of only cancel.
    const offerRetry = (): void => {
      if (widget.interactive || proceed.isConnected) return;
      proceed.replaceChildren(icon("check"), t("Spróbuj ponownie"));
      cancel.after(proceed);
    };
    const attempt = async (): Promise<void> => {
      proceed.disabled = true;
      // Proof of work shows its own progress line; a second one would only repeat it.
      status.textContent = widget.interactive ? t("Sprawdzanie…") : "";
      try {
        const token = await widget.token(action);
        if (finished) return;
        if (token === "") {
          status.textContent = widget.interactive ? t("Najpierw rozwiąż wyzwanie.") : t("Nie udało się sprawdzić przeglądarki. Spróbuj ponownie.");
          offerRetry();
          return;
        }
        await submit(token);
        finish();
      } catch {
        if (finished) return;
        status.textContent = t("Weryfikacja antybotowa nie powiodła się. Spróbuj ponownie.");
        // A widget's token was spent by the failed attempt; proof of work starts again on the retry.
        if (widget.interactive) widget.reset();
        offerRetry();
      } finally {
        proceed.disabled = false;
      }
    };
    proceed.addEventListener("click", () => {
      if (!widget.interactive) widget.reset();
      void attempt();
    });
    cancel.addEventListener("click", () => finish(new StepUpCancelled()));
    close.addEventListener("click", () => finish(new StepUpCancelled()));
    document.body.append(dialog);
    release = openModal(dialog, { onEscape: () => finish(new StepUpCancelled()), initialFocus: widget.interactive ? null : cancel });
    if (!widget.interactive) void attempt();
  });
}
