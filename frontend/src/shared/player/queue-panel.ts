import { el } from "../dom";
import { formatDuration } from "../format";
import { icon } from "../icons";
import { currentLanguage, t } from "../i18n";
import { openModal } from "../modal";
import { prefersReducedMotion } from "../motion";
import type { QueueSync } from "../queue-sync";
import { timeAgo } from "../queue-sync";
import type { PlaybackQueueDevice, QueueDisplay } from "../types";
import { QUEUE_RENDER_LIMIT, QUEUE_RENDER_STEP, type QueueModel } from "./contracts";

/** Numbers follow the interface language, like formatBytes does. */
function locale(): string {
  return currentLanguage() === "en" ? "en-GB" : "pl-PL";
}

/**
 * The queue panel: what is playing next, and what the account is playing
 * elsewhere.
 *
 * It reads the queue through `QueueModel` and reports presses back through it;
 * the queue itself — its window, its paging, what "next" means — is the
 * player's (audio-player.ts).
 *
 * Rows are drawn only while the panel is open. A change made while it is closed
 * marks them stale, and opening draws them: every track change used to rebuild
 * 160 rows (some 2 000 elements) whether or not anybody could see them. With the
 * panel open a track change moves one attribute.
 *
 * On a wide screen it is a panel above the dock that grows out of its button;
 * on a phone, a sheet from the bottom edge that a thumb can pull down
 * (shared/sheet-gestures.ts). Both leave as they came (styles/player.css).
 */
export class QueuePanel {
  public readonly element: HTMLElement;
  public readonly backdrop: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly contextLine: HTMLElement;
  private readonly shuffleToggle: HTMLButtonElement;
  private readonly devices: HTMLElement;
  private devicesAt = 0;
  /** First row of the loaded window that is drawn. */
  private renderStart = 0;
  /** The rows no longer match the queue (changed while the panel was closed). */
  private rowsStale = true;
  private scrollScheduled = false;
  private revealPending = false;
  private scrollCooldownUntil = 0;
  /** Undoes the panel's modality: background inert, focus inside, focus back on close. */
  private releaseModal: (() => void) | null = null;
  private readonly phone = window.matchMedia("(max-width: 46rem)");

  public constructor(private readonly model: QueueModel, private readonly sync: QueueSync | null) {
    this.meta = el("span", { className: "queue-panel__meta", text: t("0 utworów") });
    this.contextLine = el("p", { className: "queue-panel__context", text: t("Nie wybrano playlisty") });
    this.shuffleToggle = el("button", {
      className: "queue-panel__shuffle-toggle",
      attrs: { type: "button", "aria-pressed": String(model.shuffleWithinQueue()) }
    }) as HTMLButtonElement;
    this.shuffleToggle.addEventListener("click", () => this.model.toggleShuffleWithinQueue());
    this.list = el("div", { className: "queue-panel__list", attrs: { tabindex: "0" } });
    this.devices = el("div", { className: "queue-devices hidden", attrs: { "aria-live": "polite" } });
    const close = el(
      "button",
      { className: "player-control", attrs: { type: "button", "aria-label": t("Zamknij") }, dataset: { sheetClose: "" } },
      icon("close")
    );
    close.addEventListener("click", () => this.setOpen(false));
    this.element = el(
      "aside",
      {
        className: "queue-panel",
        attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("Kolejka odtwarzania"), "aria-hidden": "true" }
      },
      // Header and devices share one grid row: the panel's second row is the
      // scrolling list, and a third child would have taken that row away from
      // it — the list would size to its content and stop scrolling.
      el(
        "div",
        { className: "queue-panel__top" },
        el(
          "div",
          { className: "queue-panel__header" },
          el("div", { className: "queue-panel__heading" }, el("h2", { text: t("Kolejka") }), this.contextLine, this.meta, this.shuffleToggle),
          close
        ),
        this.devices
      ),
      this.list
    );
    this.backdrop = el("button", {
      className: "queue-backdrop",
      attrs: { type: "button", "aria-label": t("Zamknij kolejkę"), "aria-hidden": "true", tabindex: "-1" }
    }) as HTMLButtonElement;
    this.backdrop.addEventListener("click", () => this.setOpen(false));
    this.list.addEventListener("scroll", () => this.scheduleScroll());
    // Re-measure the row being pointed at (or focused): only then is the panel
    // certainly open, laid out and using the real font. pointerover is used
    // because pointerenter does not bubble, so one listener covers every row.
    const remeasure = (event: Event): void => {
      const row = (event.target as Element | null)?.closest?.(".queue-item__main");
      if (row instanceof HTMLElement) this.measureMarquee(row);
    };
    this.list.addEventListener("pointerover", remeasure);
    this.list.addEventListener("focusin", remeasure);
    // On a phone it is a sheet, and a sheet can be pulled down.
    const markSheet = (): void => { this.element.dataset.sheet = String(this.phone.matches); };
    this.phone.addEventListener("change", markSheet);
    markSheet();
    this.setShuffleWithinQueue(model.shuffleWithinQueue());
  }

  // --- What the queue says it is ------------------------------------------------------------

  /** "Folder: …", "Playlista: …", or a word about what just happened to the queue. */
  public get context(): string {
    return this.contextLine.textContent ?? "";
  }

  public set context(text: string) {
    this.contextLine.textContent = text;
  }

  public setShuffleWithinQueue(enabled: boolean): void {
    this.shuffleToggle.setAttribute("aria-pressed", String(enabled));
    this.shuffleToggle.textContent = t("Mieszanie załadowanego okna: {state}", { state: enabled ? t("włączone") : t("wyłączone") });
  }

  public isOpen(): boolean {
    return this.element.getAttribute("aria-hidden") === "false";
  }

  // --- Rows -------------------------------------------------------------------------------------

  /**
   * Whose stars a row is showing, said out loud.
   *
   * A number next to a track reads as "your opinion" unless something says
   * otherwise, and here it often is not — so when the playlist put its author's
   * rating there, the tooltip names the author.
   */
  private ratingLabel(columns: QueueDisplay): string {
    if (columns.rating === "average") return t("Średnia ocena");
    if (columns.rating !== "owner") return t("Twoja ocena");
    return columns.ownerName ? t("Ocena autora playlisty ({owner})", { owner: columns.ownerName }) : t("Ocena autora playlisty");
  }

  private favoriteLabel(columns: QueueDisplay): string {
    if (columns.favorite !== "owner") return t("Ulubione");
    return columns.ownerName ? t("Ulubione autora playlisty ({owner})", { owner: columns.ownerName }) : t("Ulubione autora playlisty");
  }

  public updateMeta(): void {
    const length = this.model.items().length;
    if (length === 0) {
      this.meta.textContent = t("0 utworów");
      return;
    }
    const first = this.model.offset() + 1;
    const last = this.model.offset() + length;
    this.meta.textContent = t("Pozycje {first}–{last} z {total}", {
      first: first.toLocaleString(locale()),
      last: last.toLocaleString(locale()),
      total: this.model.total().toLocaleString(locale())
    });
  }

  /** The queue changed: draw it (when open) or remember that it has to be drawn. */
  public render(alignCurrent: boolean): void {
    this.updateMeta();
    const index = this.model.index();
    if (alignCurrent && index >= 0) {
      this.renderStart = Math.max(0, index - Math.floor(QUEUE_RENDER_LIMIT / 3));
    }
    // Rows are drawn for somebody to read. With the panel closed they are only
    // marked out of date, and opening the panel draws them (setOpen).
    if (!this.isOpen()) {
      this.rowsStale = true;
      return;
    }
    this.rowsStale = false;
    const items = this.model.items();
    const maxStart = Math.max(0, items.length - QUEUE_RENDER_LIMIT);
    this.renderStart = Math.min(maxStart, Math.max(0, this.renderStart));
    const end = Math.min(items.length, this.renderStart + QUEUE_RENDER_LIMIT);
    const fragment = document.createDocumentFragment();
    const markOverflowing: HTMLElement[] = [];

    if (this.renderStart > 0 || this.model.hasBefore()) {
      const earlier = el("button", { className: "queue-window-sentinel", attrs: { type: "button" }, text: t("↑ Wcześniejsze utwory") });
      earlier.addEventListener("click", () => void this.revealBefore());
      fragment.append(earlier);
    }
    const columns = this.model.columns();
    const ratingLabel = this.ratingLabel(columns);
    for (let position = this.renderStart; position < end; position += 1) {
      const row = this.row(position, columns, ratingLabel);
      if (!row) continue;
      // Marked once the row is laid out: only lines that really do not fit get
      // the marquee, and each one scrolls exactly as far as it overflows.
      const main = row.querySelector<HTMLElement>(".queue-item__main");
      if (main) markOverflowing.push(main);
      fragment.append(row);
    }
    if (end < items.length || this.model.hasAfter()) {
      const later = el("button", { className: "queue-window-sentinel", attrs: { type: "button" }, text: t("Następne utwory ↓") });
      later.addEventListener("click", () => void this.revealAfter());
      fragment.append(later);
    }
    this.list.replaceChildren(fragment);
    // Measuring needs the rows in the document; one pass after layout keeps it
    // cheap even for a full window of 160 rows. It is only a head start, though:
    // measureMarquee runs again when the pointer arrives, because this first
    // pass can be wrong through no fault of its own (see below).
    window.requestAnimationFrame(() => {
      for (const main of markOverflowing) {
        if (main.isConnected) this.measureMarquee(main);
      }
    });
  }

  /** One row of the queue: the track at `position` of the loaded window, or null past its end. */
  private row(position: number, columns: QueueDisplay, ratingLabel: string): HTMLElement | null {
    const item = this.model.items()[position];
    if (!item) return null;
    const rating = columns.rating === "viewer"
      ? item.rating
      : columns.rating === "owner"
        ? item.owner_rating ?? null
        : columns.rating === "average" ? item.avg_rating : null;
    const favorite = columns.favorite === "viewer"
      ? item.favorite
      : columns.favorite === "owner" ? item.owner_favorite === true : false;
    const main = el(
      "button",
      {
        className: "queue-item__main",
        attrs: { type: "button", "aria-label": t("Odtwórz {title}", { title: item.title }) }
      },
      // Where the row stands in the listing — and, on the row that is playing,
      // three bars that move with the music in its place (styles/player.css).
      el(
        "span",
        { className: "queue-item__lead" },
        columns.index ? el("span", { className: "queue-item__index", text: String(this.model.offset() + position + 1) }) : null,
        el("span", { className: "playing-bars", attrs: { "aria-hidden": "true" } }, el("i"), el("i"), el("i"))
      ),
      el(
        "span",
        { className: "queue-item__copy" },
        // The text lives one level in: the outer line is the clipping box that
        // stays put while the inner one slides (see the marquee rules).
        el("strong", {}, el("span", { className: "queue-item__line", text: item.title })),
        el("small", {}, el("span", { className: "queue-item__line", text: item.artist ?? item.album ?? "" }))
      ),
      el(
        "span",
        { className: "queue-item__meta" },
        favorite
          ? el("span", {
              className: "queue-item__favorite",
              attrs: { title: this.favoriteLabel(columns), "aria-label": this.favoriteLabel(columns) }
            }, icon("heart"))
          : null,
        rating
          ? el("span", {
              className: "queue-item__rating",
              attrs: {
                title: ratingLabel,
                "aria-label": t("{label}: {value}", { label: ratingLabel, value: rating.toFixed(1) })
              }
            }, icon("star"), el("span", { text: rating.toFixed(1) }))
          : null,
        el("span", { className: "queue-item__duration", text: formatDuration(item.duration_ms) })
      )
    );
    main.addEventListener("click", () => this.model.playAt(position));
    const row = el("div", {
      className: "queue-item",
      attrs: { ...(position === this.model.index() ? { "aria-current": "true" } : {}) },
      dataset: { queueIndex: position, mediaId: item.id }
    }, main);
    const collect = this.model.collector();
    if (collect) {
      const add = el("button", {
        className: "icon-button queue-item__collection",
        attrs: { type: "button", "aria-label": t("Dodaj {title} do kolekcji", { title: item.title }) }
      }, icon("list"));
      add.dataset.tooltip = t("Dodaj do kolekcji");
      add.addEventListener("click", () => collect(item));
      row.append(add);
    }
    return row;
  }

  /**
   * Rebuild the rows of one track in place, leaving the rest of the list alone
   * (a star given on one track used to redraw the whole window of 160).
   */
  public repaintRow(mediaId: number): void {
    if (!this.isOpen() || this.rowsStale) {
      this.rowsStale = true;
      return;
    }
    const columns = this.model.columns();
    const ratingLabel = this.ratingLabel(columns);
    for (const row of this.list.querySelectorAll<HTMLElement>(`.queue-item[data-media-id="${mediaId}"]`)) {
      const fresh = this.row(Number(row.dataset.queueIndex), columns, ratingLabel);
      if (!fresh) continue;
      row.replaceWith(fresh);
      const main = fresh.querySelector<HTMLElement>(".queue-item__main");
      if (main) window.requestAnimationFrame(() => { if (main.isConnected) this.measureMarquee(main); });
    }
  }

  /**
   * Show which row is playing, by moving one attribute.
   *
   * A track change used to redraw the whole window; the rows are the same rows,
   * only the marker moves. They are redrawn when the playing track is outside
   * the drawn window (or the rows are stale), and not at all while the panel is
   * closed — opening it draws them.
   */
  public markCurrent(): void {
    if (!this.isOpen()) return;
    if (this.rowsStale) {
      this.render(true);
      return;
    }
    const index = this.model.index();
    const next = index >= 0 ? this.list.querySelector<HTMLElement>(`.queue-item[data-queue-index="${index}"]`) : null;
    if (index >= 0 && !next) {
      this.render(true);
      return;
    }
    const previous = this.list.querySelector<HTMLElement>('.queue-item[aria-current="true"]');
    if (previous === next) return;
    previous?.removeAttribute("aria-current");
    next?.setAttribute("aria-current", "true");
  }

  /**
   * Decide which lines of one row are too long to fit, and how far they scroll.
   *
   * Measured again whenever a pointer or focus arrives, because the first pass
   * after rendering can measure the wrong thing: the panel may still be closed
   * (everything is zero wide), the web font may not have arrived yet (the
   * fallback font is narrower, so a title that will overflow does not yet), or
   * the panel may have been resized since. By the time someone hovers a row,
   * layout is settled and the answer is right.
   */
  private measureMarquee(main: HTMLElement): void {
    for (const box of main.querySelectorAll<HTMLElement>(".queue-item__copy > *")) {
      const line = box.firstElementChild as HTMLElement | null;
      const width = box.clientWidth;
      // Nothing has a width while the panel is closed; leave the row alone
      // rather than recording "it fits".
      if (!line || width === 0) continue;
      const shift = line.scrollWidth - width;
      // One pixel is enough: at four, a title clipped by two or three pixels
      // showed an ellipsis and then refused to scroll, which reads as broken.
      // ("(Everything I Do) I Do It for You" misses by 1.6px in a 412px panel.)
      if (shift >= 1) {
        box.dataset.overflow = "true";
        box.style.setProperty("--queue-marquee-shift", `${shift}px`);
        // Roughly 55 px a second of travel, held briefly at each end, so the
        // text starts moving a fraction of a second after the pointer lands
        // instead of a second and a half later.
        box.style.setProperty("--queue-marquee-time", `${Math.min(9, Math.max(3, shift / 20)).toFixed(1)}s`);
      } else {
        delete box.dataset.overflow;
      }
    }
  }

  // --- The window of rows moves with the scroll -----------------------------------------------

  private scheduleScroll(): void {
    if (this.scrollScheduled) return;
    this.scrollScheduled = true;
    window.requestAnimationFrame(() => {
      this.scrollScheduled = false;
      if (this.revealPending || performance.now() < this.scrollCooldownUntil) return;
      if (this.list.scrollTop <= 32) void this.revealBefore();
      else if (this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight <= 32) void this.revealAfter();
    });
  }

  private async revealBefore(): Promise<void> {
    if (this.revealPending) return;
    this.revealPending = true;
    const anchor = this.captureAnchor();
    try {
      if (this.renderStart > 0) {
        this.renderStart = Math.max(0, this.renderStart - QUEUE_RENDER_STEP);
        this.render(false);
        this.restoreAnchor(anchor);
        return;
      }
      const added = await this.model.loadPage("before");
      if (added > 0) {
        this.renderStart = Math.max(0, this.renderStart - QUEUE_RENDER_STEP);
        this.render(false);
        this.restoreAnchor(anchor);
      }
    } finally {
      this.releaseRevealLock();
    }
  }

  private async revealAfter(): Promise<void> {
    if (this.revealPending) return;
    this.revealPending = true;
    const anchor = this.captureAnchor();
    try {
      let canAdvance = this.renderStart + QUEUE_RENDER_LIMIT < this.model.items().length;
      if (!canAdvance) {
        const added = await this.model.loadPage("after");
        canAdvance = added > 0;
      }
      if (!canAdvance) return;
      this.renderStart = Math.min(
        Math.max(0, this.model.items().length - QUEUE_RENDER_LIMIT),
        this.renderStart + QUEUE_RENDER_STEP
      );
      this.render(false);
      this.restoreAnchor(anchor);
    } finally {
      this.releaseRevealLock();
    }
  }

  private captureAnchor(): { mediaId: string; offset: number } | null {
    const listBounds = this.list.getBoundingClientRect();
    const rows = this.list.querySelectorAll<HTMLElement>(".queue-item[data-media-id]");
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom > listBounds.top + 1) {
        return { mediaId: row.dataset.mediaId ?? "", offset: bounds.top - listBounds.top };
      }
    }
    return null;
  }

  private restoreAnchor(anchor: { mediaId: string; offset: number } | null): void {
    if (!anchor?.mediaId) return;
    const row = this.list.querySelector<HTMLElement>('[data-media-id="' + anchor.mediaId + '"]');
    if (!row) return;
    const listBounds = this.list.getBoundingClientRect();
    const currentOffset = row.getBoundingClientRect().top - listBounds.top;
    this.list.scrollTop += currentOffset - anchor.offset;
  }

  private releaseRevealLock(): void {
    this.scrollCooldownUntil = performance.now() + 180;
    window.requestAnimationFrame(() => { this.revealPending = false; });
  }

  /**
   * A page of the queue arrived (`added` tracks in `direction`), and the window
   * may have been trimmed at the other end (`trimmedBefore` rows gone from its
   * start): the rows follow, without the list jumping under the reader.
   */
  public pageLoaded(direction: "before" | "after", added: number, trimmedBefore: number): void {
    if (direction === "before" && added > 0) this.renderStart += added;
    if (trimmedBefore > 0) this.renderStart = Math.max(0, this.renderStart - trimmedBefore);
    this.updateMeta();
    if (this.isOpen()) {
      const anchor = this.captureAnchor();
      this.render(false);
      this.restoreAnchor(anchor);
    } else {
      this.rowsStale = true;
    }
  }

  public scrollToCurrent(behavior: ScrollBehavior = "auto", highlight = false): void {
    let row = this.list.querySelector<HTMLElement>('[aria-current="true"]');
    const index = this.model.index();
    if (!row && index >= 0) {
      this.renderStart = Math.max(0, index - Math.floor(QUEUE_RENDER_LIMIT / 2));
      this.render(false);
      row = this.list.querySelector<HTMLElement>('[aria-current="true"]');
    }
    row?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    if (row && highlight) {
      // A short flash marks where the random jump landed once the scroll settles.
      row.classList.add("queue-item--jumped");
      window.setTimeout(() => row.classList.remove("queue-item--jumped"), 1400);
    }
  }

  /**
   * The window was replaced by one around another place in the listing (a jump
   * through a shuffled library): draw it from the top and glide down to the
   * track that was picked — the visible "spin" of the jump — instead of
   * teleporting the list onto it.
   */
  public glideToCurrent(): void {
    if (!this.isOpen()) return;
    const reduced = prefersReducedMotion();
    this.scrollCooldownUntil = performance.now() + (reduced ? 0 : 900);
    if (!reduced) this.list.scrollTop = 0;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => this.scrollToCurrent(reduced ? "auto" : "smooth", true));
    });
  }

  // --- The account's other devices ------------------------------------------------------------

  /**
   * The other devices of this account, drawn above the queue.
   *
   * Fetched when the panel opens rather than kept live: a list of two or three
   * rows that nobody is looking at is not worth a poll, and the moment somebody
   * wants to know what is playing in the other room is the moment they open
   * this panel.
   */
  private async renderDevices(): Promise<void> {
    const sync = this.sync;
    if (!sync) return;
    if (Date.now() - this.devicesAt < 4000) return;
    this.devicesAt = Date.now();
    let devices: PlaybackQueueDevice[] = [];
    try {
      devices = await sync.others();
    } catch {
      return;
    }
    this.devices.replaceChildren();
    this.devices.classList.toggle("hidden", devices.length === 0);
    if (devices.length === 0) return;
    // Signed in there now — "Przejmij" pauses that device and plays on here.
    // Its session has ended by itself — nothing is playing there to take from,
    // so "Wznów tutaj", and it can be forgotten. Signed-out devices are not
    // listed at all (CatalogActions::visibleQueueDevices).
    const live = devices.filter((device) => device.is_live !== false);
    const recent = devices.filter((device) => device.is_live === false);
    const group = (title: string, rows: PlaybackQueueDevice[]): void => {
      if (rows.length === 0) return;
      this.devices.append(el("h3", { className: "queue-devices__title", text: title }));
      for (const device of rows) this.devices.append(this.deviceRow(device));
    };
    group(t("Na innych urządzeniach"), live);
    group(t("Ostatnio na innych urządzeniach"), recent);
  }

  /** One row of the device list: what it was playing, when, and what can be done with it. */
  private deviceRow(device: PlaybackQueueDevice): HTMLElement {
    const live = device.is_live !== false;
    const take = el(
      "button",
      { className: "button button--ghost queue-devices__take", attrs: { type: "button" } },
      icon("play"),
      el("span", { text: live ? t("Przejmij") : t("Wznów tutaj") })
    );
    take.addEventListener("click", () => {
      take.disabled = true;
      void this.model.takeOver(device)
        .then((taken) => {
          if (!taken) {
            this.context = t("Nie udało się przejąć kolejki.");
            return;
          }
          // The list on screen still shows that device as playing, because it
          // was when it was drawn. Past the throttle: this is the one moment
          // the row is certainly stale.
          this.devicesAt = 0;
          void this.renderDevices();
        })
        .finally(() => { take.disabled = false; });
    });
    const actions = el("div", { className: "queue-devices__actions" }, take);
    if (!live) {
      const forget = el(
        "button",
        {
          className: "icon-button queue-devices__forget",
          attrs: { type: "button", "aria-label": t("Zapomnij to urządzenie"), title: t("Zapomnij to urządzenie") }
        },
        icon("close")
      );
      forget.addEventListener("click", () => {
        forget.disabled = true;
        void this.forgetDevice(device).finally(() => { forget.disabled = false; });
      });
      actions.append(forget);
    }
    return el(
      "div",
      { className: "queue-devices__row" + (device.is_playing && live ? " is-playing" : "") },
      el(
        "div",
        { className: "queue-devices__copy" },
        el("strong", { text: device.device_label || t("Nieznane urządzenie") }),
        el("span", {
          text: device.track
            ? [device.track.title, device.track.artist].filter(Boolean).join(" · ")
            : t("Kolejka bez utworu")
        }),
        el("small", {
          // "odtwarza" only where somebody is there to hear it: a row whose
          // session ended mid-track still says it was playing.
          text: [device.context, device.is_playing && live ? t("odtwarza") : timeAgo(device.updated_at)]
            .filter(Boolean)
            .join(" · ")
        })
      ),
      actions
    );
  }

  /** "Zapomnij to urządzenie": its stored queue goes, and the list is drawn again. */
  private async forgetDevice(device: PlaybackQueueDevice): Promise<void> {
    const sync = this.sync;
    if (!sync) return;
    try {
      await sync.forget(device.device_id);
    } catch {
      this.context = t("Nie udało się zapomnieć urządzenia.");
      return;
    }
    this.devicesAt = 0;
    await this.renderDevices();
  }

  // --- Open and closed -----------------------------------------------------------------------------

  /**
   * Open or close the panel.
   *
   * It says it is a modal dialog and behaves like one: the page behind it is
   * inert, focus moves into the list, Escape closes it and focus returns to
   * whatever opened it. The dock stays usable — it sits above the backdrop on
   * purpose, so the music can be paused or skipped with the queue open — and so
   * does the backdrop, which closes the panel on a click.
   */
  public setOpen(open: boolean): void {
    const wasOpen = this.isOpen();
    this.element.setAttribute("aria-hidden", String(!open));
    this.backdrop.setAttribute("aria-hidden", String(!open));
    document.documentElement.classList.toggle("has-open-queue", open);
    if (!open) {
      this.releaseModal?.();
      this.releaseModal = null;
      return;
    }
    // Drawn now if anything changed while it was closed; otherwise the rows are
    // already right and only the playing one may have moved.
    if (this.rowsStale) this.render(true);
    else this.markCurrent();
    void this.renderDevices();
    if (!wasOpen) {
      // The list stands on the playing track from its first frame, and the rows
      // in view arrive one after another, once per opening.
      this.scrollToCurrent("auto");
      this.arriveRows();
      this.releaseModal?.();
      this.releaseModal = openModal(this.element, {
        onEscape: () => this.setOpen(false),
        initialFocus: this.list,
        alsoActive: this.model.surfaces()
      });
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      this.scrollToCurrent(wasOpen ? "smooth" : "auto");
      if (this.isOpen() && !this.element.contains(document.activeElement)) {
        this.list.focus({ preventScroll: true });
      }
    }));
  }

  public toggle(): void {
    this.setOpen(!this.isOpen());
  }

  /** Mark the rows that are in view (a dozen at most) to arrive in turn (styles/player.css). */
  private arriveRows(): void {
    if (prefersReducedMotion()) return;
    const bounds = this.list.getBoundingClientRect();
    const marked: HTMLElement[] = [];
    for (const row of this.list.querySelectorAll<HTMLElement>(".queue-item")) {
      const box = row.getBoundingClientRect();
      if (box.bottom < bounds.top) continue;
      if (box.top > bounds.bottom || marked.length >= 12) break;
      row.style.setProperty("--row-step", String(marked.length));
      row.dataset.arriving = "true";
      marked.push(row);
    }
    window.setTimeout(() => {
      for (const row of marked) {
        delete row.dataset.arriving;
        row.style.removeProperty("--row-step");
      }
    }, 700);
  }
}
