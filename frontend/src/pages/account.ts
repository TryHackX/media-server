import {
  changePassword, createCollection, deleteCollection, failureText, getAccount, getAccountEntries,
  applyImport, discardImport, getActiveSessions, getDigest, getGuestLinks, getLibraryFilters, isAborted,
  ratingsExportUrl, requestEmailChange, resolveImportEntry, revokeGuestLink, revokeSession,
  saveUserPreferences, searchProfiles, setCollectionShared, setDigestFrequency,
  setProfileVisibility, startImport, updateCollection,
  beginTwoFactor, confirmTwoFactor, disableTwoFactor, getTwoFactor, regenerateRecoveryCodes
} from "../shared/api";
import { copyText } from "../shared/clipboard";
import { appUrl } from "../shared/config";
import { confirmDialog } from "../shared/confirm";
import { isPast } from "../shared/datetime";
import { ownDeviceLabel, setDeviceLabel } from "../shared/device-label";
import { arrive, el } from "../shared/dom";
import { formatCount, formatDateTime, formatDuration } from "../shared/format";
import { icon } from "../shared/icons";
import { dismiss, viewTransition } from "../shared/motion";
import { sectionTabs, type SectionTab } from "../shared/section-tabs";
import { LANGUAGES, t, tn, type Language } from "../shared/i18n";
import { openModal } from "../shared/modal";
import { can, isAdministrator } from "../shared/permissions";
import { defaultDeviceLabel, deviceLabel } from "../shared/queue-sync";
import { randomId } from "../shared/random-id";
import { mountShell } from "../shared/shell";
import { THEMES, applyTheme, currentTheme, rememberTheme, type Theme } from "../shared/theme";
import { codeInput, recoveryCodesView, setupView } from "../shared/two-factor-ui";
import {
  defaultUserPreferences,
  type AccountData, type AccountEntry, type AccountEntrySort, type CollectionQueueFavorite,
  type CollectionQueueRating, type CollectionRules, type GenreOption, type ImportStatus,
  type DigestFrequency, type DigestSubscription, type GuestLinkRow,
  type LibraryKind, type SessionResponse, type TwoFactorStatus, type UserCollection, type UserPreferences
} from "../shared/types";

function entryRow(entry: AccountEntry, ownProfile: boolean): HTMLElement {
  const details = [
    entry.last_position_ms ? t("Wznów od {time}", { time: formatDuration(entry.last_position_ms) }) : "",
    entry.rating
      ? t(ownProfile ? "Twoja ocena {value}" : "Ocena użytkownika {value}", { value: Number(entry.rating).toFixed(1) })
      : "",
    entry.avg_rating ? t("Średnia {value}", { value: Number(entry.avg_rating).toFixed(1) }) : "",
    typeof entry.play_count === "number"
      ? t(ownProfile ? "Twoje odtworzenia {count}" : "Odtworzenia użytkownika {count}", { count: entry.play_count })
      : "",
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

/** One of the activity lists, and the way to read it again after something changed what it shows. */
interface EntriesPanel {
  panel: HTMLElement;
  /** From the first page again, in the order the reader picked. */
  reload: () => Promise<void>;
}

/** What an applied import changed: a new playlist, or the ratings of one library. */
interface ImportApplied {
  mediaKind: LibraryKind;
  collectionId?: number;
}

function accountEntriesPanel(
  title: string,
  section: "recent" | "favorites" | "rated",
  kind: "all" | LibraryKind,
  emptyText: string,
  limit: number,
  username: string | undefined,
  ownProfile: boolean
): EntriesPanel {
  const list = el("div", { className: "account-list account-list--paged" });
  const more = el("button", { className: "button button--secondary account-list__more", attrs: { type: "button" } }, t("Pokaż więcej"));
  const sort = el(
    "select",
    { className: "input input--compact account-list__sort", attrs: { "aria-label": t("Sortowanie: {title}", { title }) } },
    el("option", { text: t("Ostatnio dodane"), attrs: { value: "newest" } }),
    el("option", { text: t("Najstarsze"), attrs: { value: "oldest" } }),
    el("option", { text: t("Nazwa A–Z"), attrs: { value: "title_asc" } }),
    // On somebody else's profile "mine" would be the reader's, and these are not.
    el("option", { text: ownProfile ? t("Moja ocena") : t("Ocena użytkownika"), attrs: { value: "own_rating_desc" } }),
    el("option", { text: t("Średnia ocena"), attrs: { value: "average_rating_desc" } }),
    el("option", { text: ownProfile ? t("Moje odtworzenia") : t("Odtworzenia użytkownika"), attrs: { value: "own_plays_desc" } }),
    el("option", { text: t("Wszystkie odtworzenia"), attrs: { value: "all_plays_desc" } }),
    el("option", { text: t("Losowo"), attrs: { value: "random" } })
  );
  let page = 0;
  let loading = false;
  let randomSeed = randomId();

  const load = async (reset = false): Promise<void> => {
    if (loading) return;
    loading = true;
    more.disabled = true;
    if (reset) {
      if (sort.value === "random") randomSeed = randomId();
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

  return {
    panel: el(
      "article",
      { className: "panel account-panel account-panel--entries" },
      el("div", { className: "account-panel__heading" }, el("h2", { text: title }), sort),
      list,
      more
    ),
    reload: () => load(true)
  };
}

function profileToolbar(account: AccountData, ownUsername: string, canBrowse: boolean): HTMLElement {
  const currentUsername = account.profile.username;
  const profileUrl = new URL(appUrl(`account/${encodeURIComponent(currentUsername)}/`), window.location.origin);
  const link = el("input", { className: "input account-profile__link", attrs: { type: "text", readonly: true, "aria-label": t("Link profilu") } });
  link.value = profileUrl.href;
  const copy = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("share"), t("Kopiuj link"));
  copy.disabled = account.profile.is_own && !account.profile.is_public;
  copy.addEventListener("click", () => {
    void copyLink(profileUrl)
      .then(() => { status.textContent = t("Link skopiowany"); })
      // The clipboard can be refused; the address is in the field beside the button.
      .catch(() => {
        link.focus();
        link.select();
        status.textContent = t("Nie udało się skopiować — adres jest zaznaczony, skopiuj go ręcznie.");
      });
  });
  const publicToggle = el("input", { attrs: { type: "checkbox" } });
  publicToggle.checked = account.profile.is_public;
  const status = el("p", { className: "form-status" });
  const describeVisibility = (): void => {
    status.textContent = account.profile.is_public
      ? t("Profil publiczny — osoby z uprawnieniem przeglądania profili mogą otworzyć ten adres.")
      : t("Profil prywatny — adres działa tylko dla Ciebie.");
  };
  describeVisibility();
  const save = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("check"), t("Zapisz widoczność"));
  // Only this dialog shows the choice, so only this dialog changes. Saving used to
  // reload the whole account page — ten requests — while the dialog, which lives
  // outside it, stayed on screen saying "Zapisywanie…" with its button disabled.
  save.addEventListener("click", () => {
    save.disabled = true;
    status.textContent = t("Zapisywanie…");
    void setProfileVisibility(publicToggle.checked)
      .then((saved) => {
        account.profile.is_public = saved.is_public;
        publicToggle.checked = saved.is_public;
        copy.disabled = account.profile.is_own && !saved.is_public;
        describeVisibility();
      })
      .catch(() => { status.textContent = t("Nie udało się zapisać widoczności profilu."); })
      .finally(() => { save.disabled = false; });
  });
  const close = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
  const dialog = el(
    "div",
    { className: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "true", "aria-labelledby": "profile-share-title" } },
    el("button", { className: "dialog__backdrop", attrs: { type: "button", tabindex: "-1", "aria-label": t("Zamknij") } }),
    el("section", { className: "dialog__panel dialog__panel--profile-share" },
      el("header", { className: "dialog__header" }, el("h2", { text: t("Udostępnij profil"), attrs: { id: "profile-share-title" } }), close),
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
  // The dialog lives on document.body while it is open, and only then. It used to
  // sit inside this panel, inside the application — and openModal() makes every
  // other child of <body> inert, so it made the application inert and the dialog
  // with it: the checkbox, "copy", "save" and the close button all ignored every
  // click and tap, and on a phone the page stayed covered until a reload. It is
  // taken off again on close, so a closed dialog leaves nothing behind on the page.
  const closeDialog = (): void => {
    releaseModal?.();
    releaseModal = null;
    // Hidden at once, taken off the page when its closing has been seen (shared/motion.ts).
    if (dialog.isConnected) dismiss(dialog);
  };
  close.addEventListener("click", closeDialog);
  dialog.querySelector(".dialog__backdrop")?.addEventListener("click", closeDialog);
  const share = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("share"), t("Udostępnij profil"));
  share.addEventListener("click", () => {
    document.body.append(dialog);
    dialog.setAttribute("aria-hidden", "false");
    releaseModal?.();
    releaseModal = openModal(dialog, { onEscape: closeDialog });
  });
  document.addEventListener("media:route-will-change", closeDialog, { once: true });
  const own = el("a", { className: "button button--secondary", attrs: { href: appUrl(`account/${encodeURIComponent(ownUsername)}/`) } }, t("Własny profil"));
  // A combobox: the field keeps the focus and the keyboard walks the list from
  // it. The list used to be a pile of links under a search box — reachable only
  // by Tab, never closed by Escape or by leaving, and announced as nothing.
  const search = el("input", {
    className: "input",
    attrs: {
      type: "search", placeholder: t("Znajdź użytkownika…"), autocomplete: "off",
      role: "combobox", "aria-label": t("Znajdź użytkownika"), "aria-autocomplete": "list",
      "aria-expanded": "false", "aria-controls": "profile-suggestions"
    }
  });
  const suggestions = el("div", {
    className: "account-profile__suggestions",
    attrs: { id: "profile-suggestions", role: "listbox", "aria-label": t("Znalezieni użytkownicy") }
  });
  let timer = 0;
  let lookup: AbortController | null = null;
  let activeOption = -1;
  const optionLinks = (): HTMLAnchorElement[] => Array.from(suggestions.querySelectorAll<HTMLAnchorElement>("a"));
  const markOption = (index: number): void => {
    const links = optionLinks();
    activeOption = links.length === 0 ? -1 : (index + links.length) % links.length;
    links.forEach((option, position) => {
      const selected = position === activeOption;
      option.classList.toggle("is-active", selected);
      option.setAttribute("aria-selected", String(selected));
      if (selected) option.scrollIntoView({ block: "nearest" });
    });
    const current = links[activeOption];
    if (current) search.setAttribute("aria-activedescendant", current.id);
    else search.removeAttribute("aria-activedescendant");
  };
  const closeSuggestions = (): void => {
    window.clearTimeout(timer);
    lookup?.abort();
    lookup = null;
    suggestions.replaceChildren();
    activeOption = -1;
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
  };
  search.addEventListener("input", () => {
    closeSuggestions();
    const query = search.value.trim();
    if (query.length < 2) return;
    timer = window.setTimeout(() => {
      // The answer to an earlier, shorter query is not waited for.
      const request = new AbortController();
      lookup = request;
      void searchProfiles(query, request.signal).then((profiles) => {
        if (lookup !== request) return;
        suggestions.replaceChildren(...profiles.map((profile, index) => el(
          "a",
          {
            attrs: {
              href: appUrl(`account/${encodeURIComponent(profile.username)}/`),
              id: `profile-option-${index}`, role: "option", tabindex: "-1", "aria-selected": "false"
            }
          },
          icon("user"),
          el("span", { text: profile.username }),
          profile.is_public ? null : el("small", { text: t("Prywatny") })
        )));
        activeOption = -1;
        search.setAttribute("aria-expanded", String(profiles.length > 0));
      }).catch((error: unknown) => {
        if (!isAborted(error) && lookup === request) closeSuggestions();
      });
    }, 220);
  });
  search.addEventListener("keydown", (event) => {
    const open = suggestions.childElementCount > 0;
    if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      markOption(activeOption + 1);
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      markOption(activeOption < 0 ? -1 : activeOption - 1);
    } else if (event.key === "Enter" && open && activeOption >= 0) {
      event.preventDefault();
      optionLinks()[activeOption]?.click();
    } else if (event.key === "Escape" && open) {
      // The list closes; the page's own Escape (the menu, a dialog) is not what was meant.
      event.preventDefault();
      event.stopPropagation();
      closeSuggestions();
    }
  });
  // Leaving the field closes the list — after a moment, so a press on one of
  // its links still lands on the link.
  search.addEventListener("blur", () => window.setTimeout(() => {
    if (document.activeElement !== search && !suggestions.contains(document.activeElement)) closeSuggestions();
  }, 180));
  return el(
    "section",
    { className: "panel account-profile" },
    el("div", { className: "account-profile__identity" },
      el("span", { className: "account-profile__avatar", attrs: { "aria-hidden": "true" }, text: Array.from(currentUsername)[0] ?? "?" }),
      el("div", {}, el("span", { className: "eyebrow", text: t("Profil użytkownika") }), el("h2", { text: currentUsername }))
    ),
    share,
    canBrowse ? el("div", { className: "account-profile__browser" }, own, el("div", { className: "account-profile__search" }, search, suggestions)) : null
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

/**
 * One playlist on the account page, and everything done to it in place.
 *
 * Editing, cancelling and saving repaint this card and nothing else; the page
 * around it used to be rebuilt after each of them — the whole account read
 * again, every open section with it, and whatever was typed elsewhere on the
 * page gone. `onDeleted` tells the page a card went, after the server agreed.
 */
function collectionCard(
  collection: UserCollection,
  onDeleted: (collection: UserCollection) => void,
  canManage: boolean,
  canShare: boolean
): HTMLElement {
  const card = el("article", { className: "collection-card" });
  const linkTo = (): URL => {
    const link = new URL(appUrl(collection.media_kind === "music" ? "music/" : "movies/"), window.location.origin);
    link.searchParams.set("collection", String(collection.id));
    return link;
  };
  let editControl: HTMLButtonElement | null = null;

  const shareButton = (): HTMLButtonElement => {
    const share = el(
      "button",
      { className: "icon-button" + (collection.is_shared ? " is-active" : ""), attrs: { type: "button", "aria-label": t("Udostępnij {name}", { name: collection.name }) } },
      icon("share")
    );
    share.dataset.tooltip = collection.is_shared ? t("Kopiuj link do udostępnionej listy") : t("Udostępnij i skopiuj link");
    share.addEventListener("click", () => {
      share.disabled = true;
      void Promise.resolve(collection.is_shared ? undefined : setCollectionShared(collection.id, true))
        .then(() => {
          collection.is_shared = true;
          share.classList.add("is-active");
          return copyLink(linkTo());
        })
        .then(() => { share.dataset.tooltip = t("Link skopiowany"); })
        .catch(() => { share.dataset.tooltip = t("Nie udało się udostępnić"); })
        .finally(() => { share.disabled = false; });
    });
    return share;
  };

  const removeButton = (): HTMLButtonElement => {
    const remove = el(
      "button",
      { className: "icon-button", attrs: { type: "button", "aria-label": t("Usuń {name}", { name: collection.name }) } },
      icon("trash")
    );
    remove.dataset.tooltip = t("Usuń kolekcję");
    remove.addEventListener("click", () => {
      void confirmDialog({
        title: t("Usunąć kolekcję?"),
        message: t("Usunąć kolekcję „{name}”? Pliki multimedialne pozostaną bez zmian.", { name: collection.name }),
        confirmLabel: t("Usuń"),
        danger: true
      }).then((agreed) => {
        if (!agreed) return;
        remove.disabled = true;
        void deleteCollection(collection.id)
          .then(() => {
            card.remove();
            onDeleted(collection);
          })
          .catch((error: unknown) => {
            remove.disabled = false;
            remove.dataset.tooltip = failureText(error, t("Nie udało się usunąć kolekcji."));
          });
      });
    });
    return remove;
  };

  const editForm = (): void => {
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
    const submit = el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zapisz")) as HTMLButtonElement;
    const cancel = el("button", { className: "button button--ghost", attrs: { type: "button" } }, t("Anuluj"));
    const form = el(
      "form",
      { className: "collection-card__edit" },
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Nazwa") }), name),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Opis") }), description),
      el("label", { className: "toggle-field" }, shared, el("span", { text: t("Udostępniona innym") })),
      queue.panel,
      el("div", { className: "collection-card__edit-actions" }, submit, cancel, status)
    );
    cancel.addEventListener("click", () => {
      paint();
      editControl?.focus();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      submit.disabled = true;
      status.textContent = t("Zapisywanie…");
      const wantsShared = shared.checked;
      const changes = { name: name.value.trim(), description: description.value.trim(), ...queue.value() };
      void updateCollection(collection.id, changes)
        .then(() => (wantsShared === collection.is_shared
          ? undefined
          : setCollectionShared(collection.id, wantsShared)))
        .then(() => {
          // What was saved is what the card shows: nothing to read back.
          Object.assign(collection, changes, { is_shared: wantsShared });
          paint();
          editControl?.focus();
        })
        .catch((error: unknown) => {
          status.textContent = failureText(error, t("Nie udało się zapisać zmian."));
          submit.disabled = false;
        });
    });
    card.replaceChildren(form);
    name.focus();
  };

  const paint = (): void => {
    const actions = el("div", { className: "collection-card__actions" });
    editControl = null;
    if (canManage) {
      editControl = el(
        "button",
        { className: "icon-button", attrs: { type: "button", "aria-label": t("Edytuj {name}", { name: collection.name }) } },
        icon("edit")
      ) as HTMLButtonElement;
      editControl.dataset.tooltip = t("Zmień nazwę, opis, widoczność lub wygląd kolejki");
      editControl.addEventListener("click", editForm);
      actions.append(editControl);
    }
    if (canShare) actions.append(shareButton());
    if (canManage) actions.append(removeButton());
    const summary = collection.is_smart
      ? t("Inteligentna lista · reguły dynamiczne")
      : tn(collection.item_count, { one: "{count} pozycja", few: "{count} pozycje", many: "{count} pozycji" });
    const link = linkTo();
    // Two rows: what the list is, and under it what can be done with it. In one
    // row the three buttons and an arrow took all but 88 pixels of the card, and
    // "Inteligentna lista · reguły dynamiczne" read "Inteligentna l…". The whole
    // card is the link, so the arrow that only said "this is a link" is gone.
    card.replaceChildren(
      el(
        "a",
        { className: "collection-card__link", attrs: { href: link.pathname + link.search } },
        el("span", { className: "collection-card__icon" }, icon(collection.media_kind === "music" ? "music" : "film")),
        el(
          "span",
          { className: "collection-card__copy" },
          el("strong", { text: collection.name, attrs: { title: collection.name } }),
          el("small", { className: "collection-card__summary", text: summary }),
          collection.description
            ? el("small", { className: "collection-card__description", text: collection.description, attrs: { title: collection.description } })
            : null
        )
      ),
      ...(actions.childElementCount > 0 ? [actions] : [])
    );
  };
  paint();
  return card;
}

/**
 * The colour theme: two samples, each drawn in its own colours, and the one that
 * is on.
 *
 * Pressing one changes the page at once — every colour is a token, so nothing
 * has to be drawn again — and saves the choice with the account, where it
 * follows the listener to their other devices. It is also kept in this browser,
 * which is what the next visit's first frame is painted from, before any
 * session has answered (public/theme-boot.js). A bridge that does not store
 * themes yet leaves it at that: a choice per device, said as such.
 */
function themePanel(session: SessionResponse): HTMLElement {
  const described: Record<Theme, { name: string; hint: string }> = {
    emerald: { name: t("Szmaragd"), hint: t("Grafit i zielony akcent — motyw, od którego wszystko się zaczęło.") },
    blue: { name: t("Estoril Blue"), hint: t("Głęboki granat, błękitny akcent i światło ambient.") }
  };
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const options = new Map<Theme, HTMLButtonElement>();
  const mark = (active: Theme): void => {
    for (const [theme, button] of options) {
      button.setAttribute("aria-checked", String(theme === active));
      // One stop for Tab; the arrows move inside the group, as in any set of radio buttons.
      button.tabIndex = theme === active ? 0 : -1;
    }
  };
  let request = 0;
  const choose = (theme: Theme): void => {
    if (theme === currentTheme() && session.preferences?.theme === theme) return;
    const current = ++request;
    void viewTransition(() => {
      applyTheme(theme);
      mark(theme);
    }, "theme");
    // Until the account confirms it, this is a choice the account does not hold.
    rememberTheme(theme, true);
    status.textContent = t("Zapisywanie…");
    void saveUserPreferences({ ...defaultUserPreferences, ...session.preferences, theme })
      .then((saved) => {
        session.preferences = saved;
        if (current !== request) return;
        const kept = saved.theme === theme;
        rememberTheme(theme, !kept);
        status.textContent = kept
          ? t("Zapisano — motyw należy do konta i obowiązuje na każdym urządzeniu.")
          : t("Zapisano na tym urządzeniu.");
      })
      .catch((error: unknown) => {
        if (current === request) status.textContent = failureText(error, t("Nie udało się zapisać motywu na koncie — zostaje na tym urządzeniu."));
      });
  };
  const group = el("div", { className: "theme-picker", attrs: { role: "radiogroup", "aria-label": t("Motyw interfejsu") } });
  for (const theme of THEMES) {
    const copy = described[theme];
    const button = el(
      "button",
      { className: "theme-option", attrs: { type: "button", role: "radio" }, dataset: { themeOption: theme } },
      // A miniature of the interface, in this theme's own tokens whatever the page is in.
      el(
        "span",
        { className: "theme-option__preview", attrs: { "aria-hidden": "true" }, dataset: { theme } },
        el("span", { className: "theme-option__line" }),
        el("span", { className: "theme-option__side" }, el("span", {}), el("span", {}), el("span", {})),
        el(
          "span",
          { className: "theme-option__main" },
          el("span", { className: "theme-option__card" }),
          el("span", { className: "theme-option__card" }),
          el("span", { className: "theme-option__card" }),
          el("span", { className: "theme-option__dock" }, el("span", { className: "theme-option__play" }), el("span", { className: "theme-option__progress" }))
        )
      ),
      el(
        "span",
        { className: "theme-option__copy" },
        el("strong", { text: copy.name }),
        el("small", { text: copy.hint })
      ),
      el("span", { className: "theme-option__check", attrs: { "aria-hidden": "true" } }, icon("check"))
    ) as HTMLButtonElement;
    button.addEventListener("click", () => choose(theme));
    options.set(theme, button);
    group.append(button);
  }
  group.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const order = [...THEMES];
    const from = order.indexOf(currentTheme());
    const next = order[(from + step + order.length) % order.length] ?? order[0]!;
    choose(next);
    options.get(next)?.focus();
  });
  mark(currentTheme());
  return el("article", { className: "panel account-panel account-panel--theme" },
    el("div", { className: "account-panel__heading" }, el("h2", { text: t("Motyw") })),
    el("p", { className: "muted", text: t("Kolory interfejsu. Zmiana działa od razu i jest zapisywana na koncie.") }),
    group,
    status
  );
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
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Język") }), select)
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
 * What this browser is called on the account's other devices.
 *
 * The name read from the user agent ("Windows · Chrome") tells the desktop from
 * the phone, not three browsers on one machine apart. Kept in this browser, not
 * with the account — the name belongs to the device — and sent at once, so the
 * queue's device list on the other screens shows it without waiting for a track.
 */
function devicePanel(): HTMLElement {
  const fallback = defaultDeviceLabel();
  const input = el("input", {
    className: "input",
    attrs: { type: "text", maxlength: "64", autocomplete: "off", spellcheck: "false", placeholder: fallback }
  }) as HTMLInputElement;
  input.value = ownDeviceLabel();
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const save = el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zapisz"));
  const form = el("form", { className: "account-preferences" },
    el("div", { className: "account-preferences__options" },
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Nazwa tego urządzenia") }), input)
    ),
    el("div", { className: "account-panel__actions" }, save, status)
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Shown back as stored: one line, at most what the server keeps (64 bytes).
    input.value = setDeviceLabel(input.value);
    const name = deviceLabel();
    status.textContent = input.value
      ? t("Zapisano — inne urządzenia widzą teraz „{name}”.", { name })
      : t("Przywrócono nazwę rozpoznaną z przeglądarki: {name}.", { name });
  });
  return el("article", { className: "panel account-panel" },
    el("div", { className: "account-panel__heading" }, el("h2", { text: t("To urządzenie") })),
    el("p", {
      className: "muted",
      text: t("Pod tą nazwą widzą je Twoje pozostałe urządzenia w kolejce, na liście „Na innych urządzeniach”. Nazwa zostaje w tej przeglądarce; puste pole przywraca nazwę rozpoznaną z przeglądarki: {name}.", { name: fallback })
    }),
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
function importPanel(onApplied: (applied: ImportApplied) => Promise<void>): HTMLElement {
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
          // The page hears what changed and repaints that much; this panel keeps
          // saying what was written instead of being rebuilt out from under it.
          void onApplied({ mediaKind: state.media_kind, collectionId: result.collection_id }).catch(() => undefined);
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
      ...(state.entries_truncated
        ? [el("p", {
            className: "notice notice--info",
            text: t("Na liście poniżej jest pierwsze {limit} pozycji tego importu; liczniki obejmują wszystkie.", {
              limit: formatCount(state.entries_limit ?? state.entries.length)
            })
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

/** Self-service password and e-mail change, shown only on the owner's profile. */
function securityPanel(session: SessionResponse): HTMLElement {
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
      .catch((error: unknown) => {
        passwordStatus.textContent = failureText(error, t("Nie udało się zmienić hasła. Sprawdź obecne hasło i długość nowego."));
      })
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
        // "Spooled" means this server sends no mail and wrote the message to a
        // folder on its own disk. An administrator can open that folder; for
        // anybody else its path was a line of server internals and no help.
        emailStatus.textContent = !result.spooled
          ? t("Sprawdź nową skrzynkę i kliknij link potwierdzający.")
          : isAdministrator(session)
            ? t("Wiadomość zapisana w logs/mail — otwórz link, aby potwierdzić.")
            : t("Ten serwer nie wysyła poczty — poproś administratora o link potwierdzający.");
      })
      .catch((error: unknown) => {
        emailStatus.textContent = failureText(error, t("Nie udało się rozpocząć zmiany adresu. Sprawdź hasło i format adresu."));
      })
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
 * Two-factor sign-in for this account (TOTP): on with the password, a QR code
 * and a first code; off, or a fresh set of recovery codes, with the password
 * and a code. The secret is shown only while it is being set up.
 */
function twoFactorPanel(): HTMLElement {
  const body = el("div", { className: "twofa-panel__body" });
  const status = el("span", { className: "form-status", attrs: { role: "status" } });
  const passwordField = (): HTMLInputElement => el("input", {
    className: "input", attrs: { type: "password", required: true, autocomplete: "current-password", placeholder: t("Obecne hasło") }
  }) as HTMLInputElement;
  const failure = (error: unknown, fallback: string): string =>
    error instanceof Error && error.message ? error.message : fallback;

  const showCodes = (codes: string[]): void => {
    // Codes only exist once 2FA is on (or was already, for a new set).
    pill.className = "status-pill status-pill--success";
    pill.textContent = t("Włączona");
    body.replaceChildren(recoveryCodesView(codes, () => void load(), t("Gotowe")));
  };

  const paintDisabled = (state: TwoFactorStatus): void => {
    const password = passwordField();
    const form = el("form", { className: "account-security__form" },
      el("p", { className: "muted", text: t("Po włączeniu logowanie wymaga też 6-cyfrowego kodu z aplikacji uwierzytelniającej na telefonie.") }),
      state.required ? el("p", { className: "notice notice--info", text: t("Administrator wymaga weryfikacji dwuetapowej od kont administratorów — przy następnym logowaniu zostaniesz o nią poproszony.") }) : null,
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Obecne hasło") }), password),
      el("div", { className: "account-security__actions" },
        el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("lock"), t("Włącz weryfikację dwuetapową")),
        status
      )
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      status.textContent = t("Sprawdzanie…");
      void beginTwoFactor(password.value)
        .then((setup) => {
          status.textContent = "";
          const code = codeInput(false);
          const confirm = el("form", { className: "account-security__form" },
            setupView(setup.secret, setup.otpauth_uri),
            el("label", { className: "field" }, el("span", { className: "field__label", text: t("Kod z aplikacji") }), code),
            el("div", { className: "account-security__actions" },
              el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Potwierdź i włącz")),
              status
            )
          );
          confirm.addEventListener("submit", (submitEvent) => {
            submitEvent.preventDefault();
            if (!confirm.reportValidity()) return;
            status.textContent = t("Sprawdzanie…");
            void confirmTwoFactor(code.value.trim())
              .then(showCodes)
              .catch((error: unknown) => { status.textContent = failure(error, t("Nieprawidłowy kod.")); code.select(); });
          });
          body.replaceChildren(confirm);
          code.focus();
        })
        .catch((error: unknown) => { status.textContent = failure(error, t("Nie udało się rozpocząć konfiguracji.")); });
    });
    body.replaceChildren(form);
  };

  const paintEnabled = (state: TwoFactorStatus): void => {
    const password = passwordField();
    const code = codeInput(false);
    code.removeAttribute("pattern");
    code.setAttribute("maxlength", "16");
    code.setAttribute("placeholder", t("Kod z aplikacji lub kod odzyskiwania"));
    const regenerate = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("refresh"), t("Nowe kody odzyskiwania"));
    const disable = el("button", { className: "button button--danger", attrs: { type: "button" } }, icon("close"), t("Wyłącz"));
    const form = el("form", { className: "account-security__form" },
      el("p", { text: tn(state.recovery_left, {
        one: "Został {count} niewykorzystany kod odzyskiwania.",
        few: "Zostały {count} niewykorzystane kody odzyskiwania.",
        many: "Zostało {count} niewykorzystanych kodów odzyskiwania."
      }) }),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Obecne hasło") }), password),
      el("label", { className: "field" }, el("span", { className: "field__label", text: t("Kod") }), code),
      el("div", { className: "account-security__actions" }, regenerate, disable, status)
    );
    const run = (action: () => Promise<void>): void => {
      if (!form.reportValidity()) return;
      status.textContent = t("Sprawdzanie…");
      void action().catch((error: unknown) => { status.textContent = failure(error, t("Sprawdź hasło i kod.")); });
    };
    regenerate.addEventListener("click", () => run(async () => showCodes(await regenerateRecoveryCodes(password.value, code.value.trim()))));
    disable.addEventListener("click", () => run(async () => {
      await disableTwoFactor(password.value, code.value.trim());
      await load();
    }));
    form.addEventListener("submit", (event) => event.preventDefault());
    body.replaceChildren(form);
  };

  const pill = el("span", { className: "status-pill" });
  const load = async (): Promise<void> => {
    status.textContent = "";
    try {
      const state = await getTwoFactor();
      pill.className = "status-pill " + (state.enabled ? "status-pill--success" : "status-pill--muted");
      pill.textContent = state.enabled ? t("Włączona") : t("Wyłączona");
      if (state.enabled) paintEnabled(state);
      else paintDisabled(state);
    } catch {
      body.replaceChildren(el("p", { className: "muted", text: t("Nie udało się wczytać ustawień weryfikacji dwuetapowej.") }));
    }
  };
  void load();
  return el("section", { className: "panel account-panel account-security twofa-panel" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Bezpieczeństwo") }), el("h2", { text: t("Weryfikacja dwuetapowa") })),
      pill
    ),
    body
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
    if (link.revoked_at) return t("wycofany {when}", { when: formatDateTime(link.revoked_at) });
    if (isPast(link.expires_at)) return t("wygasł");
    return t("ważny do {when}", { when: formatDateTime(link.expires_at) });
  };

  const load = async (): Promise<void> => {
    status.textContent = t("Pobieranie…");
    try {
      const { links, total } = await getGuestLinks();
      list.replaceChildren(...links.map((link) => {
        const revoke = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Wycofaj"));
        revoke.addEventListener("click", () => {
          revoke.disabled = true;
          void revokeGuestLink(link.id).then(load).catch(() => { revoke.disabled = false; });
        });
        const active = !link.revoked_at && !isPast(link.expires_at);
        return el("div", { className: "account-sessions__row" },
          el("div", { className: "account-sessions__copy" },
            el("strong", { text: link.label || (link.target_kind === "collection" ? t("Playlista") : t("Folder")) }),
            el("span", { text: describe(link) }),
            el("small", {
              text: t("Pobrania: {used} z {max}", {
                used: String(link.downloads_used),
                max: String(link.max_downloads)
              }) + (link.last_used_at ? " · " + t("użyty {when}", { when: formatDateTime(link.last_used_at) }) : "")
            })),
          active ? revoke : el("span", { className: "status-pill", text: t("nieaktywny") }));
      }));
      // The bridge lists the newest ones only; say so rather than pass them off as all.
      status.textContent = links.length === 0
        ? t("Nie masz żadnych linków gościnnych.")
        : total > links.length
          ? t("Linków: {count} (pokazano {shown} najnowszych)", { count: formatCount(total), shown: formatCount(links.length) })
          : t("Linków: {count}", { count: formatCount(links.length) });
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
        ? t("Ostatnia wiadomość: {when}", { when: formatDateTime(digest.last_sent_at) })
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
            el("span", { text: t("Zalogowano {when}", { when: formatDateTime(session.created_at) }) }),
            el("small", { text: t("Ostatnia aktywność {when}", { when: formatDateTime(session.last_seen_at) }) })),
          session.is_current
            ? el("span", { className: "status-pill status-pill--success", text: t("ta przeglądarka") })
            : close
        );
      }));
      status.textContent = tn(sessions.length, { one: "{count} otwarta sesja", few: "{count} otwarte sesje", many: "{count} otwartych sesji" });
      others.disabled = sessions.length < 2;
    } catch {
      status.textContent = t("Nie udało się pobrać sesji.");
    }
  };

  others.addEventListener("click", () => {
    others.disabled = true;
    void revokeSession({ others: true })
      .then((closed) => {
        status.textContent = t("Zamknięto sesji: {count}", { count: formatCount(closed) });
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
  const shell = await mountShell("account", "Moje konto", "Profil, ulubione i kolekcje");
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

  // The open section comes from the hash on arrival. The old anchor of the list
  // builder still works: it names a place inside a section.
  const arrivedAt = window.location.hash.slice(1);
  const accountTab = arrivedAt === "collection-builder" ? "collections" : arrivedAt || "overview";
  const openBuilder = arrivedAt === "collection-builder";

  let account: AccountData;
  try {
    account = await getAccount(requestedUsername);
  } catch {
    host.replaceChildren(
      el(
        "div",
        { className: "notice notice--error" },
        el("strong", { text: t("Nie udało się pobrać danych konta.") }),
        el("p", { text: t("Odśwież stronę. Jeśli błąd się powtarza, daj znać administratorowi serwera.") })
      )
    );
    return;
  }
  const username = account.profile.username;
  // Somebody else's profile is not "my account": the header says whose it is.
  if (!account.profile.is_own) shell.setTitle(t("Profil: {name}", { name: username }), t("Profil użytkownika"));
  const canonicalUrl = new URL(appUrl(`account/${encodeURIComponent(username)}/`), window.location.origin);
  if (window.location.pathname !== canonicalUrl.pathname) {
    window.history.replaceState(null, "", canonicalUrl.pathname + window.location.hash);
  }

  // The page is built once. A change repaints the panel it touched and nothing
  // else: every save used to read the whole account again and rebuild the page —
  // around ten requests from the overview — and the rebuild threw away whatever
  // the other sections held, an import waiting for review and half-typed
  // passwords included.
  const stats = arrive(el("section", { className: "account-stats", attrs: { "aria-label": t("Statystyki konta") } }));
  const paintStats = (): void => {
    stats.replaceChildren(
      ...[
        ["play", account.summary.plays, tn(account.summary.plays, { one: "odtworzenie", few: "odtworzenia", many: "odtworzeń" })],
        ["star", account.summary.ratings, tn(account.summary.ratings, { one: "ocena", few: "oceny", many: "ocen" })],
        ["heart", account.summary.favorites, tn(account.summary.favorites, { one: "ulubiony", few: "ulubione", many: "ulubionych" })],
        ["list", account.summary.collections, tn(account.summary.collections, { one: "kolekcja", few: "kolekcje", many: "kolekcji" })]
      ].map(([name, value, label]) =>
        el(
          "article",
          { className: "account-stat" },
          icon(name as "play" | "star" | "heart" | "list"),
          el("strong", { text: formatCount(Number(value)) }),
          el("span", { text: String(label) })
        )
      )
    );
  };
  paintStats();

  const canManageCollections = account.profile.is_own && can(shell.session, "can_create_collections");
  const canShareCollections = can(shell.session, "can_share");
  const collectionsHost = el("div", { className: "collection-grid" });
  const noCollections = el("div", { className: "empty-state empty-state--compact" },
    el("p", { text: t("Nie masz jeszcze własnych playlist ani kolekcji.") }));
  const syncNoCollections = (): void => {
    if (account.collections.length > 0) noCollections.remove();
    else if (!noCollections.isConnected) collectionsHost.append(noCollections);
  };
  const collectionRemoved = (removed: UserCollection): void => {
    account.collections = account.collections.filter((collection) => collection.id !== removed.id);
    account.summary.collections = Math.max(0, account.summary.collections - 1);
    paintStats();
    syncNoCollections();
  };
  const cardFor = (collection: UserCollection): HTMLElement =>
    collectionCard(collection, collectionRemoved, canManageCollections, canShareCollections);
  collectionsHost.append(...account.collections.map(cardFor));
  syncNoCollections();

  /**
   * One request after something was added — a list from the form or from an
   * import, ratings from a file — and two repaints: the numbers, and the new card
   * at the head of the grid. The cards already there stay as they are, so one
   * open for editing keeps what was typed into it.
   */
  const reloadSummary = async (createdId?: number): Promise<void> => {
    const fresh = await getAccount(username);
    account.summary = fresh.summary;
    paintStats();
    const created = createdId === undefined ? undefined : fresh.collections.find((collection) => collection.id === createdId);
    if (!created || account.collections.some((collection) => collection.id === created.id)) return;
    account.collections = [created, ...account.collections];
    collectionsHost.prepend(cardFor(created));
    syncNoCollections();
  };

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
  const minUserRating = numberInput(t("Moja ocena od"), "0", "0", "5", "0.5");
  const maxUserRating = numberInput(t("Moja ocena do"), "0", "0", "5", "0.5");
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
  // Asked for when somebody sets out to write rules for a film list, and then
  // once. It used to be fetched on every visit to the account page — a count
  // over the whole film catalogue for a form most visits never open.
  let genresAsked = false;
  const needGenres = (): void => {
    if (genresAsked || mode.value !== "smart" || kind.value !== "movies") return;
    genresAsked = true;
    void getLibraryFilters("movies")
      .then((available) => {
        genreOptions = available.genres ?? [];
        genreSelect.replaceChildren(
          ...genreOptions.map((genre) =>
            el("option", { text: t(genre.name_pl), attrs: { value: String(genre.id) } }))
        );
        syncFilmFields();
      })
      // Not answered: the next change of the form asks again.
      .catch(() => { genresAsked = false; });
  };
  kind.addEventListener("change", () => {
    syncFilmFields();
    needGenres();
  });
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
  mode.addEventListener("change", () => {
    rulesPanel.classList.toggle("hidden", mode.value !== "smart");
    needGenres();
  });
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
    const createdName = name.value.trim();
    void createCollection({ name: name.value, description: description.value.trim(), media_kind: kind.value as LibraryKind, rules })
      .then((createdId) => {
        formStatus.textContent = t("Utworzono listę „{name}”.", { name: createdName });
        // The form is ready for the next list, the way a rebuilt page used to leave it.
        form.reset();
        rulesPanel.classList.toggle("hidden", mode.value !== "smart");
        syncRatingFields();
        syncDateFields();
        syncFilmFields();
        // The list is made; failing to read it back costs its card, not the list.
        return reloadSummary(createdId).catch(() => undefined);
      })
      .catch((error: unknown) => { formStatus.textContent = failureText(error, t("Nie udało się utworzyć listy.")); })
      .finally(() => { if (submit) submit.disabled = false; });
  });

  const toolbar = profileToolbar(account, shell.session.user.username, can(shell.session, "can_browse_profiles"));
  const collectionsSection = (): HTMLElement =>
    el(
      "section",
      { className: "panel account-panel account-panel--collections" },
      el("div", { className: "section-heading" },
        el("div", {}, el("span", { className: "eyebrow", text: account.profile.is_own ? t("Twoja biblioteka") : t("Publiczna biblioteka") }), el("h2", { text: t("Playlisty i kolekcje") })),
        el("p", { text: t("Listy ręczne lub automatycznie wyliczane z ocen, ulubionych i odtworzeń.") })
      ),
      collectionsHost,
      canManageCollections ? el("details", { className: "collection-builder", attrs: { id: "collection-builder" } }, el("summary", { text: t("Utwórz nową listę") }), form) : null
    );
  // The lists that an import of ratings changes are read again after one; the
  // rest of the overview has nothing new to show.
  const entryPanels: Array<{ section: "recent" | "favorites" | "rated"; kind: LibraryKind; reload: () => Promise<void> }> = [];
  const entries = (title: string, section: "recent" | "favorites" | "rated", kind: LibraryKind, emptyText: string): HTMLElement => {
    const built = accountEntriesPanel(title, section, kind, emptyText, shell.session.settings.account_page_size, username, account.profile.is_own);
    entryPanels.push({ section, kind, reload: built.reload });
    return built.panel;
  };
  const activitySection = (): HTMLElement =>
    el(
      "section",
      { className: "account-activity" },
      el("div", { className: "section-heading" }, el("div", {}, el("span", { className: "eyebrow", text: t("Muzyka") }), el("h2", { text: t("Aktywność muzyczna") }))),
      el("div", { className: "account-columns" },
        entries(t("Ostatnio odtwarzane"), "recent", "music", t("Brak historii muzyki.")),
        entries(t("Ulubione"), "favorites", "music", t("Brak ulubionych utworów.")),
        entries(t("Ostatnio ocenione"), "rated", "music", t("Brak ocenionych utworów."))
      ),
      el("div", { className: "section-heading" }, el("div", {}, el("span", { className: "eyebrow", text: t("Filmy") }), el("h2", { text: t("Aktywność filmowa") }))),
      el("div", { className: "account-columns" },
        entries(t("Ostatnio odtwarzane"), "recent", "movies", t("Brak historii filmów.")),
        entries(t("Ulubione"), "favorites", "movies", t("Brak ulubionych filmów.")),
        entries(t("Ostatnio ocenione"), "rated", "movies", t("Brak ocenionych filmów."))
      )
    );
  /** A playlist import adds one card; a ratings import changes the numbers and two lists of its library. */
  const importApplied = async (applied: ImportApplied): Promise<void> => {
    await reloadSummary(applied.collectionId);
    if (applied.collectionId !== undefined) return;
    await Promise.all(entryPanels
      .filter((panel) => panel.kind === applied.mediaKind && panel.section !== "recent")
      .map((panel) => panel.reload()));
  };
  // Somebody else's profile is short — numbers, lists, activity — and stays
  // one page. Your own carries every setting the account has, so it is split
  // into sections, and only the open one is built: each panel fetches what it
  // shows when it is created, once, and keeps its state while you move between
  // sections.
  if (!account.profile.is_own) {
    host.replaceChildren(toolbar, stats, collectionsSection(), activitySection());
    return;
  }
  const panels: Record<string, () => HTMLElement[]> = {
    overview: () => [stats, activitySection()],
    collections: () => [collectionsSection()],
    settings: () => [el("div", { className: "account-grid account-grid--settings" },
      themePanel(shell.session),
      languagePanel(shell.session),
      devicePanel(),
      queuePreferencesPanel(shell.session, (preferences) => {
        // The session object is shared with the player, so the open queue
        // repaints without a page reload.
        shell.session.preferences = preferences;
        shell.player.refreshQueueColumns();
      }),
      digestPanel()
    )],
    data: () => [el("div", { className: "account-grid" }, ratingsExportPanel(), importPanel(importApplied))],
    security: () => [el("div", { className: "account-grid" }, securityPanel(shell.session), twoFactorPanel(), sessionsPanel(shell.session))],
    ...(shell.session.settings.guest_links_enabled === true ? { sharing: () => [guestLinksPanel()] } : {})
  };
  const tabs: SectionTab[] = [
    { id: "overview", label: t("Przegląd"), glyph: "user" },
    { id: "collections", label: t("Kolekcje"), glyph: "list" },
    { id: "settings", label: t("Ustawienia"), glyph: "settings" },
    { id: "data", label: t("Oceny i import"), glyph: "upload" },
    { id: "security", label: t("Bezpieczeństwo"), glyph: "lock" },
    ...(panels.sharing ? [{ id: "sharing", label: t("Linki dla gości"), glyph: "link" as const }] : [])
  ];
  const stage = el("div", { className: "admin-stage account-stage" });
  const built = new Map<string, HTMLElement[]>();
  const sections = sectionTabs({
    label: t("Sekcje konta"),
    tabs,
    stage,
    onOpen: (id) => {
      let content = built.get(id);
      if (!content) {
        content = (panels[id] ?? panels.overview!)();
        built.set(id, content);
      }
      stage.replaceChildren(...content);
    }
  });
  host.replaceChildren(toolbar, sections.bar, stage);
  sections.open(panels[accountTab] ? accountTab : "overview");
  if (openBuilder) {
    const builder = document.getElementById("collection-builder");
    if (builder instanceof HTMLDetailsElement) {
      builder.open = true;
      builder.scrollIntoView({ block: "start" });
    }
  }
}
