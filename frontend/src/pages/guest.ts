import "../styles/core.css";

import { apiBase } from "../shared/config";
import { adoptIsoTimes } from "../shared/datetime";
import { el, requireRoot } from "../shared/dom";
import { formatDateTime, formatDuration } from "../shared/format";
import { icon, primeIconFont } from "../shared/icons";
import { DEFAULT_LANGUAGE, isLanguage, loadLanguage, t, tn } from "../shared/i18n";

// A visitor has no account to read a language from, so this page follows the
// browser, exactly as the sign-in page does. It used to be Polish for everybody,
// including whoever was sent the link from abroad.
primeIconFont();

// English words are a chunk of their own (i18n-en.ts), waited for before anything is drawn.
const browserLanguage = navigator.language.slice(0, 2).toLowerCase();
document.documentElement.lang = await loadLanguage(isLanguage(browserLanguage) ? browserLanguage : DEFAULT_LANGUAGE);

/**
 * What somebody without an account sees when they open a shared link.
 *
 * Deliberately not the application: no shell, no navigation, no session, no
 * player dock. A visitor is here for one folder or one playlist, and everything
 * that is not that list would be either useless to them or something they
 * should not be shown. The page holds one `<audio>`/`<video>` element and a
 * list of titles.
 *
 * It also asks for nothing. The token in the address is the whole credential,
 * and the server decides from it alone what may be listed and fetched.
 */

interface GuestItem {
  id: number;
  title: string;
  artist: string | null;
  media_kind: string;
  duration_ms: number;
}

interface GuestView {
  label: string;
  target_kind: "directory" | "collection";
  expires_at: string;
  max_downloads: number;
  downloads_used: number;
  items: GuestItem[];
  /** How many files the link covers; the list stops earlier when `truncated`. */
  total?: number;
  truncated?: boolean;
}

interface GuestTransfer {
  url: string;
  name: string;
  media_kind: string;
}

const token = new URLSearchParams(window.location.search).get("token") ?? "";

async function ask<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "omit", headers: { Accept: "application/json", ...init?.headers } });
  if (!response.ok) {
    const message = await response.json().catch(() => ({}));
    throw new Error(typeof message.message === "string" ? message.message : t("Ten link wygasł albo nie istnieje."));
  }
  return adoptIsoTimes((await response.json()) as T);
}

function transfer(itemId: number, inline: boolean): Promise<{ transfer: GuestTransfer }> {
  return ask<{ transfer: GuestTransfer }>(`${apiBase}?action=guest_file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, media_item_id: itemId, inline })
  });
}

export async function mount(): Promise<void> {
  const root = requireRoot();
  const host = el("main", { className: "guest-page" });
  root.replaceChildren(host);
  if (!token) {
    host.append(el("div", { className: "notice notice--error", text: t("Ten link wygasł albo nie istnieje.") }));
    return;
  }

  let view: GuestView;
  try {
    view = (await ask<{ guest: GuestView }>(`${apiBase}?action=guest&token=${encodeURIComponent(token)}`)).guest;
  } catch (error) {
    host.append(el("div", { className: "notice notice--error", text: error instanceof Error ? error.message : t("Ten link wygasł albo nie istnieje.") }));
    return;
  }

  const status = el("p", { className: "form-status", attrs: { role: "status" } });
  const stage = el("div", { className: "guest-player" });
  const budget = (): string => view.max_downloads > 0
    ? t("Pobrania: {used} z {max}", { used: String(view.downloads_used), max: String(view.max_downloads) })
    : t("Bez limitu pobrań");
  const total = view.total ?? view.items.length;
  const meta = el("p", { className: "muted", text: [
    tn(total, { one: "{count} pozycja", few: "{count} pozycje", many: "{count} pozycji" }),
    t("ważny do {when}", { when: formatDateTime(view.expires_at) }),
    budget()
  ].join(" · ") });
  // The server lists the first part of a large share; say so instead of
  // letting the visitor take it for everything.
  const cut = view.truncated
    ? el("p", { className: "muted", text: t("Na liście jest pierwsze {shown} z {total} pozycji.", {
        shown: String(view.items.length), total: String(total)
      }) })
    : null;

  /** Only the newest press of "play" may put a player on the page. */
  let playRequest = 0;
  const play = async (item: GuestItem): Promise<void> => {
    const request = ++playRequest;
    status.textContent = t("Przygotowywanie…");
    try {
      const answer = await transfer(item.id, true);
      if (request !== playRequest) return;
      const media = el(item.media_kind === "video" ? "video" : "audio", {
        className: "guest-player__media",
        attrs: { controls: true, autoplay: true, src: answer.transfer.url }
      });
      // A file this browser cannot play (or a ticket that ran out during a long
      // pause) used to leave a silent player and no word about it.
      media.addEventListener("error", () => {
        if (request !== playRequest) return;
        status.textContent = t("Tego pliku nie udało się odtworzyć w tej przeglądarce. Spróbuj go pobrać.");
      });
      // A shared playlist plays through, like a playlist: the next title on the
      // list follows, of the same kind — an album goes on, a film does not start
      // another film unasked.
      media.addEventListener("ended", () => {
        if (request !== playRequest || item.media_kind === "video") return;
        const following = view.items[view.items.indexOf(item) + 1];
        if (following && following.media_kind === item.media_kind) void play(following);
      });
      stage.replaceChildren(el("p", { className: "guest-player__title", text: item.title }), media);
      for (const row of Array.from(host.querySelectorAll<HTMLElement>(".guest-item"))) {
        if (row.dataset.itemId === String(item.id)) row.setAttribute("aria-current", "true");
        else row.removeAttribute("aria-current");
      }
      status.textContent = "";
    } catch (error) {
      if (request !== playRequest) return;
      status.textContent = error instanceof Error ? error.message : t("Nie udało się odtworzyć.");
    }
  };

  const download = async (item: GuestItem): Promise<void> => {
    status.textContent = t("Przygotowywanie…");
    try {
      const answer = await transfer(item.id, false);
      view.downloads_used += 1;
      meta.textContent = meta.textContent!.replace(/[^·]+$/, " " + budget());
      window.location.assign(answer.transfer.url);
      status.textContent = "";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : t("Nie udało się pobrać pliku.");
    }
  };

  host.append(
    el("header", { className: "guest-header" },
      el("span", { className: "eyebrow", text: view.target_kind === "collection" ? t("Udostępniona playlista") : t("Udostępniony folder") }),
      el("h1", { text: view.label }),
      meta,
      cut,
      status
    ),
    stage,
    el("ol", { className: "guest-list" }, ...view.items.map((item) => {
      const listen = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("play"), el("span", { text: t("Odtwórz") }));
      listen.addEventListener("click", () => void play(item));
      const save = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Pobierz {title}", { title: item.title }) } }, icon("download"));
      save.addEventListener("click", () => void download(item));
      return el("li", { className: "guest-item", dataset: { itemId: item.id } },
        el("div", { className: "guest-item__copy" },
          el("strong", { text: item.title }),
          el("span", { text: [item.artist, item.duration_ms ? formatDuration(item.duration_ms) : ""].filter(Boolean).join(" · ") })),
        el("div", { className: "guest-item__actions" }, listen, save));
    })),
    el("footer", { className: "guest-footer" },
      el("p", { className: "muted", text: t("Ten link został udostępniony przez właściciela biblioteki. Nie wymaga konta i przestanie działać po upływie ważności.") }))
  );
}

void mount();
