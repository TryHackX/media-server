import "../styles/index.css";

import { collectionPreviewUrl, deleteCollection, getCollections, setCollectionShared, updateCollection } from "../shared/api";
import { copyText } from "../shared/clipboard";
import { openGuestLinkDialog } from "../shared/guest-links";
import { appUrl } from "../shared/config";
import { el } from "../shared/dom";
import { icon } from "../shared/icons";
import { t } from "../shared/i18n";
import { can } from "../shared/permissions";
import { mountShell } from "../shared/shell";
import type { CollectionSort, LibraryKind, UserCollection } from "../shared/types";

type OwnerFilter = "mine" | "others" | "all";
type VisibilityFilter = "private" | "public" | "all";

const copyLink = (url: URL): Promise<void> => copyText(url.href);

export async function mount(): Promise<void> {
  const shell = await mountShell("collections", t("Kolekcje"), t("Playlisty muzyczne i kolekcje filmowe"));
  const canCreate = can(shell.session, "can_create_collections");
  const canShare = can(shell.session, "can_share");
  // Off by default on the server; the button simply is not there.
  const guestLinksOn = shell.session.settings.guest_links_enabled === true;
  const canBrowse = can(shell.session, "can_browse_collections");
  const host = el("div", { className: "collections-page" });
  shell.content.append(host);
  if (!canBrowse) {
    host.append(el("div", { className: "notice notice--error", text: t("Twoja grupa nie ma uprawnienia do przeglądania kolekcji.") }));
    return;
  }

  const kind = el("select", { className: "input" },
    el("option", { text: t("Muzyka i filmy"), attrs: { value: "all" } }),
    el("option", { text: t("Tylko muzyczne"), attrs: { value: "music" } }),
    el("option", { text: t("Tylko filmowe"), attrs: { value: "movies" } })
  );
  const owner = el("select", { className: "input" },
    el("option", { text: t("Wszystkich użytkowników"), attrs: { value: "all" } }),
    el("option", { text: t("Tylko moje"), attrs: { value: "mine" } }),
    el("option", { text: t("Tylko innych"), attrs: { value: "others" } })
  );
  const visibility = el("select", { className: "input" },
    el("option", { text: t("Prywatne i publiczne"), attrs: { value: "all" } }),
    el("option", { text: t("Tylko prywatne"), attrs: { value: "private" } }),
    el("option", { text: t("Tylko publiczne"), attrs: { value: "public" } })
  );
  const sort = el("select", { className: "input" },
    el("option", { text: t("Ostatnio zmienione"), attrs: { value: "updated_desc" } }),
    el("option", { text: t("Nazwa A–Z"), attrs: { value: "name_asc" } }),
    el("option", { text: t("Nazwa Z–A"), attrs: { value: "name_desc" } }),
    el("option", { text: t("Najwyższa średnia ocena"), attrs: { value: "rating_desc" } }),
    el("option", { text: t("Najwięcej odtworzeń"), attrs: { value: "plays_desc" } }),
    el("option", { text: t("Najwięcej pozycji"), attrs: { value: "items_desc" } })
  );
  const search = el("input", { className: "input", attrs: { type: "search", placeholder: t("Szukaj kolekcji…"), "aria-label": t("Szukaj kolekcji") } });
  const grid = el("section", { className: "collection-browser-grid", attrs: { "aria-live": "polite" } });
  const status = el("p", { className: "collection-browser-status", attrs: { role: "status" } });
  let rows: UserCollection[] = [];

  /**
   * Rename a list without leaving the page that lists it.
   *
   * The name, the description and who may see it are exactly what this card
   * shows, so they are what it lets you change; how the playlist draws its
   * queue is a deeper setting and stays under "Moje konto", where the rest of
   * that panel lives. The form replaces the card in place — the same move the
   * account page makes — so nothing jumps around while typing.
   */
  const editForm = (collection: UserCollection, card: HTMLElement): HTMLElement => {
    const name = el("input", {
      className: "input",
      attrs: { type: "text", minlength: "2", maxlength: "191", required: true, value: collection.name, "aria-label": t("Nazwa") }
    }) as HTMLInputElement;
    const description = el("input", {
      className: "input",
      attrs: { type: "text", maxlength: "500", value: collection.description, placeholder: t("Krótki opis (opcjonalnie)"), "aria-label": t("Opis") }
    }) as HTMLInputElement;
    const shared = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
    shared.checked = collection.is_shared;
    const status = el("span", { className: "form-status", attrs: { role: "status" } });
    const cancel = el("button", { className: "button button--ghost", attrs: { type: "button" } }, t("Anuluj"));
    cancel.addEventListener("click", draw);
    const form = el(
      "form",
      { className: "collection-browser-card__edit" },
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Nazwa") }), name),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Opis") }), description),
      el("label", { className: "toggle-field" }, shared, el("span", { text: t("Udostępniona innym") })),
      el("div", { className: "collection-browser-card__edit-actions" },
        el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zapisz")),
        cancel,
        status)
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      status.textContent = t("Zapisywanie…");
      const wantsShared = shared.checked;
      void updateCollection(collection.id, { name: name.value.trim(), description: description.value.trim() })
        .then(() => (wantsShared === collection.is_shared ? undefined : setCollectionShared(collection.id, wantsShared)))
        .then(load)
        .catch(() => { status.textContent = t("Nie udało się zapisać zmian."); });
    });
    card.classList.add("is-editing");
    window.setTimeout(() => name.focus(), 0);
    return form;
  };

  const draw = (): void => {
    const needle = search.value.trim().toLocaleLowerCase("pl");
    const filtered = rows.filter((row) => !needle || row.name.toLocaleLowerCase("pl").includes(needle)
      || row.owner_name.toLocaleLowerCase("pl").includes(needle));
    grid.replaceChildren(...filtered.map((collection) => {
      const target = collection.media_kind === "music" ? "music/" : "movies/";
      const link = new URL(appUrl(target), window.location.origin);
      link.searchParams.set("collection", String(collection.id));
      const actions = el("div", { className: "collection-browser-card__actions" });
      const card = el("article", { className: "collection-browser-card panel" });
      // Edit first: it is the one action about the list itself, and the two
      // beside it are about handing it out and throwing it away.
      if (collection.is_owned && canCreate) {
        const edit = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Edytuj {name}", { name: collection.name }) } }, icon("edit"));
        edit.dataset.tooltip = t("Zmień nazwę, opis lub widoczność");
        edit.addEventListener("click", () => card.replaceChildren(editForm(collection, card)));
        actions.append(edit);
      }
      if (collection.is_owned && canShare && guestLinksOn) {
        // Sharing inside the house and sharing outside it are different acts,
        // so they are different buttons: one copies an address only accounts
        // can open, the other mints a link that needs no account at all.
        const guest = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Link gościnny do {name}", { name: collection.name }) } }, icon("magnet"));
        guest.dataset.tooltip = t("Link dla osoby bez konta");
        guest.addEventListener("click", () => openGuestLinkDialog({ kind: "collection", id: collection.id, name: collection.name }));
        actions.append(guest);
      }
      if (collection.is_owned && canShare) {
        const share = el("button", { className: "icon-button" + (collection.is_shared ? " is-active" : ""), attrs: { type: "button", "aria-label": t("Udostępnij") } }, icon("share"));
        share.dataset.tooltip = collection.is_shared ? t("Kopiuj link publiczny") : t("Udostępnij i skopiuj link");
        share.addEventListener("click", () => {
          share.disabled = true;
          void Promise.resolve(collection.is_shared ? undefined : setCollectionShared(collection.id, true))
            .then(() => { collection.is_shared = true; share.classList.add("is-active"); return copyLink(link); })
            .then(() => { share.dataset.tooltip = t("Link skopiowany"); })
            .finally(() => { share.disabled = false; });
        });
        actions.append(share);
      }
      if (collection.is_owned && canCreate) {
        const remove = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Usuń kolekcję") } }, icon("close"));
        remove.dataset.tooltip = t("Usuń kolekcję");
        remove.addEventListener("click", () => {
          if (!confirm(`Usunąć kolekcję „${collection.name}”?`)) return;
          remove.disabled = true;
          void deleteCollection(collection.id).then(load).finally(() => { remove.disabled = false; });
        });
        actions.append(remove);
      }
      card.replaceChildren(
        el("a", { className: "collection-browser-card__link", attrs: { href: link.pathname + link.search } },
          el("span", { className: "collection-browser-card__icon" }, collection.has_artwork
            ? el("img", {
                className: "collection-browser-card__cover",
                attrs: { alt: "", loading: "lazy", decoding: "async", src: collectionPreviewUrl(collection.id, collection.artwork_revision) }
              })
            : icon(collection.media_kind === "music" ? "music" : "film")),
          el("span", { className: "collection-browser-card__copy" },
            el("strong", { text: collection.name }),
            el("small", { text: `${collection.owner_name} · ${collection.is_shared ? "publiczna" : "prywatna"}` }),
            // What its author wanted said about it, before the counting starts.
            // The card had room for it all along and simply never showed it.
            collection.description
              ? el("span", { className: "collection-browser-card__description", text: collection.description, attrs: { title: collection.description } })
              : null,
            el("span", { text: collection.is_smart ? `Inteligentna · ${collection.item_count.toLocaleString("pl-PL")} pozycji` : `${collection.item_count.toLocaleString("pl-PL")} pozycji` }),
            // The first star is the list's own — the same number its card in the
            // library shows, and the one "highest rated" sorts by. The second is
            // the average of the tracks on it, which is a different question and
            // now says whose average it is.
            el("span", { className: "collection-browser-card__statistics", text: t("★ {rating} ({count}) · utwory {items} ({itemCount}) · {plays} odtworzeń", {
              rating: collection.avg_rating.toFixed(1),
              count: collection.rating_count.toLocaleString("pl-PL"),
              items: collection.items_avg_rating.toFixed(1),
              itemCount: collection.items_rating_count.toLocaleString("pl-PL"),
              plays: collection.total_play_count.toLocaleString("pl-PL")
            }) })
          ), icon("arrow")
        ), actions
      );
      return card;
    }));
    status.textContent = `${filtered.length.toLocaleString("pl-PL")} kolekcji`;
    if (!filtered.length) grid.append(el("div", { className: "empty-state" }, el("p", { text: t("Brak kolekcji pasujących do filtrów.") })));
  };
  const load = async (): Promise<void> => {
    status.textContent = t("Pobieranie kolekcji…");
    try {
      rows = await getCollections(kind.value === "all" ? undefined : kind.value as LibraryKind, {
        owner: owner.value as OwnerFilter,
        visibility: visibility.value as VisibilityFilter,
        sort: sort.value as CollectionSort
      });
      draw();
    } catch {
      rows = [];
      grid.replaceChildren(el("div", { className: "notice notice--error", text: t("Nie udało się pobrać kolekcji.") }));
      status.textContent = t("Błąd pobierania");
    }
  };
  for (const control of [kind, owner, visibility, sort]) control.addEventListener("change", () => void load());
  search.addEventListener("input", draw);
  host.append(
    el("section", { className: "collection-browser-toolbar panel" },
      el("div", { className: "collection-browser-filters" },
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Rodzaj") }), kind),
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Właściciel") }), owner),
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Widoczność") }), visibility),
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Sortowanie") }), sort),
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Wyszukiwanie") }), search)
      ),
      el("div", { className: "collection-browser-toolbar__footer" }, status,
        canCreate ? el("a", { className: "button button--primary", attrs: { href: appUrl("account/#collection-builder") } }, icon("list"), t("Utwórz kolekcję")) : null)
    ), grid
  );
  await load();
}

