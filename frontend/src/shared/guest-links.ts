import { createGuestLink } from "./api";
import { copyText } from "./clipboard";
import { el } from "./dom";
import { icon } from "./icons";
import { t } from "./i18n";
import { openModal } from "./modal";

/**
 * Handing one folder or one playlist to somebody who has no account.
 *
 * The dialog asks the two questions a link actually needs — how long it should
 * work and how many downloads it allows — and then shows the address **once**.
 * Only its hash is kept, so a link that is not copied here cannot be recovered
 * later, only issued again; the dialog says so rather than letting somebody
 * find out afterwards.
 *
 * Playing is not counted against the download budget. A link meant for
 * listening should not run out because it was listened to.
 */
export function openGuestLinkDialog(target: {
  kind: "directory" | "collection";
  id: number;
  name: string;
}): void {
  const days = el("select", { className: "input", attrs: { "aria-label": t("Ważność linku") } },
    el("option", { text: t("1 dzień"), attrs: { value: "1" } }),
    el("option", { text: t("7 dni"), attrs: { value: "7", selected: true } }),
    el("option", { text: t("30 dni"), attrs: { value: "30" } }),
    el("option", { text: t("90 dni"), attrs: { value: "90" } })
  ) as HTMLSelectElement;
  const downloads = el("select", { className: "input", attrs: { "aria-label": t("Limit pobrań") } },
    el("option", { text: t("Bez pobierania (tylko odsłuch)"), attrs: { value: "0" } }),
    el("option", { text: t("10 pobrań"), attrs: { value: "10", selected: true } }),
    el("option", { text: t("100 pobrań"), attrs: { value: "100" } }),
    el("option", { text: t("Bez limitu"), attrs: { value: "10000" } })
  ) as HTMLSelectElement;
  const address = el("input", { className: "input", attrs: { type: "text", readonly: true, "aria-label": t("Adres linku") } }) as HTMLInputElement;
  const result = el("div", { className: "guest-dialog__result hidden" },
    el("p", { className: "muted", text: t("Skopiuj adres teraz — nie da się go później odczytać, można tylko wydać nowy.") }),
    address
  );
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const create = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("share"), t("Utwórz link"));
  const copy = el("button", { className: "button button--secondary hidden", attrs: { type: "button" } }, icon("share"), t("Kopiuj link"));
  const close = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));

  const dialog = el(
    "div",
    { className: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "false" } },
    el("div", { className: "dialog__backdrop" }),
    el("div", { className: "dialog__panel dialog__panel--compact guest-dialog" },
      el("header", { className: "dialog__header" }, el("h2", { text: t("Link gościnny") }), close),
      el("div", { className: "guest-dialog__body" },
        el("p", { text: t("Udostępniasz: {name}", { name: target.name }) }),
        el("p", { className: "muted", text: t("Link działa bez konta, wygasa sam i pokazuje wyłącznie to jedno miejsce. Odtwarzanie nie zużywa limitu pobrań.") }),
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Ważność") }), days),
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Pobrania") }), downloads),
        result,
        el("div", { className: "guest-dialog__actions" }, create, copy, status)
      )
    )
  );

  let release: (() => void) | null = null;
  const dismiss = (): void => {
    release?.();
    release = null;
    dialog.remove();
  };
  close.addEventListener("click", dismiss);
  dialog.querySelector(".dialog__backdrop")?.addEventListener("click", dismiss);

  create.addEventListener("click", () => {
    create.disabled = true;
    status.textContent = t("Tworzenie…");
    void createGuestLink({
      target_kind: target.kind,
      target_id: target.id,
      days: Number(days.value),
      // Zero downloads is a real answer here ("listening only"), so "no limit"
      // is the largest budget the server accepts rather than a magic zero.
      max_downloads: Number(downloads.value)
    })
      .then((link) => {
        address.value = link.url;
        result.classList.remove("hidden");
        copy.classList.remove("hidden");
        create.classList.add("hidden");
        status.textContent = t("Link ważny do {when}", { when: link.expires_at.slice(0, 16).replace("T", " ") });
        address.focus();
        address.select();
      })
      .catch((error: unknown) => {
        status.textContent = error instanceof Error ? error.message : t("Nie udało się utworzyć linku.");
        create.disabled = false;
      });
  });
  copy.addEventListener("click", () => {
    void copyText(address.value).then(() => { status.textContent = t("Link skopiowany"); });
  });

  document.body.append(dialog);
  release = openModal(dialog, { onEscape: dismiss, initialFocus: days });
}
