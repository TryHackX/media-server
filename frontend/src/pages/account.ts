import "../styles/index.css";

import {
  changePassword, createCollection, deleteCollection, getAccount, getAccountEntries,
  applyImport, discardImport, getActiveSessions, getDigest, getGuestLinks, getLibraryFilters,
  ratingsExportUrl, requestEmailChange, resolveImportEntry, revokeGuestLink, revokeSession,
  saveUserPreferences, searchProfiles, setCollectionShared, setDigestFrequency,
  setProfileVisibility, startImport, updateCollection
} from "../shared/api";
import { copyText } from "../shared/clipboard";
import { appUrl } from "../shared/config";
import { el } from "../shared/dom";
import { formatDuration } from "../shared/format";
import { icon } from "../shared/icons";
import { LANGUAGES, t, type Language } from "../shared/i18n";
import { openModal } from "../shared/modal";
import { can } from "../shared/permissions";
import { mountShell } from "../shared/shell";
import {
  defaultUserPreferences,
  type AccountData, type AccountEntry, type AccountEntrySort, type CollectionQueueFavorite,
  type CollectionQueueRating, type CollectionRules, type GenreOption, type ImportStatus,
  type DigestFrequency, type DigestSubscription, type GuestLinkRow,
  type LibraryKind, type SessionResponse, type UserCollection, type UserPreferences
} from "../shared/types";

function entryRow(entry: AccountEntry, ownProfile: boolean): HTMLElement {
  const details = [
    entry.last_position_ms ? t("Wznów od {time}", { time: formatDuration(entry.last_position_ms) }) : "",
    entry.rating
      ? t(ownProfile ? "Twoja ocena {value}" : "Ocena użytkownika {value}", { value: Number(entry.rating).toFixed(1) })
      : "",
    entry.avg_rating ? t("Średnia {value}", { value: Number(entry.avg_rating).toFixed(1) }) : "",
    typeof entry.play_count === "number" ? t("Twoje odtworzenia {count}", { count: entry.play_count }) : "",
    typeof entry.total_play_count === "number" ? t("Wszystkie {count}", { count: entry.total_play_count }) : ""
  ].filter(Boolean);

  const target = entry.media_kind === "audio" ? "music/" : "movies/";
  const link = new URL(appUrl(target), window.location.origin);
  link.searchParams.set("q", entry.title);
  return el(
    "a",
    { className: "account-entry", attrs: { href: link.pathname + link.search } },
    el("span", { className: "account-entry__icon" }, icon(entry.media_kind === "audio" ? "music" : "film")),
    el(
      "span",
      { className: "account-entry__copy" },
      el("strong", { text: entry.title }),
      entry.artist ? el("span", { className: "account-entry__artist", text: entry.artist }) : null,
      el("small", {
        text: details.join(" · ") || (entry.media_kind === "audio" ? t("Utwór muzyczny") : t("Film"))
      })
    ),
    icon("arrow")
  );
}

function numberInput(label: string, value: string, min: string, max: string, step = "1"): HTMLInputElement {
  return el("input", {
    className: "input",
    attrs: { type: "number", value, min, max, step, "aria-label": label }
  });
}
const copyLink = (url: URL): Promise<void> => copyText(url.href);

function accountEntriesPanel(
  title: string,
  section: "recent" | "favorites" | "rated",
  kind: "all" | LibraryKind,
  emptyText: string,
  limit: number,
  username: string | undefined,
  ownProfile: boolean
): HTMLElement {
  const list = el("div", { className: "account-list account-list--paged" });
  const more = el("button", { className: "button button--secondary account-list__more", attrs: { type: "button" } }, t("Pokaż więcej"));
  const sort = el(
    "select",
    { className: "input input--compact account-list__sort", attrs: { "aria-label": `Sortowanie: ${title}` } },
    el("option", { text: t("Ostatnio dodane"), attrs: { value: "newest" } }),
    el("option", { text: t("Najstarsze"), attrs: { value: "oldest" } }),
    el("option", { text: t("Nazwa A–Z"), attrs: { value: "title_asc" } }),
    el("option", { text: t("Moja ocena"), attrs: { value: "own_rating_desc" } }),
    el("option", { text: t("Średnia ocena"), attrs: { value: "average_rating_desc" } }),
    el("option", { text: t("Moje odtworzenia"), attrs: { value: "own_plays_desc" } }),
    el("option", { text: t("Wszystkie odtworzenia"), attrs: { value: "all_plays_desc" } })
    ,el("option", { text: t("Losowo"), attrs: { value: "random" } })
  );
  let page = 0;
  let loading = false;
  let randomSeed = crypto.randomUUID().replaceAll("-", "");

  const load = async (reset = false): Promise<void> => {
    if (loading) return;
    loading = true;
    more.disabled = true;
    if (reset) {
      if (sort.value === "random") randomSeed = crypto.randomUUID().replaceAll("-", "");
      page = 0;
      list.replaceChildren(el("p", { className: "empty-copy", text: t("Pobieranie…") }));
    }
    try {
      const response = await getAccountEntries(section, kind, sort.value as AccountEntrySort, page + 1, limit, username, randomSeed);
      if (page === 0) list.replaceChildren();
      for (const entry of response.items) list.append(entryRow(entry, ownProfile));
      page = response.page;
      more.classList.toggle("hidden", !response.has_more);
      if (page === 1 && response.items.length === 0) {
        list.replaceChildren(el("p", { className: "empty-copy", text: emptyText }));
      }
    } catch {
      if (page === 0) list.replaceChildren(el("p", { className: "empty-copy", text: t("Nie udało się pobrać tej listy.") }));
    } finally {
      loading = false;
      more.disabled = false;
    }
  };

  sort.addEventListener("change", () => void load(true));
  more.addEventListener("click", () => void load());
  void load(true);

  return el(
    "article",
    { className: "panel account-panel account-panel--entries" },
    el("div", { className: "account-panel__heading" }, el("h2", { text: title }), sort),
    list,
    more
  );
}

function profileToolbar(account: AccountData, ownUsername: string, canBrowse: boolean, refresh: () => Promise<void>): HTMLElement {
  const currentUsername = account.profile.username;
  const profileUrl = new URL(appUrl(`account/${encodeURIComponent(currentUsername)}/`), window.location.origin);
  const link = el("input", { className: "input account-profile__link", attrs: { type: "text", readonly: true, "aria-label": t("Link profilu") } });
  link.value = profileUrl.href;
  const copy = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("share"), t("Kopiuj link"));
  copy.disabled = account.profile.is_own && !account.profile.is_public;
  copy.addEventListener("click", () => void copyLink(profileUrl).then(() => { copy.textContent = t("Skopiowano"); }));
  const publicToggle = el("input", { attrs: { type: "checkbox" } });
  publicToggle.checked = account.profile.is_public;
  const status = el("p", {
    className: "form-status",
    text: account.profile.is_public
      ? t("Profil publiczny — osoby z uprawnieniem przeglądania profili mogą otworzyć ten adres.")
      : t("Profil prywatny — adres działa tylko dla Ciebie.")
  });
  const save = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("check"), t("Zapisz widoczność"));
  save.addEventListener("click", () => {
    save.disabled = true;
    status.textContent = t("Zapisywanie…");
    void setProfileVisibility(publicToggle.checked)
      .then(refresh)
      .catch(() => { status.textContent = t("Nie udało się zapisać widoczności profilu."); save.disabled = false; });
  });
  const close = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
  const dialog = el(
    "div",
    { className: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "true" } },
    el("button", { className: "dialog__backdrop", attrs: { type: "button", "aria-label": t("Zamknij") } }),
    el("section", { className: "dialog__panel dialog__panel--profile-share" },
      el("header", { className: "dialog__header" }, el("h2", { text: t("Udostępnij profil") }), close),
      el("div", { className: "account-profile__share-dialog" },
        account.profile.is_own
          ? el("label", { className: "account-profile__visibility" }, publicToggle, el("span", { text: t("Profil publiczny") }))
          : null,
        status,
        el("div", { className: "account-profile__link-row" }, link, copy),
        account.profile.is_own ? el("div", { className: "account-profile__share-actions" }, save) : null
      )
    )
  );
  let releaseModal: (() => void) | null = null;
  const closeDialog = (): void => {
    dialog.setAttribute("aria-hidden", "true");
    releaseModal?.();
    releaseModal = null;
  };
  close.addEventListener("click", closeDialog);
  dialog.querySelector(".dialog__backdrop")?.addEventListener("click", closeDialog);
  const share = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("share"), t("Udostępnij profil"));
  share.addEventListener("click", () => {
    dialog.setAttribute("aria-hidden", "false");
    releaseModal?.();
    releaseModal = openModal(dialog, { onEscape: closeDialog });
  });
  document.addEventListener("media:route-will-change", closeDialog, { once: true });
  const own = el("a", { className: "button button--secondary", attrs: { href: appUrl(`account/${encodeURIComponent(ownUsername)}/`) } }, t("Własny profil"));
  const search = el("input", { className: "input", attrs: { type: "search", placeholder: t("Znajdź użytkownika…"), autocomplete: "off" } });
  const suggestions = el("div", { className: "account-profile__suggestions" });
  let timer = 0;
  let revision = 0;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    const query = search.value.trim();
    suggestions.replaceChildren();
    if (query.length < 2) return;
    const currentRevision = ++revision;
    timer = window.setTimeout(() => void searchProfiles(query).then((profiles) => {
      if (currentRevision !== revision) return;
      suggestions.replaceChildren(...profiles.map((profile) => el(
        "a",
        { attrs: { href: appUrl(`account/${encodeURIComponent(profile.username)}/`) } },
        icon("user"),
        el("span", { text: profile.username }),
        profile.is_public ? null : el("small", { text: t("Prywatny") })
      )));
    }).catch(() => undefined), 220);
  });
  return el(
    "section",
    { className: "panel account-profile" },
    el("div", {}, el("span", { className: "eyebrow", text: t("Profil użytkownika") }), el("h2", { text: currentUsername })),
    share,
    canBrowse ? el("div", { className: "account-profile__browser" }, own, el("div", { className: "account-profile__search" }, search, suggestions)) : null,
    dialog
  );
}

/**
 * What this playlist's queue shows, decided by the person who made it.
 *
 * The account page already answers this question once, globally, and that stays
 * the default — it is your queue. But a playlist is an argument about music, and
 * "these are the three I keep coming back to" is part of the argument; showing
 * the listener their own stars over somebody else's selection answers a question
 * nobody asked. So the author can put their rating and their favourites on the
 * list, and everybody who plays it sees those.
 *
 * The default stays «inherit» — "leave it to whoever is listening" — and it has
 * to: this publishes the author's ratings and favourite marks to everyone who
 * plays the list, which is a decision somebody makes, never a default they
 * discover afterwards. Offered for music only, because a film collection has no
 * playback queue to draw.
 */
function queueDisplayFields(collection: UserCollection): {
  panel: HTMLElement | null;
  value: () => { queue_rating?: CollectionQueueRating; queue_favorite?: CollectionQueueFavorite };
} {
  if (collection.media_kind !== "music") return { panel: null, value: () => ({}) };
  const rating = el("select", { className: "input", attrs: { "aria-label": t("Ocena w kolejce tej playlisty") } },
    el("option", { text: t("Jak w ustawieniach słuchacza"), attrs: { value: "inherit" } }),
    el("option", { text: t("Moja ocena (autora listy)"), attrs: { value: "owner" } }),
    el("option", { text: t("Ocena słuchacza"), attrs: { value: "viewer" } }),
    el("option", { text: t("Średnia ocena"), attrs: { value: "average" } }),
    el("option", { text: t("Bez oceny"), attrs: { value: "none" } })
  ) as HTMLSelectElement;
  rating.value = collection.queue_rating ?? "inherit";
  const favorite = el("select", { className: "input", attrs: { "aria-label": t("Ulubione w kolejce tej playlisty") } },
    el("option", { text: t("Jak w ustawieniach słuchacza"), attrs: { value: "inherit" } }),
    el("option", { text: t("Moje ulubione (autora listy)"), attrs: { value: "owner" } }),
    el("option", { text: t("Ulubione słuchacza"), attrs: { value: "viewer" } }),
    el("option", { text: t("Bez znacznika"), attrs: { value: "none" } })
  ) as HTMLSelectElement;
  favorite.value = collection.queue_favorite ?? "inherit";
  const notice = el("p", { className: "field__hint" });
  const syncNotice = (): void => {
    const shares = rating.value === "owner" || favorite.value === "owner";
    notice.textContent = shares
      ? t("Każdy, kto odtworzy tę listę, zobaczy Twoje oceny i ulubione dla jej pozycji.")
      : t("Ustawienie należy do listy — obowiązuje każdego, kto ją odtwarza.");
  };
  rating.addEventListener("change", syncNotice);
  favorite.addEventListener("change", syncNotice);
  syncNotice();
  return {
    panel: el("div", { className: "collection-card__queue" },
      el("span", { className: "field__label", text: t("Kolejka tej playlisty") }),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Ocena") }), rating),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Ulubione") }), favorite),
      notice
    ),
    value: () => ({
      queue_rating: rating.value as CollectionQueueRating,
      queue_favorite: favorite.value as CollectionQueueFavorite
    })
  };
}

function collectionCard(collection: UserCollection, refresh: () => Promise<void>, canManage: boolean, canShare: boolean): HTMLElement {
  const target = collection.media_kind === "music" ? "music/" : "movies/";
  const link = new URL(appUrl(target), window.location.origin);
  link.searchParams.set("collection", String(collection.id));
  const share = el(
    "button",
    { className: "icon-button" + (collection.is_shared ? " is-active" : ""), attrs: { type: "button", "aria-label": t("Udostępnij {name}", { name: collection.name }) } },
    icon("share")
  );
  share.dataset.tooltip = collection.is_shared ? t("Kopiuj link do udostępnionej listy") : "Udostępnij i skopiuj link";
  share.addEventListener("click", () => {
    share.disabled = true;
    void Promise.resolve(collection.is_shared ? undefined : setCollectionShared(collection.id, true))
      .then(() => {
        collection.is_shared = true;
        share.classList.add("is-active");
        return copyLink(link);
      })
      .then(() => { share.dataset.tooltip = "Link skopiowany"; })
      .catch(() => { share.dataset.tooltip = t("Nie udało się udostępnić"); })
      .finally(() => { share.disabled = false; });
  });
  const remove = el(
    "button",
    { className: "icon-button", attrs: { type: "button", "aria-label": t("Usuń {name}", { name: collection.name }) } },
    icon("close")
  );
  remove.addEventListener("click", () => {
    if (!window.confirm(t("Usunąć kolekcję „{name}”? Pliki multimedialne pozostaną bez zmian.", { name: collection.name }))) return;
    remove.disabled = true;
    void deleteCollection(collection.id).then(refresh).catch(() => { remove.disabled = false; });
  });
  const actions = el("div", { className: "collection-card__actions" });
  const card = el("article", { className: "collection-card" });
  if (canManage) {
    const edit = el(
      "button",
      { className: "icon-button", attrs: { type: "button", "aria-label": t("Edytuj {name}", { name: collection.name }) } },
      icon("edit")
    );
    edit.dataset.tooltip = t("Zmień nazwę, opis, widoczność lub wygląd kolejki");
    edit.addEventListener("click", () => {
      const name = el("input", {
        className: "input",
        attrs: { type: "text", minlength: "2", maxlength: "191", required: true, value: collection.name }
      }) as HTMLInputElement;
      const description = el("input", {
        className: "input",
        attrs: { type: "text", maxlength: "500", value: collection.description, placeholder: t("Krótki opis (opcjonalnie)") }
      }) as HTMLInputElement;
      const shared = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
      shared.checked = collection.is_shared;
      const queue = queueDisplayFields(collection);
      const status = el("span", { className: "form-status", attrs: { role: "status" } });
      const cancel = el("button", { className: "button button--ghost", attrs: { type: "button" } }, t("Anuluj"));
      const form = el(
        "form",
        { className: "collection-card__edit" },
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Nazwa") }), name),
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Opis") }), description),
        el("label", { className: "toggle-field" }, shared, el("span", { text: t("Udostępniona innym") })),
        queue.panel,
        el("div", { className: "collection-card__edit-actions" },
          el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zapisz")),
          cancel,
          status
        )
      );
      cancel.addEventListener("click", () => void refresh());
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        status.textContent = t("Zapisywanie…");
        const wantsShared = shared.checked;
        void updateCollection(collection.id, {
          name: name.value.trim(),
          description: description.value.trim(),
          ...queue.value()
        })
          .then(() => (wantsShared === collection.is_shared
            ? undefined
            : setCollectionShared(collection.id, wantsShared)))
          .then(refresh)
          .catch(() => { status.textContent = t("Nie udało się zapisać zmian."); });
      });
      card.replaceChildren(form);
      name.focus();
    });
    actions.append(edit);
  }
  if (canShare) actions.append(share);
  if (canManage) actions.append(remove);
  const summary = collection.is_smart
    ? t("Inteligentna lista · reguły dynamiczne")
    : collection.item_count.toLocaleString("pl-PL") + " pozycji";
  card.append(
    el(
      "a",
      { className: "collection-card__link", attrs: { href: link.pathname + link.search } },
      el("span", { className: "collection-card__icon" }, icon(collection.media_kind === "music" ? "music" : "film")),
      el(
        "span",
        { className: "collection-card__copy" },
        el("strong", { text: collection.name }),
        el("small", { text: collection.description ? `${summary} · ${collection.description}` : summary })
      ),
      icon("arrow")
    ),
    actions
  );
  return card;
}

/**
 * Interface language, stored with the account rather than the browser.
 *
 * Saving reloads the page. Every label is resolved once, when its element is
 * built, so a live swap would mean re-rendering the shell, the open dialogs, the
 * dock and the queue — a reload is one line and leaves nothing half-translated.
 */
function languagePanel(session: SessionResponse): HTMLElement {
  const current = session.preferences?.language ?? defaultUserPreferences.language;
  const names: Record<Language, string> = { pl: t("Polski"), en: t("Angielski") };
  const select = el(
    "select",
    { className: "input", attrs: { "aria-label": t("Język interfejsu") } },
    ...LANGUAGES.map((code) => el("option", { text: names[code], attrs: { value: code } }))
  ) as HTMLSelectElement;
  select.value = current;
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const save = el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zapisz"));
  const form = el("form", { className: "account-preferences" },
    el("div", { className: "account-preferences__options" },
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Język interfejsu") }), select)
    ),
    el("div", { className: "account-panel__actions" }, save, status)
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = t("Zapisywanie…");
    void saveUserPreferences({
      ...defaultUserPreferences,
      ...session.preferences,
      language: select.value as Language
    })
      .then(() => {
        status.textContent = t("Zapisano — interfejs używa nowego języka.");
        window.location.reload();
      })
      .catch((error: unknown) => {
        status.textContent = error instanceof Error && error.message ? error.message : t("Nie udało się zapisać ustawień.");
        save.disabled = false;
      });
  });
  return el("article", { className: "panel account-panel" },
    el("div", { className: "account-panel__heading" }, el("h2", { text: t("Język interfejsu") })),
    el("p", { className: "muted", text: t("Wybierz język napisów w aplikacji. Ustawienie należy do konta, więc obowiązuje na każdym urządzeniu.") }),
    form
  );
}

/**
 * Take your ratings and favourites away as a spreadsheet.
 *
 * Yours only — an export that could name somebody else's ratings would be a way
 * to read them. The file identifies each entry by catalogue id, so importing it
 * back restores exactly what it says, and it names no file on disk.
 */
function ratingsExportPanel(): HTMLElement {
  // Two formats because they are for two different readers: a spreadsheet opens
  // the CSV, and JSON keeps the types a rating actually has (a number, and a
  // boolean) instead of flattening everything to text.
  const csv = el("a", {
    className: "button button--secondary",
    attrs: { href: ratingsExportUrl("csv"), download: "", rel: "nofollow" }
  });
  csv.append(icon("archive"), el("span", { text: t("Pobierz oceny (CSV)") }));
  const json = el("a", {
    className: "button button--secondary",
    attrs: { href: ratingsExportUrl("json"), download: "", rel: "nofollow" }
  });
  json.append(icon("file"), el("span", { text: t("Pobierz oceny (JSON)") }));
  return el("article", { className: "panel account-panel" },
    el("div", { className: "account-panel__heading" }, el("h2", { text: t("Oceny i ulubione") })),
    el("p", { className: "muted", text: t("Twoje oceny i ulubione. CSV otwiera się w arkuszu, JSON czyta się programom; pozycje są rozpoznawane po identyfikatorze katalogu, więc import przywróci dokładnie to samo.") }),
    el("div", { className: "account-panel__actions" }, csv, json)
  );
}

/**
 * Upload a playlist or a ratings file, then agree to what it turned out to mean.
 *
 * Nothing an uploaded file says is written on its own. The server matches what
 * it can — by the file's own fingerprint first, then by our id, then by name —
 * and everything it could not settle waits here with the candidates it weighed.
 * A wrong guess would be silent: the playlist would simply hold the wrong
 * recording, and nothing on screen would ever say so.
 */
function importPanel(refresh: () => Promise<void>): HTMLElement {
  // The same shape the cover picker uses: a real drop zone over a hidden native
  // input. A bare <input type="file"> is the one control the browser draws
  // itself, and it arrives with a grey system button that belongs to no theme.
  const file = el("input", {
    className: "cover-editor__input",
    attrs: { type: "file", accept: ".m3u,.m3u8,.xspf,.csv,.json", tabindex: "-1" }
  }) as HTMLInputElement;
  const dropLabel = el("strong", { text: t("Przeciągnij plik tutaj") });
  const dropHint = el("span", { text: t("albo kliknij, aby wybrać M3U, XSPF, CSV lub JSON") });
  const dropZone = el(
    "div",
    {
      className: "cover-editor__dropzone import-form__drop",
      attrs: { tabindex: "0", role: "button", "aria-label": t("Wybierz lub upuść plik") }
    },
    el("span", { className: "cover-editor__upload-icon" }, icon("file")),
    dropLabel,
    dropHint,
    file
  );
  const showChosen = (): void => {
    const chosen = file.files?.[0];
    dropLabel.textContent = chosen ? chosen.name : t("Przeciągnij plik tutaj");
    dropHint.textContent = chosen
      ? t("{size} kB — kliknij, aby wybrać inny", { size: Math.max(1, Math.round(chosen.size / 1024)) })
      : t("albo kliknij, aby wybrać M3U, XSPF, CSV lub JSON");
  };
  file.addEventListener("change", showChosen);
  dropZone.addEventListener("click", () => file.click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      file.click();
    }
  });
  for (const name of ["dragenter", "dragover"]) {
    dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
  }
  for (const name of ["dragleave", "drop"]) {
    dropZone.addEventListener(name, () => dropZone.classList.remove("is-dragging"));
  }
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    const dropped = (event as DragEvent).dataTransfer?.files?.[0];
    if (!dropped) return;
    const carrier = new DataTransfer();
    carrier.items.add(dropped);
    file.files = carrier.files;
    showChosen();
  });
  const kind = el("select", { className: "input", attrs: { "aria-label": t("Biblioteka") } },
    el("option", { text: t("Muzyka"), attrs: { value: "music" } }),
    el("option", { text: t("Filmy"), attrs: { value: "movies" } })
  ) as HTMLSelectElement;
  const upload = el("button", { className: "button button--primary", attrs: { type: "button" } },
    icon("archive"), el("span", { text: t("Wczytaj plik") }));
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const host = el("div", { className: "stack" });

  const render = (state: ImportStatus): void => {
    const counts = state.counts;
    const summary = el("p", { className: "muted", text: t(
      "Dopasowane: {matched} · Do rozstrzygnięcia: {ambiguous} · Nieodnalezione: {missing} · Pominięte: {skipped}",
      { matched: counts.matched, ambiguous: counts.ambiguous, missing: counts.missing, skipped: counts.skipped }
    ) });
    const name = el("input", {
      className: "input",
      attrs: { type: "text", maxlength: "191", placeholder: t("Nazwa playlisty") }
    }) as HTMLInputElement;
    name.value = state.collection_name ?? "";

    const rows = state.entries
      .filter((entry) => entry.state === "ambiguous" || entry.state === "missing")
      .map((entry) => {
        const card = el("article", { className: "panel admin-lookup" });
        const choices = entry.candidates.map((candidate) => {
          const take = el("button", { className: "button button--primary", attrs: { type: "button" } },
            icon("check"), el("span", { text: t("To ten") }));
          take.addEventListener("click", () => {
            card.setAttribute("aria-busy", "true");
            void resolveImportEntry(entry.id, "choose", candidate.id)
              .then(() => card.replaceChildren(
                el("p", { className: "form-status", text: t("Wybrano: {title}", { title: candidate.title }) })
              ))
              .catch(() => { status.textContent = t("Nie udało się zapisać wyboru."); })
              .finally(() => card.removeAttribute("aria-busy"));
          });
          return el("div", { className: "admin-lookup__candidate" },
            el("div", { className: "admin-lookup__candidate-copy" },
              el("strong", { text: candidate.title || t("(bez tytułu)") }),
              candidate.artist ? el("span", { className: "muted", text: candidate.artist }) : null,
              // The folder, not the whole path: enough to tell two files with the
              // same name apart without printing the library's layout.
              candidate.folder ? el("small", { className: "muted", text: candidate.folder }) : null
            ),
            take
          );
        });
        const skip = el("button", { className: "button button--secondary", attrs: { type: "button" } },
          icon("close"), el("span", { text: t("Pomiń tę pozycję") }));
        skip.addEventListener("click", () => {
          void resolveImportEntry(entry.id, "skip")
            .then(() => card.replaceChildren(el("p", { className: "form-status", text: t("Pominięto.") })))
            .catch(() => { status.textContent = t("Nie udało się zapisać wyboru."); });
        });
        card.replaceChildren(
          el("header", { className: "admin-lookup__heading" },
            el("div", {}, el("h3", { text: entry.label })),
            el("span", { className: "admin-lookup__badge", text: entry.state === "ambiguous"
              ? t("kilka pasujących") : t("nie znaleziono") })
          ),
          choices.length > 0
            ? el("div", { className: "admin-lookup__candidates" }, ...choices)
            : el("p", { className: "empty-copy", text: t("W bibliotece nie ma pliku o tej nazwie.") }),
          el("footer", { className: "admin-lookup__footer" }, skip)
        );
        return card;
      });

    const save = el("button", { className: "button button--primary", attrs: { type: "button" } },
      icon("check"), el("span", { text: state.kind === "ratings" ? t("Zapisz oceny") : t("Utwórz playlistę") }));
    save.addEventListener("click", () => {
      save.disabled = true;
      status.textContent = t("Zapisywanie…");
      void applyImport(state.id, state.kind === "playlist" ? name.value : undefined)
        .then((result) => {
          host.replaceChildren(el("p", {
            className: "form-status",
            text: t("Zapisano {count} pozycji.", { count: result.written })
          }));
          status.textContent = "";
          return refresh();
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : t("Nie udało się zapisać importu.");
          save.disabled = false;
        });
    });
    const drop = el("button", { className: "button button--secondary", attrs: { type: "button" } },
      icon("close"), el("span", { text: t("Odrzuć import") }));
    drop.addEventListener("click", () => {
      void discardImport(state.id)
        .then(() => { host.replaceChildren(); status.textContent = t("Import odrzucony."); })
        .catch(() => { status.textContent = t("Nie udało się odrzucić importu."); });
    });

    host.replaceChildren(
      summary,
      ...(state.truncated
        ? [el("p", {
            className: "notice notice--error",
            text: t("Plik był dłuższy niż limit — wczytano pierwsze 5000 pozycji.")
          })]
        : []),
      ...(state.kind === "playlist"
        ? [el("label", { className: "field" }, el("span", { className: "field__label", text: t("Nazwa playlisty") }), name)]
        : []),
      ...(rows.length > 0
        ? [el("p", { className: "muted", text: t("Poniższych pozycji system nie rozstrzygnął sam:") }), ...rows]
        : []),
      el("div", { className: "account-panel__actions" }, save, drop)
    );
  };

  upload.addEventListener("click", () => {
    const chosen = file.files?.[0];
    if (!chosen) {
      status.textContent = t("Najpierw wybierz plik.");
      return;
    }
    upload.disabled = true;
    status.textContent = t("Wczytywanie…");
    void startImport(chosen, kind.value as LibraryKind)
      .then((state) => { status.textContent = ""; render(state); })
      .catch((error: unknown) => {
        status.textContent = error instanceof Error ? error.message : t("Nie udało się wczytać pliku.");
      })
      .finally(() => { upload.disabled = false; });
  });

  return el("article", { className: "panel account-panel" },
    el("div", { className: "account-panel__heading" }, el("h2", { text: t("Wczytaj playlistę lub oceny") })),
    el("p", { className: "muted", text: t("Obsługiwane są pliki M3U, XSPF, CSV i JSON. Nic nie zostanie zapisane, dopóki nie potwierdzisz — pozycje, których system nie rozpozna jednoznacznie, pokażą się do wyboru.") }),
    dropZone,
    el("div", { className: "import-form" },
      el("label", { className: "field import-form__kind" },
        el("span", { className: "field__label", text: t("Biblioteka") }), kind),
      upload
    ),
    status,
    host
  );
}

/** Self-service password and e-mail change, shown only on the owner's profile. */
/**
 * What the playback queue shows. Stored with the account (not the browser), so the
 * same choice applies on the phone and on the desktop.
 */
function queuePreferencesPanel(session: SessionResponse, onSaved: (preferences: UserPreferences) => void): HTMLElement {
  const current = { ...defaultUserPreferences.queue, ...(session.preferences?.queue ?? {}) };
  const indexToggle = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  indexToggle.checked = current.index;
  const favoriteToggle = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  favoriteToggle.checked = current.favorite;
  const rating = el("select", { className: "input", attrs: { "aria-label": t("Ocena w kolejce") } },
    el("option", { text: t("Moja ocena"), attrs: { value: "own" } }),
    el("option", { text: t("Średnia ocena"), attrs: { value: "average" } }),
    el("option", { text: t("Bez oceny"), attrs: { value: "none" } })
  ) as HTMLSelectElement;
  rating.value = current.rating;
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const save = el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zapisz"));

  const form = el("form", { className: "account-preferences" },
    el("div", { className: "account-preferences__options" },
      el("label", { className: "toggle-field" }, indexToggle, el("span", { text: t("Numer pozycji") })),
      el("label", { className: "toggle-field" }, favoriteToggle, el("span", { text: t("Znacznik ulubionych") })),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Ocena") }), rating)
    ),
    el("div", { className: "account-panel__actions" }, save, status)
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = t("Zapisywanie…");
    void saveUserPreferences({
      ...defaultUserPreferences,
      ...session.preferences,
      queue: {
        index: indexToggle.checked,
        favorite: favoriteToggle.checked,
        rating: rating.value as UserPreferences["queue"]["rating"]
      }
    })
      .then((saved) => {
        status.textContent = t("Zapisano — kolejka używa nowych ustawień.");
        onSaved(saved);
      })
      .catch((error: unknown) => {
        status.textContent = error instanceof Error && error.message ? error.message : t("Nie udało się zapisać ustawień.");
      })
      .finally(() => { save.disabled = false; });
  });

  return el("article", { className: "panel account-panel" },
    el("div", { className: "account-panel__heading" }, el("h2", { text: t("Kolejka odtwarzania") })),
    el("p", { className: "muted", text: t("Wybierz, co pokazuje lista kolejki obok tytułu utworu.") }),
    form
  );
}

function securityPanel(): HTMLElement {
  const currentForPassword = el("input", {
    className: "input", attrs: { type: "password", required: true, autocomplete: "current-password", placeholder: t("Obecne hasło") }
  }) as HTMLInputElement;
  const newPassword = el("input", {
    className: "input", attrs: { type: "password", required: true, minlength: "12", autocomplete: "new-password", placeholder: t("Minimum 12 znaków") }
  }) as HTMLInputElement;
  const newPasswordConfirm = el("input", {
    className: "input", attrs: { type: "password", required: true, minlength: "12", autocomplete: "new-password", placeholder: t("Powtórz nowe hasło") }
  }) as HTMLInputElement;
  const passwordStatus = el("span", { className: "form-status", attrs: { role: "status" } });
  const passwordForm = el(
    "form",
    { className: "account-security__form" },
    el("h3", { text: t("Zmiana hasła") }),
    el("label", { className: "field" }, el("span", { className: "field__label", text: t("Obecne hasło") }), currentForPassword),
    el("label", { className: "field" }, el("span", { className: "field__label", text: t("Nowe hasło") }), newPassword),
    el("label", { className: "field" }, el("span", { className: "field__label", text: t("Powtórz nowe hasło") }), newPasswordConfirm),
    el("div", { className: "account-security__actions" },
      el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zmień hasło")),
      passwordStatus
    )
  );
  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    newPasswordConfirm.setCustomValidity(newPassword.value === newPasswordConfirm.value ? "" : t("Hasła nie są identyczne."));
    if (!passwordForm.reportValidity()) return;
    const submit = passwordForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    passwordStatus.textContent = t("Zapisywanie…");
    void changePassword(currentForPassword.value, newPassword.value, newPasswordConfirm.value)
      .then(() => {
        passwordForm.reset();
        passwordStatus.textContent = t("Hasło zostało zmienione.");
      })
      .catch(() => { passwordStatus.textContent = t("Nie udało się zmienić hasła. Sprawdź obecne hasło i długość nowego."); })
      .finally(() => { if (submit) submit.disabled = false; });
  });

  const newEmail = el("input", {
    className: "input", attrs: { type: "email", required: true, maxlength: "254", autocomplete: "email", placeholder: t("nowy@adres.pl") }
  }) as HTMLInputElement;
  const currentForEmail = el("input", {
    className: "input", attrs: { type: "password", required: true, autocomplete: "current-password", placeholder: t("Obecne hasło") }
  }) as HTMLInputElement;
  const emailStatus = el("span", { className: "form-status", attrs: { role: "status" } });
  const emailForm = el(
    "form",
    { className: "account-security__form" },
    el("h3", { text: t("Zmiana adresu e-mail") }),
    el("p", { className: "muted", text: t("Na nowy adres wyślemy link potwierdzający; adres zmieni się dopiero po jego otwarciu.") }),
    el("label", { className: "field" }, el("span", { className: "field__label", text: t("Nowy adres e-mail") }), newEmail),
    el("label", { className: "field" }, el("span", { className: "field__label", text: t("Obecne hasło") }), currentForEmail),
    el("div", { className: "account-security__actions" },
      el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("share"), t("Wyślij link potwierdzający")),
      emailStatus
    )
  );
  emailForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!emailForm.reportValidity()) return;
    const submit = emailForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    emailStatus.textContent = t("Wysyłanie…");
    void requestEmailChange(newEmail.value.trim(), currentForEmail.value)
      .then((result) => {
        emailForm.reset();
        emailStatus.textContent = result.spooled
          ? t("Wiadomość zapisana w logs/mail — otwórz link, aby potwierdzić.")
          : t("Sprawdź nową skrzynkę i kliknij link potwierdzający.");
      })
      .catch(() => { emailStatus.textContent = t("Nie udało się rozpocząć zmiany adresu. Sprawdź hasło i format adresu."); })
      .finally(() => { if (submit) submit.disabled = false; });
  });

  return el(
    "section",
    { className: "panel account-panel account-security" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Bezpieczeństwo") }), el("h2", { text: t("Hasło i adres e-mail") })),
      el("p", { text: t("Zmiany wymagają potwierdzenia obecnym hasłem.") })
    ),
    el("div", { className: "account-security__grid" }, passwordForm, emailForm)
  );
}

/**
 * Every link this account has handed out, and the way to withdraw one.
 *
 * A guest link is given to somebody and then forgotten about, which is exactly
 * why it needs a page: what is still open, how much of its download budget is
 * gone, when it stops working by itself. Withdrawn links stay listed with the
 * reason, because "it ran out" and "I turned it off" are different stories.
 */
function guestLinksPanel(): HTMLElement {
  const list = el("div", { className: "account-sessions" });
  const status = el("p", { className: "form-status", attrs: { role: "status" } });

  const describe = (link: GuestLinkRow): string => {
    if (link.revoked_at) return t("wycofany {when}", { when: link.revoked_at.slice(0, 16).replace("T", " ") });
    if (Date.parse(link.expires_at.replace(" ", "T")) < Date.now()) return t("wygasł");
    return t("ważny do {when}", { when: link.expires_at.slice(0, 16).replace("T", " ") });
  };

  const load = async (): Promise<void> => {
    status.textContent = t("Pobieranie…");
    try {
      const links = await getGuestLinks();
      list.replaceChildren(...links.map((link) => {
        const revoke = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Wycofaj"));
        revoke.addEventListener("click", () => {
          revoke.disabled = true;
          void revokeGuestLink(link.id).then(load).catch(() => { revoke.disabled = false; });
        });
        const active = !link.revoked_at && Date.parse(link.expires_at.replace(" ", "T")) >= Date.now();
        return el("div", { className: "account-sessions__row" },
          el("div", { className: "account-sessions__copy" },
            el("strong", { text: link.label || (link.target_kind === "collection" ? t("Playlista") : t("Folder")) }),
            el("span", { text: describe(link) }),
            el("small", {
              text: t("Pobrania: {used} z {max}", {
                used: String(link.downloads_used),
                max: String(link.max_downloads)
              }) + (link.last_used_at ? " · " + t("użyty {when}", { when: link.last_used_at.slice(0, 16).replace("T", " ") }) : "")
            })),
          active ? revoke : el("span", { className: "status-pill", text: t("nieaktywny") }));
      }));
      status.textContent = links.length === 0
        ? t("Nie masz żadnych linków gościnnych.")
        : t("Linków: {count}", { count: links.length.toLocaleString("pl-PL") });
    } catch {
      status.textContent = t("Nie udało się pobrać linków.");
    }
  };
  void load();

  return el(
    "section",
    { className: "panel account-panel" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Udostępnianie") }), el("h2", { text: t("Linki gościnne") })),
      el("p", { text: t("Tworzysz je przyciskiem przy folderze albo playliście. Działają bez konta, pokazują wyłącznie to jedno miejsce i same wygasają.") })
    ),
    list,
    el("div", { className: "account-sessions__actions" }, status)
  );
}

/**
 * "What is new in the library", once a week, or not at all.
 *
 * Off by default and off until somebody says otherwise: mail that starts
 * arriving because a version was installed is mail people learn to filter. The
 * control says what the message contains and when the last one went out, so the
 * choice is made with the facts rather than the label.
 */
function digestPanel(): HTMLElement {
  const choice = el("select", { className: "input", attrs: { "aria-label": t("Przegląd nowości") } },
    el("option", { text: t("Nie wysyłaj"), attrs: { value: "off" } }),
    el("option", { text: t("Raz w tygodniu"), attrs: { value: "weekly" } })
  ) as HTMLSelectElement;
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const facts = el("p", { className: "muted" });

  const paint = (digest: DigestSubscription): void => {
    choice.value = digest.frequency;
    choice.disabled = !digest.has_email;
    facts.textContent = !digest.has_email
      ? t("Najpierw dodaj adres e-mail do konta — nie ma dokąd wysłać przeglądu.")
      : digest.last_sent_at
        ? t("Ostatnia wiadomość: {when}", { when: digest.last_sent_at.slice(0, 16).replace("T", " ") })
        : t("Nie wysłano jeszcze żadnej wiadomości.");
  };

  void getDigest().then(paint).catch(() => { status.textContent = t("Nie udało się pobrać ustawień powiadomień."); });
  choice.addEventListener("change", () => {
    choice.disabled = true;
    status.textContent = t("Zapisywanie…");
    void setDigestFrequency(choice.value as DigestFrequency)
      .then((digest) => {
        paint(digest);
        status.textContent = digest.frequency === "weekly"
          ? t("Przegląd będzie wysyłany raz w tygodniu.")
          : t("Powiadomienia wyłączone.");
      })
      .catch(() => { status.textContent = t("Nie udało się zapisać ustawień."); })
      .finally(() => { choice.disabled = false; });
  });

  return el(
    "article",
    { className: "panel account-panel" },
    el("div", { className: "account-panel__heading" }, el("h2", { text: t("Przegląd nowości") })),
    el("p", { className: "muted", text: t("Lista tytułów, które pojawiły się w bibliotece — tylko z tych bibliotek, do których masz dostęp. Bez ścieżek i nazw plików.") }),
    el("div", { className: "account-sessions__actions" }, choice, status),
    facts
  );
}

/**
 * Where this account is signed in, and how to sign it out elsewhere.
 *
 * The same rows the panel shows an administrator, read by their owner — and
 * the more useful half of the two, because the browser somebody forgot to sign
 * out of is usually their own. The current session has no button: ending it is
 * what "Wyloguj" in the menu is for.
 */
function sessionsPanel(session: SessionResponse): HTMLElement {
  const list = el("div", { className: "account-sessions" });
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const others = el("button", { className: "button button--secondary", attrs: { type: "button" } },
    t("Wyloguj wszystkie oprócz tej"));

  const load = async (): Promise<void> => {
    status.textContent = t("Pobieranie…");
    try {
      // Named explicitly: an administrator asking for "sessions" gets every
      // account's, and this page is about one account — the one reading it.
      const sessions = await getActiveSessions(session.user.id);
      list.replaceChildren(...sessions.map((session) => {
        const close = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Wyloguj"));
        close.addEventListener("click", () => {
          close.disabled = true;
          void revokeSession({ fingerprint: session.fingerprint })
            .then(load)
            .catch(() => { status.textContent = t("Nie udało się zamknąć sesji."); close.disabled = false; });
        });
        return el(
          "div",
          { className: "account-sessions__row" },
          el("div", { className: "account-sessions__copy" },
            el("strong", { text: session.device_label || t("Nieznane urządzenie") }),
            el("span", { text: t("Zalogowano {when}", { when: session.created_at.slice(0, 16).replace("T", " ") }) }),
            el("small", { text: t("Ostatnia aktywność {when}", { when: session.last_seen_at.slice(0, 16).replace("T", " ") }) })),
          session.is_current
            ? el("span", { className: "status-pill status-pill--success", text: t("ta przeglądarka") })
            : close
        );
      }));
      status.textContent = t("{count} otwartych sesji", { count: sessions.length.toLocaleString("pl-PL") });
      others.disabled = sessions.length < 2;
    } catch {
      status.textContent = t("Nie udało się pobrać sesji.");
    }
  };

  others.addEventListener("click", () => {
    others.disabled = true;
    void revokeSession({ others: true })
      .then((closed) => {
        status.textContent = t("Zamknięto sesji: {count}", { count: closed.toLocaleString("pl-PL") });
        return load();
      })
      .catch(() => { status.textContent = t("Nie udało się zamknąć sesji."); others.disabled = false; });
  });
  void load();

  return el(
    "section",
    { className: "panel account-panel" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Bezpieczeństwo") }), el("h2", { text: t("Aktywne sesje") })),
      el("p", { text: t("Przeglądarki, w których to konto jest zalogowane. Zamknięcie działa przy najbliższym żądaniu danej sesji.") })
    ),
    list,
    el("div", { className: "account-sessions__actions" }, others, status)
  );
}

export async function mount(): Promise<void> {
  const shell = await mountShell("account", t("Moje konto"), t("Profil, ulubione i kolekcje"));
  const host = el("div", { className: "account-page" });
  shell.content.append(host);
  const prefix = new URL(appUrl("account/"), window.location.origin).pathname;
  let requestedUsername: string | undefined;
  if (window.location.pathname.startsWith(prefix)) {
    const encoded = window.location.pathname.slice(prefix.length).replace(/\/$/, "");
    if (encoded && !encoded.includes("/")) {
      try { requestedUsername = decodeURIComponent(encoded); } catch { requestedUsername = undefined; }
    }
  }

  const refresh = async (): Promise<void> => {
    const account = await getAccount(requestedUsername);
    requestedUsername = account.profile.username;
    const canonicalUrl = new URL(appUrl(`account/${encodeURIComponent(account.profile.username)}/`), window.location.origin);
    if (window.location.pathname !== canonicalUrl.pathname) {
      window.history.replaceState(null, "", canonicalUrl.pathname);
    }
    const stats = el(
      "section",
      { className: "account-stats", attrs: { "aria-label": t("Statystyki konta") } },
      ...[
        ["play", account.summary.plays, t("odtworzeń")],
        ["star", account.summary.ratings, t("ocen")],
        ["heart", account.summary.favorites, t("ulubionych")],
        ["list", account.summary.collections, t("kolekcji")]
      ].map(([name, value, label]) =>
        el(
          "article",
          { className: "account-stat" },
          icon(name as "play" | "star" | "heart" | "list"),
          el("strong", { text: Number(value).toLocaleString("pl-PL") }),
          el("span", { text: String(label) })
        )
      )
    );

  const canManageCollections = account.profile.is_own && can(shell.session, "can_create_collections");
    const collectionsHost = el(
      "div",
      { className: "collection-grid" },
      ...account.collections.map((collection) => collectionCard(collection, refresh, canManageCollections, can(shell.session, "can_share")))
    );
    if (!account.collections.length) {
      collectionsHost.append(
        el("div", { className: "empty-state empty-state--compact" }, el("p", { text: t("Nie masz jeszcze własnych playlist ani kolekcji.") }))
      );
    }

    const name = el("input", {
      className: "input",
      attrs: { type: "text", minlength: "2", maxlength: "191", required: true, placeholder: t("Np. Wieczorny chill") }
    });
    const description = el("input", {
      className: "input",
      attrs: { type: "text", maxlength: "500", placeholder: t("Krótki opis (opcjonalnie)") }
    }) as HTMLInputElement;
    const kind = el(
      "select",
      { className: "input" },
      el("option", { text: t("Playlista muzyczna"), attrs: { value: "music" } }),
      el("option", { text: t("Kolekcja filmów"), attrs: { value: "movies" } })
    );
    const mode = el(
      "select",
      { className: "input" },
      el("option", { text: t("Ręczna"), attrs: { value: "manual" } }),
      el("option", { text: t("Inteligentna (reguły)"), attrs: { value: "smart" } })
    );
    const query = el("input", { className: "input", attrs: { type: "search", maxlength: "191", placeholder: t("Tytuł, artysta, album…") } });
    const favorite = el(
      "select",
      { className: "input" },
      el("option", { text: t("Dowolne"), attrs: { value: "any" } }),
      el("option", { text: t("Tylko ulubione"), attrs: { value: "yes" } }),
      el("option", { text: t("Bez ulubionych"), attrs: { value: "no" } })
    );
    const ratingStatus = el(
      "select",
      { className: "input" },
      el("option", { text: t("Wszystkie oceny"), attrs: { value: "all" } }),
      el("option", { text: t("Ocenione przeze mnie"), attrs: { value: "rated" } }),
      el("option", { text: t("Jeszcze nieocenione"), attrs: { value: "unrated" } })
    );
    const playScope = el(
      "select",
      { className: "input" },
      el("option", { text: t("Odtworzenia wszystkich"), attrs: { value: "total" } }),
      el("option", { text: t("Moje odtworzenia"), attrs: { value: "own" } }),
      el("option", { text: t("Odtworzenia innych użytkowników"), attrs: { value: "others" } }),
      el("option", { text: t("Nieodtworzone"), attrs: { value: "unplayed" } })
    );
    const minPlays = numberInput(t("Minimalna liczba odtworzeń"), "0", "0", "1000000000");
    const maxPlays = numberInput(t("Maksymalna liczba odtworzeń"), "0", "0", "1000000000");
    const minRating = numberInput(t("Minimalna średnia ocena"), "0", "0", "5", "0.5");
    const maxRating = numberInput(t("Maksymalna średnia ocena"), "0", "0", "5", "0.5");
    const minRatingCount = numberInput(t("Minimalna liczba ocen"), "0", "0", "1000000000");
    const maxRatingCount = numberInput(t("Maksymalna liczba ocen"), "0", "0", "1000000000");
    const dateScope = el(
      "select",
      { className: "input" },
      el("option", { text: t("Dowolna data odtworzenia"), attrs: { value: "any" } }),
      el("option", { text: t("Data moich odtworzeń"), attrs: { value: "own" } }),
      el("option", { text: t("Data wszystkich odtworzeń"), attrs: { value: "total" } }),
      el("option", { text: t("Data odtworzeń innych użytkowników"), attrs: { value: "others" } })
    );
    const playedFrom = el("input", { className: "input", attrs: { type: "date", "aria-label": t("Data odtworzenia od") } });
    const playedTo = el("input", { className: "input", attrs: { type: "date", "aria-label": t("Data odtworzenia do") } });
    const ratingScope = el(
      "select",
      { className: "input" },
      el("option", { text: t("Moja ocena i średnia społeczności"), attrs: { value: "both" } }),
      el("option", { text: t("Tylko moja ocena"), attrs: { value: "own" } }),
      el("option", { text: t("Tylko średnia społeczności"), attrs: { value: "community" } })
    );
    const minUserRating = numberInput("Moja ocena od", "0", "0", "5", "0.5");
    const maxUserRating = numberInput("Moja ocena do", "0", "0", "5", "0.5");
    // Films only: a release year range and the genres a work may carry. Both
    // come from the title lookup rather than from the file, so the fields stay
    // out of the form until the catalogue actually knows some genres — an empty
    // multi-select tells nobody why it is empty.
    const minYear = numberInput(t("Rok od"), "0", "0", "2049");
    const maxYear = numberInput(t("Rok do"), "0", "0", "2049");
    const genreSelect = el("select", {
      className: "input smart-rules__genres",
      attrs: { multiple: "multiple", size: "8", "aria-label": t("Gatunki") }
    }) as HTMLSelectElement;
    const yearFromField = el("label", { className: "field smart-film-field hidden" }, el("span", { className: "field__label", text: t("Rok od") }), minYear);
    const yearToField = el("label", { className: "field smart-film-field hidden" }, el("span", { className: "field__label", text: t("Rok do") }), maxYear);
    const genreField = el(
      "label",
      { className: "field smart-film-field hidden" },
      el("span", { className: "field__label", text: t("Gatunki") }),
      genreSelect,
      el("span", { className: "field__hint", text: t("Wybierz kilka — lista zbierze pozycje z dowolnym z nich.") })
    );
    const ownRatingFromField = el("label", { className: "field" }, el("span", { className: "field__label", text: t("Moja ocena od") }), minUserRating);
    const ownRatingToField = el("label", { className: "field" }, el("span", { className: "field__label", text: t("Moja ocena do") }), maxUserRating);
    const averageRatingFromField = el("label", { className: "field" }, el("span", { className: "field__label", text: t("Średnia ocena od") }), minRating);
    const averageRatingToField = el("label", { className: "field" }, el("span", { className: "field__label", text: t("Średnia ocena do") }), maxRating);
    const rulesPanel = el(
      "div",
      { className: "smart-rules hidden" },
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Wyszukiwanie") }), query),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Ulubione") }), favorite),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Stan oceny") }), ratingStatus),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Źródło oceny") }), ratingScope),
      ownRatingFromField,
      ownRatingToField,
      averageRatingFromField,
      averageRatingToField,
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Liczba ocen od") }), minRatingCount),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Liczba ocen do") }), maxRatingCount),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Typ odtworzeń") }), playScope),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Odtworzenia od") }), minPlays),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Odtworzenia do") }), maxPlays),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Typ daty") }), dateScope),
      el("label", { className: "field smart-date-field" }, el("span", { className: "field__label", text: t("Data odtworzenia od") }), playedFrom),
      el("label", { className: "field smart-date-field" }, el("span", { className: "field__label", text: t("Data odtworzenia do") }), playedTo),
      yearFromField,
      yearToField,
      genreField,
      el("p", { className: "smart-rules__hint", text: t("Wartość 0 w polu «do» oznacza brak górnej granicy.") })
    );
    /**
     * Reveal the film-only rules once there is a genre dictionary to offer, and
     * only while the list is about films. Asked once per editor, not per change.
     */
    let genreOptions: GenreOption[] = [];
    const syncFilmFields = (): void => {
      const show = kind.value === "movies" && genreOptions.length > 0;
      rulesPanel.querySelectorAll(".smart-film-field").forEach((field) => field.classList.toggle("hidden", !show));
    };
    void getLibraryFilters("movies")
      .then((available) => {
        genreOptions = available.genres ?? [];
        genreSelect.replaceChildren(
          ...genreOptions.map((genre) =>
            el("option", { text: t(genre.name_pl), attrs: { value: String(genre.id) } }))
        );
        syncFilmFields();
      })
      .catch(() => undefined);
    kind.addEventListener("change", syncFilmFields);
    const syncRatingFields = (): void => {
      const scope = ratingScope.value;
      ownRatingFromField.classList.toggle("hidden", scope === "community");
      ownRatingToField.classList.toggle("hidden", scope === "community");
      averageRatingFromField.classList.toggle("hidden", scope === "own");
      averageRatingToField.classList.toggle("hidden", scope === "own");
    };
    const syncDateFields = (): void => rulesPanel.querySelectorAll(".smart-date-field").forEach((field) => field.classList.toggle("hidden", dateScope.value === "any"));
    ratingScope.addEventListener("change", syncRatingFields);
    dateScope.addEventListener("change", syncDateFields);
    mode.addEventListener("change", () => rulesPanel.classList.toggle("hidden", mode.value !== "smart"));
    syncRatingFields();
    syncDateFields();
    const formStatus = el("span", { className: "form-status", attrs: { role: "status" } });
    const form = el(
      "form",
      { className: "collection-create" },
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Nazwa") }), name),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Opis") }), description),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Biblioteka") }), kind),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Tryb") }), mode),
      rulesPanel,
      el("div", { className: "collection-create__footer" },
        el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Utwórz")),
        formStatus
      )
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit) submit.disabled = true;
      formStatus.textContent = t("Zapisywanie…");
      const rules: CollectionRules | null = mode.value === "smart" ? {
        query: query.value.trim() || null,
        favorite: favorite.value as CollectionRules["favorite"],
        rating_status: ratingStatus.value as CollectionRules["rating_status"],
        play_scope: playScope.value as CollectionRules["play_scope"],
        date_scope: dateScope.value as CollectionRules["date_scope"],
        played_from: dateScope.value === "any" ? null : (playedFrom.value || null),
        played_to: dateScope.value === "any" ? null : (playedTo.value || null),
        rating_scope: ratingScope.value as CollectionRules["rating_scope"],
        min_user_rating: Number(minUserRating.value),
        max_user_rating: Number(maxUserRating.value),
        min_plays: Number(minPlays.value),
        max_plays: Number(maxPlays.value),
        min_rating: Number(minRating.value),
        max_rating: Number(maxRating.value),
        min_rating_count: Number(minRatingCount.value),
        max_rating_count: Number(maxRatingCount.value),
        min_year: kind.value === "movies" ? Number(minYear.value) : 0,
        max_year: kind.value === "movies" ? Number(maxYear.value) : 0,
        genres: kind.value === "movies"
          ? Array.from(genreSelect.selectedOptions, (chosen) => Number(chosen.value))
          : []
      } : null;
      void createCollection({ name: name.value, description: description.value.trim(), media_kind: kind.value as LibraryKind, rules })
        .then(refresh)
        .catch(() => { formStatus.textContent = t("Nie udało się utworzyć listy. Migracja bazy może jeszcze oczekiwać."); })
        .finally(() => { if (submit) submit.disabled = false; });
    });

    host.replaceChildren(
      profileToolbar(account, shell.session.user.username, can(shell.session, "can_browse_profiles"), refresh),
      stats,
      ...(account.profile.is_own
        ? [
            languagePanel(shell.session),
            queuePreferencesPanel(shell.session, (preferences) => {
              // The session object is shared with the player, so the open queue
              // repaints without a page reload.
              shell.session.preferences = preferences;
              shell.player.refreshQueueColumns();
            }),
            ratingsExportPanel(),
            importPanel(refresh),
            securityPanel(),
            sessionsPanel(shell.session),
            digestPanel(),
            ...(shell.session.settings.guest_links_enabled === true ? [guestLinksPanel()] : [])
          ]
        : []),
      el(
        "section",
        { className: "panel account-panel account-panel--collections" },
        el("div", { className: "section-heading" },
          el("div", {}, el("span", { className: "eyebrow", text: account.profile.is_own ? t("Twoja biblioteka") : t("Publiczna biblioteka") }), el("h2", { text: t("Playlisty i kolekcje") })),
          el("p", { text: t("Listy ręczne lub automatycznie wyliczane z ocen, ulubionych i odtworzeń.") })
        ),
        collectionsHost,
        canManageCollections ? el("details", { className: "collection-builder", attrs: { id: "collection-builder" } }, el("summary", { text: t("Utwórz nową listę") }), form) : null
      ),
      el(
        "section",
        { className: "account-activity" },
        el("div", { className: "section-heading" }, el("div", {}, el("span", { className: "eyebrow", text: t("Muzyka") }), el("h2", { text: t("Aktywność muzyczna") }))),
        el("div", { className: "account-columns" },
          accountEntriesPanel(t("Ostatnio odtwarzane"), "recent", "music", t("Brak historii muzyki."), shell.session.settings.account_page_size, requestedUsername, account.profile.is_own),
          accountEntriesPanel(t("Ulubione"), "favorites", "music", t("Brak ulubionych utworów."), shell.session.settings.account_page_size, requestedUsername, account.profile.is_own),
          accountEntriesPanel(t("Ostatnio ocenione"), "rated", "music", t("Brak ocenionych utworów."), shell.session.settings.account_page_size, requestedUsername, account.profile.is_own)
        ),
        el("div", { className: "section-heading" }, el("div", {}, el("span", { className: "eyebrow", text: t("Filmy") }), el("h2", { text: t("Aktywność filmowa") }))),
        el("div", { className: "account-columns" },
          accountEntriesPanel(t("Ostatnio odtwarzane"), "recent", "movies", t("Brak historii filmów."), shell.session.settings.account_page_size, requestedUsername, account.profile.is_own),
          accountEntriesPanel(t("Ulubione"), "favorites", "movies", t("Brak ulubionych filmów."), shell.session.settings.account_page_size, requestedUsername, account.profile.is_own),
          accountEntriesPanel(t("Ostatnio ocenione"), "rated", "movies", t("Brak ocenionych filmów."), shell.session.settings.account_page_size, requestedUsername, account.profile.is_own)
        )
      )
    );
  };

  try {
    await refresh();
  } catch {
    host.replaceChildren(
      el(
        "div",
        { className: "notice notice--error" },
        el("strong", { text: t("Nie udało się pobrać danych konta.") }),
        el("p", { text: t("Odśwież sesję. Jeżeli błąd wraca, sprawdź log mostu PHP — interfejs nie ukrywa już reszty strony.") })
      )
    );
  }
}

