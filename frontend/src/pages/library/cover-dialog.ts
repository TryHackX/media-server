import { ApiError, collectionPreviewUrl, saveCollectionArtwork } from "../../shared/api";
import { CoverPicker } from "../../shared/cover-picker";
import { el } from "../../shared/dom";
import { icon } from "../../shared/icons";
import { t } from "../../shared/i18n";
import { openModal } from "../../shared/modal";

export interface CoverDialog {
  /** Offer the playlist a cover of its own; `hasArtwork` when it has one already. */
  open(collectionId: number, hasArtwork: boolean): void;
  dispose(): void;
}

/**
 * Give a playlist an own cover, or take it away again.
 *
 * The picker is the same one the tag editor uses, so the cropping, the checks
 * and the 500x500 WebP result are identical; only the endpoint differs. The
 * dialog is built the first time it is asked for. `onSaved` redraws whatever
 * shows the cover (the page's listing); the dialog closes after it has.
 */
export function createCoverDialog(onSaved: () => Promise<void>): CoverDialog {
  let picker: CoverPicker | null = null;
  let dialog: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  let releaseModal: (() => void) | null = null;
  let collectionId: number | null = null;

  const close = (): void => {
    picker?.destroy();
    dialog?.setAttribute("aria-hidden", "true");
    releaseModal?.();
    releaseModal = null;
  };

  const build = (): HTMLElement => {
    const line = el("span", { className: "form-status", attrs: { role: "status" } });
    // One status line for the whole dialog, so the picker and the save button
    // never contradict each other.
    const cover = new CoverPicker({
      hint: t("Wybierz obraz, ustaw kadr 1:1 i zapisz. Bez własnej okładki playlista pokazuje okładki swoich utworów."),
      placeholder: "list",
      onMessage: (text) => { line.textContent = text; }
    });
    const closeButton = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
    const cancel = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Anuluj"));
    const save = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("check"), t("Zapisz okładkę"));
    closeButton.addEventListener("click", close);
    cancel.addEventListener("click", close);
    save.addEventListener("click", () => {
      const change = cover.change();
      if (collectionId === null || change === undefined) {
        line.textContent = t("Najpierw wybierz nową okładkę albo ją usuń.");
        return;
      }
      save.disabled = true;
      line.textContent = t("Zapisywanie…");
      void saveCollectionArtwork(collectionId, change)
        .then(() => {
          cover.markSaved();
          line.textContent = change === null ? t("Okładka usunięta.") : t("Okładka zapisana.");
          // Redrawn so the card and the candidates match what was just stored.
          return onSaved();
        })
        .then(() => window.setTimeout(close, 700))
        .catch((error: unknown) => {
          line.textContent = error instanceof ApiError && error.message ? error.message : t("Nie udało się zapisać okładki.");
        })
        .finally(() => { save.disabled = false; });
    });
    const built = el(
      "div",
      { className: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "true", "aria-labelledby": "collection-cover-title" } },
      el("button", { className: "dialog__backdrop", attrs: { type: "button", tabindex: "-1", "aria-label": t("Zamknij") } }),
      el(
        "section",
        { className: "dialog__panel dialog__panel--metadata" },
        el("header", { className: "dialog__header" },
          el("div", {}, el("span", { className: "eyebrow", text: t("Playlista") }), el("h2", { text: t("Okładka playlisty"), attrs: { id: "collection-cover-title" } })),
          closeButton
        ),
        el("div", { className: "collection-cover" },
          cover.element,
          el("div", { className: "metadata-form__actions" }, line, cancel, save)
        )
      )
    );
    built.querySelector(".dialog__backdrop")?.addEventListener("click", close);
    document.body.append(built);
    picker = cover;
    status = line;
    return built;
  };

  return {
    open(id: number, hasArtwork: boolean): void {
      collectionId = id;
      dialog ??= build();
      status!.textContent = "";
      picker!.reset(hasArtwork ? collectionPreviewUrl(id, String(Date.now())) : null);
      dialog.setAttribute("aria-hidden", "false");
      releaseModal?.();
      releaseModal = openModal(dialog, { onEscape: close });
    },
    dispose(): void {
      close();
      dialog?.remove();
    }
  };
}
