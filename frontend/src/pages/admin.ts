import {
  activateUser, createUser, decideTitleLookup, deletePermissionGroup, failureText, getActiveSessions, getActivity, getAdmin,
  decideTitleFolder, getDigest, getIndexingStatus, getTitleFolderWorks, getTitleFolders, getTitleLookups, resendUserActivation,
  releaseStepUp, resetUserTwoFactor, revokeSession, saveAdminSettings, savePermissionGroup, sendDigestNow, serverStats, startCatalogScan,
  retryMetadata, startMetadataWorker, startSubtitleCache, startTitleWorker, subtitleCacheStatus, updateUser,
  deleteUser, previewUserDeletion
} from "../shared/api";
import { confirmDialog } from "../shared/confirm";
import { arrive, el } from "../shared/dom";
import { formatBytes, formatCount, formatDateTime } from "../shared/format";
import { applyIconPack, ensureProStylesheet, proIconPack } from "../shared/icon-pack";
import { DEFAULT_ICON_STYLE, ICON_STYLE_IDS, splitIconStyle } from "../shared/icon-styles";
import { icon, type IconName } from "../shared/icons";
import { t, tn } from "../shared/i18n";
import { isAdministrator } from "../shared/permissions";
import { sectionTabs } from "../shared/section-tabs";
import { showToast } from "../shared/toast";
import { mountShell } from "../shared/shell";
import { orderedVisualizerPlugins } from "../shared/visualizations/registry";
import type {
  ActivityEntry, AdminData, AdminMetadataFailure, AdminSettings, AdminUser, CompatibilityAudioProfile, CompatibilityVideoProfile, KeyedCaptchaProvider,
  StepUpContext, StepUpSubject,
  LibrarySort, PermissionGroup, RolePermissions, SubtitleCacheStatus, TitleLookupCandidate,
  TitleLookupEntry, TitleLookupFolder, TitleLookupPage, UserRole
} from "../shared/types";

function field(label: string, control: HTMLElement): HTMLElement {
  return el("label", { className: "field" }, el("span", { className: "field__label", text: label }), control);
}

function roleLabel(role: UserRole): string {
  return role === "super_admin" ? t("Superadministrator") : role === "admin" ? t("Administrator") : t("Użytkownik");
}

function roleSelect(value: UserRole, enabled: boolean): HTMLSelectElement {
  const select = el("select", { className: "input", attrs: { disabled: !enabled, "aria-label": t("Rola użytkownika") } });
  for (const role of ["user", "admin", "super_admin"] as UserRole[]) {
    select.append(el("option", { text: roleLabel(role), attrs: { value: role, ...(role === value ? { selected: true } : {}) } }));
  }
  return select;
}

/**
 * The matcher explains itself in short English notes (src/media_server/filmweb.py);
 * this says them in the interface's language. An unknown note is shown as it is.
 */
function matcherReason(reason: string): string {
  const fixed: Record<string, string> = {
    "year exact": t("rok zgodny"),
    "year ±1": t("rok ±1"),
    "year unknown on one side": t("rok znany tylko z jednej strony"),
    "runtime matches": t("czas trwania zgodny"),
    "runtime not comparable": t("czasu trwania nie da się porównać"),
    "another part of the series": t("inna część serii"),
    "exact title and year, nothing else close": t("dokładny tytuł i rok, bez rywali"),
    "no plausible candidate": t("brak wiarygodnej propozycji"),
    "nothing found": t("nic nie znaleziono")
  };
  if (fixed[reason]) return fixed[reason]!;
  let match = /^title (\d+)%$/.exec(reason);
  if (match) return t("tytuł zgodny w {percent}%", { percent: match[1]! });
  match = /^year off by (\d+)$/.exec(reason);
  if (match) return tn(Number(match[1]), { one: "rok różni się o {count} rok", few: "rok różni się o {count} lata", many: "rok różni się o {count} lat" });
  match = /^runtime (~?)(\d+) min out$/.exec(reason);
  if (match) return t("czas trwania różni się o {minutes} min", { minutes: `${match[1]}${match[2]}` });
  match = /^wrong kind \((serial|film)\)$/.exec(reason);
  if (match) return match[1] === "serial" ? t("inny rodzaj: serial") : t("inny rodzaj: film");
  match = /^too close to call \((\d+) vs (\d+)\)$/.exec(reason);
  if (match) return t("dwie propozycje zbyt blisko siebie ({first} i {second})", { first: match[1]!, second: match[2]! });
  return reason;
}

function fileCount(count: number): string {
  return tn(count, { one: "{count} plik", few: "{count} pliki", many: "{count} plików" });
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
    el("div", {}, el("strong", { text: formatCount(value) }), el("span", { text: label }))
  );
}

/**
 * Per-source catalog cards. The overview shows them read-only; the indexing
 * section adds the "scan now" launcher (`withScan`), so starting a scan lives next
 * to the scan history instead of on the dashboard.
 */
/**
 * What to call a source of the catalogue.
 *
 * The scanner names a new source after its kind, in English — "Music",
 * "Movies" — and the panel printed that under the slug: "music / Music". That
 * default says nothing the kind does not, so the kind is said instead, in the
 * interface's language; a name somebody actually gave the source is kept as it
 * is.
 */
function sourceName(row: { display_name: string; media_kind: string }): string {
  const given = row.display_name.trim();
  if (given !== "" && !["music", "movies", "mixed", "muzyka", "filmy"].includes(given.toLowerCase())) return given;
  return row.media_kind === "music" ? t("Muzyka") : row.media_kind === "movies" ? t("Filmy") : t("Muzyka i filmy");
}

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
          // The slug stays in sight: it is what the command line and the logs call this source.
          el("div", {}, el("span", { className: "eyebrow", text: t("Źródło „{slug}”", { slug: row.slug }) }), el("h3", { text: sourceName(row) }))
        ),
        row.filesystem_path
          ? el("p", { className: "admin-catalog__path", attrs: { title: row.filesystem_path } }, icon("folder"), el("span", { text: row.filesystem_path }))
          : null,
        el("strong", { text: formatCount(Number(row.items)) }),
        el("p", { text: t("pozycji w katalogu") }),
        el("div", { className: "admin-catalog__details" },
          el("span", {}, icon("music"), `${t("Audio")} `, formatCount(Number(row.audio))),
          el("span", {}, icon("film"), `${t("Wideo")} `, formatCount(Number(row.video))),
          el("span", {}, icon("image"), `${t("Obrazy")} `, formatCount(Number(row.images))),
          el("span", {}, icon("file"), `${t("Inne")} `, formatCount(Number(row.auxiliary)))
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
    }),
    // The owner's decision (12.11.2026): folders are chosen on the server, by the
    // installer ("Foldery z mediami" on Windows, --zmien foldery on Debian), never from
    // here — a borrowed administrator session must not be a way to put a whole disk in the library.
    withScan
      ? el("p", { className: "admin-catalog__note", text: t("Foldery bibliotek zmienia się na komputerze z serwerem, w instalatorze: na Windows uruchom Zainstaluj.cmd i wybierz „Foldery z mediami”, na Debianie sudo bash zainstaluj-debian.sh --zmien foldery. Z panelu nie da się ich zmienić — przejęta sesja administratora nie wystawi w ten sposób całego dysku.") })
      : null
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
  // A disabled account is not waiting for anything: it was switched off.
  const isPending = user.email_verified_at === null && Boolean(user.email) && !user.disabled_at;
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
    }).then((result) => {
      status.className = "admin-user__message is-success";
      status.textContent = t("Zapisano");
      password.value = "";
      passwordConfirm.value = "";
      // The card is updated in place instead of rebuilding the section: a rebuild
      // would replace this very card and wipe the confirmation as it appears.
      user.is_active = result.is_active ?? active.checked;
      if (result.disabled !== undefined) user.disabled_at = result.disabled ? (user.disabled_at ?? "now") : null;
      active.checked = Boolean(Number(user.is_active));
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
  const twoFactorPill = el("span", { className: "status-pill status-pill--success", text: "2FA", attrs: { title: t("Weryfikacja dwuetapowa włączona") } });
  twoFactorPill.classList.toggle("hidden", user.two_factor !== true);
  const repaintPills = (): void => {
    if (isPending) {
      pill.className = "status-pill status-pill--warning";
      pill.textContent = t("Oczekuje na aktywację");
    } else {
      const isActive = Boolean(Number(user.is_active));
      pill.className = "status-pill " + (isActive ? "status-pill--success" : "status-pill--muted");
      pill.textContent = isActive ? t("Aktywne") : t("Wyłączone");
    }
    const group = groups.find((entry) => entry.id === user.permission_group_id);
    const guest = group ? group.slug === GUEST_GROUP_SLUG : Boolean(Number(user.is_guest));
    guestPill.classList.toggle("hidden", !guest);
  };
  repaintPills();
  const footer = el("footer", { className: "admin-user__footer" }, status, save);
  // Deleting takes everything that is the account's own with it — its ratings
  // above all, so that one account's mess leaves the averages with it. The same
  // rules as every other change: not one's own account, and an administrator's
  // only by a super_admin. Counted first, then the name typed.
  if (user.id !== currentId && (user.role === "user" || canPromote)) {
    const remove = el("button", { className: "button button--danger admin-user__delete", attrs: { type: "button" } }, icon("trash"), t("Usuń konto"));
    remove.addEventListener("click", () => {
      remove.disabled = true;
      void previewUserDeletion(user.id)
        .then((footprint) => confirmDialog({
          title: t("Usunąć konto {username}?", { username: user.username }),
          message: t(
            "Znikną konto i wszystko, co do niego należy: oceny ({ratings}), ulubione ({favorites}), playlisty ({collections}) z ich głosami i linkami, głosy na cudze playlisty ({votes}), historia odtwarzania ({history}), linki gościnne ({links}), kolejki i sesje ({sessions}). Średnie ocen przeliczą się od razu; ogólne liczniki odtworzeń zostają. Tego nie da się cofnąć.",
            {
              ratings: footprint.ratings,
              favorites: footprint.favorites,
              collections: footprint.collections,
              votes: footprint.collection_votes,
              history: footprint.history,
              links: footprint.guest_links,
              sessions: footprint.sessions
            }
          ),
          confirmLabel: t("Usuń konto"),
          danger: true,
          typeToConfirm: { label: t("Wpisz nazwę konta, aby potwierdzić"), expected: user.username }
        }))
        .then(async (agreed) => {
          if (!agreed) return;
          status.className = "admin-user__message";
          status.textContent = t("Usuwanie…");
          await deleteUser(user.id, user.username);
          showToast(t("Konto {username} usunięte.", { username: user.username }), "success");
          await refresh();
        })
        .catch((error: unknown) => {
          status.className = "admin-user__message is-error";
          status.textContent = error instanceof Error && error.message ? error.message : t("Nie udało się usunąć");
        })
        .finally(() => { if (remove.isConnected) remove.disabled = false; });
    });
    footer.prepend(remove);
  }
  if (user.two_factor === true) {
    // For an account that lost both its phone and its recovery codes.
    const reset = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("lock"), t("Zresetuj 2FA"));
    reset.addEventListener("click", () => {
      void confirmDialog({
        title: t("Wyłączyć weryfikację dwuetapową?"),
        message: t("Wyłączyć weryfikację dwuetapową konta {username}? Zaloguje się samym hasłem, dopóki nie włączy jej ponownie.", { username: user.username }),
        confirmLabel: t("Zresetuj 2FA"),
        danger: true
      }).then((agreed) => {
        if (!agreed) return;
        reset.disabled = true;
        status.className = "admin-user__message";
        status.textContent = t("Zapisywanie…");
        void resetUserTwoFactor(user.id)
          .then(() => {
            user.two_factor = false;
            twoFactorPill.classList.add("hidden");
            reset.remove();
            status.className = "admin-user__message is-success";
            status.textContent = t("Weryfikacja dwuetapowa wyłączona");
          })
          .catch((error: unknown) => {
            status.className = "admin-user__message is-error";
            status.textContent = error instanceof Error && error.message ? error.message : t("Błąd zapisu");
            reset.disabled = false;
          });
      });
    });
    footer.prepend(reset);
  }
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
    // Blocking is its own button: the "active" box of a pending account is
    // already unticked, so unticking it cannot say "stop this registration".
    const block = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("close"), t("Zablokuj konto"));
    block.addEventListener("click", () => {
      block.disabled = true;
      status.className = "admin-user__message";
      status.textContent = t("Zapisywanie…");
      void updateUser({ user_id: user.id, role: role.value as UserRole, permission_group_id: Number(group.value), disabled: true })
        .then(async () => {
          status.className = "admin-user__message is-success";
          status.textContent = t("Konto zablokowane");
          await refresh();
        })
        .catch((error: unknown) => {
          status.className = "admin-user__message is-error";
          status.textContent = error instanceof Error && error.message ? error.message : t("Błąd zapisu");
          block.disabled = false;
        });
    });
    footer.prepend(el("div", { className: "admin-user__pending-actions" }, activate, resend, block));
  }
  return el(
    "article",
    { className: "admin-user" + (isPending ? " admin-user--pending" : "") },
    el("header", { className: "admin-user__identity" },
      el("span", { className: "user-chip__avatar", text: user.username.slice(0, 1).toUpperCase() }),
      el("div", {}, el("strong", { text: user.username }), el("small", { text: user.email ?? "ID " + user.id })),
      guestPill,
      twoFactorPill,
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
  // The scanner's own words for where a scan stands; an unknown one is shown as it is.
  const states: Record<string, string> = {
    completed: t("zakończony"),
    running: t("w toku"),
    failed: t("błąd"),
    queued: t("w kolejce")
  };
  table.append(el("tbody", {}, ...data.scans.map((scan) => el("tr", {},
    el("td", { text: String(scan.id) }),
    el("td", { text: scan.slug }),
    el("td", {}, el("span", {
      className: "status-pill " + (scan.status === "completed" ? "status-pill--success" : scan.status === "failed" ? "status-pill--warning" : ""),
      text: states[scan.status] ?? scan.status
    })),
    el("td", { text: formatCount(Number(scan.discovered_count)) }),
    el("td", { text: String(scan.error_count) }),
    el("td", { text: scan.finished_at ? formatDateTime(scan.finished_at) : "—" })
  ))));
  return table;
}

function subtitleCachePanel(data: AdminData): HTMLElement {
  const root = el("select", { className: "input" }, el("option", { text: t("Wszystkie źródła filmów"), attrs: { value: "all" } }));
  for (const row of data.catalog.filter((entry) => Number(entry.video) > 0)) {
    root.append(el("option", { text: t("{name} ({count} filmów)", { name: sourceName(row), count: formatCount(Number(row.video)) }), attrs: { value: row.slug } }));
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
  // Assigned below; read by `paint` only after the first status answer arrives.
  let panel: HTMLElement | null = null;
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
    // Only while somebody can see it. A panel that has been taken off the page —
    // the reader left the section or the application — stops asking.
    if (state.state === "running" && (panel === null || panel.isConnected)) {
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
  panel = el(
    "div",
    { className: "admin-subtitle-cache" },
    el("div", { className: "admin-subtitle-cache__fields" }, field(t("Zakres"), root), field(t("Tryb"), mode), field(t("Wybrane ID filmów"), ids)),
    progress,
    status,
    el("div", { className: "admin-subtitle-cache__actions" }, start),
    el("p", { className: "admin-subtitle-cache__hint", text: t("Eksportowana jest wyłącznie każda obsługiwana ścieżka tekstowa, po kolei. Gotowy WebVTT pozostaje w prywatnym cache; przewijanie nie uruchamia ponownego FFmpeg.") })
  );
  void subtitleCacheStatus().then(paint).catch(() => { status.textContent = t("Usługa cache napisów jest niedostępna."); });
  return panel;
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
  "stepup.pause": t("Pauza za zbyt wiele żądań"),
  "stepup.block": t("Blokada za zbyt wiele żądań"),
  "stepup.release": t("Zdjęcie pauzy lub blokady"),
  "user.twofa_enable": t("Włączenie weryfikacji dwuetapowej"),
  "user.twofa_disable": t("Wyłączenie weryfikacji dwuetapowej"),
  "user.twofa_recovery": t("Nowe kody odzyskiwania"),
  "user.twofa_recovery_used": t("Logowanie kodem odzyskiwania"),
  "user.twofa_reset": t("Reset weryfikacji dwuetapowej przez administratora"),
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
          } else if (page.truncated && page.total !== undefined) {
            // The list stops at 500; the genre still lands on every work in the folder.
            workList.prepend(el("p", { className: "muted", text: t("Na liście jest pierwsze {shown} z {total} pozycji.", {
              shown: String(page.works.length), total: String(page.total)
            }) }));
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
        el("span", { className: "admin-lookup__badge", text: `${tn(folder.works, {
          one: "{count} pozycja", few: "{count} pozycje", many: "{count} pozycji"
        })} · ${fileCount(folder.files)}` })
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
        el("span", { className: "admin-lookup__badge", text: `${entry.is_episode ? t("serial") : t("film")} · ${fileCount(entry.item_count)}` })
      ),
      el("p", { className: "admin-lookup__reasons", text: entry.reasons.length > 0
        ? t("Dlaczego niepewne: {reasons}", { reasons: entry.reasons.map(matcherReason).join(", ") })
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
  // Built node by node. It was a template assigned as HTML with the label
  // inside an attribute — safe only for as long as every label stays a constant
  // of this file, which nothing enforced.
  const shape = (name: string, attributes: Record<string, string>): SVGElement => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [attribute, value] of Object.entries(attributes)) node.setAttribute(attribute, value);
    return node;
  };
  const svg = shape("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img", "aria-label": label });
  svg.append(
    shape("polygon", { class: "stats-chart__area", points: `0,${height} ${line} ${width},${height}` }),
    shape("polyline", { class: "stats-chart__line", points: line })
  );
  const figure = el("figure", { className: "stats-chart" });
  figure.append(svg);
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
              el("td", { text: formatCount(entry.files) })
            )))));
      status.textContent = tn(stats.totals.samples, {
        one: "{count} próbka · {bytes} wysłane",
        few: "{count} próbki · {bytes} wysłane",
        many: "{count} próbek · {bytes} wysłane"
      }, { bytes: formatBytes(stats.totals.bytes) }) + (stats.totals.restarts > 0 ? " · " + t("restartów: {count}", { count: String(stats.totals.restarts) }) : "");
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
        t("Zapisanych kont: {count}", { count: formatCount(server.subscribers) }),
        server.last_sent_at
          ? t("ostatni przebieg {when}", { when: formatDateTime(server.last_sent_at) })
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
          sent: formatCount(result.sent),
          empty: formatCount(result.empty)
        }) + ((result.failed ?? 0) > 0
          // Named, not just counted: a mailbox that refuses mail is something the
          // operator can go and fix, and the rest of the run went out regardless.
          ? " · " + t("nie dotarło do: {names}", { names: (result.failed_recipients ?? []).join(", ") })
          : "");
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
          el("td", { text: formatDateTime(session.created_at, "seconds") }),
          el("td", { text: formatDateTime(session.last_seen_at, "seconds") }),
          el("td", {}, session.is_current
            ? el("span", { className: "status-pill status-pill--success", text: t("ta przeglądarka") })
            : close)
        ));
      }
      status.textContent = tn(sessions.length, { one: "{count} otwarta sesja", few: "{count} otwarte sesje", many: "{count} otwartych sesji" });
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
              text: `${activityLabels()[entry.value] ?? entry.value} (${formatCount(entry.count)})`,
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
          el("td", { text: formatDateTime(entry.created_at, "seconds") }),
          el("td", { text: entry.actor_name ?? t("konto usunięte") }),
          el("td", { text: activityLabels()[entry.action] ?? entry.action }),
          el("td", { text: entry.target_id ? `${entry.target_type} #${entry.target_id}` : entry.target_type }),
          el("td", { className: "admin-activity__details", text: activityDetails(entry) })
        ));
      }
      status.textContent = tn(result.total, {
        one: "{count} zdarzenie w dzienniku",
        few: "{count} zdarzenia w dzienniku",
        many: "{count} zdarzeń w dzienniku"
      });
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
              el("td", { text: formatDateTime(String(user.last_login_at), "seconds") })
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
    el("div", { className: "admin-metric" + tone }, el("strong", { text: formatCount(value) }), el("span", { text: label }));
  // Failed readings go back to the queue and the worker starts on them; a
  // damaged file fails again with its reason, which the refreshed list shows.
  const retry = (mediaItemId: number | null, button: HTMLButtonElement): void => {
    button.disabled = true;
    status.textContent = t("Ponawianie…");
    void retryMetadata(mediaItemId)
      .then((result) => {
        status.textContent = result.requeued === 0
          ? t("Nie było czego ponowić.")
          : result.metadata?.status === "already_running"
            ? t("Ponowiono: {count} — worker już pracuje, weźmie je po kolei.", { count: formatCount(result.requeued) })
            : t("Ponowiono: {count} — worker czyta pliki w tle.", { count: formatCount(result.requeued) });
        window.setTimeout(() => void refresh(), 4000);
      })
      .catch((error: unknown) => {
        status.textContent = error instanceof Error && error.message ? error.message : t("Nie udało się ponowić.");
        button.disabled = false;
      });
  };
  const failures = metadataFailureList(data.metadata_failures ?? [], retry);
  return el(
    "article",
    { className: "panel admin-card" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Metadane") }), el("h3", { text: t("Kolejka odczytu plików") })),
      el("p", { text: t("Tagi audio czyta Mutagen, czas trwania, rozdzielczość i kodeki filmów — ffprobe.") })
    ),
    el("div", { className: "admin-metrics" },
      figure(t("oczekuje"), queue.queued),
      figure(t("w toku"), queue.running),
      figure(t("nieudane"), queue.failed),
      figure(t("gotowe"), queue.done)
    ),
    ...(failures ? [failures] : []),
    el("div", { className: "admin-card__actions" }, run, status)
  );
}

/**
 * The files behind the "failed" counter, and why each one failed.
 *
 * The counter cannot tell a damaged file from a configuration error: a missing
 * ffprobe fails every film the same way, a broken MP3 fails on its own. One row
 * per file with its last reason says which it is. A file queued again after it
 * changed counts once per failed reading, so the rows add up to the counter; one
 * that later read fine is marked, because the counter keeps counting it.
 */
function metadataFailureList(
  failures: AdminMetadataFailure[],
  retry: (mediaItemId: number | null, button: HTMLButtonElement) => void
): HTMLElement | null {
  if (failures.length === 0) return null;
  const rows = failures.map((failure) => {
    const facts = [
      tn(failure.failures, { one: "{count} nieudana próba", few: "{count} nieudane próby", many: "{count} nieudanych prób" }),
      t("ostatnio {when}", { when: formatDateTime(failure.failed_at) }),
      failure.missing ? t("pozycji nie ma już w katalogu") : "",
      failure.resolved ? t("później odczytany poprawnie") : ""
    ].filter(Boolean).join(" · ");
    // A file that left the catalogue has nothing left to read again.
    const again = failure.missing
      ? null
      : el("button", {
          className: "button button--secondary",
          attrs: { type: "button", "aria-label": t("Spróbuj ponownie odczytać {path}", { path: failure.path ?? "" }) }
        }, icon("history"), el("span", { text: t("Spróbuj ponownie") }));
    again?.addEventListener("click", () => retry(failure.media_item_id, again));
    return el("li", { className: "admin-failures__row" + (failure.resolved ? " is-resolved" : "") },
      el("span", {
        className: "admin-lookup__path",
        text: failure.path ? prettyPath(`${failure.root ?? ""}/${failure.path}`) : t("Pozycja usunięta z katalogu")
      }),
      el("strong", { className: "admin-failures__reason", text: failure.reason || t("Bez opisu błędu.") }),
      el("small", { className: "muted", text: facts }),
      // Wrapped, so the grid row does not stretch the button across the card.
      again === null ? null : el("div", {}, again)
    );
  });
  const all = el("button", { className: "button button--secondary", attrs: { type: "button" } },
    icon("history"), el("span", { text: t("Spróbuj ponownie wszystkie") }));
  all.addEventListener("click", () => retry(null, all));
  return el("details", { className: "admin-failures" },
    el("summary", {
      text: tn(failures.length, {
        one: "Pokaż plik, którego nie udało się odczytać",
        few: "Pokaż {count} pliki, których nie udało się odczytać",
        many: "Pokaż {count} plików, których nie udało się odczytać"
      })
    }),
    el("ul", { className: "admin-failures__list" }, ...rows),
    el("div", { className: "admin-card__actions" }, all)
  );
}

/**
 * Which icons the interface draws: Font Awesome Free, or a style of an installed
 * Pro package. The preview is drawn in the chosen style on the spot, so nobody
 * saves a style to find out what it looks like.
 */
function iconSettings(settings: AdminSettings): {
  element: HTMLElement;
  values: () => Pick<AdminSettings, "icon_pack" | "icon_style">;
} {
  const pro = proIconPack();
  const pack = el("select", { className: "input" },
    el("option", { text: t("Font Awesome Free — klasyczny"), attrs: { value: "free" } }),
    el("option", {
      text: pro ? t("Font Awesome Pro {version}", { version: pro.version }) : t("Font Awesome Pro — niezainstalowany"),
      attrs: { value: "pro", ...(pro ? {} : { disabled: true }) }
    })
  ) as HTMLSelectElement;
  const families: Record<string, string> = {
    classic: t("Klasyczny"), duotone: "Duotone", sharp: "Sharp", "sharp-duotone": "Sharp Duotone"
  };
  const weights: Record<string, string> = { solid: "Solid", regular: "Regular", light: "Light", thin: "Thin" };
  const offered = new Set(pro?.styles ?? []);
  const style = el("select", { className: "input" }) as HTMLSelectElement;
  for (const family of Object.keys(families)) {
    const group = el("optgroup", { attrs: { label: families[family]! } });
    for (const id of ICON_STYLE_IDS.filter((candidate) => splitIconStyle(candidate)?.family === family)) {
      const weight = splitIconStyle(id)!.weight;
      group.append(el("option", {
        text: `${families[family]} · ${weights[weight]}`,
        attrs: { value: id, ...(offered.has(id) ? {} : { disabled: true }) }
      }));
    }
    style.append(group);
  }
  pack.value = pro && settings.icon_pack === "pro" ? "pro" : "free";
  style.value = settings.icon_style && offered.has(settings.icon_style) ? settings.icon_style : DEFAULT_ICON_STYLE;
  const samples: IconName[] = ["home", "music", "film", "list", "smart", "search", "play", "shuffle", "download", "user", "settings", "star"];
  const preview = el("div", { className: "icon-preview", attrs: { "aria-hidden": "true" } },
    ...samples.map((name) => icon(name)),
    el("span", { className: "icon-preview__filled is-active" }, icon("heart"))
  );
  const sync = (): void => {
    style.disabled = pack.value !== "pro";
    const chosen = pack.value === "pro" ? style.value : "free";
    if (chosen === "free") {
      preview.dataset.iconStyle = "free";
      return;
    }
    void ensureProStylesheet().then((loaded) => { if (loaded) preview.dataset.iconStyle = chosen; });
  };
  pack.addEventListener("change", sync);
  style.addEventListener("change", sync);
  sync();
  const element = el("section", { className: "admin-settings__icons" },
    el("div", { className: "section-heading" },
      el("div", {}, el("span", { className: "eyebrow", text: t("Wygląd") }), el("h3", { text: t("Ikony") })),
      el("p", { text: pro
        ? t("Free działa w każdej instalacji. Styl Pro widzą wszyscy od następnego otwarcia strony; Solid wygląda jak Free.")
        : t("Paczka Pro nie jest zainstalowana — instrukcja w docs/FRONTEND.md, sekcja „Ikony”.") })
    ),
    el("div", { className: "admin-settings__icon-fields" },
      field(t("Zestaw ikon"), pack),
      field(t("Styl"), style)
    ),
    preview
  );
  return {
    element,
    values: () => ({ icon_pack: pack.value === "pro" ? "pro" : "free", icon_style: style.value })
  };
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
  // How far ahead a film is loaded in compatibility mode (stream-buffer.ts).
  const videoBuffer = el("input", {
    className: "input",
    attrs: { id: "video-buffer-seconds", type: "number", min: "0", max: "600", step: "10", value: String(settings.video_buffer_seconds ?? 60) }
  });
  const videoBufferField = el("div", { className: "field admin-settings__audio-profile" },
    el("label", { className: "field__label", attrs: { for: videoBuffer.id }, text: t("Zapas filmu w trybie zgodnym (s)") }),
    videoBuffer,
    el("p", {
      className: "admin-audio-profile-note",
      text: t("Ile sekund filmu odtwarzacz pobiera z wyprzedzeniem, żeby chwilowe zwolnienie łącza nie zatrzymywało obrazu. Przeglądarka sama trzyma tylko 2–3 s takiego strumienia. Pliki zostają bez zmian; 0 wyłącza zapas. Telefon z małą pamięcią może dostać mniej, niż tu ustawiono.")
    })
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
  const icons = iconSettings(settings);
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
      videoBufferField,
      icons.element,
      el("section", { className: "admin-settings__visualizers" },
        el("div", { className: "section-heading" },
          el("div", {}, el("span", { className: "eyebrow", text: t("Odtwarzacz") }), el("h3", { text: t("Kolejność wizualizacji") })),
          el("p", { text: t("Ułóż listę, włącz wybrane efekty i uruchom podgląd bez opuszczania panelu.") })
        ),
        visualizerList
      )
    ),
    el("div", { className: "admin-settings__actions" },
      el("button", { className: "button button--primary", attrs: { type: "submit" }, dataset: { tooltip: t("Zapisz ustawienia") } }, icon("check"), t("Zapisz ustawienia")),
      status
    )
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button) { button.disabled = true; button.dataset.tooltip = t("Zapisywanie ustawień…"); }
    // Only this tab's fields. The security tab is saved by its own form, and a
    // copy of its values taken when this tab was drawn would put them back.
    void saveAdminSettings({
      music_sort: musicSort.value as LibrarySort,
      movies_sort: moviesSort.value as LibrarySort,
      account_page_size: Math.max(10, Math.min(100, Number(pageSize.value) || 20)),
      compatibility_audio_profile: audioProfile.value as CompatibilityAudioProfile,
      compatibility_video_profile: videoProfile.value as CompatibilityVideoProfile,
      playback_threshold_percent: Math.max(1, Math.min(100, Number(playbackThreshold.value) || 15)),
      video_buffer_seconds: Math.max(0, Math.min(600, Math.round(Number(videoBuffer.value) || 0))),
      visualizer_order: [...visualizerOrder],
      visualizer_enabled: visualizerOrder.filter((id) => visualizerEnabled.has(id)),
      ...icons.values()
    }).then(() => {
      Object.assign(settings, icons.values());
      // This page switches at once; everybody else on their next page.
      applyIconPack(settings);
      settings.compatibility_audio_profile = audioProfile.value as CompatibilityAudioProfile;
      settings.compatibility_video_profile = videoProfile.value as CompatibilityVideoProfile;
      settings.playback_threshold_percent = Math.max(1, Math.min(100, Number(playbackThreshold.value) || 15));
      settings.video_buffer_seconds = Math.max(0, Math.min(600, Math.round(Number(videoBuffer.value) || 0)));
      settings.visualizer_order = [...visualizerOrder];
      settings.visualizer_enabled = visualizerOrder.filter((id) => visualizerEnabled.has(id));
      status.textContent = t("Ustawienia zapisane.");
      if (button) button.dataset.tooltip = t("Ustawienia zapisane");
    })
      .catch(() => {
        status.textContent = t("Nie udało się zapisać ustawień.");
        if (button) button.dataset.tooltip = t("Nie udało się zapisać ustawień");
      })
      .finally(() => {
        if (!button) return;
        button.disabled = false;
        window.setTimeout(() => { button.dataset.tooltip = t("Zapisz ustawienia"); }, 2200);
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
    ["none", t("Wyłączona")], ["recaptcha", "Google reCAPTCHA v2"],
    ["recaptcha_v3", t("Google reCAPTCHA v3 (niewidoczna)")],
    ["hcaptcha", "hCaptcha"], ["turnstile", "Cloudflare Turnstile"],
    ["pow", t("Proof-of-work (wbudowany)")]
  ] as const) {
    const option = el("option", { attrs: { value }, text: label }) as HTMLOptionElement;
    option.selected = settings.captcha_provider === value;
    provider.append(option);
  }
  // Every provider keeps its own pair on the server, so switching the select
  // shows that provider's stored public key and whether its secret is set; what
  // was typed for another provider stays in these drafts until saved.
  const keyed = (value: string): value is KeyedCaptchaProvider =>
    value === "recaptcha" || value === "recaptcha_v3" || value === "hcaptcha" || value === "turnstile";
  const siteKeys: Partial<Record<KeyedCaptchaProvider, string>> = { ...(settings.captcha_site_keys ?? {}) };
  if (keyed(settings.captcha_provider) && siteKeys[settings.captcha_provider] === undefined) {
    siteKeys[settings.captcha_provider] = settings.captcha_site_key;
  }
  const secretsSet: Partial<Record<KeyedCaptchaProvider, boolean>> = { ...(settings.captcha_secrets_configured ?? {}) };
  const secretDrafts: Partial<Record<KeyedCaptchaProvider, string>> = {};
  const siteKey = el("input", {
    className: "input",
    attrs: { type: "text", maxlength: 191, placeholder: t("Klucz publiczny (site key)") }
  }) as HTMLInputElement;
  const secret = el("input", {
    className: "input",
    attrs: { type: "password", maxlength: 191, autocomplete: "new-password" }
  }) as HTMLInputElement;
  const minScore = el("input", {
    className: "input",
    attrs: { type: "number", min: 0, max: 1, step: 0.05, value: String(settings.captcha_v3_min_score ?? 0.5) }
  }) as HTMLInputElement;
  const powDifficulty = el("input", {
    className: "input",
    attrs: { type: "number", min: 1000, max: 10000000, step: 1000, value: String(settings.captcha_pow_max_number ?? 200000) }
  }) as HTMLInputElement;
  const keyFields = el("div", { className: "admin-settings__grid" },
    field(t("Klucz publiczny"), siteKey),
    field(t("Klucz prywatny"), secret)
  );
  const scoreField = field(t("Minimalny wynik reCAPTCHA v3 (0–1)"), minScore);
  let shownProvider = provider.value;
  const showKeys = (): void => {
    if (keyed(shownProvider)) {
      siteKeys[shownProvider] = siteKey.value.trim();
      secretDrafts[shownProvider] = secret.value;
    }
    shownProvider = provider.value;
    keyFields.hidden = !keyed(shownProvider);
    scoreField.hidden = shownProvider !== "recaptcha_v3";
    if (!keyed(shownProvider)) return;
    siteKey.value = siteKeys[shownProvider] ?? "";
    secret.value = secretDrafts[shownProvider] ?? "";
    secret.placeholder = secretsSet[shownProvider] ? t("Zapisany — wpisz, aby zmienić") : t("Klucz prywatny (secret)");
  };
  provider.addEventListener("change", showKeys);
  const loginMode = el("select", { className: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["always", t("Zawsze")], ["after", t("Po kilku nieudanych próbach")], ["never", t("Nigdy")]
  ] as const) {
    const option = el("option", { attrs: { value }, text: label }) as HTMLOptionElement;
    option.selected = (settings.captcha_login_mode ?? (settings.captcha_protect_login ? "always" : "after")) === value;
    loginMode.append(option);
  }
  const loginAfter = el("input", {
    className: "input",
    attrs: { type: "number", min: 1, max: 50, value: String(settings.captcha_login_after ?? 3) }
  }) as HTMLInputElement;
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
  const ladder = stepUpControls(settings);
  const requireTwoFactor = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  requireTwoFactor.checked = settings.twofa_require_admins === true;

  const hint = el("p", { className: "muted" });
  const paintHint = (): void => {
    const chosen = provider.value;
    if (chosen === "none") {
      hint.textContent = t("Formularze działają bez stałego wyzwania; gdy ktoś przekroczy limity, zapyta go wbudowany proof-of-work.");
      return;
    }
    if (chosen === "pow") {
      hint.textContent = t("Wbudowany proof-of-work: przeglądarka rozwiązuje zadanie w tle, bez kluczy i skryptów z zewnątrz.");
      return;
    }
    const ready = keyed(chosen) && siteKey.value.trim() !== "" && (secretsSet[chosen] === true || secret.value !== "");
    hint.textContent = ready
      ? t("Wyzwanie jest aktywne na stronie logowania; w aplikacji limity zawsze używają proof-of-work.")
      : t("Uzupełnij oba klucze — bez nich ochrona pozostaje nieaktywna, żeby nie zablokować logowania.");
  };
  provider.addEventListener("change", paintHint);
  siteKey.addEventListener("input", paintHint);
  secret.addEventListener("input", paintHint);
  showKeys();
  paintHint();

  // One card per subject (styles: the security tab in admin.css lays them out,
  // two columns on a wide screen, one on a phone, in this order). Each card is
  // named for where it stands in that layout.
  const group = (area: string, ...children: Array<Node | null>): HTMLElement =>
    el("section", { className: `admin-settings__group admin-settings__group--${area}` }, ...children);
  const heading = (title: string, text?: string): HTMLElement =>
    el("div", { className: "section-heading" }, el("h3", { text: title }), text ? el("p", { className: "muted", text }) : null);
  const toggle = (box: HTMLInputElement, label: string): HTMLElement =>
    el("label", { className: "toggle-field" }, box, el("span", { text: label }));
  ladder.element.classList.add("admin-settings__group", "admin-settings__group--ladder");
  const form = el("form", { className: "admin-settings admin-settings--security" },
    group("registration",
      heading(t("Rejestracja")),
      el("div", { className: "admin-settings__grid" },
        toggle(registration, t("Rejestracja otwarta")),
        toggle(activation, t("Wymagaj potwierdzenia adresu e-mail")),
        field(t("Rola nowych kont"), defaultRole)
      )
    ),
    group("bots",
      heading(t("Ochrona antybotowa"), t("Klucz prywatny jest zapisywany, ale nigdy nie jest odsyłany do przeglądarki.")),
      el("div", { className: "admin-settings__grid" },
        field(t("Dostawca"), provider),
        scoreField,
        field(t("Trudność proof-of-work (największa liczba)"), powDifficulty)
      ),
      keyFields,
      el("div", { className: "admin-settings__grid" },
        field(t("Wyzwanie przy logowaniu"), loginMode),
        field(t("Po ilu nieudanych próbach"), loginAfter),
        toggle(protectRegister, t("Chroń rejestrację"))
      ),
      hint
    ),
    group("limits",
      heading(t("Limity pobierania"), t("Globalny limit liczy pobrania plików i archiwów w kroczącym oknie czasu i dotyczy każdego zwykłego konta; grupa uprawnień może dodać własny limit z innym oknem oraz ograniczyć liczbę równoczesnych pobrań. Administratorów limity nie obejmują.")),
      el("div", { className: "admin-settings__grid" },
        field(t("Pobrań w oknie (0 = bez limitu)"), downloadLimit),
        field(t("Okno czasu (minuty)"), downloadWindow)
      )
    ),
    ladder.element,
    group("twofa",
      heading(t("Weryfikacja dwuetapowa"), t("Każde konto może włączyć ją w „Moje konto”. Wymagana od administratorów oznacza, że administrator bez niej skonfiguruje ją przy następnym logowaniu, zanim wejdzie dalej.")),
      el("div", { className: "admin-settings__grid" }, toggle(requireTwoFactor, t("Wymagaj od administratorów")))
    ),
    group("sharing",
      heading(t("Udostępnianie na zewnątrz"), t("Link gościnny otwiera jeden folder albo jedną playlistę osobie bez konta. Wyłączone unieważnia też linki już wydane, a przycisk znika z kart.")),
      el("div", { className: "admin-settings__grid" }, toggle(guestLinks, t("Zezwól na linki gościnne")))
    ),
    group("player",
      heading(t("Odtwarzacz"), t("Na telefonie odtwarzacz zawsze można zwinąć do jednej linii; na dużym ekranie ta możliwość jest domyślnie wyłączona.")),
      el("div", { className: "admin-settings__grid" }, toggle(dockCollapseDesktop, t("Pozwól zwijać odtwarzacz także na komputerze")))
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
      captcha_login_mode: loginMode.value,
      captcha_login_after: Math.max(1, Math.min(50, Number(loginAfter.value) || 3)),
      captcha_v3_min_score: Math.max(0, Math.min(1, Number(minScore.value) || 0)),
      captcha_pow_max_number: Math.max(1000, Math.min(10000000, Number(powDifficulty.value) || 200000)),
      captcha_protect_registration: protectRegister.checked,
      download_rate_limit: Math.max(0, Math.min(10000, Number(downloadLimit.value) || 0)),
      download_rate_window_minutes: Math.max(1, Math.min(10080, Number(downloadWindow.value) || 60)),
      dock_collapse_desktop: dockCollapseDesktop.checked,
      guest_links_enabled: guestLinks.checked,
      twofa_require_admins: requireTwoFactor.checked,
      ...ladder.patch()
    };
    // Each provider's public key goes under its own name. A secret is omitted
    // entirely when untouched, so an admin can save without retyping one the
    // panel is not allowed to show them.
    if (keyed(shownProvider)) {
      siteKeys[shownProvider] = siteKey.value.trim();
      secretDrafts[shownProvider] = secret.value;
    }
    for (const name of ["recaptcha", "recaptcha_v3", "hcaptcha", "turnstile"] as const) {
      if (siteKeys[name] !== undefined) patch[`captcha_site_key_${name}`] = siteKeys[name];
      if (secretDrafts[name]) patch[`captcha_secret_key_${name}`] = secretDrafts[name];
    }

    void saveAdminSettings(patch as Partial<AdminSettings>)
      .then((updated) => {
        Object.assign(settings, updated);
        Object.assign(secretsSet, updated.captcha_secrets_configured ?? {});
        Object.assign(siteKeys, updated.captcha_site_keys ?? {});
        for (const name of Object.keys(secretDrafts) as KeyedCaptchaProvider[]) delete secretDrafts[name];
        secret.value = "";
        shownProvider = "none";
        showKeys();
        status.textContent = t("Ustawienia zapisane.");
        paintHint();
      })
      .catch(() => { status.textContent = t("Nie udało się zapisać ustawień."); })
      .finally(() => { if (button) button.disabled = false; });
  });
  return form;
}

/** What each context of the step-up ladder counts; a function so the labels follow the language. */
function stepUpContextLabels(): Array<[StepUpContext, string]> {
  return [
    ["request", t("Każde żądanie do serwera")],
    ["download", t("Pobrania (pliki i archiwa)")],
    ["compat", t("Strumienie trybu zgodnego")],
    ["guest_link", t("Nowe linki gościnne")],
    ["register", t("Rejestracje")],
    ["resend", t("Ponowne wysłanie linku aktywacyjnego")]
  ];
}

/**
 * The step-up ladder's settings (StepUpGuard.php): per context, how many
 * requests in the window go through untouched (soft), from when on a person
 * must prove to be there, and from when on everybody is paused (hard).
 */
function stepUpControls(settings: AdminSettings): { element: HTMLElement; patch(): Record<string, unknown> } {
  const checkbox = (checked: boolean): HTMLInputElement => {
    const box = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
    box.checked = checked;
    return box;
  };
  const enabled = checkbox(settings.stepup_enabled !== false);
  const staffExempt = checkbox(settings.stepup_staff_exempt !== false);
  const passMinutes = numberInput(settings.stepup_pass_minutes ?? 30, 1, 1440);
  const blockAfter = numberInput(settings.stepup_block_after ?? 5, 1, 100);
  const blockMinutes = numberInput(settings.stepup_block_minutes ?? 60, 1, 10080);
  const rows = stepUpContextLabels().map(([context, label]) => {
    const current = settings.stepup_thresholds?.[context] ?? { soft: 1, hard: 1, window: 60 };
    return {
      context,
      label,
      soft: numberInput(current.soft, 1, 100000),
      hard: numberInput(current.hard, 1, 100000),
      window: numberInput(current.window, 10, 604800)
    };
  });
  const table = el("table", { className: "data-table stepup-thresholds" },
    el("thead", {}, el("tr", {},
      el("th", { text: t("Co liczymy") }),
      el("th", { text: t("Wyzwanie od") }),
      el("th", { text: t("Pauza od") }),
      el("th", { text: t("Okno (s)") })
    )),
    el("tbody", {}, ...rows.map((row) => {
      // Named one by one: on a phone the table is a block per row with the
      // column names over the fields (data-label, the security tab in panels.css),
      // and a field in a table cell has no name of its own anyway.
      const columns: Array<[HTMLInputElement, string]> = [[row.soft, t("Wyzwanie od")], [row.hard, t("Pauza od")], [row.window, t("Okno (s)")]];
      for (const [input, column] of columns) input.setAttribute("aria-label", `${row.label}: ${column}`);
      return el("tr", {},
        el("th", { text: row.label, attrs: { scope: "row" } }),
        ...columns.map(([input, column]) => el("td", { dataset: { label: column } }, input))
      );
    }))
  );
  const element = el("div", { className: "stack stepup-settings" },
    el("div", { className: "section-heading" },
      el("h3", { text: t("Krok w górę i blokady") }),
      el("p", { className: "muted", text: t("Po przekroczeniu progu wyzwania serwer prosi o potwierdzenie, że to człowiek (w aplikacji proof-of-work, na stronie logowania wybrany dostawca), i wydaje przepustkę na kilka minut. Po progu pauzy odmawia aż do przesunięcia okna; kto mimo pauzy próbuje dalej, zostaje czasowo zablokowany. Liczy się konto, adres (jako skrót) i urządzenie.") })
    ),
    el("div", { className: "admin-settings__grid" },
      el("label", { className: "toggle-field" }, enabled, el("span", { text: t("Włącz krok w górę") })),
      el("label", { className: "toggle-field" }, staffExempt, el("span", { text: t("Nie dotyczy administratorów") })),
      field(t("Przepustka ważna (minuty)"), passMinutes),
      field(t("Blokada po tylu odmowach w pauzie"), blockAfter),
      field(t("Długość blokady (minuty)"), blockMinutes)
    ),
    el("div", { className: "table-wrap" }, table)
  );
  return {
    element,
    patch(): Record<string, unknown> {
      const read = (input: HTMLInputElement, min: number, max: number, fallback: number): number =>
        Math.max(min, Math.min(max, Math.round(Number(input.value)) || fallback));
      const patch: Record<string, unknown> = {
        stepup_enabled: enabled.checked,
        stepup_staff_exempt: staffExempt.checked,
        stepup_pass_minutes: read(passMinutes, 1, 1440, 30),
        stepup_block_after: read(blockAfter, 1, 100, 5),
        stepup_block_minutes: read(blockMinutes, 1, 10080, 60)
      };
      for (const row of rows) {
        const soft = read(row.soft, 1, 100000, 1);
        patch[`stepup_${row.context}_soft`] = soft;
        patch[`stepup_${row.context}_hard`] = Math.max(soft, read(row.hard, 1, 100000, soft));
        patch[`stepup_${row.context}_window`] = read(row.window, 10, 604800, 60);
      }
      return patch;
    }
  };
}

function durationText(seconds: number): string {
  if (seconds >= 3600) return t("{hours} g {minutes} min", { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) });
  if (seconds >= 60) return t("{minutes} min", { minutes: Math.ceil(seconds / 60) });
  return t("{seconds} s", { seconds });
}

/** Who the ladder asked, paused or blocked in the last day, with the way to let them go. */
function stepUpList(subjects: StepUpSubject[]): HTMLElement {
  const host = el("div", { className: "stack" });
  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const contexts = new Map<string, string>(stepUpContextLabels());
  contexts.set("login", t("Logowanie"));
  const who = (row: StepUpSubject): string => {
    const short = row.subject.slice(2, 12);
    if (row.kind === "u") return row.username ?? `ID ${row.subject.slice(2)}`;
    const name = row.kind === "c" ? t("adres {digest}…", { digest: short }) : t("urządzenie {digest}…", { digest: short });
    return row.username ? `${name} (${row.username})` : name;
  };
  const stateText = (row: StepUpSubject): string => {
    switch (row.state) {
      case "blocked": return t("zablokowany jeszcze {time}", { time: durationText(row.seconds_left) });
      case "paused": return t("pauza jeszcze {time}", { time: durationText(row.seconds_left) });
      case "challenged": return t("poproszony o wyzwanie");
      default: return t("już wolny");
    }
  };
  const paint = (rows: StepUpSubject[]): void => {
    if (rows.length === 0) {
      host.replaceChildren(el("p", { className: "muted", text: t("Nikt nie przekroczył progów w ostatniej dobie.") }), status);
      return;
    }
    const body = el("tbody", {}, ...rows.map((row) => {
      const release = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Odblokuj"));
      release.addEventListener("click", () => {
        release.disabled = true;
        status.textContent = t("Zapisywanie…");
        void releaseStepUp(row.subject)
          .then((fresh) => { status.textContent = t("Odblokowano."); paint(fresh); })
          .catch((error: unknown) => {
            status.textContent = error instanceof Error && error.message ? error.message : t("Błąd zapisu");
            release.disabled = false;
          });
      });
      const pill = el("span", {
        className: "status-pill " + (row.state === "blocked" ? "status-pill--danger" : row.state === "paused" ? "status-pill--warning" : "status-pill--muted"),
        text: stateText(row)
      });
      return el("tr", {},
        el("td", { text: who(row) }),
        el("td", { text: contexts.get(row.context) ?? row.context }),
        el("td", {}, pill),
        el("td", { text: formatCount(row.hits) }),
        el("td", { text: t("{time} temu", { time: durationText(row.seconds_ago) }) }),
        el("td", {}, release)
      );
    }));
    host.replaceChildren(
      el("div", { className: "table-wrap" }, el("table", { className: "data-table" },
        el("thead", {}, el("tr", {},
          el("th", { text: t("Kto") }), el("th", { text: t("Co") }), el("th", { text: t("Stan") }),
          el("th", { text: t("Liczba") }), el("th", { text: t("Ostatnio") }), el("th", {})
        )),
        body
      )),
      status
    );
  };
  paint(subjects);
  return el("div", { className: "stepup-list" },
    el("div", { className: "section-heading" },
      el("h3", { text: t("Ograniczeni i zablokowani") }),
      el("p", { className: "muted", text: t("Konta, adresy i urządzenia, które w ostatniej dobie dostały wyzwanie, pauzę albo blokadę. Adres widać tylko jako skrót — sam adres nie jest zapisywany.") })
    ),
    host
  );
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
      void confirmDialog({
        title: t("Usunąć grupę?"),
        message: t("Usunąć grupę „{name}”? {members} kont trafi do wybranej grupy.", { name: group.name, members: group.members }),
        confirmLabel: t("Usuń"),
        danger: true
      }).then((agreed) => {
        if (!agreed) return;
        remove.disabled = true;
        void deletePermissionGroup(group.id, Number(target.value) || null)
          .then(apply)
          .catch((error: unknown) => {
            status.className = "admin-user__message is-error";
            status.textContent = failureText(error, t("Nie udało się usunąć"));
          })
          .finally(() => { remove.disabled = false; });
      });
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
  const shell = await mountShell("admin", "Administracja", "Użytkownicy, katalog i diagnostyka");
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
  const securityHost = el("div", { className: "admin-security" });
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
  let titleWorkerBuilt: HTMLElement | null = null;
  let subtitleBuilt: HTMLElement | null = null;
  const painters: Record<string, (data: AdminData) => void> = {
    overview: (data) => {
      const accountCount = data.users.length;
      const activeCount = data.users.filter((user) => Boolean(Number(user.is_active))).length;
      const pendingCount = data.users.filter((user) => user.email_verified_at === null && Boolean(user.email) && !user.disabled_at).length;
      const adminCount = data.users.filter((user) => user.role !== "user").length;
      const itemCount = data.catalog.reduce((sum, row) => sum + Number(row.items), 0);
      metricsHost.replaceChildren(el("section", { className: "admin-metrics admin-metrics--quad" },
        metric("user", accountCount, tn(accountCount, { one: "konto", few: "konta", many: "kont" })),
        metric("check", activeCount, tn(activeCount, { one: "aktywne", few: "aktywne", many: "aktywnych" })),
        metric("history", pendingCount, tn(pendingCount, { one: "oczekujące", few: "oczekujące", many: "oczekujących" })),
        metric("admin", adminCount, tn(adminCount, { one: "administrator", few: "administratorzy", many: "administratorów" }))
      ));
      // The catalogue total belongs to the catalogue: as a fifth tile it left
      // the account tiles three-and-two, with a hole where a sixth would go.
      catalogHost.replaceChildren(
        sectionHeading(
          t("Biblioteka"),
          t("Stan katalogu"),
          `${tn(itemCount, { one: "{count} pozycja", few: "{count} pozycje", many: "{count} pozycji" })} · ${t("Jedna wspólna baza i ostatni zakończony stan indeksowania.")}`
        ),
        catalogCards(data, () => refresh("overview"), false)
      );
    },
    accounts: (data) => {
      // Accounts still waiting for activation come first, so the queue an
      // operator acts on is never buried under the alphabet.
      const orderedUsers = [...data.users].sort((a, b) => {
        const aPending = a.email_verified_at === null && Boolean(a.email) && !a.disabled_at ? 0 : 1;
        const bPending = b.email_verified_at === null && Boolean(b.email) && !b.disabled_at ? 0 : 1;
        return aPending - bPending || a.username.localeCompare(b.username, "pl");
      });
      usersHost.replaceChildren(...orderedUsers.map((user) =>
        userCard(user, shell.session.user.id, shell.session.user.role === "super_admin", data.groups ?? [], () => refresh("accounts"))
      ));
      const previousChoice = createGroup ? Number(createGroup.value) : null;
      createGroup = groupSelect(data.groups ?? [], previousChoice, t("Grupa uprawnień nowego konta"));
      createGroupHost.replaceChildren(createGroup);
    },
    security: (data) => securityHost.replaceChildren(securityForm(data.settings), stepUpList(data.stepup ?? [])),
    groups: (data) => groupsHost.replaceChildren(groupsPanel(data)),
    library: (data) => settingsHost.replaceChildren(settingsForm(data.settings, (id) => void shell.player.previewVisualizer(id))),
    scans: (data) => {
      catalogScanHost.replaceChildren(catalogCards(data, () => refresh("scans"), true));
      metadataQueueHost.replaceChildren(metadataQueuePanel(data, () => refresh("scans")));
      // Built once per visit and then left alone. Both hold what the operator is
      // choosing (range, mode, film ids, batch size) and the subtitle one runs its
      // own status polling — and the live refresh below used to rebuild them every
      // four seconds, wiping what was being typed and starting one more polling
      // chain each time: about fifty requests a second after five minutes.
      if (!titleWorkerBuilt) titleWorkerHost.replaceChildren(titleWorkerBuilt = titleWorkerPanel());
      if (!subtitleBuilt) subtitleHost.replaceChildren(subtitleBuilt = subtitleCachePanel(data));
      scansHost.replaceChildren(scanTable(data));
    },
    activity: (data) => activityHost.replaceChildren(activityPanel(data)),
    // Reads its own series from the service; the account data a refresh carries
    // has nothing to say about it.
    stats: () => statsHost.replaceChildren(statsPanel()),
    // The panel fetches its own pages, so a refresh only has to rebuild it.
    genres: () => lookupsHost.replaceChildren(titleLookupsPanel())
  };

  /** The panel's data as last read whole, so a partial reading can be laid over it. */
  let latest: AdminData | null = null;
  const refresh = async (section?: string): Promise<void> => {
    const data = await getAdmin();
    latest = data;
    const targets = section === undefined ? Object.keys(painters) : [section, "overview"];
    for (const key of new Set(targets)) painters[key]?.(data);
  };
  /**
   * The Indexing section's own reading, every few seconds while it is open: only
   * what moves while a scan or a batch runs (api.ts, `getIndexingStatus`), laid
   * over the rest of the panel's data as it was last read.
   */
  const refreshIndexing = async (): Promise<void> => {
    const status = await getIndexingStatus();
    if (latest === null) return;
    latest = { ...latest, ...status };
    painters.scans?.(latest);
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
  let liveInFlight = false;
  const stopLive = (): void => { window.clearInterval(liveTimer); liveTimer = 0; };
  const startLive = (section: string): void => {
    stopLive();
    if (section !== "scans") return;
    liveTimer = window.setInterval(() => {
      // A tab in the background gets nothing: the browser throttles the timer
      // anyway, and a hidden page has nobody to tell. Nor does a tick whose
      // predecessor is still waiting: over a slow link the reads used to stack up.
      if (document.hidden || active !== "scans" || liveInFlight) return;
      liveInFlight = true;
      void refreshIndexing().catch(() => undefined).finally(() => { liveInFlight = false; });
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
      id: "security", label: t("Bezpieczeństwo"), glyph: "lock", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Rejestracja"), t("Konta i ochrona antybotowa"), t("Kto może założyć konto, czy musi potwierdzić adres i jakie wyzwanie chroni formularze.")),
        securityHost)
    },
    {
      id: "groups", label: t("Grupy"), glyph: "users", body: el("section", { className: "panel admin-section admin-section--users" },
        sectionHeading(t("Uprawnienia"), t("Grupy uprawnień"), t("Twórz własne grupy z własnym zestawem praw i limitów, a potem przypisuj do nich konta.")),
        groupsHost)
    },
    {
      id: "library", label: t("Biblioteka"), glyph: "settings", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Konfiguracja"), t("Ustawienia biblioteki i odtwarzacza"), t("Domyślne sortowanie, profile trybu zgodnego, próg odtworzenia i wizualizacje. Prawa kont ustawiasz w sekcji Grupy.")),
        settingsHost)
    },
    {
      // Everything that works in the background lives here, in the order it runs:
      // find the files, read them, name them, prepare their subtitles. Each panel
      // updates itself while this section is open — no button asks to be pressed
      // twice to find out what happened.
      id: "scans", label: t("Indeksowanie"), glyph: "database", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Indeksowanie"), t("Wszystko, co dzieje się w tle"), t("Skan katalogu, odczyt metadanych, gatunki filmów i cache napisów. Panele odświeżają się same, dopóki ta sekcja jest otwarta.")),
        catalogScanHost,
        metadataQueueHost,
        titleWorkerHost,
        subtitleHost,
        scansHost)
    },
    {
      id: "genres", label: t("Gatunki"), glyph: "tags", body: el("section", { className: "panel admin-section" },
        sectionHeading(
          t("Gatunki"),
          t("Niepewne dopasowania"),
          t("Gatunek i rok pobierane są automatycznie tylko wtedy, gdy tytuł, rok i czas trwania się zgadzają. Reszta czeka tutaj — potwierdź jedną z propozycji, ustaw ręcznie albo pomiń.")
        ),
        lookupsHost)
    },
    {
      id: "stats", label: t("Statystyki"), glyph: "chart", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Serwer"), t("Ruch, transfery i cache"), t("Z dziennika usługi transferowej: jedna próbka na minutę, trzymana w plikach obok cache, które mierzy.")),
        statsHost)
    },
    {
      id: "activity", label: t("Aktywność"), glyph: "history", body: el("section", { className: "panel admin-section" },
        sectionHeading(t("Aktywność"), t("Dziennik i logowania"), t("Kto był ostatnio i co zmienił — zdarzenia z dziennika audytu z filtrami po rodzaju i koncie.")),
        activityHost)
    }
  ];

  const stage = el("div", { className: "admin-stage" });
  const loaded = new Set<string>();
  let active = "";

  /**
   * Put a section on the stage and read its data the first time it is opened.
   *
   * The section is named once, on the way in, and everything after the wait
   * speaks of that one. `active` moves on when another tab is pressed while this
   * one is still loading, and the code used to read it afterwards: the section
   * that had just loaded was not the one marked as loaded, and a failure wrote
   * its notice over whichever section was on screen by then.
   */
  const show = async (id: string): Promise<void> => {
    const section = sections.find((entry) => entry.id === id) ?? sections[0]!;
    active = section.id;
    stage.replaceChildren(section.body);
    startLive(section.id);
    if (loaded.has(section.id)) {
      stage.removeAttribute("aria-busy");
      return;
    }
    stage.setAttribute("aria-busy", "true");
    try {
      await refresh(section.id);
      loaded.add(section.id);
      // Tiles arrive once, with the section's first data — not with every refresh after it.
      if (active === section.id) {
        for (const list of Array.from(stage.querySelectorAll<HTMLElement>(".admin-metrics, .admin-catalog"))) arrive(list);
      }
    } catch {
      if (active === section.id) {
        stage.replaceChildren(el("div", { className: "notice notice--error", text: t("Nie udało się pobrać danych sekcji.") }));
      }
    } finally {
      if (active === section.id) stage.removeAttribute("aria-busy");
    }
  };

  const reload = el("button", {
    className: "button button--secondary admin-subnav-bar__reload",
    attrs: { type: "button" }
  }, icon("refresh"), el("span", { className: "admin-subnav__label", text: t("Odśwież") }));
  reload.addEventListener("click", () => {
    loaded.clear();
    void show(active);
  });

  // The same row of section buttons the account page has (shared/section-tabs.ts);
  // this page used to carry a copy of it.
  let opening: Promise<void> = Promise.resolve();
  const tabs = sectionTabs({
    label: t("Sekcje administracji"),
    tabs: sections.map(({ id, label, glyph }) => ({ id, label, glyph })),
    onOpen: (id) => { opening = show(id); },
    trailing: reload,
    stage
  });
  shell.content.append(el("div", { className: "admin-page" }, tabs.bar, stage));

  const requested = window.location.hash.slice(1);
  tabs.open(sections.some((entry) => entry.id === requested) ? requested : sections[0]!.id);
  await opening;
}

