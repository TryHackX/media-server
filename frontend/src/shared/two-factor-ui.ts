/**
 * The pieces of two-factor sign-in that the sign-in page and "Moje konto"
 * share: the setup view (QR code, the secret as text, an otpauth:// link a phone
 * opens in its authenticator app), the code field, and the one-time display of
 * the recovery codes.
 */
import { copyText } from "./clipboard";
import { el } from "./dom";
import { t } from "./i18n";
import { icon } from "./icons";
import { encodeQr, qrSvg } from "./qr";

/** The secret in groups of four, which is how people copy it by hand. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function setupView(secret: string, otpauthUri: string): HTMLElement {
  let qr: Element;
  try {
    qr = qrSvg(encodeQr(otpauthUri), t("Kod QR do zeskanowania w aplikacji uwierzytelniającej"));
  } catch {
    qr = el("p", { className: "muted", text: t("Nie udało się narysować kodu QR — wpisz klucz ręcznie.") });
  }
  return el("div", { className: "twofa-setup" },
    el("div", { className: "twofa-setup__qr" }, qr),
    el("div", { className: "twofa-setup__text" },
      el("p", { className: "muted", text: t("Zeskanuj kod w aplikacji uwierzytelniającej (np. Aegis, Google Authenticator, 1Password) albo wpisz klucz ręcznie.") }),
      el("code", { className: "twofa-setup__secret", text: grouped(secret), attrs: { "aria-label": t("Klucz") } }),
      el("a", { className: "button button--secondary twofa-setup__link", attrs: { href: otpauthUri } },
        icon("link"), t("Otwórz w aplikacji na tym telefonie"))
    )
  );
}

/** Six digits from the app, or (with `recovery`) one of the recovery codes. */
export function codeInput(recovery = false): HTMLInputElement {
  return el("input", {
    className: "input twofa-code",
    attrs: recovery
      ? { type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", maxlength: "16", required: true, placeholder: "xxxxx-xxxxx" }
      : { type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9 ]{6,7}", maxlength: "7", required: true, placeholder: "123456" }
  }) as HTMLInputElement;
}

/** The recovery codes, shown once, with copy and save. `onDone` is the way on. */
export function recoveryCodesView(codes: string[], onDone: () => void, doneLabel: string): HTMLElement {
  const status = el("span", { className: "form-status", attrs: { role: "status" } });
  const copy = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("file"), t("Kopiuj"));
  copy.addEventListener("click", () => {
    void copyText(codes.join("\n"))
      .then(() => { status.textContent = t("Skopiowano."); })
      .catch(() => { status.textContent = t("Nie udało się skopiować — przepisz kody."); });
  });
  const save = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("download"), t("Zapisz do pliku"));
  save.addEventListener("click", () => {
    const blob = new Blob([`TryHackX Media — ${t("kody odzyskiwania")}\n\n${codes.join("\n")}\n`], { type: "text/plain" });
    const link = el("a", { attrs: { href: URL.createObjectURL(blob), download: "tryhackx-media-recovery-codes.txt" } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  const done = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("check"), doneLabel);
  done.addEventListener("click", onDone);
  return el("div", { className: "twofa-recovery" },
    el("p", { text: t("Kody odzyskiwania — każdy działa raz, gdy nie masz telefonu. Zapisz je teraz w bezpiecznym miejscu: nie pokażemy ich ponownie.") }),
    el("ol", { className: "twofa-recovery__codes" }, ...codes.map((code) => el("li", {}, el("code", { text: code })))),
    el("div", { className: "twofa-recovery__actions" }, copy, save, done),
    status
  );
}
