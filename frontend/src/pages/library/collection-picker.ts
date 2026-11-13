import { createCollection, failureText, getCollections, setCollectionItem } from "../../shared/api";
import { el } from "../../shared/dom";
import { icon } from "../../shared/icons";
import { t } from "../../shared/i18n";
import { openModal } from "../../shared/modal";
import type { LibraryKind, MediaItem, UserCollection } from "../../shared/types";

export interface CollectionPickerOptions {
  kind: LibraryKind;
  /** The account's playlists of this library, as the page holds them now. */
  collections: () => UserCollection[];
  /** A playlist was made here: the page's list is replaced by the fresh one. */
  onCollections: (list: UserCollection[]) => void;
  /** Settles when the page's first list of playlists has arrived. */
  ready: Promise<void>;
}

export interface CollectionPicker {
  /** Ask which hand-made playlist the item should join. */
  open(item: MediaItem): void;
  /** Close it and take it off the page (the page is going away). */
  dispose(): void;
}

/**
 * "Add to a playlist": the dialog a card, or the dock, opens for one track or
 * film.
 *
 * Only hand-made lists are offered — a smart one is computed and takes nothing
 * by hand — and a new list can be made on the spot, so the item does not have
 * to wait for a trip to the account page.
 */
export function createCollectionPicker(options: CollectionPickerOptions): CollectionPicker {
  let target: MediaItem | null = null;
  const search = el("input", {
    className: "input", attrs: { type: "search", placeholder: t("Szukaj playlisty…"), "aria-label": t("Szukaj playlisty") }
  });
  const select = el("select", { className: "input", attrs: { "aria-label": t("Wybierz kolekcję") } });
  const feedback = el("span", { className: "form-status", attrs: { role: "status" } });
  const closeButton = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
  const confirm = el(
    "button",
    { className: "button button--primary", attrs: { type: "button" } },
    icon("check"),
    t("Dodaj")
  );
  const createName = el("input", {
    className: "input", attrs: { type: "text", minlength: "2", maxlength: "191", placeholder: t("Nazwa nowej playlisty"), "aria-label": t("Nazwa nowej playlisty") }
  });
  const create = el(
    "button",
    { className: "button button--secondary", attrs: { type: "button" } },
    icon("check"),
    t("Utwórz")
  );
  const dialog = el(
    "div",
    { className: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "true", "aria-labelledby": "collection-picker-title" } },
    el("button", { className: "dialog__backdrop", attrs: { type: "button", tabindex: "-1", "aria-label": t("Zamknij") } }),
    el(
      "section",
      { className: "dialog__panel dialog__panel--compact" },
      el("header", { className: "dialog__header" }, el("h2", { text: t("Dodaj do kolekcji"), attrs: { id: "collection-picker-title" } }), closeButton),
      el(
        "div",
        { className: "collection-picker" },
        el("p", { text: t("Wybierz ręczną listę. Inteligentne listy są wyliczane automatycznie.") }),
        search,
        select,
        el("div", { className: "collection-picker__divider" }, el("span", { text: t("lub utwórz nową") })),
        el("div", { className: "collection-picker__create" }, createName, create),
        feedback,
        el("div", { className: "collection-picker__actions" }, confirm)
      )
    )
  );
  let releaseModal: (() => void) | null = null;
  const close = (): void => {
    dialog.setAttribute("aria-hidden", "true");
    releaseModal?.();
    releaseModal = null;
    target = null;
    feedback.textContent = "";
  };

  const renderOptions = (): number => {
    const needle = search.value.trim().toLocaleLowerCase("pl");
    const matching = options.collections().filter((collection) =>
      !collection.is_smart && (!needle || collection.name.toLocaleLowerCase("pl").includes(needle))
    );
    select.replaceChildren(...matching.map((collection) =>
      el("option", { text: collection.name, attrs: { value: collection.id } })
    ));
    feedback.textContent = matching.length ? "" : t("Nie znaleziono ręcznej playlisty.");
    confirm.disabled = matching.length === 0;
    return matching.length;
  };

  closeButton.addEventListener("click", close);
  dialog.querySelector(".dialog__backdrop")?.addEventListener("click", close);
  confirm.addEventListener("click", () => {
    const collectionId = Number(select.value);
    if (!target || !Number.isSafeInteger(collectionId) || collectionId < 1) return;
    confirm.disabled = true;
    feedback.textContent = t("Dodawanie…");
    void setCollectionItem(collectionId, target.id, true)
      .then(() => {
        feedback.textContent = t("Dodano do kolekcji.");
        window.setTimeout(close, 650);
      })
      .catch((error: unknown) => { feedback.textContent = failureText(error, t("Nie udało się dodać do kolekcji.")); })
      .finally(() => { confirm.disabled = false; });
  });
  create.addEventListener("click", () => {
    const name = createName.value.trim();
    if (name.length < 2) {
      feedback.textContent = t("Nazwa playlisty musi mieć co najmniej 2 znaki.");
      createName.focus();
      return;
    }
    create.disabled = true;
    feedback.textContent = t("Tworzenie playlisty…");
    void createCollection({ name, media_kind: options.kind, rules: null })
      .then(async (createdId) => {
        options.onCollections(await getCollections(options.kind));
        search.value = name;
        renderOptions();
        select.value = String(createdId);
        createName.value = "";
        feedback.textContent = t("Playlista utworzona — możesz od razu dodać pozycję.");
      })
      .catch((error: unknown) => { feedback.textContent = failureText(error, t("Nie udało się utworzyć playlisty.")); })
      .finally(() => { create.disabled = false; });
  });
  createName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      create.click();
    }
  });
  search.addEventListener("input", renderOptions);
  document.body.append(dialog);

  return {
    open(item: MediaItem): void {
      target = item;
      search.value = "";
      // The list may still be on its way when the dock's button is pressed early.
      void options.ready.then(() => { if (target === item) renderOptions(); });
      const count = renderOptions();
      if (!count && options.collections().length === 0) {
        feedback.textContent = t("Najpierw utwórz playlistę w zakładce Moje konto.");
      }
      dialog.setAttribute("aria-hidden", "false");
      releaseModal?.();
      releaseModal = openModal(dialog, { onEscape: close, initialFocus: search });
    },
    dispose(): void {
      close();
      dialog.remove();
    }
  };
}
