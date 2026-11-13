import { appUrl } from "../config";
import { el } from "../dom";
import { formatBytes, formatDuration } from "../format";
import { icon, type IconName } from "../icons";
import { currentLanguage, t, tn } from "../i18n";
import { openModal } from "../modal";
import { flipFrom, prefersReducedMotion, pulse } from "../motion";
import { DURATION, EASE_EXIT, EASE_OUT, flipInvert, flipTransform } from "../motion-math";
import { can } from "../permissions";
import { queueSourceView, type QueueSourceKind, type RepeatMode, type ShuffleMode } from "../player-state";
import type { MediaItem, QueueSourceState, SessionResponse } from "../types";
import { DOCK_TWO_ROWS_REM, PHONE_PLAYER, type DockHandlers } from "./contracts";

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

/** How far along a range input stands, for the stylesheet that draws its filled part (`--fill`). */
function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 1;
  const fraction = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty("--fill", `${Math.min(100, Math.max(0, fraction * 100)).toFixed(2)}%`);
}

/**
 * The player's dock: what is playing, and the controls for it, along the bottom
 * edge of every page.
 *
 * It draws and reports — the handlers it is given are the player's
 * (audio-player.ts); nothing about the queue or the audio element is known here.
 *
 * It is one set of elements in three arrangements, chosen by the room there is
 * (styles/player.css):
 *
 * - **a wide dock**: one row — the track, the transport and the timeline, the
 *   volume and the extras;
 * - **a narrower one** (a tablet, a small window): two rows, which can be folded
 *   to one (remembered);
 * - **a phone**: a mini-player — the cover, the title, play, next and the
 *   queue, a thin line of progress along its top edge — that opens into a sheet
 *   covering the screen, with everything in it. The mini-player is what a visit
 *   starts with, always: a sheet over the page is something a person opens,
 *   never something a reload restores.
 *
 * Opening and closing the sheet moves the cover from its small place to its
 * large one and back (FLIP: the layout changes at once, the cover is drawn where
 * it was and released), while the sheet itself is uncovered from the bottom
 * edge. Opacity, transform and clip-path only; none of it under reduced motion.
 */
export class PlayerDock {
  public readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly technical: HTMLButtonElement;
  private technicalViews: string[] = [];
  private technicalViewIndex = 0;
  private technicalTimer = 0;
  /** "Playing from": the playlist, folder or search the queue was built from. */
  private readonly sourceLink: HTMLAnchorElement;
  private readonly artwork: HTMLElement;
  private readonly artworkImage: HTMLImageElement;
  /** The cover again, enlarged and blurred, behind the open sheet. */
  private readonly ambient: HTMLImageElement;
  private readonly track: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly shuffleButton: HTMLButtonElement;
  private readonly repeatButton: HTMLButtonElement;
  private readonly progress: HTMLInputElement;
  private readonly elapsed: HTMLElement;
  private readonly total: HTMLElement;
  /** The mini-player's line of progress. */
  private readonly line: HTMLElement;
  private readonly volume: HTMLInputElement;
  private readonly volumeButton: HTMLButtonElement;
  private readonly rating: HTMLElement;
  private readonly favoriteButton: HTMLButtonElement;
  private readonly editControl: HTMLButtonElement;
  private readonly visualizerControl: HTMLButtonElement;
  private readonly collapseButton: HTMLButtonElement;
  /** Folded to one row — a tablet's and (where the operator allows it) a desktop's remembered choice. */
  private collapsed: boolean;
  /** The phone's sheet is open. Never remembered. */
  private sheet = false;
  private releaseSheet: (() => void) | null = null;
  private sheetAnimations: Animation[] = [];
  private readonly phone = window.matchMedia(PHONE_PLAYER);
  /** Until the dock has a width of its own to go by: the window that leaves it two rows beside the sidebar. */
  private readonly narrowWindow = window.matchMedia("(max-width: 85rem)");
  /** Whether the dock stood in two rows when last asked; see `fitRows`. */
  private twoRows = false;
  private fitScheduled = false;

  public constructor(private readonly session: SessionResponse, private readonly handlers: DockHandlers) {
    this.title = el("strong", { className: "audio-dock__title", text: t("Wybierz utwór") });
    this.sourceLink = el("a", { className: "audio-dock__source hidden", attrs: { href: appUrl("music/") } }) as HTMLAnchorElement;
    this.subtitle = el("span", { className: "audio-dock__subtitle", text: t("Kolejka jest pusta") });
    this.technical = el("button", {
      className: "audio-dock__technical",
      attrs: { type: "button", "aria-label": t("Przełącz szczegóły utworu") }
    }) as HTMLButtonElement;
    this.technical.addEventListener("click", () => {
      this.showNextTechnicalView();
      // A hand-picked view deserves a full interval before the rotation moves on.
      this.restartTechnicalRotation();
    });
    this.artworkImage = el("img", { className: "audio-dock__artwork-image", attrs: { alt: "" } });
    this.artworkImage.addEventListener("load", () => this.artwork.classList.add("has-image"));
    this.artworkImage.addEventListener("error", () => this.artwork.classList.remove("has-image"));
    this.artwork = el("span", { className: "audio-dock__artwork" }, icon("music"), this.artworkImage);
    this.ambient = el("img", { className: "audio-dock__ambient", attrs: { alt: "", "aria-hidden": "true" } });
    this.playButton = el(
      "button",
      { className: "player-control player-control--primary", attrs: { type: "button", "aria-label": t("Odtwórz") } },
      icon("play")
    );
    this.playButton.addEventListener("click", () => this.handlers.playPause());
    this.progress = el("input", {
      className: "audio-dock__progress range",
      attrs: { type: "range", min: "0", max: "1000", value: "0", "aria-label": t("Pozycja utworu") }
    });
    this.progress.addEventListener("input", () => {
      paintRange(this.progress);
      this.handlers.seek(Number(this.progress.value) / 1000);
    });
    this.elapsed = el("span", { className: "audio-dock__time audio-dock__time--elapsed", text: "0:00" });
    this.total = el("span", { className: "audio-dock__time audio-dock__time--total", text: "0:00" });
    this.line = el("span", { className: "audio-dock__line", attrs: { "aria-hidden": "true" } }, el("span", { className: "audio-dock__line-fill" }));
    this.rating = el("div", { className: "now-rating" });
    this.favoriteButton = el(
      "button",
      { className: "player-control audio-dock__favorite", attrs: { type: "button", "aria-label": t("Ulubione") } },
      icon("heart")
    );
    this.favoriteButton.addEventListener("click", () => this.handlers.toggleFavorite());
    const previous = this.control("previous", t("Poprzedni"), () => this.handlers.previous());
    previous.classList.add("audio-dock__previous");
    const next = this.control("next", t("Następny"), () => this.handlers.next());
    next.classList.add("audio-dock__next");
    this.shuffleButton = this.control("shuffle", t("Losowanie"), () => this.handlers.cycleShuffle());
    this.shuffleButton.classList.add("audio-dock__shuffle");
    this.shuffleButton.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.handlers.toggleShuffleWithinQueue();
    });
    this.repeatButton = this.control("repeat", t("Powtarzanie"), () => this.handlers.cycleRepeat());
    this.repeatButton.classList.add("audio-dock__repeat");
    this.volume = el("input", {
      className: "audio-dock__volume range",
      attrs: { type: "range", min: "0", max: "1", step: "0.01", value: "0.8", "aria-label": t("Głośność") }
    });
    this.volume.addEventListener("input", () => {
      paintRange(this.volume);
      this.handlers.setVolume(Number(this.volume.value));
    });
    this.volumeButton = this.control("volume", t("Wycisz"), () => this.handlers.toggleMute());
    this.volumeButton.classList.add("audio-dock__mute");

    // The buttons are a group of their own for the phone's sheet, where a screen
    // too narrow for the stars and the buttons on one line moves the buttons
    // down together (styles/player.css); elsewhere the group is not a box at all.
    const tools = el("div", { className: "audio-dock__tools" }, this.favoriteButton);
    const extras = el("div", { className: "audio-dock__extras" }, this.rating, tools);
    this.favoriteButton.classList.toggle("hidden", !can(session, "can_favorite"));
    // Shown only while the page offers an editor (setEditable), never as a dead
    // control: the right to edit tags is a group permission.
    this.editControl = this.control("edit", t("Edytuj tagi katalogowe"), () => this.handlers.edit());
    this.editControl.classList.add("hidden");
    tools.append(this.editControl);
    if (can(session, "can_download_file")) {
      tools.append(this.control("download", t("Pobierz utwór"), () => this.handlers.download()));
    }
    this.visualizerControl = this.control("visualizer", t("Wizualizacja"), () => this.handlers.toggleVisualizer());
    this.visualizerControl.classList.add("audio-dock__visualizer");
    // Known without the visualizers themselves: an operator who switched every one off left an empty list.
    this.visualizerControl.disabled = session.settings.visualizer_enabled.length === 0;
    const queueControl = this.control("list", t("Kolejka"), () => this.handlers.toggleQueue());
    queueControl.classList.add("audio-dock__queue");
    tools.append(this.visualizerControl, queueControl);

    const storedCollapsed = localStorage.getItem("media-dock-collapsed");
    // A tablet starts folded (the second row is a fifth of its screen), a desktop
    // with the full player; a stored choice wins over both.
    this.collapsed = storedCollapsed === null ? window.matchMedia("(max-width: 78rem)").matches : storedCollapsed === "true";
    this.collapseButton = el("button", {
      className: "player-control audio-dock__collapse",
      attrs: { type: "button" },
      dataset: { sheetClose: "" }
    }, icon("chevron")) as HTMLButtonElement;
    this.collapseButton.addEventListener("click", () => this.toggle());

    this.track = el(
      "div",
      { className: "audio-dock__track" },
      el("span", { className: "audio-dock__art-cell" }, this.artwork),
      el("div", { className: "audio-dock__copy" }, this.sourceLink, this.title, this.subtitle, this.technical)
    );
    this.bar = el(
      "div",
      { className: "audio-dock__bar" },
      this.collapseButton,
      this.track,
      el(
        "div",
        { className: "audio-dock__center" },
        el("div", { className: "audio-dock__controls" }, this.shuffleButton, previous, this.playButton, next, this.repeatButton),
        el("div", { className: "audio-dock__timeline" }, this.elapsed, this.progress, this.total)
      ),
      el("div", { className: "audio-dock__right" }, el("div", { className: "audio-dock__volume-group" }, this.volumeButton, this.volume), extras)
    );
    this.root = el(
      "section",
      { className: "audio-dock", attrs: { "aria-label": t("Odtwarzacz muzyki"), "aria-hidden": "true" } },
      this.ambient,
      this.line,
      this.bar
    );

    // A phone's mini-player opens when the track is pressed — anywhere on it that
    // is not a control of its own — or pushed upwards.
    this.track.addEventListener("click", (event) => {
      if (!this.phone.matches || this.sheet) return;
      if (event.target instanceof Element && event.target.closest("a, button")) return;
      this.openSheet();
    });
    let touchStart: { x: number; y: number } | null = null;
    this.root.addEventListener("touchstart", (event) => {
      const touch = event.touches[0];
      touchStart = touch && event.touches.length === 1 && this.phone.matches && !this.sheet ? { x: touch.clientX, y: touch.clientY } : null;
    }, { passive: true });
    this.root.addEventListener("touchend", (event) => {
      const touch = event.changedTouches[0];
      if (!touchStart || !touch) return;
      const up = touchStart.y - touch.clientY;
      if (up > 28 && up > Math.abs(touch.clientX - touchStart.x) * 1.5) this.openSheet();
      touchStart = null;
    }, { passive: true });

    this.twoRows = this.narrowWindow.matches;
    this.applyState();
    // Rotating a phone, or resizing a window across a threshold, changes which
    // arrangement this is — so the state is decided again with it.
    this.phone.addEventListener("change", () => this.applyState());
    this.narrowWindow.addEventListener("change", () => this.scheduleFit());
    // A page change under an open sheet: the page that was asked for is what should be seen.
    document.addEventListener("media:route-will-change", () => this.closeSheet(false));
    // How tall the dock is, for whatever has to stay clear of it — the page's
    // bottom padding and the panels above it (styles/player.css) — and how wide,
    // for whether it stands in two rows.
    if ("ResizeObserver" in window) {
      new ResizeObserver(() => {
        this.reportHeight();
        this.scheduleFit();
      }).observe(this.root);
    }
    this.setShuffle("current", false);
    this.setRepeat("off");
    this.restartTechnicalRotation();
  }

  private control(name: IconName, label: string, handler: () => void): HTMLButtonElement {
    const button = el("button", { className: "player-control", attrs: { type: "button", "aria-label": label } }, icon(name));
    button.addEventListener("click", handler);
    return button as HTMLButtonElement;
  }

  // --- What the player tells the dock -------------------------------------------------

  /** The dock exists from the first track on: until something plays there is nothing to dock. */
  public show(): void {
    this.root.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("has-audio-player");
    this.fitRows();
    this.reportHeight();
  }

  /** A new track: its names, its technical lines and its cover. */
  public showTrack(item: MediaItem, artworkUrl: string): void {
    this.describe(item);
    const channelLabel = item.channels === 1
      ? t("Mono")
      : item.channels === 2
        ? t("Stereo")
        : item.channels ? tn(item.channels, { one: "{count} kanał", few: "{count} kanały", many: "{count} kanałów" }) : "";
    const primary = [
      item.file_extension?.toUpperCase(),
      channelLabel,
      item.bitrate ? `${Math.round(item.bitrate / 1000)} kb/s` : "",
      item.sample_rate ? `${(item.sample_rate / 1000).toLocaleString(currentLanguage() === "en" ? "en-GB" : "pl-PL", { maximumFractionDigits: 1 })} kHz` : ""
    ].filter(Boolean).join(" · ");
    const secondary = [
      item.year,
      item.genre,
      item.mime_type?.replace(/^audio\//, "").toUpperCase(),
      item.size_bytes ? formatBytes(item.size_bytes) : ""
    ].filter(Boolean).join(" · ");
    this.technicalViews = [primary, secondary].filter(Boolean);
    this.technicalViewIndex = 0;
    this.renderTechnicalView();
    this.restartTechnicalRotation();
    this.artwork.classList.remove("has-image");
    this.setArtwork(artworkUrl);
  }

  /** The same track with changed tags or a changed cover. */
  public updateTrack(item: MediaItem, artworkUrl: string): void {
    this.describe(item);
    this.setArtwork(artworkUrl);
  }

  private describe(item: MediaItem): void {
    this.title.textContent = item.title;
    this.title.title = item.title;
    this.subtitle.textContent = [item.artist, item.album, formatDuration(item.duration_ms)].filter(Boolean).join(" · ");
  }

  private setArtwork(url: string): void {
    this.artworkImage.src = url;
    this.ambient.src = url;
  }

  public setSubtitle(text: string): void {
    this.subtitle.textContent = text;
  }

  /** A short message in the track line, which then gets its artist back. */
  public flashStatus(text: string): void {
    const previous = this.subtitle.textContent;
    this.subtitle.textContent = text;
    window.setTimeout(() => {
      if (this.subtitle.textContent === text) this.subtitle.textContent = previous;
    }, 4000);
  }

  public setPlaying(playing: boolean): void {
    this.playButton.replaceChildren(icon(playing ? "pause" : "play"));
    this.playButton.setAttribute("aria-label", playing ? t("Pauza") : t("Odtwórz"));
    this.root.classList.toggle("is-playing", playing);
  }

  public setProgress(current: number, duration: number): void {
    const fraction = duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;
    this.progress.value = String(Math.round(fraction * 1000));
    paintRange(this.progress);
    this.line.style.setProperty("--progress", fraction.toFixed(4));
    this.elapsed.textContent = clock(current);
    this.total.textContent = clock(duration);
  }

  public setSource(source: QueueSourceState | null): void {
    const view = queueSourceView(source);
    if (!view) {
      this.sourceLink.classList.add("hidden");
      this.sourceLink.replaceChildren();
      return;
    }
    const kinds: Record<QueueSourceKind, { label: string; glyph: IconName }> = {
      smart: { label: t("Playlista inteligentna"), glyph: "smart" },
      playlist: { label: t("Playlista"), glyph: "list" },
      search: { label: t("Wyszukiwanie"), glyph: "search" },
      folder: { label: t("Folder"), glyph: "folder" },
      library: { label: t("Cała biblioteka"), glyph: "music" }
    };
    const kind = kinds[view.kind];
    const described = view.name ? `${kind.label} · ${view.name}` : kind.label;
    this.sourceLink.replaceChildren(icon(kind.glyph), el("span", { className: "audio-dock__source-kind", text: kind.label }));
    if (view.name) this.sourceLink.append(el("span", { className: "audio-dock__source-name", text: view.name }));
    this.sourceLink.href = appUrl(view.path);
    this.sourceLink.title = t("Odtwarzane z: {source}", { source: described });
    this.sourceLink.setAttribute("aria-label", t("Odtwarzane z: {source}", { source: described }));
    this.sourceLink.classList.remove("hidden");
  }

  public setShuffle(mode: ShuffleMode, withinQueue: boolean): void {
    const labels: Record<ShuffleMode, string> = {
      off: t("Wyłączone"),
      current: t("Utwory w bieżącym folderze lub wyszukiwaniu"),
      all: t("Wszystkie utwory"),
      folders: t("Losowe foldery, utwory w albumie kolejno"),
      mixed: t("Pełna losowość w bieżącej playliście")
    };
    const badges: Record<ShuffleMode, string> = { off: "", current: "C", all: "A", folders: "F", mixed: "M" };
    const label = labels[mode];
    const button = this.shuffleButton;
    button.classList.toggle("is-active", mode !== "off");
    button.dataset.mode = mode;
    button.dataset.badge = badges[mode];
    button.setAttribute("aria-label", t("Losowanie: {mode}", { mode: label }));
    button.title = t("Losowanie: {mode}", { mode: label });
    // The right-click shortcut is named only where there is a right button to
    // click: on a phone "PPM" explained a gesture the screen does not have. The
    // switch itself is in the queue panel for everybody.
    const hasMouse = window.matchMedia("(any-pointer: fine)").matches;
    button.dataset.tooltip = hasMouse
      ? t("Losowanie: {mode}. PPM: losowanie w kolejce {state}.", { mode: label, state: withinQueue ? t("włączone") : t("wyłączone") })
      : t("Losowanie: {mode}", { mode: label });
  }

  public setRepeat(mode: RepeatMode): void {
    const labels: Record<RepeatMode, string> = {
      off: t("Wyłączone"),
      once: t("Powtórz bieżący jeszcze raz"),
      one: t("Powtarzaj bieżący utwór"),
      all: t("Powtarzaj bieżącą kolejkę")
    };
    const badges: Record<RepeatMode, string> = { off: "", once: "+1", one: "1", all: "A" };
    const label = labels[mode];
    const button = this.repeatButton;
    button.classList.toggle("is-active", mode !== "off");
    button.dataset.mode = mode;
    button.dataset.badge = badges[mode];
    button.setAttribute("aria-label", t("Powtarzanie: {mode}", { mode: label }));
    button.title = t("Powtarzanie: {mode}", { mode: label });
    button.dataset.tooltip = t("Powtarzanie: {mode}", { mode: label });
  }

  public setVolume(level: number, muted: boolean): void {
    if (Number(this.volume.value) !== level) this.volume.value = String(level);
    paintRange(this.volume);
    this.volumeButton.setAttribute("aria-pressed", String(muted));
    this.volumeButton.replaceChildren(icon(muted ? "volume-muted" : "volume"));
    this.volumeButton.setAttribute("aria-label", muted ? t("Włącz dźwięk") : t("Wycisz"));
    this.volumeButton.title = muted ? t("Włącz dźwięk") : t("Wycisz");
  }

  /** The stars of the playing track (the player builds them: a rating is saved, which is its business). */
  public setRating(picker: HTMLElement): void {
    this.rating.replaceChildren(picker);
  }

  /** `celebrate` when the listener has just made it one: the heart answers the press. */
  public setFavorite(active: boolean, celebrate = false): void {
    this.favoriteButton.classList.toggle("is-active", active);
    this.favoriteButton.setAttribute("aria-pressed", String(active));
    if (active && celebrate) pulse(this.favoriteButton, "is-popping", 420);
  }

  public setEditable(editable: boolean): void {
    this.editControl.classList.toggle("hidden", !editable);
  }

  public setVisualizerAvailable(available: boolean): void {
    this.visualizerControl.disabled = !available;
  }

  /**
   * Whether the page can set the volume at all. An iPhone's cannot — the keys on
   * its side are the only volume it has, and `volume` there is read-only — so
   * the slider, which would move and change nothing, is not shown (player.css).
   */
  public setVolumeControllable(controllable: boolean): void {
    this.root.classList.toggle("has-fixed-volume", !controllable);
  }

  // --- The technical line ------------------------------------------------------------------

  private restartTechnicalRotation(): void {
    window.clearInterval(this.technicalTimer);
    this.technicalTimer = window.setInterval(() => this.showNextTechnicalView(), 3800);
  }

  private showNextTechnicalView(): void {
    if (this.technicalViews.length < 2) return;
    this.technical.classList.add("is-switching");
    window.setTimeout(() => {
      this.technicalViewIndex = (this.technicalViewIndex + 1) % this.technicalViews.length;
      this.renderTechnicalView();
      this.technical.classList.remove("is-switching");
    }, 140);
  }

  private renderTechnicalView(): void {
    const value = this.technicalViews[this.technicalViewIndex] ?? "";
    this.technical.textContent = value;
    this.technical.title = value || t("Brak dodatkowych danych technicznych");
  }

  // --- Folded, open, and the phone's sheet ------------------------------------------------

  /**
   * Whether the dock offers folding to one row at all: wherever it stands in
   * two, and on a desktop's single row only when the operator turned that on. A
   * phone has its mini-player and sheet instead.
   */
  private foldOffered(): boolean {
    return this.session.settings.dock_collapse_desktop === true || this.twoRows;
  }

  /**
   * Whether the dock stands in two rows. The stylesheet decides that by the
   * dock's own width (a container query — beside the sidebar the window's width
   * says little), so the same width is read here; before the dock is on the
   * page it has none, and the window stands in for it.
   */
  private fitRows(): void {
    const width = this.root.clientWidth;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const twoRows = width > 0 ? width <= DOCK_TWO_ROWS_REM * rem : this.narrowWindow.matches;
    if (twoRows === this.twoRows) return;
    this.twoRows = twoRows;
    this.applyState();
  }

  /** On the next frame: a resize observer that changed what it observes would be reported as a loop. */
  private scheduleFit(): void {
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    window.requestAnimationFrame(() => {
      this.fitScheduled = false;
      this.fitRows();
    });
  }

  private applyState(): void {
    const phone = this.phone.matches;
    if (!phone && this.sheet) this.closeSheet(false);
    const foldable = !phone && this.foldOffered();
    // The fold is remembered, but only obeyed where it can be undone: folded on a
    // tablet, the same account's desktop would otherwise be stuck with one row
    // and no control to restore it.
    const folded = phone ? !this.sheet : this.collapsed && foldable;
    this.root.classList.toggle("is-collapsed", folded);
    this.root.classList.toggle("is-sheet", phone && this.sheet);
    this.root.classList.toggle("is-foldable", foldable);
    this.root.dataset.sheet = String(phone && this.sheet);
    const open = phone ? this.sheet : !folded;
    this.collapseButton.setAttribute("aria-expanded", String(open));
    this.collapseButton.setAttribute("aria-label", open ? t("Zwiń odtwarzacz") : t("Rozwiń odtwarzacz"));
  }

  private toggle(): void {
    if (this.phone.matches) {
      if (this.sheet) this.closeSheet();
      else this.openSheet();
      return;
    }
    this.collapsed = !this.collapsed;
    localStorage.setItem("media-dock-collapsed", String(this.collapsed));
    this.applyState();
    // A pointer leaves no focus ring behind; the keyboard keeps its place.
    if (!this.collapseButton.matches(":focus-visible")) this.collapseButton.blur();
  }

  /** What rises with the sheet (everything but the cover, which travels on its own). */
  private sheetParts(): HTMLElement[] {
    return Array.from(this.bar.querySelectorAll<HTMLElement>(".audio-dock__copy, .audio-dock__timeline, .audio-dock__controls, .audio-dock__volume-group, .audio-dock__extras"));
  }

  private stopSheetAnimations(): void {
    for (const animation of this.sheetAnimations) animation.cancel();
    this.sheetAnimations = [];
  }

  private openSheet(): void {
    if (this.sheet || !this.phone.matches || this.root.getAttribute("aria-hidden") === "true") return;
    this.stopSheetAnimations();
    const first = this.artwork.getBoundingClientRect();
    const barHeight = this.root.getBoundingClientRect().height;
    this.sheet = true;
    this.applyState();
    document.documentElement.classList.add("has-player-sheet");
    // A sheet over the whole screen is a dialog: the page under it is out of
    // reach, Escape closes it, and the focus comes back to where it was.
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.tabIndex = -1;
    this.releaseSheet = openModal(this.root, {
      onEscape: () => this.closeSheet(),
      initialFocus: this.root,
      alsoActive: this.handlers.surfaces()
    });
    if (prefersReducedMotion() || typeof this.root.animate !== "function") return;
    const height = this.root.getBoundingClientRect().height;
    // The sheet is uncovered from the strip the mini-player stood in, upwards.
    this.sheetAnimations.push(this.root.animate(
      [{ clipPath: `inset(${Math.max(0, height - barHeight)}px 0 0 0)` }, { clipPath: "inset(0 0 0 0)" }],
      { duration: DURATION.sheet, easing: EASE_OUT }
    ));
    const travel = flipFrom(this.artwork, first, { duration: DURATION.sheet });
    if (travel) this.sheetAnimations.push(travel);
    for (const part of this.sheetParts()) {
      this.sheetAnimations.push(part.animate(
        [{ opacity: 0, transform: "translateY(0.75rem)" }, { opacity: 1, transform: "none" }],
        { duration: DURATION.slow, delay: 90, easing: EASE_OUT, fill: "backwards" }
      ));
    }
  }

  /** Back to the mini-player; `animate` false when the page is going away under it. */
  public closeSheet(animate = true): void {
    if (!this.sheet) return;
    this.stopSheetAnimations();
    const finish = (): void => {
      this.stopSheetAnimations();
      this.root.style.removeProperty("transition");
      this.sheet = false;
      this.root.removeAttribute("role");
      this.root.removeAttribute("aria-modal");
      this.root.removeAttribute("tabindex");
      this.applyState();
      document.documentElement.classList.remove("has-player-sheet");
      this.releaseSheet?.();
      this.releaseSheet = null;
      this.reportHeight();
    };
    if (!animate || prefersReducedMotion() || typeof this.root.animate !== "function") {
      finish();
      return;
    }
    // Pulled down by a thumb (shared/sheet-gestures.ts), the sheet closes from
    // where it was let go: its own slide back up is switched off, and the
    // closing below starts that many pixels down.
    const pulled = Math.max(0, Number(this.root.dataset.pulledBy) || 0);
    this.root.style.transition = "none";
    // Where the cover will stand in the mini-player: the layout is switched for
    // one measurement and switched back, all before the next frame is drawn.
    const large = this.artwork.getBoundingClientRect();
    const height = this.root.getBoundingClientRect().height;
    this.root.classList.add("is-collapsed");
    this.root.classList.remove("is-sheet");
    const small = this.artwork.getBoundingClientRect();
    const barHeight = this.root.getBoundingClientRect().height;
    this.root.classList.remove("is-collapsed");
    this.root.classList.add("is-sheet");
    const exit = { duration: 280, easing: EASE_EXIT, fill: "forwards" as const };
    const delta = flipInvert(small, large);
    if (delta) {
      this.sheetAnimations.push(this.artwork.animate(
        [{ transformOrigin: "0 0", transform: "none" }, { transformOrigin: "0 0", transform: flipTransform(delta) }],
        exit
      ));
    }
    for (const part of this.sheetParts()) {
      this.sheetAnimations.push(part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE_EXIT, fill: "forwards" }));
    }
    const cover = this.root.animate(
      [
        { clipPath: "inset(0 0 0 0)", translate: `0 ${pulled}px` },
        { clipPath: `inset(${Math.max(0, height - barHeight)}px 0 0 0)`, translate: "0 0" }
      ],
      exit
    );
    this.sheetAnimations.push(cover);
    cover.finished.then(finish, () => undefined);
  }

  private reportHeight(): void {
    // The sheet covers the page; what the page keeps clear is the mini-player it folds back to.
    if (this.sheet) return;
    const height = this.root.offsetHeight;
    if (height > 0) document.documentElement.style.setProperty("--dock-height", `${height}px`);
  }
}
