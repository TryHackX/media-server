import { ApiError, getSession, logout } from "./api";
import { queueModeFallback, restoreQueueLoaders } from "./queue-loaders";
import { AudioPlayer } from "./audio-player";
import { appUrl } from "./config";
import { el, requireRoot } from "./dom";
import { icon, type IconName } from "./icons";
import { setLanguage, t } from "./i18n";
import { MetadataEditor } from "./metadata-editor";
import { can, canAccessLibrary, canEditMetadata, isAdministrator } from "./permissions";
import type { MediaItem, SessionResponse, UserRole } from "./types";
import { installFloatingTooltips } from "./tooltips";

type ActivePage = "home" | "music" | "movies" | "collections" | "account" | "admin";

interface ShellResult {
  content: HTMLElement;
  actions: HTMLElement;
  session: SessionResponse;
  player: AudioPlayer;
}

interface PersistentShell {
  result: ShellResult;
  shell: HTMLElement;
  nav: HTMLElement;
  title: HTMLElement;
  eyebrow: HTMLElement;
  menuButton: HTMLButtonElement;
  setMenu(open: boolean): void;
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
function adoptLanguage(session: SessionResponse): void {
  // The document's own `lang` is set here rather than inside the translator, so
  // that module stays free of the DOM and can be unit-tested on its own.
  document.documentElement.lang = setLanguage(session.preferences?.language);
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

async function requireSession(): Promise<SessionResponse> {
  try {
    return await getSession();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status === 401 || error.status === 403) {
      window.location.assign(appUrl("login/"));
    }
    throw error;
  }
}

function updateActiveNavigation(nav: HTMLElement, active: ActivePage): void {
  for (const link of nav.querySelectorAll<HTMLAnchorElement>(".nav-link")) {
    const target = new URL(link.href, window.location.origin).pathname;
    const expected = active === "home" ? appUrl() : appUrl(`${active}/`);
    if (target === expected || (active === "account" && target === appUrl("account/"))) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

export async function mountShell(
  active: ActivePage,
  title: string,
  eyebrow: string
): Promise<ShellResult> {
  if (persistentShell?.shell.isConnected) {
    persistentShell.title.textContent = t(title);
    persistentShell.eyebrow.textContent = t(eyebrow);
    updateActiveNavigation(persistentShell.nav, active);
    persistentShell.setMenu(false);
    persistentShell.result.actions.replaceChildren();
    persistentShell.result.content.replaceChildren();
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
  sessionPromise ??= requireSession().catch((error: unknown) => {
    sessionPromise = null;
    throw error;
  });
  const session = await sessionPromise;
  adoptLanguage(session);
  const player = new AudioPlayer(session);
  player.setEditHandler(shellEditHandler(session));
  await player.ready();
  installFloatingTooltips();
  const root = requireRoot();
  const shell = el("div", { className: "app-shell", dataset: { sidebarOpen: "false" } });
  const sidebar = el("aside", { className: "sidebar", attrs: { "aria-label": t("Nawigacja główna") } });
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
  if (canAccessLibrary(session, "music")) nav.append(navLink("Music", "music/", "music", active === "music"));
  if (canAccessLibrary(session, "movies")) nav.append(navLink("Movies", "movies/", "film", active === "movies"));
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
      attrs: { type: "button", "aria-label": t("Otwórz menu"), "aria-expanded": "false" }
    },
    icon("menu")
  );
  const actions = el("div", { className: "topbar__actions" });
  const eyebrowElement = el("div", { className: "topbar__eyebrow", text: t(eyebrow) });
  const titleElement = el("h1", { text: t(title) });
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
  const content = el("main", { className: "page-content", attrs: { id: "main-content" } });
  main.append(topbar, content);
  const backdrop = el("button", {
    className: "sidebar-backdrop",
    attrs: { type: "button", "aria-label": t("Zamknij menu"), tabindex: "-1" }
  });
  shell.append(sidebar, main, backdrop);
  root.replaceChildren(shell);

  const setMenu = (open: boolean): void => {
    shell.dataset.sidebarOpen = String(open);
    menuButton.setAttribute("aria-expanded", String(open));
    document.documentElement.classList.toggle("has-open-sidebar", open);
  };
  menuButton.addEventListener("click", () => setMenu(shell.dataset.sidebarOpen !== "true"));
  backdrop.addEventListener("click", () => setMenu(false));
  nav.addEventListener("click", () => setMenu(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setMenu(false);
    }
  });
  persistentShell = { result: { content, actions, session, player }, shell, nav, title: titleElement,
    eyebrow: eyebrowElement, menuButton, setMenu };

  // A first mount after a reload has just restored the queue from storage (the
  // ready() above waited for it); its loaders were functions and did not
  // survive, so they are rebuilt here too — as is the answer to "the reader
  // pressed shuffle", for the same reason.
  restoreQueueLoaders(player);
  player.setQueueModeChangeHandler(queueModeFallback(player));

  return persistentShell.result;
}

