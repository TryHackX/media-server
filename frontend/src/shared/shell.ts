import { ApiError, getSession, logout, saveUserPreferences } from "./api";
import { applyIconPack, primeIconPack } from "./icon-pack";
import { queueModeFallback, restoreQueueLoaders } from "./queue-loaders";
import { AudioPlayer } from "./audio-player";
import { appUrl } from "./config";
import { el, requireRoot } from "./dom";
import { icon, type IconName } from "./icons";
import { loadLanguage, preloadLanguage, t } from "./i18n";
import { MetadataEditor } from "./metadata-editor";
import { pageRise } from "./motion";
import { can, canAccessLibrary, canEditMetadata, isAdministrator } from "./permissions";
import { installSheetGestures } from "./sheet-gestures";
import { applyTheme, hasUnsavedTheme, primeTheme, rememberTheme, resolveTheme, storedTheme } from "./theme";
import { defaultUserPreferences, type MediaItem, type SessionResponse, type UserRole } from "./types";
import { installFloatingTooltips } from "./tooltips";
import { trackKeyboard } from "./viewport";

// The icon style this browser used last, before the session answers (shared/icon-pack.ts).
primeIconPack();
// And its theme — normally already on the page (public/theme-boot.js ran before the first paint).
primeTheme();

type ActivePage = "home" | "music" | "movies" | "collections" | "account" | "admin";

interface ShellResult {
  content: HTMLElement;
  actions: HTMLElement;
  session: SessionResponse;
  player: AudioPlayer;
  /**
   * Rename the page after it has mounted — for a title only the page's own data
   * can supply (somebody else's profile). Takes finished text, not a key: there
   * is nothing left to translate in a user's name.
   */
  setTitle(title: string, eyebrow?: string): void;
}

interface PersistentShell {
  result: ShellResult;
  shell: HTMLElement;
  nav: HTMLElement;
  title: HTMLElement;
  eyebrow: HTMLElement;
  menuButton: HTMLButtonElement;
  active: ActivePage;
  setMenu(open: boolean, restoreFocus?: boolean): void;
}

let persistentShell: PersistentShell | null = null;
let sessionPromise: Promise<SessionResponse> | null = null;
let metadataEditor: MetadataEditor | null = null;

/**
 * Editor for the dock's "edit tags" control. The dialog lives on document.body,
 * so one instance serves every page; without this fallback the control went dead
 * after soft-navigating away from the library page that used to own the editor.
 */
function shellEditHandler(session: SessionResponse): ((item: MediaItem) => void) | null {
  if (!canEditMetadata(session)) return null;
  return openMetadataEditor;
}

/** Open the shared tag/artwork editor (one dialog per document, any page). */
export function openMetadataEditor(item: MediaItem): void {
  if (metadataEditor === null) {
    metadataEditor = new MetadataEditor();
    // Edited tags and artwork must show up wherever the track is visible, so the
    // player (dock and open queue) is told about the save.
    metadataEditor.onSaved = (saved) => persistentShell?.result.player.applyItemUpdate({ ...saved });
  }
  metadataEditor.open(item);
}

const roleLabels: Record<UserRole, string> = {
  user: "Użytkownik",
  admin: "Administrator",
  super_admin: "Super administrator"
};

/**
 * Adopt the account's language before anything is drawn.
 *
 * Every string is resolved at render time, so this has to happen before the
 * first page mounts — which it does, because the session is awaited here and
 * pages only run afterwards.
 */
async function adoptLanguage(session: SessionResponse): Promise<void> {
  // The document's own `lang` is set here rather than inside the translator, so
  // that module stays free of the DOM and can be unit-tested on its own.
  const language = await loadLanguage(session.preferences?.language);
  document.documentElement.lang = language;
  try { localStorage.setItem(LANGUAGE_HINT, language); } catch { /* pamięć przeglądarki może być niedostępna */ }
}

/**
 * Adopt the account's colour theme (shared/theme.ts decides which wins).
 *
 * The page has been drawn in this browser's last theme since before its first
 * frame; if the account says otherwise — it was changed on another device — the
 * colours change here, once, and the browser remembers the new one. A choice
 * made while the bridge could not store themes is handed to the account the
 * first time it can.
 */
function adoptTheme(session: SessionResponse): void {
  const decision = resolveTheme({ account: session.preferences?.theme, stored: storedTheme(), unsaved: hasUnsavedTheme() });
  applyTheme(decision.theme);
  if (!decision.pushToAccount) {
    // Kept as "not on the account" only while the account has nowhere to keep it.
    rememberTheme(decision.theme, session.preferences?.theme === undefined && hasUnsavedTheme());
    return;
  }
  void saveUserPreferences({ ...defaultUserPreferences, ...session.preferences, theme: decision.theme })
    .then((saved) => {
      session.preferences = saved;
      rememberTheme(decision.theme, saved.theme !== decision.theme);
    })
    .catch(() => undefined);
}

/**
 * The language this browser was last used in. English is a chunk of its own
 * (i18n-en.ts) and the account's choice is known only once the session has
 * answered; with this the two are asked for side by side instead of one after
 * the other. Only a hint: the session decides.
 */
const LANGUAGE_HINT = "media-language";

function hintedLanguage(): string | null {
  try { return localStorage.getItem(LANGUAGE_HINT); } catch { return null; }
}

function navLink(label: string, path: string, iconName: IconName, active: boolean): HTMLAnchorElement {
  return el(
    "a",
    {
      className: "nav-link",
      attrs: {
        href: appUrl(path),
        ...(active ? { "aria-current": "page" } : {})
      }
    },
    icon(iconName),
    label
  );
}

/**
 * Read the session, and say what is wrong when it cannot be read.
 *
 * Three different failures used to share one answer — "go to the sign-in page":
 *
 * - **401, not signed in.** `request()` has already sent the browser to sign in
 *   and told it where to come back to (`?next=`). A second redirect from here
 *   raced the first and won, so the deep link — a shared playlist, a section of
 *   the panel — was gone by the time the password was typed. Nothing to do here.
 * - **403.** The bridge refuses this browser the session route itself; sign-in
 *   is the only page that can explain or fix that.
 * - **No answer at all** (the server is out of reach, or answered 5xx). Signing
 *   in again fixes neither, and offline it was worse than useless: the service
 *   worker served the cached shell, the shell redirected to a sign-in page it
 *   had no copy of, the worker answered that with the shell again — a reload
 *   loop on a phone with no signal. The page now says so in place and offers to
 *   try again, which is also what happens by itself once the network is back.
 */
async function requireSession(): Promise<SessionResponse> {
  try {
    return await getSession();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    if (error instanceof ApiError && error.status === 403) {
      window.location.assign(appUrl("login/"));
      throw error;
    }
    // No session to read a language from: the one this browser was last used in.
    document.documentElement.lang = await loadLanguage(hintedLanguage());
    showUnreachable(error instanceof ApiError);
    throw error;
  }
}

/** The whole page, when there is no session to draw it from: what happened and a way to try again. */
function showUnreachable(answered: boolean): void {
  const retry = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("refresh"), t("Spróbuj ponownie"));
  retry.addEventListener("click", () => window.location.reload());
  requireRoot().replaceChildren(
    el(
      "main",
      { className: "unreachable", attrs: { role: "alert" } },
      el("span", { className: "unreachable__icon" }, icon("server")),
      el("h1", { text: answered ? t("Serwer nie odpowiada") : t("Brak połączenia z serwerem") }),
      el("p", {
        className: "muted",
        text: answered
          ? t("Biblioteka chwilowo nie działa. Spróbuj ponownie za moment.")
          : t("Biblioteka jest dostępna tylko wtedy, gdy serwer domowy jest w zasięgu.")
      }),
      retry
    )
  );
  // Back in range: no reason to make anybody press the button.
  window.addEventListener("online", () => window.location.reload(), { once: true });
}

function updateActiveNavigation(nav: HTMLElement, active: ActivePage): void {
  for (const link of nav.querySelectorAll<HTMLAnchorElement>(".nav-link")) {
    const target = new URL(link.href, window.location.origin).pathname;
    const expected = active === "home" ? appUrl() : appUrl(`${active}/`);
    if (target === expected || (active === "account" && target === appUrl("account/"))) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

/**
 * The tab's title, kept in step with the page.
 *
 * Every HTML entry carries its own `<title>`, but navigation inside the
 * application never loads another one — so the tab, the history list and a
 * screen reader all kept announcing whichever page the visit started on.
 */
function setDocumentTitle(active: ActivePage, title: string): void {
  document.title = active === "home" ? "TryHackX Media" : `${t(title)} · TryHackX Media`;
}

/**
 * Bring the new page in rather than snapping it into place.
 *
 * Only the content moves. The sidebar, the header and the player stay exactly
 * where they were, which is what makes a navigation read as one application
 * changing its mind instead of a sequence of separate pages. The old content is
 * already gone by now, so there is nothing to fade out and no delay is added —
 * the new page simply arrives with a short rise. Opacity and transform only:
 * both run on the compositor, so the animation does not compete with the page
 * building itself on the main thread.
 */
function animatePageIn(content: HTMLElement): void {
  // Inside a page transition the router does this itself, once the old page has
  // begun to fade (router.ts): started here it would be half over before the
  // new page is shown at all.
  if (document.documentElement.dataset.vt === "page") return;
  pageRise(content, true);
}

export async function mountShell(
  active: ActivePage,
  title: string,
  eyebrow: string
): Promise<ShellResult> {
  if (persistentShell?.shell.isConnected) {
    persistentShell.active = active;
    persistentShell.title.textContent = t(title);
    persistentShell.eyebrow.textContent = t(eyebrow);
    setDocumentTitle(active, title);
    updateActiveNavigation(persistentShell.nav, active);
    persistentShell.setMenu(false, false);
    persistentShell.result.actions.replaceChildren();
    persistentShell.result.content.replaceChildren();
    animatePageIn(persistentShell.result.content);
    // A new page with the keyboard still on the link that led to it — or, after
    // the old content went, on nothing at all — is a page a screen reader never
    // hears about. The heading takes the focus: it is read out, and Tab goes on
    // from the top of the new page. No ring is drawn for a pointer (the heading
    // is not a control), only for somebody who arrived by keyboard.
    persistentShell.title.focus({ preventScroll: true });
    persistentShell.result.player.setEditHandler(shellEditHandler(persistentShell.result.session));
    persistentShell.result.player.setCollectionHandler(null);
    // The queue-mode handler closes over the previous page's directory/collection
    // state; without this reset a Music page's handler survives navigation to
    // Movies. It is replaced rather than dropped: the shuffle button is in the
    // dock, which is on every page, so every page needs an answer to "rebuild
    // the queue for this mode" — the library installs its own richer one when it
    // mounts, right after this.
    persistentShell.result.player.setQueueModeChangeHandler(queueModeFallback(persistentShell.result.player));
    // The queue outlives every page, so whatever rebuilds its loaders has to
    // run wherever the reader lands — not only on the music library, which is
    // where this used to live and why shuffling quietly shrank to one window.
    restoreQueueLoaders(persistentShell.result.player);
    return persistentShell.result;
  }
  // Cache only a successful session. A transient failure (e.g. 500 from the bridge)
  // must not be memoised, or every later mount would rethrow the stale rejection.
  preloadLanguage(hintedLanguage());
  sessionPromise ??= requireSession().catch((error: unknown) => {
    sessionPromise = null;
    throw error;
  });
  const session = await sessionPromise;
  await adoptLanguage(session);
  adoptTheme(session);
  applyIconPack(session.settings);
  const player = new AudioPlayer(session);
  player.setEditHandler(shellEditHandler(session));
  await player.ready();
  installFloatingTooltips();
  // A phone: sheets that can be pulled down, and a page that knows when a keyboard is over it.
  installSheetGestures();
  trackKeyboard();
  const root = requireRoot();
  const shell = el("div", { className: "app-shell", dataset: { sidebarOpen: "false" } });
  const sidebar = el("aside", { className: "sidebar", attrs: { id: "app-sidebar", "aria-label": t("Nawigacja główna") } });
  const brand = el(
    "a",
    { className: "brand", attrs: { href: appUrl() } },
    el("span", { className: "brand__mark" }, icon("server")),
    el(
      "span",
      { className: "brand__copy" },
      el("span", { text: "TryHackX Media" }),
      el("small", { text: t("Home server") })
    )
  );
  const user = session.user;
  // Libraries the group cannot access are simply absent from the navigation; the
  // bridge refuses their data anyway, so a bookmarked page shows an empty state.
  const nav = el("nav", { className: "nav-list" }, navLink(t("Start"), "", "home", active === "home"));
  if (canAccessLibrary(session, "music")) nav.append(navLink(t("Muzyka"), "music/", "music", active === "music"));
  if (canAccessLibrary(session, "movies")) nav.append(navLink(t("Filmy"), "movies/", "film", active === "movies"));
  if (can(session, "can_browse_collections")) {
    nav.append(navLink(t("Kolekcje"), "collections/", "list", active === "collections"));
  }
  nav.append(navLink(t("Moje konto"), "account/", "user", active === "account"));
  if (isAdministrator(session)) {
    nav.append(navLink(t("Administracja"), "admin/", "admin", active === "admin"));
  }
  const userChip = el(
    "div",
    { className: "user-chip" },
    el("span", { className: "user-chip__avatar", text: user.username.slice(0, 1).toUpperCase() }),
    el(
      "span",
      { className: "user-chip__copy" },
      el("span", { className: "user-chip__name", text: user.username }),
      el("span", {
        className: "user-chip__role",
        text: user.is_guest ? t("Konto gościa") : t(roleLabels[user.role])
      })
    )
  );
  const logoutButton = el(
    "button",
    { className: "button button--quiet", attrs: { type: "button" } },
    t("Wyloguj")
  );
  logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
      await logout();
    } finally {
      window.location.replace(appUrl("login/?logged_out=1"));
    }
  });
  const footer = el(
    "div",
    { className: "sidebar__footer" },
    userChip,
    logoutButton
  );
  sidebar.append(brand, nav, footer);

  const main = el("div", { className: "app-main" });
  const menuButton = el(
    "button",
    {
      className: "icon-button mobile-menu-button",
      attrs: { type: "button", "aria-label": t("Otwórz menu"), "aria-expanded": "false", "aria-controls": "app-sidebar" }
    },
    icon("menu")
  );
  const actions = el("div", { className: "topbar__actions" });
  const eyebrowElement = el("div", { className: "topbar__eyebrow", text: t(eyebrow) });
  // Focusable from script only: a soft navigation lands the focus here (see above).
  const titleElement = el("h1", { text: t(title), attrs: { tabindex: "-1" } });
  const topbar = el(
    "header",
    { className: "topbar" },
    menuButton,
    el(
      "div",
      { className: "topbar__copy" },
      eyebrowElement,
      titleElement
    ),
    actions
  );
  const content = el("main", { className: "page-content", attrs: { id: "main-content", tabindex: "-1" } });
  main.append(topbar, content);
  const backdrop = el("button", {
    className: "sidebar-backdrop",
    attrs: { type: "button", "aria-label": t("Zamknij menu"), tabindex: "-1" }
  });
  // First thing Tab reaches: past the navigation and the header, into the page.
  // A button rather than a link to #main-content, which the router would take
  // for a navigation and mount the page again.
  const skip = el("button", { className: "skip-link", attrs: { type: "button" } }, t("Przejdź do treści"));
  skip.addEventListener("click", () => content.focus());
  shell.append(skip, sidebar, main, backdrop);
  root.replaceChildren(shell);
  setDocumentTitle(active, title);
  animatePageIn(content);

  /**
   * The navigation as a drawer (below 64rem, the width pages.css slides it off
   * the screen at) and as a column (above).
   *
   * Slid away, it used to stay in the page for the keyboard and for screen
   * readers: Tab walked through six invisible links before reaching anything on
   * screen. A closed drawer is `inert` now; an open one takes the focus and
   * makes the page behind it inert instead, and closing it hands the focus back
   * to the button that opened it. The button says which of the two it will do.
   */
  const drawer = window.matchMedia("(max-width: 64rem)");
  const menuOpen = (): boolean => shell.dataset.sidebarOpen === "true";
  const syncDrawer = (): void => {
    const open = menuOpen();
    sidebar.inert = drawer.matches && !open;
    main.inert = drawer.matches && open;
    menuButton.setAttribute("aria-label", open ? t("Zamknij menu") : t("Otwórz menu"));
  };
  const setMenu = (open: boolean, restoreFocus = true): void => {
    const wasOpen = menuOpen();
    const focusInside = sidebar.contains(document.activeElement);
    shell.dataset.sidebarOpen = String(open);
    menuButton.setAttribute("aria-expanded", String(open));
    document.documentElement.classList.toggle("has-open-sidebar", open);
    syncDrawer();
    if (!drawer.matches || open === wasOpen) return;
    if (open) {
      (nav.querySelector<HTMLElement>('.nav-link[aria-current="page"]') ?? nav.querySelector<HTMLElement>(".nav-link"))
        ?.focus({ preventScroll: true });
    } else if (restoreFocus && (focusInside || document.activeElement === document.body)) {
      menuButton.focus({ preventScroll: true });
    }
  };
  menuButton.addEventListener("click", () => setMenu(!menuOpen()));
  backdrop.addEventListener("click", () => setMenu(false));
  // A link in the drawer leads to another page: that page takes the focus.
  nav.addEventListener("click", () => setMenu(false, false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menuOpen()) setMenu(false);
  });
  drawer.addEventListener("change", syncDrawer);
  syncDrawer();
  const setTitle = (text: string, eyebrowText?: string): void => {
    titleElement.textContent = text;
    if (eyebrowText !== undefined) eyebrowElement.textContent = eyebrowText;
    document.title = persistentShell?.active === "home" ? "TryHackX Media" : `${text} · TryHackX Media`;
  };
  persistentShell = { result: { content, actions, session, player, setTitle }, shell, nav, title: titleElement,
    eyebrow: eyebrowElement, menuButton, active, setMenu };

  // A first mount after a reload has just restored the queue from storage (the
  // ready() above waited for that, and only that — the restored track's stream
  // ticket arrives in the background, after the page is drawn); its loaders were
  // functions and did not survive, so they are rebuilt here too — as is the
  // answer to "the reader pressed shuffle", for the same reason.
  restoreQueueLoaders(player);
  player.setQueueModeChangeHandler(queueModeFallback(player));

  return persistentShell.result;
}

