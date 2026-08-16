import "../styles/index.css";

import { apiBase } from "../shared/config";
import { el, requireRoot } from "../shared/dom";
import { formatDuration } from "../shared/format";
import { icon } from "../shared/icons";
import { t } from "../shared/i18n";

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
  return (await response.json()) as T;
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
  const meta = el("p", { className: "muted", text: [
    view.items.length === 1 ? t("1 pozycja") : t("{count} pozycji", { count: view.items.length.toLocaleString("pl-PL") }),
    t("ważny do {when}", { when: view.expires_at.slice(0, 16).replace("T", " ") }),
    budget()
  ].join(" · ") });

  const play = async (item: GuestItem): Promise<void> => {
    status.textContent = t("Przygotowywanie…");
    try {
      const answer = await transfer(item.id, true);
      const media = el(item.media_kind === "video" ? "video" : "audio", {
        className: "guest-player__media",
        attrs: { controls: true, autoplay: true, src: answer.transfer.url }
      });
      stage.replaceChildren(el("p", { className: "guest-player__title", text: item.title }), media);
      status.textContent = "";
    } catch (error) {
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
      status
    ),
    stage,
    el("ol", { className: "guest-list" }, ...view.items.map((item) => {
      const listen = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("play"), el("span", { text: t("Odtwórz") }));
      listen.addEventListener("click", () => void play(item));
      const save = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Pobierz {title}", { title: item.title }) } }, icon("download"));
      save.addEventListener("click", () => void download(item));
      return el("li", { className: "guest-item" },
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
