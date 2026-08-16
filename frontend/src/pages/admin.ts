import "../styles/index.css";

import {
  activateUser, createUser, decideTitleLookup, deletePermissionGroup, getActiveSessions, getActivity, getAdmin,
  decideTitleFolder, getDigest, getTitleFolderWorks, getTitleFolders, getTitleLookups, resendUserActivation,
  revokeSession, saveAdminSettings, savePermissionGroup, sendDigestNow, serverStats, startCatalogScan,
  startMetadataWorker, startSubtitleCache, startTitleWorker, subtitleCacheStatus, updateUser
} from "../shared/api";
import { el } from "../shared/dom";
import { formatBytes } from "../shared/format";
import { icon, type IconName } from "../shared/icons";
import { t } from "../shared/i18n";
import { isAdministrator } from "../shared/permissions";
import { mountShell } from "../shared/shell";
import { orderedVisualizerPlugins } from "../shared/visualizations/registry";
import type {
  ActivityEntry, AdminData, AdminSettings, AdminUser, CompatibilityAudioProfile, CompatibilityVideoProfile,
  LibrarySort, PermissionGroup, RolePermissions, SubtitleCacheStatus, TitleLookupCandidate,
  TitleLookupEntry, TitleLookupFolder, TitleLookupPage, UserRole
} from "../shared/types";

function field(label: string, control: HTMLElement): HTMLElement {
  return el("label", { className: "field" }, el("span", { className: "field__label", text: label }), control);
}

function roleLabel(role: UserRole): string {
  return role === "super_admin" ? "Superadministrator" : role === "admin" ? "Administrator" : t("Użytkownik");
}

function roleSelect(value: UserRole, enabled: boolean): HTMLSelectElement {
  const select = el("select", { className: "input", attrs: { disabled: !enabled, "aria-label": t("Rola użytkownika") } });
  for (const role of ["user", "admin", "super_admin"] as UserRole[]) {
    select.append(el("option", { text: roleLabel(role), attrs: { value: role, ...(role === value ? { selected: true } : {}) } }));
  }
  return select;
}

function sectionHeading(eyebrow: string, title: string, copy: string): HTMLElement {
  return el(
    "div",
    { className: "section-heading" },
    el("div", {}, el("span", { className: "eyebrow", text: eyebrow }), el("h2", { text: title })),
    el("p", { text: copy })
  );
}

function metric(name: IconName, value: number, label: string): HTMLElement {
  return el(
    "article",
    { className: "admin-metric" },
    el("span", { className: "admin-metric__icon" }, icon(name)),
    el("div", {}, el("strong", { text: value.toLocaleString("pl-PL") }), el("span", { text: label }))
  );
}

/**
 * Per-source catalog cards. The overview shows them read-only; the indexing
 * section adds the "scan now" launcher (`withScan`), so starting a scan lives next
 * to the scan history instead of on the dashboard.
 */
function catalogCards(data: AdminData, refresh: () => Promise<void>, withScan: boolean): HTMLElement {
  return el(
    "div",
    { className: "admin-catalog" },
    ...data.catalog.map((row) => {
      const name: IconName = row.media_kind === "music" ? "music" : row.media_kind === "movies" ? "film" : "server";
      const card = el(
        "article",
        { className: "admin-catalog__card" },
        el("header", { className: "admin-catalog__header" },
          el("span", { className: "admin-catalog__icon" }, icon(name)),
          el("div", {}, el("span", { className: "eyebrow", text: row.slug }), el("h3", { text: row.display_name }))
        ),
        el("strong", { text: Number(row.items).toLocaleString("pl-PL") }),
        el("p", { text: t("pozycji w katalogu") }),
        el("div", { className: "admin-catalog__details" },
          el("span", {}, icon("music"), "Audio ", Number(row.audio).toLocaleString("pl-PL")),
          el("span", {}, icon("film"), "Wideo ", Number(row.video).toLocaleString("pl-PL")),
          el("span", {}, icon("image"), "Obrazy ", Number(row.images).toLocaleString("pl-PL")),
          el("span", {}, icon("file"), "Inne ", Number(row.auxiliary).toLocaleString("pl-PL"))
        )
      );
      if (!withScan) return card;
      const scanStatus = el("span", { className: "admin-catalog__scan-status", attrs: { role: "status" } });
      const scan = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("server"), t("Skanuj teraz"));
      scan.addEventListener("click", () => {
        scan.disabled = true;
        scanStatus.textContent = t("Zlecanie skanu…");
        void startCatalogScan(row.slug, row.media_kind)
          .then(() => {
            scanStatus.textContent = t("Skan uruchomiony w tle.");
            window.setTimeout(() => void refresh(), 1200);
          })
          .catch(() => { scanStatus.textContent = t("Nie udało się uruchomić skanu."); })
          .finally(() => { scan.disabled = false; });
      });
      card.append(el("footer", { className: "admin-catalog__actions" }, scan, scanStatus));
      return card;
    })
  );
}

const GUEST_GROUP_SLUG = "guest";

/**
 * Group picker for account forms. The group is the single source of truth for an
 * account's rights (a "guest" account is simply a member of the system guest group).
 */
function groupSelect(groups: PermissionGroup[], selectedId: number | null, label: string): HTMLSelectElement {
  const select = el("select", { className: "input", attrs: { "aria-label": label } }) as HTMLSelectElement;
  const fallback = groups.find((entry) => entry.slug === "user") ?? groups[0];
  for (const entry of groups) {
    const option = el("option", { attrs: { value: String(entry.id) }, text: entry.name }) as HTMLOptionElement;
    option.selected = selectedId === null ? entry === fallback : selectedId === entry.id;
    select.append(option);
  }
  return select;
}

function userCard(
  user: AdminUser, currentId: number, canPromote: boolean,
  groups: PermissionGroup[], refresh: () => Promise<void>
): HTMLElement {
  const role = roleSelect(user.role, canPromote && user.id !== currentId);
  const group = groupSelect(groups, user.permission_group_id, t("Grupa uprawnień"));
  const active = el("input", { attrs: { type: "checkbox", ...(Boolean(Number(user.is_active)) ? { checked: true } : {}) } });
  const password = el("input", {
    className: "input",
    attrs: { type: "password", minlength: "12", placeholder: t("Pozostaw puste bez zmiany"), autocomplete: "new-password" }
  });
  const passwordConfirm = el("input", {
    className: "input",
    attrs: { type: "password", minlength: "12", placeholder: t("Powtórz nowe hasło"), autocomplete: "new-password" }
  });
  if (user.id === currentId) active.disabled = true;
  const isPending = user.email_verified_at === null && Boolean(user.email);
  const status = el("span", { className: "admin-user__message", attrs: { role: "status" } });
  const save = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("check"), t("Zapisz"));
  save.addEventListener("click", () => {
    passwordConfirm.setCustomValidity("");
    if (password.value !== passwordConfirm.value) {
      passwordConfirm.setCustomValidity(t("Hasła nie są identyczne."));
      passwordConfirm.reportValidity();
      return;
    }
    save.disabled = true;
    status.className = "admin-user__message";
    status.textContent = t("Zapisywanie…");
    void updateUser({
      user_id: user.id,
      role: role.value as UserRole,
      is_active: active.checked,
      permission_group_id: Number(group.value),
      ...(password.value ? { password: password.value, password_confirm: passwordConfirm.value } : {})
    }).then(() => {
      status.className = "admin-user__message is-success";
      status.textContent = t("Zapisano");
      password.value = "";
      passwordConfirm.value = "";
      // The card is updated in place instead of rebuilding the section: a rebuild
      // would replace this very card and wipe the confirmation as it appears.
      user.is_active = active.checked;
      user.role = role.value as UserRole;
      user.permission_group_id = Number(group.value);
      user.is_guest = groups.find((entry) => entry.id === user.permission_group_id)?.slug === GUEST_GROUP_SLUG;
      repaintPills();
    }).catch((error: unknown) => {
      status.className = "admin-user__message is-error";
      status.textContent = error instanceof Error && error.message ? error.message : t("Błąd zapisu");
    }).finally(() => { save.disabled = false; });
  });
  const pill = el("span", { className: "status-pill" });
  const guestPill = el("span", { className: "status-pill status-pill--muted", text: t("Gość") });
  const repaintPills = (): void => {
    if (isPending) {
      pill.className = "status-pill status-pill--warning";
      pill.textContent = t("Oczekuje na aktywację");
    } else {
      const isActive = Boolean(Number(user.is_active));
      pill.className = "status-pill " + (isActive ? "status-pill--success" : "status-pill--muted");
      pill.textContent = isActive ? "Aktywne" : t("Wyłączone");
    }
    const group = groups.find((entry) => entry.id === user.permission_group_id);
    const guest = group ? group.slug === GUEST_GROUP_SLUG : Boolean(Number(user.is_guest));
    guestPill.classList.toggle("hidden", !guest);
  };
  repaintPills();
  const footer = el("footer", { className: "admin-user__footer" }, status, save);
  if (isPending) {
    const activate = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("check"), t("Aktywuj konto"));
    activate.addEventListener("click", () => {
      activate.disabled = true;
      status.className = "admin-user__message";
      status.textContent = t("Aktywowanie…");
      void activateUser(user.id)
        .then(async () => {
          status.className = "admin-user__message is-success";
          status.textContent = t("Konto aktywowane");
          await refresh();
        })
        .catch(() => {
          status.className = "admin-user__message is-error";
          status.textContent = t("Nie udało się aktywować");
          activate.disabled = false;
        });
    });
    const resend = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("share"), t("Wyślij link ponownie"));
    resend.addEventListener("click", () => {
      resend.disabled = true;
      status.className = "admin-user__message";
      status.textContent = t("Wysyłanie…");
      void resendUserActivation(user.id)
        .then((result) => {
          status.className = "admin-user__message is-success";
          status.textContent = result.spooled ? t("Wiadomość zapisana w logs/mail") : t("Wiadomość wysłana");
        })
        .catch(() => {
          status.className = "admin-user__message is-error";
          status.textContent = t("Nie udało się wysłać");
        })
        .finally(() => { resend.disabled = false; });
    });
    footer.prepend(el("div", { className: "admin-user__pending-actions" }, activate, resend));
  }
  return el(
    "article",
    { className: "admin-user" + (isPending ? " admin-user--pending" : "") },
    el("header", { className: "admin-user__identity" },
      el("span", { className: "user-chip__avatar", text: user.username.slice(0, 1).toUpperCase() }),
      el("div", {}, el("strong", { text: user.username }), el("small", { text: user.email ?? "ID " + user.id })),
      guestPill,
      pill
    ),
    el("div", { className: "admin-user__controls" },
      field(t("Rola"), role),
      field(t("Grupa uprawnień"), group),
      el("div", { className: "admin-user__toggles" },
        el("label", { className: "toggle-field" }, active, el("span", { text: t("Konto aktywne") }))
      ),
      el("div", { className: "admin-user__passwords" }, field(t("Nowe hasło"), password), field(t("Powtórz nowe hasło"), passwordConfirm))
    ),
    footer
  );
}

function scanTable(data: AdminData): HTMLElement {
  const table = el("table", { className: "data-table" });
  table.append(el("thead", {}, el("tr", {},
    el("th", { text: "ID" }), el("th", { text: t("Źródło") }), el("th", { text: t("Status") }),
    el("th", { text: t("Pozycje") }), el("th", { text: t("Błędy") }), el("th", { text: t("Zakończenie") })
  )));
  table.append(el("tbody", {}, ...data.scans.map((scan) => el("tr", {},
    el("td", { text: String(scan.id) }),
    el("td", { text: scan.slug }),
    el("td", {}, el("span", { className: "status-pill " + (scan.status === "completed" ? "status-pill--success" : ""), text: scan.status })),
    el("td", { text: Number(scan.discovered_count).toLocaleString("pl-PL") }),
    el("td", { text: String(scan.error_count) }),
    el("td", { text: scan.finished_at ?? "—" })
  ))));
  return table;
}

function subtitleCachePanel(data: AdminData): HTMLElement {
  const root = el("select", { className: "input" }, el("option", { text: t("Wszystkie źródła filmów"), attrs: { value: "all" } }));
  for (const row of data.catalog.filter((entry) => Number(entry.video) > 0)) {
    root.append(el("option", { text: t("{name} ({count} filmów)", { name: row.display_name, count: Number(row.video).toLocaleString("pl-PL") }), attrs: { value: row.slug } }));
  }
  const mode = el(
    "select",
    { className: "input" },
    el("option", { text: t("Tylko brakujące napisy"), attrs: { value: "missing" } }),
    el("option", { text: t("Odśwież istniejący cache"), attrs: { value: "refresh" } })
  );
  const ids = el("input", {
    className: "input",
    attrs: { type: "text", inputmode: "numeric", placeholder: t("Opcjonalnie ID filmów, np. 12, 45, 81"), maxlength: "4096" }
  });
  const progress = el("progress", { className: "admin-subtitle-cache__progress", attrs: { max: "1", value: "0" } });
  const status = el("p", { className: "admin-subtitle-cache__status", attrs: { role: "status" }, text: t("Generator jest gotowy.") });
  const start = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("server"), t("Generuj cache napisów"));
  let pollTimer = 0;
  const paint = (state: SubtitleCacheStatus): void => {
    const total = Number(state.total_files) || 0;
    const done = Number(state.processed_files) || 0;
    progress.max = Math.max(1, total);
    progress.value = Math.min(done, Math.max(1, total));
    start.disabled = state.state === "running";
    if (state.state === "running") {
      status.textContent = t("Przetworzono {done}/{total} filmów · wygenerowano {generated} · z cache {cached} · błędy {errors}", {
        done, total, generated: state.generated_tracks, cached: state.cached_tracks, errors: state.errors
      }) + (state.current_file ? ` · ${state.current_file}` : "");
    } else if (state.state === "completed") {
      // "Skipped" is the number worth seeing after the first full pass: it says
      // the run cost nothing for those films, which is the point of the record.
      status.textContent = t("Gotowe: {done} filmów, {generated} nowych ścieżek, {cached} już w cache, {skipped} pominiętych, {errors} błędów.", {
        done, generated: state.generated_tracks, cached: state.cached_tracks,
        skipped: state.skipped_files ?? 0, errors: state.errors
      })
        // Counted apart: a picture track becomes a folder of images rather than
        // a WebVTT file, and costs about half a minute instead of a second.
        + (state.picture_tracks ? " " + t("W tym {count} ścieżek obrazkowych.", { count: state.picture_tracks }) : "");
    } else if (state.state === "failed") {
      status.textContent = t("Generator zakończył się błędem. Szczegóły są w logu usługi transferowej.");
    } else {
      status.textContent = t("Generator jest gotowy.");
    }
    window.clearTimeout(pollTimer);
    if (state.state === "running") {
      pollTimer = window.setTimeout(() => void subtitleCacheStatus().then(paint).catch(() => undefined), 1500);
    }
  };
  start.addEventListener("click", () => {
    const parsedIds = ids.value.trim() === "" ? [] : ids.value.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (parsedIds.some((value) => !Number.isSafeInteger(value) || value < 1) || parsedIds.length > 500) {
      ids.setCustomValidity(t("Podaj maksymalnie 500 dodatnich identyfikatorów oddzielonych przecinkami."));
      ids.reportValidity();
      return;
    }
    ids.setCustomValidity("");
    start.disabled = true;
    status.textContent = t("Uruchamianie generatora…");
    void startSubtitleCache({ root: root.value, mode: mode.value as "missing" | "refresh", media_item_ids: parsedIds })
      .then(paint)
      .catch(() => { status.textContent = t("Nie udało się uruchomić generatora."); start.disabled = false; });
  });
  void subtitleCacheStatus().then(paint).catch(() => { status.textContent = t("Usługa cache napisów jest niedostępna."); });
  return el(
    "div",
    { className: "admin-subtitle-cache" },
    el("div", { className: "admin-subtitle-cache__fields" }, field(t("Zakres"), root), field("Tryb", mode), field(t("Wybrane ID filmów"), ids)),
    progress,
    status,
    el("div", { className: "admin-subtitle-cache__actions" }, start),
    el("p", { className: "admin-subtitle-cache__hint", text: t("Eksportowana jest wyłącznie każda obsługiwana ścieżka tekstowa, po kolei. Gotowy WebVTT pozostaje w prywatnym cache; przewijanie nie uruchamia ponownego FFmpeg.") })
  );
}

/**
 * Readable names for what the trail records; anything new falls back to its key.
 *
 * A function, not a constant: a module constant resolves its labels while the
 * bundle loads, which is before the shell has adopted the account's language.
 */
function activityLabels(): Record<string, string> {
  return {
  "media.rating": t("Ocena lub ulubione"),
  "media.metadata_override": t("Edycja tagów"),
  "media.artwork_override": t("Zmiana okładki utworu"),
  "media.artwork_remove": t("Usunięcie okładki utworu"),
  "collection.create": t("Utworzenie playlisty"),
  "collection.update": t("Zmiana playlisty"),
  "collection.delete": t("Usunięcie playlisty"),
  "collection.item": t("Zmiana zawartości playlisty"),
  "collection.reorder": t("Zmiana kolejności playlisty"),
  "collection.share": t("Udostępnienie playlisty"),
  "collection.artwork": t("Okładka playlisty"),
  "collection.artwork_remove": t("Usunięcie okładki playlisty"),
  "user.create": t("Utworzenie konta"),
  "user.update": t("Zmiana konta"),
  "user.activate": t("Aktywacja konta"),
  "settings.update": t("Zmiana ustawień"),
    "profile.visibility": t("Widoczność profilu")
  };
}

function activityDetails(entry: ActivityEntry): string {
  if (!entry.details) return "";
  return Object.entries(entry.details)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" · ");
}

/**
 * The audit trail, finally readable.
 *
 * Every audited action has been written since the first milestone, but the only
 * way to read it was a SQL client. Filters run against the indexed columns, and
 * the panel asks for one page at a time — the trail outlives any single view.
 */
/**
 * A catalogue path written so a person can read it.
 *
 * Slashes become spaced arrows, because a run-on path is one long word that the
 * eye slides off; the media root is not shown because every row shares it.
 */
function prettyPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).join("  ›  ");
}

/**
 * The review queue read as folders instead of as works.
 *
 * The single-work view is right when there are a handful of decisions and
 * useless when there are hundreds: one cartoon anthology in this library is 515
 * separate works and one answer, and one cartoon series is 303. Setting a genre
 * on the folder writes it to everything inside, which is the difference between
 * a review and an afternoon of clicking.
 */
function titleFolderView(genres: TitleLookupPage["genres"], onDone: () => void): HTMLElement {
  const host = el("div", { className: "stack" });
  const status = el("p", { className: "form-status", attrs: { role: "status" } });

  const card = (folder: TitleLookupFolder): HTMLElement => {
    const box = el("article", { className: "panel admin-folder" });
    const chosen = el("select", {
      className: "input",
      attrs: { multiple: "multiple", size: "6", "aria-label": t("Gatunki") }
    }) as HTMLSelectElement;
    chosen.replaceChildren(
      ...genres.map((genre) => el("option", { text: t(genre.name_pl), attrs: { value: String(genre.id) } }))
    );
    const year = el("input", {
      className: "input",
      attrs: { type: "number", min: "1888", max: "2049", placeholder: t("Rok"), "aria-label": t("Rok") }
    }) as HTMLInputElement;
    // Years typed against single episodes. The folder's genre is shared — every
    // episode of a cartoon is animation — but its year is not, because a run of
    // one spans decades.
    const perWork = new Map<number, number>();
    const workList = el("div", { className: "admin-folder__works hidden" });
    const workToggle = el("button", { className: "button button--secondary", attrs: { type: "button" } },
      icon("list"), el("span", { text: t("Rok osobno dla każdego odcinka") }));
    let workListLoaded = false;
    workToggle.addEventListener("click", () => {
      const hidden = workList.classList.toggle("hidden");
      if (hidden || workListLoaded) return;
      workListLoaded = true;
      workList.replaceChildren(el("p", { className: "muted", text: t("Pobieranie…") }));
      void getTitleFolderWorks(folder.folder)
        .then((page) => {
          workList.replaceChildren(...page.works.map((work) => {
            const field = el("input", {
              className: "input input--compact",
              attrs: { type: "number", min: "1888", max: "2049", placeholder: t("Rok"), "aria-label": work.title }
            }) as HTMLInputElement;
            if (work.year !== null) field.value = String(work.year);
            field.addEventListener("change", () => {
              const value = Number(field.value);
              if (field.value && value >= 1888 && value <= 2049) perWork.set(work.id, value);
              else perWork.delete(work.id);
            });
            return el("div", { className: "admin-folder__work" },
              el("div", { className: "admin-folder__work-copy" },
                el("strong", { text: work.title }),
                el("small", { className: "admin-lookup__path", text: prettyPath(work.path) })
              ),
              field
            );
          }));
          if (page.works.length === 0) {
            workList.replaceChildren(el("p", { className: "empty-copy", text: t("Nic tu nie czeka.") }));
          }
        })
        .catch(() => workList.replaceChildren(
          el("p", { className: "empty-copy", text: t("Nie udało się pobrać pozycji folderu.") })
        ));
    });

    const apply = el("button", { className: "button button--primary", attrs: { type: "button" } },
      icon("check"), el("span", { text: t("Ustaw dla {count} pozycji", { count: folder.works }) }));
    apply.addEventListener("click", () => {
      apply.disabled = true;
      box.setAttribute("aria-busy", "true");
      void decideTitleFolder({
        folder: folder.folder,
        genres: Array.from(chosen.selectedOptions, (option) => Number(option.value)),
        year: year.value ? Number(year.value) : null,
        years: Object.fromEntries(perWork)
      })
        .then((result) => {
          box.replaceChildren(el("p", { className: "form-status", text: t(
            "Ustawiono dla {works} pozycji ({files} plików).", { works: result.works, files: result.files }
          ) }));
          onDone();
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : t("Nie udało się ustawić folderu.");
          apply.disabled = false;
        })
        .finally(() => box.removeAttribute("aria-busy"));
    });

    box.replaceChildren(
      el("header", { className: "admin-lookup__heading" },
        el("div", { className: "admin-lookup__title" },
          el("h3", { text: folder.folder }),
          el("small", { className: "muted", text: folder.samples.join(" · ") })
        ),
        el("span", { className: "admin-lookup__badge", text: t("{works} pozycji · {files} plików", {
          works: folder.works, files: folder.files
        }) })
      ),
      el("div", { className: "admin-folder__form" },
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Gatunki") }), chosen),
        el("label", { className: "field" },
          el("span", { className: "field__label", text: t("Rok dla wszystkich") }), year),
        apply
      ),
      el("div", { className: "admin-folder__footer" }, workToggle),
      workList
    );
    return box;
  };

  const load = (): void => {
    status.textContent = t("Pobieranie…");
    void getTitleFolders("review")
      .then((page) => {
        status.textContent = "";
        host.replaceChildren(
          page.folders.length === 0
            ? el("p", { className: "empty-copy", text: t("Nie ma folderu, w którym czeka więcej niż jedna pozycja.") })
            : el("p", { className: "muted", text: t("Folder ustawiony tutaj nadpisuje wszystkie czekające w nim pozycje. Decyzje wpisane ręcznie zostają nietknięte.") }),
          ...page.folders.map(card)
        );
      })
      .catch(() => { status.textContent = t("Nie udało się pobrać listy folderów."); });
  };
  load();
  return el("div", { className: "stack" }, status, host);
}

/**
 * Works whose genre the lookup would not commit to on its own.
 *
 * The matcher writes an answer down unattended only when the title, the year
 * and the runtime all agree; everything short of that arrives here, because a
 * wrong genre is invisible once it is on a card and nothing would ever prompt
 * anybody to check it. Each row therefore shows what was searched for, what
 * came back, and *why* the matcher hesitated — a runtime fifty minutes out is a
 * different problem from two candidates that scored the same.
 *
 * Confirming does not go back to Filmweb: every candidate was stored with its
 * genres when the lookup ran, so a decision is a local write.
 */
function titleLookupsPanel(): HTMLElement {
  const statusFilter = el(
    "select",
    { className: "input", attrs: { "aria-label": t("Stan dopasowania") } },
    el("option", { text: t("Do sprawdzenia"), attrs: { value: "review" } }),
    el("option", { text: t("Nic nie znaleziono"), attrs: { value: "none" } }),
    el("option", { text: t("Dopasowane"), attrs: { value: "matched" } }),
    el("option", { text: t("Pominięte"), attrs: { value: "skipped" } }),
    el("option", { text: t("Oczekujące"), attrs: { value: "pending" } }),
    el("option", { text: t("Błędy"), attrs: { value: "failed" } })
  );
  const summary = el("p", { className: "muted" });
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const list = el("div", { className: "stack" });
  const reload = el("button", { className: "button button--secondary hidden", attrs: { type: "button" } },
    icon("history"), el("span", { text: t("Odśwież") }));
  const more = el("button", { className: "button button--secondary hidden", attrs: { type: "button" } }, t("Pokaż więcej"));
  let page = 1;
  let loading = false;
  let genres: TitleLookupPage["genres"] = [];

  // The server resolves each candidate's genres to names before sending them.
  // It has to: Filmweb numbers its genres and so does this catalogue, the two
  // overlap, and reading one as the other turned "Horror" into "Dokumentalny"
  // on every card here. Nothing in this file compares a genre id any more.
  const genreNames = (candidate: TitleLookupCandidate): string =>
    (candidate.genres ?? []).map((genre) => t(genre.name_pl)).join(", ");

  const decide = (
    entry: TitleLookupEntry,
    payload: Parameters<typeof decideTitleLookup>[0],
    card: HTMLElement
  ): void => {
    card.setAttribute("aria-busy", "true");
    void decideTitleLookup(payload)
      .then(() => {
        card.replaceChildren(el("p", {
          className: "form-status",
          text: t("Zapisano dla: {title}", { title: entry.query_title })
        }));
      })
      .catch(() => { status.textContent = t("Nie udało się zapisać decyzji."); })
      .finally(() => card.removeAttribute("aria-busy"));
  };

  const card = (entry: TitleLookupEntry): HTMLElement => {
    const host = el("article", { className: "panel admin-lookup" });
    const manualGenres = el("select", {
      className: "input",
      attrs: { multiple: "multiple", size: "6", "aria-label": t("Gatunki") }
    }) as HTMLSelectElement;
    manualGenres.replaceChildren(
      ...genres.map((genre) => el("option", { text: t(genre.name_pl), attrs: { value: String(genre.id) } }))
    );
    const manualYear = el("input", {
      className: "input",
      attrs: { type: "number", min: "1888", max: "2049", placeholder: t("Rok"), "aria-label": t("Rok") }
    }) as HTMLInputElement;

    const candidates = entry.candidates.map((candidate) => {
      const take = el("button", { className: "button button--primary", attrs: { type: "button" } },
        icon("check"), el("span", { text: t("To jest to") }));
      take.addEventListener("click", () =>
        decide(entry, { id: entry.id, decision: "confirm", filmweb_id: candidate.filmweb_id }, host));
      const facts = [
        candidate.year ? String(candidate.year) : t("rok nieznany"),
        candidate.duration_minutes ? t("{count} min", { count: candidate.duration_minutes }) : "",
        candidate.entity === "serial" ? t("serial") : t("film"),
        t("pewność {value}%", { value: candidate.confidence })
      ].filter(Boolean);
      return el(
        "div",
        { className: "admin-lookup__candidate" },
        el("div", { className: "admin-lookup__candidate-copy" },
          el("strong", { text: candidate.title }),
          candidate.original_title && candidate.original_title !== candidate.title
            ? el("span", { className: "muted", text: candidate.original_title })
            : null,
          el("small", { text: facts.join(" · ") }),
          genreNames(candidate)
            ? el("small", { className: "muted", text: genreNames(candidate) })
            : el("small", { className: "muted", text: t("bez gatunku") }),
          el("a", {
            className: "admin-lookup__link",
            text: t("Zobacz na Filmwebie"),
            attrs: { href: candidate.url, target: "_blank", rel: "noopener noreferrer" }
          })
        ),
        take
      );
    });

    const skip = el("button", { className: "button button--secondary", attrs: { type: "button" } },
      icon("close"), el("span", { text: t("Żadne z tych") }));
    skip.addEventListener("click", () => decide(entry, { id: entry.id, decision: "skip" }, host));
    const saveManual = el("button", { className: "button button--secondary", attrs: { type: "button" } },
      icon("check"), el("span", { text: t("Zapisz ręcznie") }));
    saveManual.addEventListener("click", () => decide(entry, {
      id: entry.id,
      decision: "manual",
      genres: Array.from(manualGenres.selectedOptions, (chosen) => Number(chosen.value)),
      year: manualYear.value ? Number(manualYear.value) : null
    }, host));

    host.replaceChildren(
      el("header", { className: "admin-lookup__heading" },
        el("div", { className: "admin-lookup__title" },
          el("h3", { text: entry.query_title }),
          // The whole path, not the bare file name: "289 - Podniebna
          // niespodzianka.avi" is not something anybody can find on a disk, and
          // "Smerfy / Smerfy / 289 - …" is.
          el("small", { className: "admin-lookup__path", text: prettyPath(entry.path || entry.subject) })
        ),
        el("span", { className: "admin-lookup__badge", text: entry.is_episode
          ? t("serial · {count} plików", { count: entry.item_count })
          : t("film · {count} plików", { count: entry.item_count }) })
      ),
      el("p", { className: "admin-lookup__reasons", text: entry.reasons.length > 0
        ? t("Dlaczego niepewne: {reasons}", { reasons: entry.reasons.join(", ") })
        : (entry.last_error ?? t("Brak wyniku wyszukiwania.")) }),
      candidates.length > 0
        ? el("div", { className: "admin-lookup__candidates" }, ...candidates)
        : el("p", { className: "empty-copy", text: t("Wyszukiwarka nie zwróciła nic sensownego — ustaw gatunek ręcznie albo pomiń.") }),
      el("details", { className: "admin-lookup__manual" },
        el("summary", { text: t("Ustaw ręcznie") }),
        el("div", { className: "admin-lookup__manual-body" },
          el("label", { className: "field" }, el("span", { className: "field__label", text: t("Gatunki") }), manualGenres),
          el("label", { className: "field" }, el("span", { className: "field__label", text: t("Rok") }), manualYear),
          saveManual
        )
      ),
      el("footer", { className: "admin-lookup__footer" }, skip)
    );
    return host;
  };

  const load = async (reset: boolean): Promise<void> => {
    if (loading) return;
    loading = true;
    more.disabled = true;
    if (reset) {
      page = 1;
      status.textContent = t("Pobieranie…");
    }
    try {
      const result = await getTitleLookups({ status: statusFilter.value, page, limit: 20 });
      genres = result.genres;
      if (reset) list.replaceChildren();
      for (const entry of result.entries) list.append(card(entry));
      if (reset && result.entries.length === 0) {
        list.replaceChildren(el("p", { className: "empty-copy", text: t("Nic tu nie czeka.") }));
      }
      const counts = result.counts;
      summary.textContent = t(
        "Dopasowane: {matched} · Do sprawdzenia: {review} · Bez wyniku: {none} · Oczekujące: {pending}",
        {
          matched: counts.matched ?? 0,
          review: counts.review ?? 0,
          none: counts.none ?? 0,
          pending: counts.pending ?? 0
        }
      );
      status.textContent = "";
      more.classList.toggle("hidden", page * result.limit >= result.total);
      page += 1;
    } catch {
      status.textContent = t("Nie udało się pobrać listy dopasowań.");
    } finally {
      loading = false;
      more.disabled = false;
    }
  };

  statusFilter.addEventListener("change", () => void load(true));
  more.addEventListener("click", () => void load(false));
  reload.addEventListener("click", () => void load(true));
  void load(true);

  // Two ways to read the same queue: one work at a time, or a folder at a time.
  const singleView = el("div", { className: "stack" }, status, list, more);
  const groupHost = el("div", { className: "stack hidden" });
  const viewSwitch = el(
    "select",
    { className: "input", attrs: { "aria-label": t("Widok") } },
    el("option", { text: t("Pojedynczo"), attrs: { value: "single" } }),
    el("option", { text: t("Folderami"), attrs: { value: "folders" } })
  ) as HTMLSelectElement;
  viewSwitch.addEventListener("change", () => {
    const grouped = viewSwitch.value === "folders";
    singleView.classList.toggle("hidden", grouped);
    groupHost.classList.toggle("hidden", !grouped);
    statusFilter.classList.toggle("hidden", grouped);
    if (grouped) groupHost.replaceChildren(titleFolderView(genres, () => void load(true)));
  });

  return el(
    "div",
    { className: "stack" },
    el("div", { className: "admin-lookup__toolbar" }, viewSwitch, statusFilter, summary),
    singleView,
    groupHost
  );
}

/**
 * Sessions that are open right now, and the way to close one.
 *
 * The log next to it answers "who was here"; this answers "who is here", which
 * is the question you ask when a browser was left signed in somewhere it should
 * not have been. Until there was a table of sessions the only cure was changing
 * the password.
 *
 * Closing takes effect on that session's next request — near instant in
 * practice, since the application talks to the server constantly — and the card
 * says so rather than pretending the browser dies the moment the button is
 * pressed. The current session is listed too, marked, and without a button: the
 * way to end your own session is "Wyloguj".
 */
/**
 * One series drawn as an area, in SVG, by hand.
 *
 * A chart library would be a dependency and a download for four hundred points
 * and one shape. What is actually needed is a path, a baseline and a label —
 * and drawing it here means it inherits the theme's colours instead of carrying
 * a palette of its own.
 *
 * The vertical scale is per chart and printed on it. A shared scale would make
 * the quiet series a flat line at the bottom of a busy one, which is exactly
 * the reading nobody wants: each chart answers "when was *this* busy".
 */
function areaChart(values: number[], label: string, format: (value: number) => string): HTMLElement {
  const width = 720;
  const height = 120;
  // The scale needs a floor to divide by; the caption must not borrow it. A
  // chart of an idle hour printed "szczyt 1" — a peak that never happened.
  const observed = Math.max(0, ...values);
  const peak = Math.max(1, observed);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const point = (value: number, index: number): string =>
    `${(index * step).toFixed(1)},${(height - (value / peak) * (height - 8) - 2).toFixed(1)}`;
  const line = values.map(point).join(" ");
  const svg = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${label}">
      <polygon class="stats-chart__area" points="0,${height} ${line} ${width},${height}"></polygon>
      <polyline class="stats-chart__line" points="${line}"></polyline>
    </svg>`;
  const figure = el("figure", { className: "stats-chart" });
  figure.innerHTML = svg;
  figure.append(el("figcaption", { className: "stats-chart__caption" },
    el("span", { text: label }),
    el("span", { className: "stats-chart__peak", text: t("szczyt {value}", { value: format(observed) }) })));
  return figure;
}

/**
 * What the server has been doing, from its own diary.
 *
 * `/health/status` only ever answered "right now", which is the wrong tense for
 * most of an operator's questions — whether anything was streaming overnight,
 * whether the cache stopped growing, whether today is busier than last week.
 * The service writes one line a minute to `runtime/stats/history.jsonl`; this
 * reads it back.
 */
function statsPanel(): HTMLElement {
  const range = el("select", { className: "input", attrs: { "aria-label": t("Zakres statystyk") } },
    el("option", { text: t("Ostatnia godzina"), attrs: { value: "1" } }),
    el("option", { text: t("Ostatnia doba"), attrs: { value: "24", selected: true } }),
    el("option", { text: t("Ostatni tydzień"), attrs: { value: "168" } })
  ) as HTMLSelectElement;
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const summary = el("div", { className: "admin-metrics" });
  const charts = el("div", { className: "stack" });
  const caches = el("div", { className: "table-wrap" });

  const load = async (): Promise<void> => {
    status.textContent = t("Pobieranie…");
    try {
      const stats = await serverStats(Number(range.value));
      const current = stats.current;
      summary.replaceChildren(
        metric("play", Number(current.transfers_active ?? 0), t("aktywnych transferów")),
        metric("download", stats.totals.transfers, t("transferów w oknie")),
        metric("server", stats.totals.peak_active, t("szczyt równoległych")),
        // Hours are the useful unit for a server that has been up for days, and
        // useless for one restarted five minutes ago — which is exactly when
        // somebody is looking at this panel.
        ...(Number(current.uptime_seconds ?? 0) >= 3600
          ? [metric("history", Math.round(Number(current.uptime_seconds ?? 0) / 3600), t("godzin działania"))]
          : [metric("history", Math.round(Number(current.uptime_seconds ?? 0) / 60), t("minut działania"))]),
        metric("admin", stats.totals.errors, t("błędów 5xx"))
      );
      if (stats.samples.length === 0) {
        charts.replaceChildren(el("p", { className: "muted", text: t("Usługa nie zapisała jeszcze żadnej próbki — pierwsza pojawi się po minucie działania.") }));
      } else {
        charts.replaceChildren(
          areaChart(stats.samples.map((sample) => sample.bytes), t("Wysłane dane"), (value) => formatBytes(value) + "/min"),
          areaChart(stats.samples.map((sample) => sample.active), t("Aktywne transfery"), (value) => String(Math.round(value))),
          areaChart(stats.samples.map((sample) => sample.requests), t("Żądania"), (value) => String(Math.round(value)) + "/min")
        );
      }
      const cacheRows = Object.entries(stats.cache);
      caches.replaceChildren(cacheRows.length === 0
        ? el("p", { className: "muted", text: t("Rozmiary cache pojawią się przy kolejnym pomiarze.") })
        : el("table", { className: "data-table" },
            el("thead", {}, el("tr", {}, el("th", { text: t("Cache") }), el("th", { text: t("Rozmiar") }), el("th", { text: t("Plików") }))),
            el("tbody", {}, ...cacheRows.map(([name, entry]) => el("tr", {},
              el("td", { text: name }),
              el("td", { text: formatBytes(entry.bytes) }),
              el("td", { text: entry.files.toLocaleString("pl-PL") })
            )))));
      status.textContent = t("{count} próbek · {bytes} wysłane", {
        count: stats.totals.samples.toLocaleString("pl-PL"),
        bytes: formatBytes(stats.totals.bytes)
      }) + (stats.totals.restarts > 0 ? " · " + t("restartów: {count}", { count: String(stats.totals.restarts) }) : "");
    } catch {
      status.textContent = t("Nie udało się pobrać statystyk. Usługa transferowa może być zatrzymana.");
    }
  };
  range.addEventListener("change", () => void load());
  void load();

  return el(
    "article",
    { className: "panel admin-card" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Serwer") }), el("h3", { text: t("Co się działo") })),
      el("p", { text: t("Jedna próbka na minutę z usługi transferowej, trzymana w runtime/stats. Liczniki resetuje restart usługi, więc wykres pokazuje różnice, a nie sumy od startu.") })
    ),
    el("div", { className: "admin-activity__filters" }, range, status),
    summary,
    charts,
    caches
  );
}

/**
 * The weekly digest, from the operator's side.
 *
 * Two facts and one button: how many accounts asked for it, when a run last
 * went out, and "send now" for when somebody wants to see the message today.
 * Sending obeys the subscriptions — an operator may run the job early, and
 * still may not sign anybody up for it.
 */
function digestPanel(): HTMLElement {
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const facts = el("p", { className: "muted" });
  const send = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("share"), t("Wyślij teraz"));

  const load = async (): Promise<void> => {
    try {
      const digest = await getDigest();
      const server = digest.server;
      if (!server) { facts.textContent = ""; return; }
      facts.textContent = [
        t("Zapisanych kont: {count}", { count: server.subscribers.toLocaleString("pl-PL") }),
        server.last_sent_at
          ? t("ostatni przebieg {when}", { when: server.last_sent_at.slice(0, 16).replace("T", " ") })
          : t("nie było jeszcze żadnego przebiegu"),
        server.spooled ? t("tryb spool — wiadomości lądują w logs/mail") : t("wysyłka przez SMTP")
      ].join(" · ");
      send.disabled = server.subscribers === 0;
    } catch {
      facts.textContent = t("Nie udało się pobrać ustawień powiadomień.");
    }
  };

  send.addEventListener("click", () => {
    send.disabled = true;
    status.textContent = t("Wysyłanie…");
    void sendDigestNow()
      .then((result) => {
        status.textContent = t("Wysłano: {sent}, bez nowości: {empty}", {
          sent: result.sent.toLocaleString("pl-PL"),
          empty: result.empty.toLocaleString("pl-PL")
        });
        return load();
      })
      .catch(() => { status.textContent = t("Nie udało się wysłać przeglądu."); })
      .finally(() => { send.disabled = false; });
  });
  void load();

  return el(
    "article",
    { className: "panel admin-card" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Powiadomienia") }), el("h3", { text: t("Cotygodniowy przegląd nowości") })),
      el("p", { text: t("Wychodzi tylko do kont, które go włączyły w „Moim koncie”, i wymienia wyłącznie biblioteki, do których dane konto ma dostęp. Harmonogram: scripts/digest — polecenie php integrations/php/stage/digest.php.") })
    ),
    el("div", { className: "admin-activity__filters" }, send, status),
    facts
  );
}

function sessionsPanel(): HTMLElement {
  const rows = el("tbody");
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const refresh = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Odśwież"));

  const load = async (): Promise<void> => {
    refresh.disabled = true;
    status.textContent = t("Pobieranie…");
    try {
      const sessions = await getActiveSessions();
      rows.replaceChildren();
      if (sessions.length === 0) {
        rows.append(el("tr", {}, el("td", { attrs: { colspan: "5" }, text: t("Brak otwartych sesji.") })));
      }
      for (const session of sessions) {
        const close = el("button", { className: "button button--danger", attrs: { type: "button" } }, t("Wyloguj"));
        close.addEventListener("click", () => {
          close.disabled = true;
          void revokeSession({ fingerprint: session.fingerprint })
            .then(load)
            .catch(() => { status.textContent = t("Nie udało się zamknąć sesji."); close.disabled = false; });
        });
        rows.append(el(
          "tr",
          {},
          el("td", { text: session.username }),
          el("td", { text: session.device_label || t("Nieznane urządzenie") }),
          el("td", { text: session.created_at.slice(0, 19).replace("T", " ") }),
          el("td", { text: session.last_seen_at.slice(0, 19).replace("T", " ") }),
          el("td", {}, session.is_current
            ? el("span", { className: "status-pill status-pill--success", text: t("ta przeglądarka") })
            : close)
        ));
      }
      status.textContent = t("{count} otwartych sesji", { count: sessions.length.toLocaleString("pl-PL") });
    } catch {
      status.textContent = t("Nie udało się pobrać sesji.");
    } finally {
      refresh.disabled = false;
    }
  };

  refresh.addEventListener("click", () => void load());
  void load();

  return el(
    "article",
    { className: "panel admin-card" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Sesje") }), el("h3", { text: t("Kto jest zalogowany teraz") })),
      el("p", { text: t("Zamknięcie działa przy najbliższym żądaniu tej sesji. Identyfikator sesji nie jest przechowywany — w bazie jest wyłącznie jego skrót.") })
    ),
    // One button per row and no bulk action here on purpose: this list holds
    // several accounts, so "sign out everywhere else" would be a question about
    // whose sessions. On your own account page it has only one answer, and that
    // is where it lives.
    el("div", { className: "admin-activity__filters" }, refresh, status),
    el("div", { className: "table-wrap" }, el("table", { className: "data-table" },
      el("thead", {}, el("tr", {},
        el("th", { text: t("Konto") }), el("th", { text: t("Urządzenie") }),
        el("th", { text: t("Zalogowano") }), el("th", { text: t("Ostatnia aktywność") }), el("th", { text: t("Akcja") })
      )),
      rows
    ))
  );
}

function activityPanel(data: AdminData): HTMLElement {
  const eventFilter = el("select", { className: "input", attrs: { "aria-label": t("Rodzaj zdarzenia") } });
  const actorFilter = el("select", { className: "input", attrs: { "aria-label": t("Konto") } });
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const rows = el("tbody");
  const more = el("button", { className: "button button--secondary hidden", attrs: { type: "button" } }, t("Pokaż starsze"));
  const retention = el("p", { className: "muted" });
  let page = 1;
  let loading = false;

  const load = async (reset: boolean): Promise<void> => {
    if (loading) return;
    loading = true;
    more.disabled = true;
    if (reset) {
      page = 1;
      status.textContent = t("Pobieranie…");
    }
    try {
      const result = await getActivity({
        event: eventFilter.value,
        actor: actorFilter.value ? Number(actorFilter.value) : null,
        page,
        limit: 25
      });
      if (reset) {
        rows.replaceChildren();
        // Built once from what the log actually holds, so the filter cannot
        // offer an event nobody has ever triggered.
        if (eventFilter.options.length === 0) {
          eventFilter.append(el("option", { text: t("Wszystkie zdarzenia"), attrs: { value: "" } }));
          for (const entry of result.actions) {
            eventFilter.append(el("option", {
              text: `${activityLabels()[entry.value] ?? entry.value} (${entry.count.toLocaleString("pl-PL")})`,
              attrs: { value: entry.value }
            }));
          }
        }
        retention.textContent = t("Wpisy starsze niż {months} miesięcy są usuwane automatycznie.", { months: Math.round(result.retention_days / 30) });
      }
      for (const entry of result.entries) {
        rows.append(el(
          "tr",
          {},
          el("td", { text: entry.created_at.slice(0, 19).replace("T", " ") }),
          el("td", { text: entry.actor_name ?? t("konto usunięte") }),
          el("td", { text: activityLabels()[entry.action] ?? entry.action }),
          el("td", { text: entry.target_id ? `${entry.target_type} #${entry.target_id}` : entry.target_type }),
          el("td", { className: "admin-activity__details", text: activityDetails(entry) })
        ));
      }
      status.textContent = t("{count} zdarzeń w dzienniku", { count: result.total.toLocaleString("pl-PL") });
      more.classList.toggle("hidden", !result.has_more);
      if (result.entries.length === 0 && page === 1) {
        rows.replaceChildren(el("tr", {}, el("td", { attrs: { colspan: "5" }, text: t("Brak zdarzeń dla tych filtrów.") })));
      }
    } catch {
      status.textContent = t("Nie udało się pobrać dziennika.");
    } finally {
      loading = false;
      more.disabled = false;
    }
  };

  actorFilter.append(el("option", { text: t("Wszystkie konta"), attrs: { value: "" } }));
  for (const user of [...(data.users ?? [])].sort((left, right) => left.username.localeCompare(right.username, "pl"))) {
    actorFilter.append(el("option", { text: user.username, attrs: { value: String(user.id) } }));
  }
  for (const control of [eventFilter, actorFilter]) control.addEventListener("change", () => void load(true));
  more.addEventListener("click", () => {
    page += 1;
    void load(false);
  });
  void load(true);

  // Who was here recently — the same rows the accounts section shows, read for
  // a different question.
  const seen = [...(data.users ?? [])]
    .filter((user) => Boolean(user.last_login_at))
    .sort((left, right) => String(right.last_login_at).localeCompare(String(left.last_login_at)))
    .slice(0, 8);

  return el(
    "div",
    { className: "stack" },
    sessionsPanel(),
    digestPanel(),
    el(
      "article",
      { className: "panel admin-card" },
      el("div", { className: "section-heading" },
        el("div", {}, el("span", { className: "eyebrow", text: t("Konta") }), el("h3", { text: t("Ostatnie logowania") }))),
      seen.length === 0
        ? el("p", { className: "muted", text: t("Żadne konto nie logowało się od czasu wdrożenia tej wersji.") })
        : el("div", { className: "table-wrap" }, el("table", { className: "data-table" },
            el("thead", {}, el("tr", {}, el("th", { text: t("Konto") }), el("th", { text: t("Rola") }), el("th", { text: t("Ostatnie logowanie") }))),
            el("tbody", {}, ...seen.map((user) => el("tr", {},
              el("td", { text: user.username }),
              el("td", { text: user.role }),
              el("td", { text: String(user.last_login_at).slice(0, 19).replace("T", " ") })
            )))
          ))
    ),
    el(
      "article",
      { className: "panel admin-card" },
      el("div", { className: "section-heading" },
        el("div", {}, el("span", { className: "eyebrow", text: t("Dziennik") }), el("h3", { text: t("Kto, co i kiedy") })),
        el("p", { text: t("Zapisywane są zmiany kont, ustawień, playlist, ocen i tagów.") })
      ),
      el("div", { className: "admin-activity__filters" },
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Zdarzenie") }), eventFilter),
        el("label", { className: "field" }, el("span", { className: "field__label", text: t("Konto") }), actorFilter),
        status
      ),
      el("div", { className: "table-wrap" }, el("table", { className: "data-table" },
        el("thead", {}, el("tr", {},
          el("th", { text: t("Kiedy") }), el("th", { text: t("Kto") }), el("th", { text: t("Zdarzenie") }),
          el("th", { text: t("Cel") }), el("th", { text: t("Szczegóły") })
        )),
        rows
      )),
      more,
      retention
    )
  );
}

/**
 * The metadata queue: what a scan left for the worker to read.
 *
 * A scan only compares size and mtime; tags and the ffprobe pass happen here.
 * Until now that worker existed only as a command line, so a freshly scanned
 * film had no duration or resolution until somebody remembered to run it.
 */
/**
 * The film-genre worker, moved here from the review screen.
 *
 * Everything that grinds away in the background belongs in one place, so this
 * sits next to the scan and the metadata queue rather than beside the queue of
 * decisions it fills. The batch is a choice: a taste of fifty, a serious dent,
 * or the whole queue in one run.
 *
 * "Everything" is not a flood. Each work is a request to somebody else's server
 * and the worker waits about a second and a bit between them, so a full drain of
 * a thousand works takes roughly twenty minutes of polite knocking rather than a
 * thousand requests at once — which is how an address gets blocked.
 */
function titleWorkerPanel(): HTMLElement {
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const size = el("select", { className: "input", attrs: { "aria-label": t("Wielkość porcji") } },
    el("option", { text: t("Porcja 50 dzieł"), attrs: { value: "50" } }),
    el("option", { text: t("Porcja 200 dzieł"), attrs: { value: "200" } }),
    el("option", { text: t("Porcja 500 dzieł"), attrs: { value: "500" } }),
    el("option", { text: t("Cała kolejka"), attrs: { value: "5000" } })
  ) as HTMLSelectElement;
  const run = el("button", { className: "button button--primary", attrs: { type: "button" } },
    icon("history"), el("span", { text: t("Sprawdź gatunki") }));
  run.addEventListener("click", () => {
    run.disabled = true;
    const batch = Number(size.value);
    status.textContent = batch >= 5000
      ? t("Przemielenie całej kolejki potrwa kilkadziesiąt minut — worker robi przerwy między zapytaniami.")
      : t("Wyszukiwanie w tle — to potrwa kilka minut.");
    void startTitleWorker(batch)
      .then((result) => {
        if (result.status === "already_running") status.textContent = t("Wyszukiwanie już trwa.");
      })
      .catch(() => { status.textContent = t("Nie udało się uruchomić wyszukiwania."); })
      .finally(() => { run.disabled = false; });
  });
  return el("article", { className: "panel admin-worker" },
    el("div", { className: "admin-worker__heading" },
      el("h3", { text: t("Gatunki i rok filmów") }),
      el("p", { className: "muted", text: t("Pobiera gatunek, rok i czas trwania z zewnętrznego katalogu. Niepewne dopasowania czekają na decyzję w sekcji Gatunki.") })
    ),
    el("div", { className: "admin-worker__actions" }, size, run, status)
  );
}

function metadataQueuePanel(data: AdminData, refresh: () => Promise<void>): HTMLElement {
  const queue = data.metadata ?? { queued: 0, running: 0, failed: 0, done: 0 };
  const status = el("span", { className: "form-status", attrs: { role: "status" } });
  const run = el(
    "button",
    { className: "button button--secondary", attrs: { type: "button" } },
    icon("server"),
    queue.queued > 0 ? t("Przetwórz porcję (200)") : t("Przetwórz kolejkę")
  );
  run.disabled = queue.queued === 0;
  run.addEventListener("click", () => {
    run.disabled = true;
    status.textContent = t("Uruchamianie…");
    void startMetadataWorker(200)
      .then(async (result) => {
        status.textContent = result.status === "already_running"
          ? t("Worker już pracuje — odśwież za chwilę.")
          : t("Worker czyta pliki w tle. Odśwież, aby zobaczyć postęp.");
        // Give the batch a head start before the counts are read again.
        window.setTimeout(() => void refresh(), 4000);
      })
      .catch((error: unknown) => {
        status.textContent = error instanceof Error && error.message ? error.message : t("Nie udało się uruchomić workera.");
        run.disabled = false;
      });
  });
  const figure = (label: string, value: number, tone = ""): HTMLElement =>
    el("div", { className: "admin-metric" + tone }, el("strong", { text: value.toLocaleString("pl-PL") }), el("span", { text: label }));
  return el(
    "article",
    { className: "panel admin-card" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Metadane") }), el("h3", { text: t("Kolejka odczytu plików") })),
      el("p", { text: t("Tagi audio czyta Mutagen, czas trwania, rozdzielczość i kodeki filmów — ffprobe.") })
    ),
    el("div", { className: "admin-metrics" },
      figure("oczekuje", queue.queued),
      figure(t("w toku"), queue.running),
      figure("nieudane", queue.failed),
      figure("gotowe", queue.done)
    ),
    el("div", { className: "admin-card__actions" }, run, status)
  );
}

function settingsForm(settings: AdminSettings, previewVisualizer: (id: string) => void): HTMLElement {
  const sortOptions: Array<[LibrarySort, string]> = [
    ["title_asc", t("Nazwa A–Z")],
    ["title_desc", t("Nazwa Z–A")],
    ["plays_desc", t("Najwięcej odtworzeń")],
    ["rating_desc", t("Najwyższa średnia ocena")],
    ["rating_count_desc", t("Najwięcej ocen")],
    ["size_desc", t("Największy rozmiar")],
    ["duration_desc", t("Najdłuższe")],
    ["duration_asc", t("Najkrótsze")],
    ["random", t("Losowo (foldery)")]
  ];
  const makeSort = (value: LibrarySort): HTMLSelectElement => {
    const select = el("select", { className: "input" });
    for (const [key, label] of sortOptions) {
      const option = el("option", { text: label, attrs: { value: key } });
      option.selected = key === value;
      select.append(option);
    }
    return select;
  };
  const musicSort = makeSort(settings.music_sort);
  const moviesSort = makeSort(settings.movies_sort);
  const pageSize = el("input", {
    className: "input",
    attrs: { type: "number", min: "10", max: "100", step: "5", value: String(settings.account_page_size) }
  });
  const playbackThreshold = el("input", {
    className: "input",
    attrs: { type: "number", min: "1", max: "100", step: "1", value: String(settings.playback_threshold_percent) }
  });
  const audioProfile = el("select", { className: "input" });
  const audioProfiles: Array<[CompatibilityAudioProfile, string]> = [
    ["stereo_low", t("Stereo AAC 128 kb/s — mniejszy transfer")],
    ["stereo_standard", t("Stereo AAC 192 kb/s — najlepsza zgodność")],
    ["stereo_high", t("Stereo AAC 320 kb/s — wyższa jakość")],
    ["surround_aac", t("Wielokanałowy AAC do 512 kb/s — eksperymentalny")]
  ];
  for (const [value, label] of audioProfiles) {
    const option = el("option", { text: label, attrs: { value } });
    option.selected = value === settings.compatibility_audio_profile;
    audioProfile.append(option);
  }
  const audioDescriptions: Record<CompatibilityAudioProfile, string> = {
    stereo_low: t("Miksuje źródło do 2 kanałów AAC 128 kb/s. Najmniejszy transfer, niższa jakość."),
    stereo_standard: t("Miksuje źródło do 2 kanałów AAC 192 kb/s. To ten sam domyślny profil, którego aplikacja używała wcześniej."),
    stereo_high: t("Miksuje źródło do 2 kanałów AAC 320 kb/s. Większy transfer, lepsza jakość."),
    surround_aac: t("Próbuje zachować liczbę i układ kanałów źródła (np. 5.1→5.1) w AAC do 512 kb/s. Nie tworzy sztucznych kanałów; przeglądarka lub urządzenie może wykonać własny downmix albo odmówić odtwarzania.")
  };
  const audioNote = el("p", { className: "admin-audio-profile-note" });
  const syncAudioNote = (): void => {
    audioNote.textContent = audioDescriptions[audioProfile.value as CompatibilityAudioProfile];
  };
  audioProfile.addEventListener("change", syncAudioNote);
  syncAudioNote();
  audioProfile.id = "compatibility-audio-profile";
  const audioField = el(
    "div",
    { className: "field admin-settings__audio-profile" },
    el("label", { className: "field__label", attrs: { for: audioProfile.id }, text: t("Tryb dźwięku filmów") }),
    audioProfile,
    audioNote
  );
  const videoProfile = el("select", { className: "input" });
  const videoProfiles: Array<[CompatibilityVideoProfile, string]> = [
    ["native_copy", t("Natywny obraz — HEVC/H.264/AV1/VP9 bez kodowania")],
    ["h264_fallback", t("H.264 — awaryjna zgodność przeglądarki")]
  ];
  for (const [value, label] of videoProfiles) {
    const option = el("option", { text: label, attrs: { value } });
    option.selected = value === settings.compatibility_video_profile;
    videoProfile.append(option);
  }
  const videoDescriptions: Record<CompatibilityVideoProfile, string> = {
    native_copy: t("HEVC, H.264, AV1 i VP9 są kopiowane bez kodowania obrazu do strumienia MP4; kodowany jest tylko wybrany dźwięk AAC. To tryb domyślny bez obciążania kodera GPU."),
    h264_fallback: t("Używa sprzętowego H.264 wyłącznie jako awaryjnej zgodności, gdy konkretna przeglądarka nie potrafi zdekodować natywnego kodeka obrazu.")
  };
  const videoNote = el("p", { className: "admin-audio-profile-note" });
  const syncVideoNote = (): void => { videoNote.textContent = videoDescriptions[videoProfile.value as CompatibilityVideoProfile]; };
  videoProfile.addEventListener("change", syncVideoNote);
  syncVideoNote();
  videoProfile.id = "compatibility-video-profile";
  const videoField = el("div", { className: "field admin-settings__audio-profile" },
    el("label", { className: "field__label", attrs: { for: videoProfile.id }, text: t("Jakość zgodnego obrazu filmów") }),
    videoProfile,
    videoNote
  );
  const visualizerOrder = orderedVisualizerPlugins(settings.visualizer_order).map((plugin) => plugin.id);
  const visualizerEnabled = new Set(settings.visualizer_enabled);
  const visualizerList = el("div", { className: "admin-visualizers" });
  let draggingVisualizer = "";
  const renderVisualizerOrder = (): void => {
    const plugins = orderedVisualizerPlugins(visualizerOrder);
    visualizerList.replaceChildren(...plugins.map((plugin, index) => {
      const preview = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("visualizer"), t("Podgląd"));
      const enabled = el("input", { attrs: { type: "checkbox", ...(visualizerEnabled.has(plugin.id) ? { checked: true } : {}) } });
      enabled.addEventListener("change", () => {
        if (enabled.checked) visualizerEnabled.add(plugin.id);
        else visualizerEnabled.delete(plugin.id);
      });
      preview.addEventListener("click", () => previewVisualizer(plugin.id));
      const drag = el("button", {
        className: "admin-visualizer__drag",
        attrs: { type: "button", draggable: "true", "aria-label": t("Przeciągnij {name}; strzałki góra i dół zmieniają pozycję", { name: plugin.label }) }
      }, icon("grip"));
      return el("div", { className: "admin-visualizer", dataset: { visualizerId: plugin.id } },
        drag,
        el("span", { className: "admin-visualizer__position", text: String(index + 1) }),
        el("strong", { text: plugin.label }),
        el("label", { className: "toggle-field admin-visualizer__enabled" }, enabled, el("span", { text: t("Włączona") })),
        el("div", { className: "admin-visualizer__actions" }, preview)
      );
    }));
    visualizerList.querySelectorAll<HTMLElement>(".admin-visualizer").forEach((card, index) => {
      const plugin = plugins[index];
      if (!plugin) return;
      const drag = card.querySelector<HTMLButtonElement>(".admin-visualizer__drag");
      drag?.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const target = Math.max(0, Math.min(visualizerOrder.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
        if (target === index) return;
        [visualizerOrder[index], visualizerOrder[target]] = [visualizerOrder[target]!, visualizerOrder[index]!];
        renderVisualizerOrder();
        visualizerList.querySelectorAll<HTMLButtonElement>(".admin-visualizer__drag")[target]?.focus();
      });
      drag?.addEventListener("dragstart", (event) => {
        draggingVisualizer = plugin.id;
        visualizerList.classList.add("is-reordering");
        card.classList.add("is-dragging");
        event.dataTransfer?.setData("text/plain", plugin.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      drag?.addEventListener("dragend", () => {
        draggingVisualizer = "";
        visualizerList.classList.remove("is-reordering");
        visualizerList.querySelectorAll(".is-dragging, .is-drop-before, .is-drop-after").forEach((node) =>
          node.classList.remove("is-dragging", "is-drop-before", "is-drop-after"));
      });
      card.addEventListener("dragover", (event) => {
        if (!draggingVisualizer || draggingVisualizer === plugin.id) return;
        event.preventDefault();
        const after = event.clientY >= card.getBoundingClientRect().top + card.offsetHeight / 2;
        card.classList.toggle("is-drop-before", !after);
        card.classList.toggle("is-drop-after", after);
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      });
      card.addEventListener("dragleave", (event) => {
        if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
        card.classList.remove("is-drop-before", "is-drop-after");
      });
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        visualizerList.classList.remove("is-reordering");
        const source = draggingVisualizer || event.dataTransfer?.getData("text/plain") || "";
        const sourceIndex = visualizerOrder.indexOf(source);
        if (sourceIndex < 0 || source === plugin.id) return;
        const after = card.classList.contains("is-drop-after");
        const [moved] = visualizerOrder.splice(sourceIndex, 1);
        let targetIndex = visualizerOrder.indexOf(plugin.id);
        if (after) targetIndex += 1;
        visualizerOrder.splice(targetIndex, 0, moved!);
        renderVisualizerOrder();
      });
    });
  };
  renderVisualizerOrder();
  // Rights of the built-in user/guest groups are edited in the "Grupy" section
  // only; the matrix that used to sit here duplicated it.
  const status = el("span", { className: "form-status sr-only", attrs: { role: "status", "aria-live": "polite" } });
  const form = el(
    "form",
    { className: "admin-settings" },
    el("div", { className: "admin-settings__defaults" },
      field(t("Domyślne sortowanie muzyki"), musicSort),
      field(t("Domyślne sortowanie filmów"), moviesSort),
      field(t("Pozycji na stronę konta"), pageSize),
      field(t("Próg zaliczenia odtworzenia (%)"), playbackThreshold),
      audioField,
      videoField,
      el("section", { className: "admin-settings__visualizers" },
        el("div", { className: "section-heading" },
          el("div", {}, el("span", { className: "eyebrow", text: t("Odtwarzacz") }), el("h3", { text: t("Kolejność wizualizacji") })),
          el("p", { text: t("Ułóż listę, włącz wybrane efekty i uruchom podgląd bez opuszczania panelu.") })
        ),
        visualizerList
      )
    ),
    el("div", { className: "admin-settings__actions" },
      el("button", { className: "button button--primary", attrs: { type: "submit" }, dataset: { tooltip: "Zapisz ustawienia" } }, icon("check"), t("Zapisz ustawienia")),
      status
    )
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button) { button.disabled = true; button.dataset.tooltip = t("Zapisywanie ustawień…"); }
    void saveAdminSettings({
      ...settings,
      music_sort: musicSort.value as LibrarySort,
      movies_sort: moviesSort.value as LibrarySort,
      account_page_size: Math.max(10, Math.min(100, Number(pageSize.value) || 20)),
      compatibility_audio_profile: audioProfile.value as CompatibilityAudioProfile,
      compatibility_video_profile: videoProfile.value as CompatibilityVideoProfile,
      playback_threshold_percent: Math.max(1, Math.min(100, Number(playbackThreshold.value) || 15)),
      visualizer_order: [...visualizerOrder],
      visualizer_enabled: visualizerOrder.filter((id) => visualizerEnabled.has(id))
    }).then(() => {
      settings.compatibility_audio_profile = audioProfile.value as CompatibilityAudioProfile;
      settings.compatibility_video_profile = videoProfile.value as CompatibilityVideoProfile;
      settings.playback_threshold_percent = Math.max(1, Math.min(100, Number(playbackThreshold.value) || 15));
      settings.visualizer_order = [...visualizerOrder];
      settings.visualizer_enabled = visualizerOrder.filter((id) => visualizerEnabled.has(id));
      status.textContent = t("Ustawienia zapisane.");
      if (button) button.dataset.tooltip = "Ustawienia zapisane";
    })
      .catch(() => {
        status.textContent = t("Nie udało się zapisać ustawień.");
        if (button) button.dataset.tooltip = t("Nie udało się zapisać ustawień");
      })
      .finally(() => {
        if (!button) return;
        button.disabled = false;
        window.setTimeout(() => { button.dataset.tooltip = "Zapisz ustawienia"; }, 2200);
      });
  });
  return form;
}

/**
 * Sign-up rules and the anti-bot challenge.
 *
 * Saving posts the whole settings object because the server validates the core
 * fields on every write; the fields this form owns are merged over the values
 * that were loaded, so nothing outside this screen is disturbed.
 */
function securityForm(settings: AdminSettings): HTMLElement {
  const status = el("p", { className: "muted", attrs: { role: "status" } });
  const registration = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  registration.checked = settings.registration_enabled;
  const activation = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  activation.checked = settings.registration_requires_activation;
  const defaultRole = roleSelect(settings.registration_default_role, true);

  const provider = el("select", { className: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["none", t("Wyłączona")], ["recaptcha", "Google reCAPTCHA"],
    ["hcaptcha", "hCaptcha"], ["turnstile", "Cloudflare Turnstile"]
  ] as const) {
    const option = el("option", { attrs: { value }, text: label }) as HTMLOptionElement;
    option.selected = settings.captcha_provider === value;
    provider.append(option);
  }
  const siteKey = el("input", {
    className: "input",
    attrs: { type: "text", maxlength: 191, placeholder: t("Klucz publiczny (site key)"), value: settings.captcha_site_key }
  }) as HTMLInputElement;
  const secret = el("input", {
    className: "input",
    attrs: {
      type: "password", maxlength: 191, autocomplete: "new-password",
      placeholder: settings.captcha_secret_configured ? t("Zapisany — wpisz, aby zmienić") : "Klucz prywatny (secret)"
    }
  }) as HTMLInputElement;
  const protectLogin = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  protectLogin.checked = settings.captcha_protect_login;
  const protectRegister = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  protectRegister.checked = settings.captcha_protect_registration;
  const downloadLimit = el("input", {
    className: "input",
    attrs: { type: "number", min: 0, max: 10000, value: String(settings.download_rate_limit) }
  }) as HTMLInputElement;
  const downloadWindow = el("input", {
    className: "input",
    attrs: { type: "number", min: 1, max: 10080, value: String(settings.download_rate_window_minutes) }
  }) as HTMLInputElement;
  const dockCollapseDesktop = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  dockCollapseDesktop.checked = settings.dock_collapse_desktop === true;
  const guestLinks = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  guestLinks.checked = settings.guest_links_enabled === true;

  const hint = el("p", { className: "muted" });
  const paintHint = (): void => {
    if (provider.value === "none") {
      hint.textContent = t("Formularze logowania i rejestracji działają bez dodatkowego wyzwania.");
      return;
    }
    const ready = siteKey.value.trim() !== "" && (settings.captcha_secret_configured || secret.value !== "");
    hint.textContent = ready
      ? "Wyzwanie jest aktywne dla zaznaczonych formularzy."
      : t("Uzupełnij oba klucze — bez nich ochrona pozostaje nieaktywna, żeby nie zablokować logowania.");
  };
  provider.addEventListener("change", paintHint);
  siteKey.addEventListener("input", paintHint);
  secret.addEventListener("input", paintHint);
  paintHint();

  const form = el("form", { className: "admin-settings" },
    el("div", { className: "admin-settings__grid" },
      el("label", { className: "toggle-field" }, registration, el("span", { text: t("Rejestracja otwarta") })),
      el("label", { className: "toggle-field" }, activation, el("span", { text: t("Wymagaj potwierdzenia adresu e-mail") })),
      field(t("Rola nowych kont"), defaultRole)
    ),
    el("div", { className: "section-heading" },
      el("h3", { text: t("Ochrona antybotowa") }),
      el("p", { className: "muted", text: t("Klucz prywatny jest zapisywany, ale nigdy nie jest odsyłany do przeglądarki.") })
    ),
    el("div", { className: "admin-settings__grid" },
      field(t("Dostawca"), provider),
      field(t("Klucz publiczny"), siteKey),
      field(t("Klucz prywatny"), secret),
      el("label", { className: "toggle-field" }, protectLogin, el("span", { text: t("Chroń logowanie") })),
      el("label", { className: "toggle-field" }, protectRegister, el("span", { text: t("Chroń rejestrację") }))
    ),
    hint,
    el("div", { className: "section-heading" },
      el("h3", { text: t("Limity pobierania") }),
      el("p", { className: "muted", text: t("Globalny limit liczy pobrania plików i archiwów w kroczącym oknie czasu i dotyczy każdego zwykłego konta; grupa uprawnień może dodać własny limit z innym oknem oraz ograniczyć liczbę równoczesnych pobrań. Administratorów limity nie obejmują.") })
    ),
    el("div", { className: "admin-settings__grid" },
      field(t("Pobrań w oknie (0 = bez limitu)"), downloadLimit),
      field(t("Okno czasu (minuty)"), downloadWindow)
    ),
    el("div", { className: "section-heading" },
      el("h3", { text: t("Udostępnianie na zewnątrz") }),
      el("p", { className: "muted", text: t("Link gościnny otwiera jeden folder albo jedną playlistę osobie bez konta. Wyłączone unieważnia też linki już wydane, a przycisk znika z kart.") })
    ),
    el("div", { className: "admin-settings__grid" },
      el("label", { className: "toggle-field" }, guestLinks, el("span", { text: t("Zezwól na linki gościnne") }))
    ),
    el("div", { className: "section-heading" },
      el("h3", { text: t("Odtwarzacz") }),
      el("p", { className: "muted", text: t("Na telefonie odtwarzacz zawsze można zwinąć do jednej linii; na dużym ekranie ta możliwość jest domyślnie wyłączona.") })
    ),
    el("div", { className: "admin-settings__grid" },
      el("label", { className: "toggle-field" }, dockCollapseDesktop, el("span", { text: t("Pozwól zwijać odtwarzacz także na komputerze") }))
    ),
    el("div", { className: "admin-settings__actions" },
      el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zapisz")),
      status
    )
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button) button.disabled = true;
    status.textContent = t("Zapisywanie…");
    const patch: Record<string, unknown> = {
      registration_enabled: registration.checked,
      registration_requires_activation: activation.checked,
      registration_default_role: defaultRole.value,
      captcha_provider: provider.value,
      captcha_site_key: siteKey.value.trim(),
      captcha_protect_login: protectLogin.checked,
      captcha_protect_registration: protectRegister.checked,
      download_rate_limit: Math.max(0, Math.min(10000, Number(downloadLimit.value) || 0)),
      download_rate_window_minutes: Math.max(1, Math.min(10080, Number(downloadWindow.value) || 60)),
      dock_collapse_desktop: dockCollapseDesktop.checked,
      guest_links_enabled: guestLinks.checked
    };
    // Omitted entirely when untouched, so an admin can save without retyping a
    // secret the panel is not allowed to show them.
    if (secret.value !== "") patch.captcha_secret_key = secret.value;

    void saveAdminSettings({ ...settings, ...patch } as unknown as AdminSettings)
      .then((updated) => {
        Object.assign(settings, updated);
        secret.value = "";
        settings.captcha_secret_configured = updated.captcha_secret_configured;
        secret.placeholder = updated.captcha_secret_configured
          ? t("Zapisany — wpisz, aby zmienić")
          : "Klucz prywatny (secret)";
        status.textContent = t("Ustawienia zapisane.");
        paintHint();
      })
      .catch(() => { status.textContent = t("Nie udało się zapisać ustawień."); })
      .finally(() => { if (button) button.disabled = false; });
  });
  return form;
}

/**
 * Rights, grouped the way an operator thinks about them (labels mirror
 * PermissionGroups::FLAGS). A function for the same reason as activityLabels().
 */
function groupFlagSections(): Array<[string, Array<[keyof RolePermissions, string]>]> {
  return [
  [t("Biblioteki"), [
    ["can_access_music", t("Dostęp do muzyki")],
    ["can_access_movies", t("Dostęp do filmów")],
    ["can_stream_compat", t("Tryb zgodny wideo (transkodowanie FFmpeg)")]
  ]],
  [t("Pobieranie"), [
    ["can_download_file", t("Pojedyncze pliki")],
    ["can_download_selection", t("Zaznaczone pliki i wyniki wyszukiwania")],
    ["can_download_folder", t("Cały folder lub playlista")],
    ["can_download_library", t("Cała biblioteka (korzeń)")]
  ]],
  [t("Działania"), [
    ["can_rate", t("Ocenianie")],
    ["can_favorite", t("Ulubione")],
    ["can_edit_metadata", t("Edycja tagów i okładek")]
  ]],
  [t("Społeczność"), [
    ["can_create_collections", t("Tworzenie kolekcji")],
    ["can_browse_collections", t("Przeglądanie kolekcji innych")],
    ["can_browse_profiles", t("Przeglądanie profili")],
    ["can_share", t("Udostępnianie linków")]
  ]]
  ];
}

function numberInput(value: number, min: number, max: number): HTMLInputElement {
  return el("input", { className: "input", attrs: { type: "number", min, max, value: String(value) } }) as HTMLInputElement;
}

/** One editable group card: rights, limits and removal. */
function groupCard(group: PermissionGroup, all: PermissionGroup[], apply: (groups: PermissionGroup[]) => void): HTMLElement {
  const status = el("span", { className: "admin-user__message", attrs: { role: "status" } });
  const name = el("input", { className: "input", attrs: { type: "text", maxlength: 64, value: group.name } }) as HTMLInputElement;
  const description = el("input", {
    className: "input",
    attrs: { type: "text", maxlength: 255, value: group.description, placeholder: t("Do czego służy ta grupa") }
  }) as HTMLInputElement;
  const streams = numberInput(group.max_concurrent_streams, 0, 10000);
  const downloads = numberInput(group.download_limit, 0, 10000);
  const downloadWindow = numberInput(group.download_window_minutes || 60, 1, 10080);
  const concurrentDownloads = numberInput(group.max_concurrent_downloads, 0, 10000);
  // Empty means no restriction; the server normalises whatever is typed here
  // ("MP3, .flac; mkv") into a sorted, comma-separated list.
  const extensions = el("input", {
    className: "input",
    attrs: { type: "text", maxlength: 255, value: group.download_extensions ?? "", placeholder: t("np. mp3, flac, mkv — puste = bez ograniczeń") }
  }) as HTMLInputElement;

  const checks = new Map<keyof RolePermissions, HTMLInputElement>();
  const flagGroups = groupFlagSections().map(([title, flags]) => el(
    "fieldset",
    { className: "admin-group__flag-set" },
    el("legend", { text: title }),
    ...flags.map(([key, label]) => {
      const input = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
      input.checked = group[key];
      checks.set(key, input);
      return el("label", { className: "toggle-field" }, input, el("span", { text: label }));
    })
  ));

  const save = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("check"), t("Zapisz"));
  save.addEventListener("click", () => {
    save.disabled = true;
    status.className = "admin-user__message";
    status.textContent = t("Zapisywanie…");
    const payload: Partial<PermissionGroup> = {
      id: group.id,
      name: name.value.trim(),
      description: description.value.trim(),
      max_concurrent_streams: Number(streams.value) || 0,
      download_limit: Number(downloads.value) || 0,
      download_window_minutes: Math.max(1, Math.min(10080, Number(downloadWindow.value) || 60)),
      max_concurrent_downloads: Number(concurrentDownloads.value) || 0,
      download_extensions: extensions.value
    };
    for (const [key, input] of checks) payload[key] = input.checked;
    void savePermissionGroup(payload)
      // Editing a group does not change the list, so the cards are left in
      // place; re-rendering here would wipe the confirmation the moment it
      // appears. Only the header, which mirrors the name, is refreshed.
      .then((groups) => {
        status.className = "admin-user__message is-success";
        status.textContent = t("Zapisano");
        const heading = card.querySelector("header strong");
        if (heading) heading.textContent = payload.name ?? group.name;
        const latest = groups.find((entry) => entry.id === group.id);
        if (latest) Object.assign(group, latest);
      })
      .catch((error: unknown) => {
        status.className = "admin-user__message is-error";
        status.textContent = error instanceof Error && error.message ? error.message : t("Błąd zapisu");
      })
      .finally(() => { save.disabled = false; });
  });

  const footer = el("footer", { className: "admin-user__footer" }, status, save);
  if (!group.is_system) {
    // Members must land somewhere, so removal always names a destination.
    const target = el("select", { className: "input input--compact", attrs: { "aria-label": t("Przenieś członków do") } }) as HTMLSelectElement;
    for (const candidate of all.filter((entry) => entry.id !== group.id)) {
      target.append(el("option", { attrs: { value: String(candidate.id) }, text: candidate.name }));
    }
    const remove = el("button", { className: "button button--danger", attrs: { type: "button" } }, icon("close"), t("Usuń"));
    remove.addEventListener("click", () => {
      if (!window.confirm(t("Usunąć grupę „{name}”? {members} kont trafi do wybranej grupy.", { name: group.name, members: group.members }))) return;
      remove.disabled = true;
      void deletePermissionGroup(group.id, Number(target.value) || null)
        .then(apply)
        .catch(() => { status.className = "admin-user__message is-error"; status.textContent = t("Nie udało się usunąć"); })
        .finally(() => { remove.disabled = false; });
    });
    footer.prepend(el("div", { className: "admin-group__remove" }, target, remove));
  }

  const card = el("article", { className: "admin-user admin-group" },
    el("header", { className: "admin-user__identity" },
      el("span", { className: "user-chip__avatar", text: group.name.slice(0, 1).toUpperCase() }),
      el("div", {}, el("strong", { text: group.name }), el("small", { text: `${group.slug} · ${group.members} kont` })),
      group.is_system
        ? el("span", { className: "status-pill status-pill--muted", text: t("Systemowa") })
        : el("span", { className: "status-pill status-pill--success", text: t("Własna") })
    ),
    el("div", { className: "admin-user__controls" },
      field(t("Nazwa"), name),
      field(t("Opis"), description),
      el("div", { className: "admin-group__flags" }, ...flagGroups),
      el("div", { className: "admin-group__limits" },
        field(t("Równoczesne strumienie trybu zgodnego (0 = bez limitu)"), streams),
        field(t("Pobrań w oknie (0 = bez limitu)"), downloads),
        field(t("Okno limitu pobrań (minuty)"), downloadWindow),
        field(t("Równoczesne pobrania (0 = bez limitu)"), concurrentDownloads)
      ),
      field(t("Dozwolone rozszerzenia plików"), extensions)
    ),
    footer
  );
  return card;
}

function groupsPanel(data: AdminData): HTMLElement {
  const host = el("div", { className: "admin-users" });
  const apply = (groups: PermissionGroup[]): void => {
    data.groups = groups;
    host.replaceChildren(...groups.map((group) => groupCard(group, groups, apply)));
  };
  apply(data.groups ?? []);

  const name = el("input", { className: "input", attrs: { type: "text", maxlength: 64, required: true, placeholder: t("np. Rodzina") } }) as HTMLInputElement;
  const status = el("span", { className: "admin-user__message", attrs: { role: "status" } });
  const create = el("form", { className: "admin-create" },
    field(t("Nazwa nowej grupy"), name),
    el("div", { className: "admin-create__actions" },
      el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("user"), t("Dodaj grupę")),
      status
    )
  );
  create.addEventListener("submit", (event) => {
    event.preventDefault();
    if (name.value.trim() === "") return;
    const button = create.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button) button.disabled = true;
    status.className = "admin-user__message";
    status.textContent = t("Tworzenie…");
    // A new group starts with nothing granted; rights are added deliberately.
    void savePermissionGroup({ name: name.value.trim(), description: "" })
      // No full refresh: the response already carries the new list, and
      // rebuilding the panel would detach any card being edited.
      .then((groups) => { name.value = ""; status.textContent = t("Grupa utworzona."); apply(groups); })
      .catch(() => { status.className = "admin-user__message is-error"; status.textContent = t("Nie udało się utworzyć grupy."); })
      .finally(() => { if (button) button.disabled = false; });
  });

  return el("div", { className: "stack" }, create, host);
}

export async function mount(): Promise<void> {
  const shell = await mountShell("admin", t("Administracja"), t("Użytkownicy, katalog i diagnostyka"));
  if (!isAdministrator(shell.session)) {
    shell.content.append(el("div", { className: "notice notice--error", text: t("Brak uprawnień administratora.") }));
    return;
  }
  const metricsHost = el("div");
  const catalogHost = el("div", { className: "stack" });
  const catalogScanHost = el("div", { className: "stack" });
  const metadataQueueHost = el("div", { className: "stack" });
  const titleWorkerHost = el("div", { className: "stack" });
  const activityHost = el("div", { className: "stack" });
  const lookupsHost = el("div", { className: "stack" });
  const usersHost = el("div", { className: "admin-users" });
  const scansHost = el("div", { className: "table-wrap" });
  const settingsHost = el("div");
  const securityHost = el("div");
  const groupsHost = el("div");
  const subtitleHost = el("div");
  const statsHost = el("div", { className: "stack" });
  const notice = el("div", { className: "hidden", attrs: { role: "status" } });

  /**
   * Rebuild one section from fresh data.
   *
   * Rebuilding every section on every save was what wiped a confirmation the
   * moment it appeared and reset forms the operator was still filling in, so a
   * refresh now touches only what it has to: the section that changed (and the
   * overview metrics, which summarise all of them).
   */
  const painters: Record<string, (data: AdminData) => void> = {
    overview: (data) => {
      const pendingCount = data.users.filter((user) => user.email_verified_at === null && Boolean(user.email)).length;
      metricsHost.replaceChildren(el("section", { className: "admin-metrics" },
        metric("user", data.users.length, "kont"),
        metric("check", data.users.filter((user) => Boolean(Number(user.is_active))).length, "aktywnych"),
        metric("history", pendingCount, t("oczekujących")),
        metric("admin", data.users.filter((user) => user.role !== "user").length, t("administratorów")),
        metric("server", data.catalog.reduce((sum, row) => sum + Number(row.items), 0), "pozycji")
      ));
      catalogHost.replaceChildren(
        sectionHeading(t("Biblioteka"), t("Stan katalogu"), t("Jedna wspólna baza i ostatni zakończony stan indeksowania.")),
        catalogCards(data, () => refresh("overview"), false)
      );
    },
    accounts: (data) => {
      // Accounts still waiting for activation come first, so the queue an
      // operator acts on is never buried under the alphabet.
      const orderedUsers = [...data.users].sort((a, b) => {
        const aPending = a.email_verified_at === null && Boolean(a.email) ? 0 : 1;
        const bPending = b.email_verified_at === null && Boolean(b.email) ? 0 : 1;
        return aPending - bPending || a.username.localeCompare(b.username, "pl");
      });
      usersHost.replaceChildren(...orderedUsers.map((user) =>
        userCard(user, shell.session.user.id, shell.session.user.role === "super_admin", data.groups ?? [], () => refresh("accounts"))
      ));
      const previousChoice = createGroup ? Number(createGroup.value) : null;
      createGroup = groupSelect(data.groups ?? [], previousChoice, t("Grupa uprawnień nowego konta"));
      createGroupHost.replaceChildren(createGroup);
    },
    security: (data) => securityHost.replaceChildren(securityForm(data.settings)),
    groups: (data) => groupsHost.replaceChildren(groupsPanel(data)),
    library: (data) => settingsHost.replaceChildren(settingsForm(data.settings, (id) => void shell.player.previewVisualizer(id))),
    scans: (data) => {
      catalogScanHost.replaceChildren(catalogCards(data, () => refresh("scans"), true));
      metadataQueueHost.replaceChildren(metadataQueuePanel(data, () => refresh("scans")));
      titleWorkerHost.replaceChildren(titleWorkerPanel());
      subtitleHost.replaceChildren(subtitleCachePanel(data));
      scansHost.replaceChildren(scanTable(data));
    },
    activity: (data) => activityHost.replaceChildren(activityPanel(data)),
    // Reads its own series from the service; the account data a refresh carries
    // has nothing to say about it.
    stats: () => statsHost.replaceChildren(statsPanel()),
    // The panel fetches its own pages, so a refresh only has to rebuild it.
    genres: () => lookupsHost.replaceChildren(titleLookupsPanel())
  };

  const refresh = async (section?: string): Promise<void> => {
    const data = await getAdmin();
    const targets = section === undefined ? Object.keys(painters) : [section, "overview"];
    for (const key of new Set(targets)) painters[key]?.(data);
  };

  /**
   * Keep the background section honest while somebody is looking at it.
   *
   * A scan, a metadata batch and a genre run all take minutes, and a panel that
   * only tells the truth when a button is pressed is a panel that is usually
   * wrong. This re-reads every few seconds and repaints in place; it stops the
   * moment the section is left, so no other screen pays for it.
   *
   * Deliberately not faster: the answer is a database query over the whole
   * catalogue, and nothing here changes meaningfully inside four seconds.
   */
  let liveTimer = 0;
  const stopLive = (): void => { window.clearInterval(liveTimer); liveTimer = 0; };
  const startLive = (section: string): void => {
    stopLive();
    if (section !== "scans") return;
    liveTimer = window.setInterval(() => {
      // A tab in the background gets nothing: the browser throttles the timer
      // anyway, and a hidden page has nobody to tell.
      if (document.hidden || active !== "scans") return;
      void refresh("scans").catch(() => undefined);
    }, 4000);
  };
  document.addEventListener("media:route-will-change", stopLive, { once: true });

  const username = el("input", { className: "input", attrs: { type: "text", minlength: "3", maxlength: "191", required: true, placeholder: t("Nazwa konta") } });
  const password = el("input", { className: "input", attrs: { type: "password", minlength: "12", required: true, placeholder: t("Minimum 12 znaków"), autocomplete: "new-password" } });
  const passwordConfirm = el("input", { className: "input", attrs: { type: "password", minlength: "12", required: true, placeholder: t("Powtórz hasło"), autocomplete: "new-password" } });
  const role = roleSelect("user", shell.session.user.role === "super_admin");
  // Filled with the real groups on the first refresh; the group (not a guest
  // checkbox) decides what the new account may do.
  const createGroupHost = el("span");
  let createGroup: HTMLSelectElement | null = null;
  const createForm = el("form", { className: "admin-create" },
    field(t("Nazwa użytkownika"), username), field(t("Hasło"), password), field(t("Powtórz hasło"), passwordConfirm), field(t("Rola"), role),
    field(t("Grupa uprawnień"), createGroupHost),
    el("div", { className: "admin-create__actions" }, el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("user"), t("Utwórz konto")))
  );
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    passwordConfirm.setCustomValidity("");
    if (password.value !== passwordConfirm.value) {
      passwordConfirm.setCustomValidity(t("Hasła nie są identyczne."));
      passwordConfirm.reportValidity();
      return;
    }
    const submit = createForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    void createUser({
      username: username.value,
      password: password.value,
      password_confirm: passwordConfirm.value,
      role: role.value as UserRole,
      permission_group_id: Number(createGroup?.value ?? 0)
    })
      .then(async () => {
        createForm.reset();
        notice.className = "notice";
        notice.textContent = t("Konto zostało utworzone.");
        await refresh("accounts");
      })
      .catch((error: unknown) => {
        notice.className = "notice notice--error";
        notice.textContent = error instanceof Error && error.message
          ? t("Nie udało się utworzyć konta: {reason}", { reason: error.message })
          : t("Nie udało się utworzyć konta. Sprawdź dane i uprawnienia.");
      })
      .finally(() => { if (submit) submit.disabled = false; });
  });

  // One long page hid everything below the fold, so the panel is split into
  // categories and only the open one is built. Each category is rendered from a
  // fresh fetch the first time it is opened, and again on demand.
  const sections: Array<{ id: string; label: string; glyph: IconName; body: HTMLElement }> = [
    { id: "overview", label: t("Przegląd"), glyph: "server", body: el("div", { className: "stack" }, metricsHost, el("section", { className: "panel admin-section" }, catalogHost)) },
    {
      id: "accounts", label: t("Konta"), glyph: "user", body: el("div", { className: "stack" },
        el("section", { className: "panel admin-section" },
          sectionHeading(t("Dostęp"), t("Nowe konto"), t("Hasło jest hashowane po stronie serwera, a działania administratora są audytowane.")),
          createForm, notice),
        el("section", { className: "panel admin-section admin-section--users" },
          sectionHeading(t("Uprawnienia"), t("Użytkownicy"), t("Rola, grupa uprawnień (konto gościa to członkostwo w grupie „Goście”), status konta i bezpieczna zmiana hasła.")),
          usersHost))
    },
    {
      id: "security", label: t("Bezpieczeństwo"), glyph: "admin", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Rejestracja"), t("Konta i ochrona antybotowa"), t("Kto może założyć konto, czy musi potwierdzić adres i jakie wyzwanie chroni formularze.")),
        securityHost)
    },
    {
      id: "groups", label: t("Grupy"), glyph: "list", body: el("section", { className: "panel admin-section admin-section--users" },
        sectionHeading(t("Uprawnienia"), t("Grupy uprawnień"), t("Twórz własne grupy z własnym zestawem praw i limitów, a potem przypisuj do nich konta.")),
        groupsHost)
    },
    {
      id: "library", label: t("Biblioteka"), glyph: "music", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Konfiguracja"), t("Ustawienia biblioteki i odtwarzacza"), t("Domyślne sortowanie, profile trybu zgodnego, próg odtworzenia i wizualizacje. Prawa kont ustawiasz w sekcji Grupy.")),
        settingsHost)
    },
    {
      // Everything that works in the background lives here, in the order it runs:
      // find the files, read them, name them, prepare their subtitles. Each panel
      // updates itself while this section is open — no button asks to be pressed
      // twice to find out what happened.
      id: "scans", label: t("Indeksowanie"), glyph: "history", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Indeksowanie"), t("Wszystko, co dzieje się w tle"), t("Skan katalogu, odczyt metadanych, gatunki filmów i cache napisów. Panele odświeżają się same, dopóki ta sekcja jest otwarta.")),
        catalogScanHost,
        metadataQueueHost,
        titleWorkerHost,
        subtitleHost,
        scansHost)
    },
    {
      id: "genres", label: t("Gatunki"), glyph: "film", body: el("section", { className: "panel admin-section" },
        sectionHeading(
          t("Gatunki"),
          t("Niepewne dopasowania"),
          t("Gatunek i rok pobierane są automatycznie tylko wtedy, gdy tytuł, rok i czas trwania się zgadzają. Reszta czeka tutaj — potwierdź jedną z propozycji, ustaw ręcznie albo pomiń.")
        ),
        lookupsHost)
    },
    {
      id: "stats", label: t("Statystyki"), glyph: "server", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Serwer"), t("Ruch, transfery i cache"), t("Z dziennika usługi transferowej: jedna próbka na minutę, trzymana w plikach obok cache, które mierzy.")),
        statsHost)
    },
    {
      id: "activity", label: t("Aktywność"), glyph: "history", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Aktywność"), t("Dziennik i logowania"), t("Kto był ostatnio i co zmienił — zdarzenia z dziennika audytu z filtrami po rodzaju i koncie.")),
        activityHost)
    }
  ];

  const nav = el("nav", { className: "admin-subnav", attrs: { "aria-label": t("Sekcje administracji") } });
  const stage = el("div", { className: "admin-stage" });
  const loaded = new Set<string>();
  let active = "";

  const open = async (id: string): Promise<void> => {
    const section = sections.find((entry) => entry.id === id) ?? sections[0]!;
    active = section.id;
    for (const button of Array.from(nav.querySelectorAll("button"))) {
      const selected = button.dataset.section === active;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
    }
    if (window.location.hash.slice(1) !== active) {
      window.history.replaceState(null, "", `#${active}`);
    }
    stage.replaceChildren(section.body);
    startLive(active);
    if (loaded.has(active)) return;
    stage.setAttribute("aria-busy", "true");
    try {
      await refresh(active);
      loaded.add(active);
    } catch {
      stage.replaceChildren(el("div", { className: "notice notice--error", text: t("Nie udało się pobrać danych sekcji.") }));
    } finally {
      stage.removeAttribute("aria-busy");
    }
  };

  for (const section of sections) {
    // The label is hidden on phones (icons only), so the name also lives in aria-label/title.
    const button = el("button", {
      className: "admin-subnav__item",
      attrs: { type: "button", "aria-label": section.label, title: section.label }
    }, icon(section.glyph), el("span", { className: "admin-subnav__label", text: section.label })) as HTMLButtonElement;
    button.dataset.section = section.id;
    button.addEventListener("click", () => void open(section.id));
    nav.append(button);
  }

  const reload = el("button", { className: "button button--secondary", attrs: { type: "button" } },
    icon("history"), t("Odśwież"));
  reload.addEventListener("click", () => {
    loaded.clear();
    void open(active);
  });

  shell.content.append(el("div", { className: "admin-page" },
    el("div", { className: "admin-subnav-bar" }, nav, reload),
    stage
  ));

  const requested = window.location.hash.slice(1);
  await open(sections.some((entry) => entry.id === requested) ? requested : sections[0]!.id);
}

