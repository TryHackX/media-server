import { ApiError, createFileTransfer, previewUrl, recordPlayback, updateRating } from "./api";
import { el } from "./dom";
import { formatBytes, formatDuration } from "./format";
import { icon } from "./icons";
import { currentLanguage, t } from "./i18n";
import { can } from "./permissions";
import { cycleRepeat, cycleShuffle, mergeQueueItems, nextTrackIndex, resolveQueueDisplay, trimQueueItems, type RepeatMode, type ShuffleMode } from "./player-state";
import { startQueueFromSource } from "./queue-loaders";
import { QueueSync, timeAgo } from "./queue-sync";
import { ratingPicker } from "./rating";
import {
  defaultUserPreferences,
  type MediaItem,
  type PlaybackQueueDevice,
  type QueueDisplay,
  type QueuePage,
  type QueueSourceState,
  type SessionResponse
} from "./types";
import { VisualizerEngine } from "./visualizations/engine";
import { orderedVisualizerPlugins } from "./visualizations/registry";
import type { VisualizerPlugin } from "./visualizations/types";

type EditHandler = (item: MediaItem) => void;
type QueueDirection = "before" | "after";
type QueueLoader = (direction: QueueDirection, cursor: number) => Promise<QueuePage>;
type GlobalQueueLoader = (offset: number) => Promise<QueuePage>;
type CollectionHandler = (item: MediaItem) => void;

interface QueuePagingState {
  loader: QueueLoader;
  hasBefore: boolean;
  hasAfter: boolean;
  pendingBefore: Promise<number> | null;
  pendingAfter: Promise<number> | null;
}

/**
 * One visited track. The absolute position is what makes "previous" work after a
 * random jump: the jump replaces the whole loaded window, so the earlier track is
 * usually no longer in `queue` and can only be found again by its position in the
 * full listing.
 */
interface HistoryEntry {
  id: number;
  offset: number;
  /** Ordering the offset belongs to; a re-shuffle invalidates positions, not tracks. */
  generation: number;
  /** Kept so a remembered track can be replayed even when its position is stale. */
  item?: MediaItem;
}

/**
 * Where the queue came from, kept so a page reload can rebuild the loaders.
 *
 * Without it a restored session had a window of tracks but no way to fetch more,
 * so "random over the whole library" degenerated into random inside that window.
 *
 * One type, not two: this is also exactly what travels to the server and back
 * when a device stores its queue or hands it to another one. Two definitions of
 * the same five values would drift the first time one of them gained a field.
 */
export type QueueSource = QueueSourceState;

interface StoredPlayerState {
  version: 1;
  queue: MediaItem[];
  index: number;
  offset: number;
  total: number;
  position: number;
  playing: boolean;
  shuffleMode: ShuffleMode;
  repeat: RepeatMode;
  /** Older builds stored bare ids; both shapes are accepted on restore. */
  playbackHistory: Array<number | HistoryEntry>;
  playbackCounted?: boolean;
  listenedSeconds?: number;
  context?: string;
  source?: QueueSource;
}

const QUEUE_RENDER_LIMIT = 160;
const QUEUE_RENDER_STEP = 80;
const QUEUE_MEMORY_LIMIT = QUEUE_RENDER_LIMIT * 5;

/** Numbers follow the interface language, like formatBytes does. */
function locale(): string {
  return currentLanguage() === "en" ? "en-GB" : "pl-PL";
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export class AudioPlayer {
  private readonly audio = new Audio();
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly technical: HTMLElement;
  private technicalViews: string[] = [];
  private technicalViewIndex = 0;
  private technicalTimer = 0;
  private editControl: HTMLButtonElement | null = null;
  private collapsed = false;
  private touchRevealTimer = 0;
  private revealCollapse: (() => void) | null = null;
  private readonly collapseButton: HTMLButtonElement;
  private readonly artwork: HTMLElement;
  private readonly artworkImage: HTMLImageElement;
  private readonly playButton: HTMLButtonElement;
  private readonly shuffleButton: HTMLButtonElement;
  private readonly repeatButton: HTMLButtonElement;
  private readonly progress: HTMLInputElement;
  private readonly time: HTMLElement;
  private readonly queuePanel: HTMLElement;
  private readonly queueList: HTMLElement;
  private readonly queueBackdrop: HTMLButtonElement;
  private readonly queueMeta: HTMLElement;
  private readonly queueContext: HTMLElement;
  private readonly queueShuffleToggle: HTMLButtonElement;
  private readonly queueDevices: HTMLElement;
  /**
   * The queue, told to the server, so another device can see it and take it
   * over. A guest has no account to hang a device on, so it stays local.
   */
  private readonly queueSync: QueueSync | null;
  private queueDevicesAt = 0;
  private readonly visualizer: HTMLElement;
  private readonly visualizerBackdrop: HTMLButtonElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly visualizerMode: HTMLSelectElement;
  private readonly rating: HTMLElement;
  private readonly favoriteButton: HTMLButtonElement;
  private queue: MediaItem[] = [];
  private index = -1;
  private activeItem: MediaItem | null = null;
  private activeAbsoluteIndex = -1;
  private queueOffset = 0;
  private queueTotal = 0;
  private queueRenderStart = 0;
  private queueScrollScheduled = false;
  private queueRevealPending = false;
  private queueScrollCooldownUntil = 0;
  private playbackStartedItemId = -1;
  private listeningItemId = -1;
  private listenedSeconds = 0;
  private playbackTick = 0;
  private playbackHistory: HistoryEntry[] = [];
  /** Tracks rewound past, replayed in order before the next random pick. */
  private playbackFuture: HistoryEntry[] = [];
  /** Bumped whenever the queue ordering is replaced (new folder, new shuffle seed). */
  private queueGeneration = 0;
  private queueSource: QueueSource | null = null;
  private playbackWrites: Promise<void> = Promise.resolve();
  private shuffleWithinQueue = localStorage.getItem("media-shuffle-within-queue") === "true";
  private paging: QueuePagingState | null = null;
  private shuffleMode: ShuffleMode = "current";
  private globalQueueLoader: GlobalQueueLoader | null = null;
  private globalShufflePending: Promise<void> | null = null;
  private shuffleSeed = "";
  private queueModeChangeHandler: ((preserveCurrent: boolean) => void | Promise<void>) | null = null;
  private repeat: RepeatMode = "off";
  private lastProgressSent = 0;
  private loadRevision = 0;
  /**
   * Whether the listener wants sound, as opposed to whether the element makes
   * any. The two part company exactly when a stream ticket runs out: the
   * element stops, but nobody asked it to.
   */
  private desiredPlaying = false;
  /** The track a new ticket was already fetched for, so a dead file tries once. */
  private streamRefreshItemId = -1;
  private analyser: AnalyserNode | null = null;
  private visualizerEngine: VisualizerEngine | null = null;
  private visualizerResizeFrame = 0;
  private visualizerResetPending = false;
  private visualizerResizeObserver: ResizeObserver | null = null;
  private readonly visualizerPlugins: VisualizerPlugin[];
  private readonly allVisualizerPlugins: VisualizerPlugin[];
  private collectionHandler: CollectionHandler | null = null;
  private onEdit: EditHandler | null;
  private readonly restoration: Promise<void>;
  private stateWriteAt = 0;

  public constructor(
    private readonly session: SessionResponse,
    onEdit?: EditHandler
  ) {
    this.onEdit = onEdit ?? null;
    this.queueSync = session.user.is_guest
      ? null
      : new QueueSync((toDevice) => this.yieldPlayback(toDevice));
    this.allVisualizerPlugins = orderedVisualizerPlugins(session.settings.visualizer_order);
    this.visualizerPlugins = orderedVisualizerPlugins(session.settings.visualizer_order, session.settings.visualizer_enabled);
    this.audio.preload = "metadata";
    this.audio.volume = Number(localStorage.getItem("media-volume") ?? "0.8");

    this.title = el("strong", { className: "audio-dock__title", text: t("Wybierz utwór") });
    this.subtitle = el("span", { className: "audio-dock__subtitle", text: t("Kolejka jest pusta") });
    this.technical = el("button", {
      className: "audio-dock__technical",
      attrs: { type: "button", "aria-label": t("Przełącz szczegóły utworu") }
    });
    this.technical.addEventListener("click", () => {
      this.showNextTechnicalView();
      // A hand-picked view deserves a full interval before the rotation moves on.
      this.restartTechnicalRotation();
    });
    this.artworkImage = el("img", { className: "audio-dock__artwork-image", attrs: { alt: "" } });
    this.artworkImage.addEventListener("load", () => this.artwork.classList.add("has-image"));
    this.artworkImage.addEventListener("error", () => this.artwork.classList.remove("has-image"));
    this.artwork = el("span", { className: "audio-dock__artwork" }, icon("music"), this.artworkImage);
    this.playButton = el(
      "button",
      { className: "player-control player-control--primary", attrs: { type: "button", "aria-label": t("Odtwórz") } },
      icon("play")
    );
    this.progress = el("input", {
      className: "audio-dock__progress",
      attrs: { type: "range", min: "0", max: "1000", value: "0", "aria-label": t("Pozycja utworu") }
    });
    this.time = el("span", { className: "audio-dock__time", text: "0:00 / 0:00" });
    this.queueMeta = el("span", { className: "queue-panel__meta", text: t("0 utworów") });
    this.queueContext = el("p", { className: "queue-panel__context", text: t("Nie wybrano playlisty") });
    this.queueShuffleToggle = el("button", {
      className: "queue-panel__shuffle-toggle",
      attrs: { type: "button", "aria-pressed": String(this.shuffleWithinQueue) }
    });
    this.queueShuffleToggle.addEventListener("click", () => this.toggleQueueShuffle());
    this.queueList = el("div", { className: "queue-panel__list", attrs: { tabindex: "0" } });
    this.queueDevices = el("div", { className: "queue-devices hidden", attrs: { "aria-live": "polite" } });
    this.queuePanel = el(
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
          el("div", {}, el("h2", { text: t("Kolejka") }), this.queueContext, this.queueMeta, this.queueShuffleToggle),
          this.closeButton("queue")
        ),
        this.queueDevices
      ),
      this.queueList
    );
    this.queueBackdrop = el("button", {
      className: "queue-backdrop",
      attrs: { type: "button", "aria-label": t("Zamknij kolejkę"), "aria-hidden": "true", tabindex: "-1" }
    });
    this.queueBackdrop.addEventListener("click", () => this.setQueuePanel(false));
    this.visualizerBackdrop = el("button", {
      className: "visualizer-backdrop",
      attrs: { type: "button", "aria-label": t("Zamknij wizualizację"), "aria-hidden": "true", tabindex: "-1" }
    });
    this.visualizerBackdrop.addEventListener("click", () => this.setVisualizer(false));
    this.canvas = el("canvas", { className: "visualizer-panel__canvas" });
    this.visualizerMode = el("select", { className: "input input--compact visualizer-panel__select", attrs: { "aria-label": t("Tryb wizualizacji") } });
    for (const plugin of this.visualizerPlugins) {
      this.visualizerMode.append(el("option", { text: plugin.label, attrs: { value: plugin.id } }));
    }
    const savedVisualizer = localStorage.getItem("media-visualizer-mode");
    if (savedVisualizer && this.visualizerPlugins.some((plugin) => plugin.id === savedVisualizer)) this.visualizerMode.value = savedVisualizer;
    this.visualizerMode.addEventListener("change", () => {
      localStorage.setItem("media-visualizer-mode", this.visualizerMode.value);
      this.visualizerEngine?.select(this.visualizerMode.value);
    });
    const shiftVisualizer = (direction: 1 | -1): void => {
      const current = Math.max(0, this.visualizerPlugins.findIndex((plugin) => plugin.id === this.visualizerMode.value));
      const nextIndex = (current + direction + this.visualizerPlugins.length) % this.visualizerPlugins.length;
      const next = this.visualizerPlugins[nextIndex];
      if (!next) return;
      this.visualizerMode.value = next.id;
      localStorage.setItem("media-visualizer-mode", next.id);
      this.visualizerEngine?.select(next.id);
    };
    this.visualizer = el(
      "div",
      { className: "visualizer-panel", attrs: { "aria-hidden": "true" } },
      this.canvas,
      el(
        "div",
        { className: "visualizer-panel__toolbar" },
        this.control("previous", "Poprzednia wizualizacja", () => shiftVisualizer(-1)),
        this.visualizerMode,
        this.control("next", t("Następna wizualizacja"), () => shiftVisualizer(1)),
        this.control("fullscreen", t("Pełny ekran"), () => {
          const operation = document.fullscreenElement === this.visualizer
            ? document.exitFullscreen()
            : this.visualizer.requestFullscreen();
          void operation.catch(() => undefined);
        }),
        this.closeButton("visualizer")
      )
    );
    this.rating = el("div", { className: "now-rating" });
    this.favoriteButton = el(
      "button",
      { className: "player-control", attrs: { type: "button", "aria-label": t("Ulubione") } },
      icon("heart")
    );
    const previous = this.control("previous", t("Poprzedni"), () => void this.previous());
    const next = this.control("next", t("Następny"), () => void this.next(false));
    this.shuffleButton = this.control("shuffle", "Losowanie", () => {
      this.shuffleMode = cycleShuffle(this.shuffleMode);
      this.shuffleSeed = this.createShuffleSeed();
      // The mode lives in two places — here and in the remembered source — and
      // they are one fact. Only the music library used to keep them together,
      // so switching shuffle anywhere else left the source claiming the old
      // mode; the loaders rebuilt from it on the next navigation, and random
      // playback quietly shrank to the window it happened to be holding.
      this.rememberQueueMode();
      this.updateShuffleButton();
      void Promise.resolve(this.queueModeChangeHandler?.(true)).catch(() => undefined);
    });
    this.shuffleButton.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.toggleQueueShuffle();
    });
    this.repeatButton = this.control("repeat", "Powtarzanie", () => {
      this.repeat = cycleRepeat(this.repeat);
      this.updateRepeatButton();
    });
    this.updateShuffleButton();
    this.updateRepeatButton();
    const volume = el("input", {
      className: "audio-dock__volume",
      attrs: { type: "range", min: "0", max: "1", step: "0.01", value: String(this.audio.volume), "aria-label": t("Głośność") }
    });
    const volumeButton = this.control("volume", t("Wycisz"), () => { this.audio.muted = !this.audio.muted; });
    volumeButton.classList.add("audio-dock__mute");
    const syncVolumeButton = (): void => {
      volumeButton.setAttribute("aria-pressed", String(this.audio.muted));
      volumeButton.replaceChildren(icon(this.audio.muted ? "volume-muted" : "volume"));
      volumeButton.setAttribute("aria-label", this.audio.muted ? t("Włącz dźwięk") : t("Wycisz"));
      volumeButton.title = this.audio.muted ? t("Włącz dźwięk") : t("Wycisz");
    };
    this.audio.addEventListener("volumechange", syncVolumeButton);
    syncVolumeButton();
    volume.addEventListener("input", () => {
      this.audio.volume = Number(volume.value);
      if (this.audio.volume > 0) this.audio.muted = false;
      localStorage.setItem("media-volume", volume.value);
    });

    const extra = el("div", { className: "audio-dock__extras" }, this.rating, this.favoriteButton);
    this.favoriteButton.classList.toggle("hidden", !this.can("can_favorite"));
    // Shown only while a handler is registered (see setEditHandler), never as a
    // dead control: the right to edit tags is a group permission now.
    this.editControl = this.control("edit", t("Edytuj tagi katalogowe"), () => {
      const item = this.current();
      if (item && this.onEdit) this.onEdit(item);
    });
    this.editControl.classList.toggle("hidden", this.onEdit === null);
    extra.append(this.editControl);
    if (this.can("can_download_file")) {
      extra.append(this.control("download", t("Pobierz utwór"), () => void this.downloadCurrent()));
    }
    const visualizerControl = this.control("visualizer", t("Wizualizacja"), () => void this.toggleVisualizer());
    visualizerControl.disabled = this.visualizerPlugins.length === 0;
    extra.append(visualizerControl, this.control("list", t("Kolejka"), () => this.setQueuePanel(this.queuePanel.getAttribute("aria-hidden") === "true")));

    // Collapsing keeps the dock a one-line bar on a phone, where the extras row
    // and the artwork eat a third of the screen; the state is remembered. The
    // control appears on hover or touch, on phones only unless the operator
    // enabled it for desktop as well.
    // Phones start collapsed (the dock would otherwise take a third of the screen),
    // desktops start with the full player; a stored choice wins over both.
    const storedCollapsed = localStorage.getItem("media-dock-collapsed");
    this.collapsed = storedCollapsed === null
      ? window.matchMedia("(max-width: 78rem)").matches
      : storedCollapsed === "true";
    this.collapseButton = el("button", {
      className: "audio-dock__collapse",
      attrs: { type: "button", "aria-expanded": String(!this.collapsed) }
    }, icon("arrow"));
    this.collapseButton.addEventListener("click", () => {
      this.setCollapsed(!this.collapsed);
      // Pointer users keep the focus ring otherwise, which holds the chevron at
      // full strength for good; keyboard focus still reveals it through
      // :focus-visible, which a click does not set.
      this.collapseButton.blur();
    });

    this.root = el(
      "section",
      { className: "audio-dock", attrs: { "aria-label": t("Odtwarzacz muzyki"), "aria-hidden": "true" } },
      this.collapseButton,
      el("div", { className: "audio-dock__track" }, this.artwork, el("div", {}, this.title, this.subtitle, this.technical)),
      el(
        "div",
        { className: "audio-dock__center" },
        el("div", { className: "audio-dock__controls" }, this.shuffleButton, previous, this.playButton, next, this.repeatButton),
        el("div", { className: "audio-dock__timeline" }, this.progress, this.time)
      ),
      el("div", { className: "audio-dock__right" }, volumeButton, volume, extra)
    );
    this.applyCollapsed();
    // Rotating a phone, or resizing a window across the threshold, changes whether
    // the control exists — so the collapsed state has to be re-decided with it.
    window.matchMedia("(max-width: 78rem)").addEventListener("change", () => this.applyCollapsed());
    // The control is a hint, not furniture: any pointer entering the dock (or a
    // tap on touch, which has no hover) reveals it for a few seconds and then it
    // fades again — on desktop as well as on a phone.
    const revealCollapse = (): void => {
      // Driven from here rather than a :hover rule so touch behaves the same as a
      // mouse and the control always fades again after a fixed moment.
      this.root.classList.add("is-revealing");
      this.collapseButton.style.opacity = "1";
      window.clearTimeout(this.touchRevealTimer);
      this.touchRevealTimer = window.setTimeout(() => {
        this.root.classList.remove("is-revealing");
        this.collapseButton.style.opacity = "";
      }, 3200);
    };
    this.revealCollapse = revealCollapse;
    this.root.addEventListener("pointerdown", revealCollapse);
    this.root.addEventListener("pointerenter", revealCollapse);
    this.root.addEventListener("pointermove", (event) => {
      if (event.pointerType === "mouse" && !this.root.classList.contains("is-revealing")) revealCollapse();
    });
    this.collapseButton.addEventListener("focus", revealCollapse);
    document.body.append(this.root, this.queueBackdrop, this.queuePanel, this.visualizerBackdrop, this.visualizer);
    this.bindEvents();
    this.restartTechnicalRotation();
    this.restoration = this.restoreState();
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    localStorage.setItem("media-dock-collapsed", String(collapsed));
    this.applyCollapsed();
    // Keep the control visible briefly after a click, then let it fade like always.
    this.revealCollapse?.();
  }

  /**
   * Whether this screen offers the collapse control at all.
   *
   * Phones always do; a desktop only when the operator turned it on. Must match
   * the widths that reveal `.audio-dock__collapse` in player.css.
   */
  private collapseOffered(): boolean {
    return this.session.settings.dock_collapse_desktop === true
      || window.matchMedia("(max-width: 78rem)").matches;
  }

  private applyCollapsed(): void {
    // The choice is remembered, but only obeyed where it can be undone. Collapsing
    // on a phone used to leave the desktop stuck with a one-line dock and no
    // control to restore it, because the button is hidden on wide screens.
    this.root.classList.toggle("is-collapsed", this.collapsed && this.collapseOffered());
    // Desktop keeps the full dock unless the operator allowed collapsing there.
    this.root.classList.toggle("allows-desktop-collapse", this.session.settings.dock_collapse_desktop === true);
    this.collapseButton.setAttribute("aria-expanded", String(!this.collapsed));
    this.collapseButton.setAttribute("aria-label", this.collapsed ? t("Rozwiń odtwarzacz") : t("Zwiń odtwarzacz"));
  }

  /**
   * What the queue rows show, resolved for the queue that is actually loaded.
   *
   * The account's choice is the base — it is your queue. A playlist may override
   * either half of it, and then every listener sees what its author chose: the
   * selection is the point of a playlist, and "these are the three I keep coming
   * back to" is part of what is being said. `inherit`, the default, leaves that
   * half to the account, so an untouched playlist looks exactly as it did.
   */
  private queueColumns(): QueueDisplay {
    const account = { ...defaultUserPreferences.queue, ...(this.session.preferences?.queue ?? {}) };
    const source = this.queueSource;
    const list = source?.kind === "collection"
      ? { rating: source.queueRating, favorite: source.queueFavorite }
      : {};
    return { ...resolveQueueDisplay(account, list), ownerName: source?.ownerName ?? "" };
  }

  /**
   * Whose stars a row is showing, said out loud.
   *
   * A number next to a track reads as "your opinion" unless something says
   * otherwise, and here it often is not — so when the playlist put its author's
   * rating there, the tooltip names the author.
   */
  private queueRatingLabel(columns: QueueDisplay): string {
    if (columns.rating === "average") return t("Średnia ocena");
    if (columns.rating !== "owner") return t("Twoja ocena");
    return columns.ownerName
      ? t("Ocena autora playlisty ({owner})", { owner: columns.ownerName })
      : t("Ocena autora playlisty");
  }

  private queueFavoriteLabel(columns: QueueDisplay): string {
    if (columns.favorite !== "owner") return t("Ulubione");
    return columns.ownerName
      ? t("Ulubione autora playlisty ({owner})", { owner: columns.ownerName })
      : t("Ulubione autora playlisty");
  }

  /** Rebuild the queue rows after the account's display choices changed. */
  public refreshQueueColumns(): void {
    if (this.queuePanel.getAttribute("aria-hidden") === "false") this.renderQueue(false);
  }

  private restartTechnicalRotation(): void {
    window.clearInterval(this.technicalTimer);
    this.technicalTimer = window.setInterval(() => this.showNextTechnicalView(), 3800);
  }

  public ready(): Promise<void> {
    return this.restoration;
  }

  public hasQueue(): boolean {
    return this.queue.length > 0;
  }

  public pause(): void {
    this.audio.pause();
  }

  public setEditHandler(handler: EditHandler | null): void {
    this.onEdit = handler;
    this.editControl?.classList.toggle("hidden", handler === null);
  }

  public setQueueModeChangeHandler(handler: ((preserveCurrent: boolean) => void | Promise<void>) | null): void {
    this.queueModeChangeHandler = handler;
  }

  public setCollectionHandler(handler: CollectionHandler | null): void {
    this.collectionHandler = handler;
    if (this.queuePanel.getAttribute("aria-hidden") === "false") this.renderQueue(false);
  }

  public nextQueueShuffle(): { mode: ShuffleMode; seed: string } {
    this.shuffleSeed = this.createShuffleSeed();
    return { mode: this.shuffleMode, seed: this.shuffleSeed };
  }

  public currentItem(): MediaItem | null {
    return this.current();
  }

  public isPlaying(): boolean {
    return !this.audio.paused;
  }

  public async playPrepared(): Promise<void> {
    if (this.current()) await this.audio.play().catch(() => undefined);
  }

  public showQueue(): void {
    this.setQueuePanel(true);
  }

  public async previewVisualizer(id: string): Promise<void> {
    const plugin = this.allVisualizerPlugins.find((candidate) => candidate.id === id);
    if (!plugin) return;
    if (!this.visualizerMode.querySelector(`option[value="${CSS.escape(id)}"]`)) {
      this.visualizerMode.append(el("option", { text: `${plugin.label} (podgląd)`, attrs: { value: id } }));
    }
    this.visualizerMode.value = id;
    localStorage.setItem("media-visualizer-mode", id);
    this.setVisualizer(true);
    await this.ensureVisualizerEngine();
    this.visualizerEngine?.select(id);
    this.visualizerEngine?.start();
  }

  /**
   * ``position.resumeSeconds`` starts the first track where it was left, which is
   * what the start page's "continue" shelf hands over. Later tracks in the queue
   * begin at zero as usual.
   */
  public async setQueue(
    items: MediaItem[],
    startId?: number,
    autoplay = true,
    position?: Pick<QueuePage, "offset" | "total"> & { context?: string; resumeSeconds?: number }
  ): Promise<void> {
    this.paging = null;
    this.globalQueueLoader = null;
    this.queue = items.filter((item) => item.media_kind === "audio");
    this.activeItem = null;
    this.activeAbsoluteIndex = -1;
    // A new queue is a new ordering: positions recorded so far stop being valid
    // (the tracks themselves stay reachable). The rewind trail starts over.
    this.queueGeneration += 1;
    this.playbackFuture = [];
    this.queueOffset = Math.max(0, position?.offset ?? 0);
    this.queueTotal = Math.max(this.queue.length, position?.total ?? this.queue.length);
    this.queueContext.textContent = position?.context?.trim() || t("Bieżąca kolejka");
    this.index = Math.max(0, startId ? this.queue.findIndex((item) => item.id === startId) : 0);
    if (this.queue.length === 0) {
      this.index = -1;
      return;
    }
    this.queueRenderStart = Math.max(0, this.index - Math.floor(QUEUE_RENDER_LIMIT / 3));
    this.root.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("has-audio-player");
    this.renderQueue(true);
    this.persistState();
    await this.loadCurrent(autoplay, Math.max(0, position?.resumeSeconds ?? 0));
  }

  public setQueuePaging(loader: QueueLoader, hasBefore: boolean, hasAfter: boolean): void {
    this.paging = {
      loader,
      hasBefore,
      hasAfter,
      pendingBefore: null,
      pendingAfter: null
    };
    this.updateQueueMeta();
    if (this.queuePanel.getAttribute("aria-hidden") === "false") this.renderQueue(false);
  }

  public setGlobalQueueLoader(loader: GlobalQueueLoader | null): void {
    this.globalQueueLoader = loader;
    if (loader) this.configureGlobalPaging();
  }

  /** Record where this queue came from, so a reload can rebuild its loaders. */
  public setQueueSource(source: QueueSource | null): void {
    this.queueSource = source;
    this.persistState();
    // The source also carries a playlist's display rules, so an open queue has
    // to repaint: without this, the rows keep the previous list's columns.
    if (this.queuePanel.getAttribute("aria-hidden") === "false") this.renderQueue(false);
  }

  /** Source restored from the last session, until a page re-attaches its loaders. */
  public queueSourceInfo(): QueueSource | null {
    return this.queueSource;
  }

  /** Carry the current shuffle mode and seed into the remembered source. */
  private rememberQueueMode(): void {
    if (!this.queueSource) return;
    this.queueSource = { ...this.queueSource, shuffleMode: this.shuffleMode, shuffleSeed: this.shuffleSeed };
    this.persistState();
  }

  /** Where the current track is, in seconds — for rebuilding a queue in place. */
  public playbackPosition(): number {
    return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
  }

  /** What the queue says it is ("Folder: …", "Playlista: …"), for a rebuild. */
  public queueContextLabel(): string {
    return this.queueContext.textContent ?? "";
  }

  private configureGlobalPaging(): void {
    const loader = this.globalQueueLoader;
    if (!loader) return;
    const pageLoader: QueueLoader = async (direction) => {
      const offset = direction === "before"
        ? Math.max(0, this.queueOffset - QUEUE_RENDER_LIMIT)
        : Math.min(this.queueTotal, this.queueOffset + this.queue.length);
      const page = await loader(offset);
      return {
        ...page,
        has_more: direction === "before"
          ? page.offset > 0
          : page.offset + page.items.length < page.total
      };
    };
    this.setQueuePaging(
      pageLoader,
      this.queueOffset > 0,
      this.queueOffset + this.queue.length < this.queueTotal
    );
  }

  public async prefetchAfter(): Promise<void> {
    await this.loadPage("after");
  }

  /**
   * Apply a change made elsewhere (rating, favourite, edited tags) to every copy
   * of the track the player holds, and repaint what shows it.
   *
   * The queue keeps its own objects, so without this a star given on a card or a
   * tag edited in the dialog stayed invisible in the open queue until it was
   * rebuilt from the server.
   */
  public applyItemUpdate(update: Partial<MediaItem> & { id: number }): void {
    const targets = [
      ...this.queue.filter((item) => item.id === update.id),
      ...(this.activeItem?.id === update.id ? [this.activeItem] : [])
    ];
    if (targets.length === 0) return;
    for (const target of targets) Object.assign(target, update);
    const current = this.current();
    if (current?.id === update.id) {
      this.renderRating(current);
      this.title.textContent = current.title;
      this.subtitle.textContent = [current.artist, current.album, formatDuration(current.duration_ms)]
        .filter(Boolean)
        .join(" · ");
      this.artworkImage.src = previewUrl(current.id) + "&revision=" + Date.now();
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: current.title,
          artist: current.artist ?? "",
          album: current.album ?? ""
        });
      }
    }
    this.repaintQueueRow(update.id);
  }


  /** Rebuild one visible queue row in place, leaving the rest of the list alone. */
  private repaintQueueRow(mediaId: number): void {
    if (this.queuePanel.getAttribute("aria-hidden") !== "false") return;
    const row = this.queueList.querySelector<HTMLElement>(`.queue-item[data-media-id="${mediaId}"]`);
    if (row) this.renderQueue(false);
  }

  private current(): MediaItem | null {
    return this.index >= 0 ? this.queue[this.index] ?? this.activeItem : this.activeItem;
  }

  private createShuffleSeed(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  private toggleQueueShuffle(): void {
    this.shuffleWithinQueue = !this.shuffleWithinQueue;
    localStorage.setItem("media-shuffle-within-queue", String(this.shuffleWithinQueue));
    this.queueShuffleToggle.setAttribute("aria-pressed", String(this.shuffleWithinQueue));
    this.queueShuffleToggle.textContent = t("Mieszanie załadowanego okna: {state}", { state: this.shuffleWithinQueue ? t("włączone") : t("wyłączone") });
    this.updateShuffleButton();
  }

  private updateShuffleButton(): void {
    const labels: Record<ShuffleMode, string> = {
      off: t("Wyłączone"),
      current: t("Utwory w bieżącym folderze lub wyszukiwaniu"),
      all: t("Wszystkie utwory"),
      folders: t("Losowe foldery, utwory w albumie kolejno"),
      mixed: t("Pełna losowość w bieżącej playliście")
    };
    const badges: Record<ShuffleMode, string> = { off: "", current: "C", all: "A", folders: "F", mixed: "M" };
    const label = labels[this.shuffleMode];
    this.shuffleButton.classList.toggle("is-active", this.shuffleMode !== "off");
    this.shuffleButton.dataset.mode = this.shuffleMode;
    this.shuffleButton.dataset.badge = badges[this.shuffleMode];
    this.shuffleButton.setAttribute("aria-label", t("Losowanie: {mode}", { mode: label }));
    this.shuffleButton.title = t("Losowanie: {mode}", { mode: label });
    this.shuffleButton.dataset.tooltip = t("Losowanie: {mode}. PPM: losowanie w kolejce {state}.", {
      mode: label,
      state: this.shuffleWithinQueue ? t("włączone") : t("wyłączone")
    });
    this.queueShuffleToggle.setAttribute("aria-pressed", String(this.shuffleWithinQueue));
    this.queueShuffleToggle.textContent = t("Mieszanie załadowanego okna: {state}", {
      state: this.shuffleWithinQueue ? t("włączone") : t("wyłączone")
    });
  }

  private updateRepeatButton(): void {
    const labels: Record<RepeatMode, string> = {
      off: t("Wyłączone"),
      once: t("Powtórz bieżący jeszcze raz"),
      one: t("Powtarzaj bieżący utwór"),
      all: t("Powtarzaj bieżącą kolejkę")
    };
    const badges: Record<RepeatMode, string> = { off: "", once: "+1", one: "1", all: "A" };
    const label = labels[this.repeat];
    this.repeatButton.classList.toggle("is-active", this.repeat !== "off");
    this.repeatButton.dataset.mode = this.repeat;
    this.repeatButton.dataset.badge = badges[this.repeat];
    this.repeatButton.setAttribute("aria-label", t("Powtarzanie: {mode}", { mode: label }));
    this.repeatButton.title = "Powtarzanie: " + label;
    this.repeatButton.dataset.tooltip = "Powtarzanie: " + label;
  }

  private control(name: Parameters<typeof icon>[0], label: string, handler: () => void): HTMLButtonElement {
    const button = el("button", { className: "player-control", attrs: { type: "button", "aria-label": label } }, icon(name));
    button.addEventListener("click", handler);
    return button;
  }

  private closeButton(target: "queue" | "visualizer"): HTMLButtonElement {
    return this.control("close", "Zamknij", () => {
      if (target === "queue") return this.setQueuePanel(false);
      this.setVisualizer(false);
    });
  }

  private bindEvents(): void {
    this.playButton.addEventListener("click", () => {
      if (!this.current()) return;
      if (this.audio.paused) void this.audio.play();
      else this.audio.pause();
    });
    this.progress.addEventListener("input", () => {
      if (Number.isFinite(this.audio.duration)) {
        this.audio.currentTime = (Number(this.progress.value) / 1000) * this.audio.duration;
      }
    });
    this.queueList.addEventListener("scroll", () => this.scheduleQueueScroll());
    // Re-measure the row being pointed at (or focused): only then is the panel
    // certainly open, laid out and using the real font. pointerover is used
    // because pointerenter does not bubble, so one listener covers every row.
    const remeasure = (event: Event): void => {
      const row = (event.target as Element | null)?.closest?.(".queue-item__main");
      if (row instanceof HTMLElement) this.measureMarquee(row);
    };
    this.queueList.addEventListener("pointerover", remeasure);
    this.queueList.addEventListener("focusin", remeasure);
    this.audio.addEventListener("play", () => {
      this.desiredPlaying = true;
      this.streamRefreshItemId = -1;
      this.updatePlayState();
      this.persistState();
      const entry = this.currentHistoryEntry();
      if (entry) {
        if (this.playbackHistory.at(-1)?.id !== entry.id) this.playbackHistory.push(entry);
        if (this.playbackHistory.length > 200) this.playbackHistory.splice(0, this.playbackHistory.length - 200);
      }
      this.playbackTick = performance.now();
    });
    this.audio.addEventListener("pause", () => {
      // A pause the element performed because the source died is not a decision
      // to stop listening, so it must not clear the intent that refreshStream
      // restores playback from.
      if (this.audio.error === null) this.desiredPlaying = false;
      this.playbackTick = 0;
      this.updatePlayState();
      this.persistState();
    });
    // A stream ticket is good for five minutes, which is shorter than a coffee.
    // Pause for longer than that, press play, and the element re-requests a
    // range it is no longer allowed to have: the request is refused, the
    // element gives up, and because nothing was listening the dock went on
    // showing a track that was playing silence. Mint a new ticket and carry on
    // from the same second.
    this.audio.addEventListener("error", () => void this.refreshStream());
    this.audio.addEventListener("playing", () => { this.playbackTick = performance.now(); });
    this.audio.addEventListener("waiting", () => { this.playbackTick = 0; });
    this.audio.addEventListener("seeking", () => { this.playbackTick = 0; });
    this.audio.addEventListener("timeupdate", () => {
      this.captureListenedTime();
      const duration = this.audio.duration || 0;
      this.progress.value = String(duration > 0 ? Math.round((this.audio.currentTime / duration) * 1000) : 0);
      this.time.textContent = `${clock(this.audio.currentTime)} / ${clock(duration)}`;
      if (this.audio.currentTime - this.lastProgressSent >= 20) {
        this.lastProgressSent = this.audio.currentTime;
        const item = this.current();
        if (item) void this.record(item.id, "progress", this.audio.currentTime * 1000);
      }
      if (performance.now() - this.stateWriteAt >= 2500) this.persistState();
    });
    this.audio.addEventListener("ended", () => {
      const item = this.current();
      if (item) {
        this.captureListenedTime();
        this.qualifyPlayback(item);
        this.listeningItemId = -1;
        void this.record(item.id, "complete").finally(() => void this.next(true));
      }
      else void this.next(true);
    });
    this.favoriteButton.addEventListener("click", () => void this.toggleFavorite());
    document.addEventListener("keydown", (event) => {
      // Escape closes the open panels first: it must work even while focus sits on
      // the control that opened them (which the form-field guard below skips), and
      // in fullscreen the first press only leaves fullscreen.
      if (event.key === "Escape") {
        const queueOpen = this.queuePanel.getAttribute("aria-hidden") === "false";
        const visualizerOpen = this.visualizer.getAttribute("aria-hidden") === "false";
        if (!queueOpen && !visualizerOpen) return;
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
          return;
        }
        event.preventDefault();
        this.setQueuePanel(false);
        this.setVisualizer(false);
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, select, button")) return;
      if (event.code === "Space" && this.current()) {
        event.preventDefault();
        this.playButton.click();
      }
    });
    document.addEventListener("fullscreenchange", () => this.scheduleVisualizerResize(true));
    window.addEventListener("resize", () => this.scheduleVisualizerResize());
    if ("ResizeObserver" in window) {
      this.visualizerResizeObserver = new ResizeObserver(() => this.scheduleVisualizerResize());
      this.visualizerResizeObserver.observe(this.visualizer);
    }
    window.addEventListener("pagehide", () => {
      this.persistState();
      // The tab is going away, and a plain fetch would go with it. This is the
      // save the other device reads to see where this one stopped.
      void this.queueSync?.flush(true);
    });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => void this.audio.play());
      navigator.mediaSession.setActionHandler("pause", () => this.audio.pause());
      navigator.mediaSession.setActionHandler("previoustrack", () => void this.previous());
      navigator.mediaSession.setActionHandler("nexttrack", () => void this.next(false));
    }
  }

  private record(itemId: number, event: "start" | "progress" | "complete", positionMs = 0): Promise<void> {
    this.playbackWrites = this.playbackWrites
      .catch(() => undefined)
      .then(() => recordPlayback(itemId, event, positionMs));
    return this.playbackWrites;
  }

  private captureListenedTime(): void {
    const now = performance.now();
    if (this.playbackTick > 0 && !this.audio.paused && !this.audio.seeking && this.audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.listenedSeconds += Math.min(1, Math.max(0, (now - this.playbackTick) / 1000));
      const item = this.current();
      if (item) this.qualifyPlayback(item);
    }
    this.playbackTick = !this.audio.paused && !this.audio.seeking ? now : 0;
  }

  private qualifyPlayback(item: MediaItem): void {
    if (this.playbackStartedItemId === item.id) return;
    const itemDuration = Math.max(0, (item.duration_ms ?? 0) / 1000);
    const duration = itemDuration > 0
      ? itemDuration
      : Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    if (duration <= 0) return;
    const percent = Math.max(1, Math.min(100, Number(this.session.settings.playback_threshold_percent) || 15));
    if (this.listenedSeconds + 0.05 < duration * percent / 100) return;
    this.playbackStartedItemId = item.id;
    void this.record(item.id, "start");
  }

  private async loadCurrent(autoplay: boolean, resumeSeconds = 0): Promise<void> {
    const item = this.current();
    if (!item) return;
    const revision = ++this.loadRevision;
    if (this.index >= 0) {
      this.activeItem = item;
      this.activeAbsoluteIndex = this.queueOffset + this.index;
    }
    this.audio.pause();
    if (this.listeningItemId !== item.id) {
      this.listeningItemId = item.id;
      this.listenedSeconds = 0;
      this.playbackStartedItemId = -1;
    }
    this.playbackTick = 0;
    this.lastProgressSent = 0;
    this.title.textContent = item.title;
    this.subtitle.textContent = [item.artist, item.album, formatDuration(item.duration_ms)].filter(Boolean).join(" · ");
    const channelLabel = item.channels === 1
      ? t("Mono")
      : item.channels === 2
        ? t("Stereo")
        : item.channels ? t("{count} kanałów", { count: item.channels }) : "";
    const primaryTechnical = [
      item.file_extension?.toUpperCase(),
      channelLabel,
      item.bitrate ? `${Math.round(item.bitrate / 1000)} kb/s` : "",
      item.sample_rate ? `${(item.sample_rate / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} kHz` : ""
    ].filter(Boolean).join(" · ");
    const secondaryTechnical = [
      item.year,
      item.genre,
      item.mime_type?.replace(/^audio\//, "").toUpperCase(),
      item.size_bytes ? formatBytes(item.size_bytes) : ""
    ].filter(Boolean).join(" · ");
    this.technicalViews = [primaryTechnical, secondaryTechnical].filter(Boolean);
    this.technicalViewIndex = 0;
    this.renderTechnicalView();
    this.restartTechnicalRotation();
    this.artwork.classList.remove("has-image");
    this.artworkImage.src = previewUrl(item.id) + "&revision=" + item.id;
    this.renderRating(item);
    this.renderQueue(true);
    if (this.queuePanel.getAttribute("aria-hidden") === "false") {
      window.requestAnimationFrame(() => this.scrollCurrentInQueue("smooth"));
    }
    try {
      const transfer = await createFileTransfer(item.id, true);
      if (revision !== this.loadRevision) return;
      this.audio.src = transfer.url;
      this.audio.load();
      const beginPlayback = (): void => {
        if (revision !== this.loadRevision) return;
        if (resumeSeconds > 0 && Number.isFinite(this.audio.duration)) {
          this.audio.currentTime = Math.min(resumeSeconds, Math.max(0, this.audio.duration - 0.1));
        }
        if (autoplay) void this.audio.play().catch(() => undefined);
      };
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: item.artist ?? "", album: item.album ?? "" });
      }
      if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) beginPlayback();
      else this.audio.addEventListener("loadedmetadata", beginPlayback, { once: true });
      this.persistState();
      if (this.index >= this.queue.length - 3) void this.loadPage("after");
    } catch {
      if (revision === this.loadRevision) this.subtitle.textContent = t("Nie udało się przygotować utworu");
    }
  }

  /**
   * Ask for a new stream ticket for the track already loaded, and resume.
   *
   * Only for a ticket that ran out: an unreadable or missing file would fail
   * again immediately, so one attempt per track is all this gets. The position
   * is kept because the listener did not ask to start over — they asked to
   * carry on, and from their side nothing happened at all.
   */
  private async refreshStream(): Promise<void> {
    const item = this.current();
    if (!item || this.streamRefreshItemId === item.id) return;
    this.streamRefreshItemId = item.id;
    const position = this.audio.currentTime;
    const wasPlaying = this.desiredPlaying;
    const revision = this.loadRevision;
    try {
      const transfer = await createFileTransfer(item.id, true);
      if (revision !== this.loadRevision) return;
      this.audio.src = transfer.url;
      this.audio.load();
      this.audio.addEventListener("loadedmetadata", () => {
        if (revision !== this.loadRevision) return;
        if (position > 0 && Number.isFinite(this.audio.duration)) {
          this.audio.currentTime = Math.min(position, Math.max(0, this.audio.duration - 0.1));
        }
        if (wasPlaying) void this.audio.play().catch(() => undefined);
      }, { once: true });
    } catch {
      if (revision === this.loadRevision) this.subtitle.textContent = t("Nie udało się przygotować utworu");
    }
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

  private storageKey(): string {
    return `media-player-state-v1:${this.session.user.id}`;
  }

  private persistState(): void {
    if (this.queue.length === 0 || this.index < 0) return;
    const limit = 400;
    const start = Math.max(0, Math.min(this.index - 160, this.queue.length - limit));
    const state: StoredPlayerState = {
      version: 1,
      queue: this.queue.slice(start, start + limit),
      index: this.index - start,
      offset: this.queueOffset + start,
      total: this.queueTotal,
      position: Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0,
      playing: !this.audio.paused,
      shuffleMode: this.shuffleMode,
      repeat: this.repeat,
      // Track objects are dropped here: 200 of them would dwarf the stored queue,
      // and after a reload the ordering is new anyway.
      playbackHistory: this.playbackHistory
        .slice(-200)
        .map(({ id, offset, generation }) => ({ id, offset, generation })),
      playbackCounted: this.playbackStartedItemId === this.current()?.id,
      listenedSeconds: this.listenedSeconds,
      context: this.queueContext.textContent ?? "",
      ...(this.queueSource ? { source: this.queueSource } : {})
    };
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(state));
      this.stateWriteAt = performance.now();
    } catch { /* pamięć przeglądarki może być niedostępna */ }
    // The same state, told to the server on its own rhythm: local storage
    // restores this browser, the server is what lets another device see it.
    this.queueSync?.push({
      source: this.queueSource,
      offset: this.queueOffset + this.index,
      total: this.queueTotal,
      mediaItemId: this.current()?.id ?? null,
      positionMs: Math.round((Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0) * 1000),
      isPlaying: !this.audio.paused,
      repeat: this.repeat,
      context: this.queueContext.textContent ?? ""
    });
  }

  /**
   * Another device took this queue over.
   *
   * "Hand playback over" has to mean the music stops here, otherwise it is
   * copying, not handing. The dock says which device has it now — a player that
   * pauses itself with no explanation looks broken.
   */
  private yieldPlayback(toDevice: string): void {
    if (this.audio.paused) return;
    this.audio.pause();
    this.queueContext.textContent = t("Odtwarzanie przejęte przez: {device}", { device: toDevice });
  }

  /** Where the loaded window sits in the whole listing, for the paging loaders. */
  public queueWindow(): { offset: number; length: number; total: number } {
    return { offset: this.queueOffset, length: this.queue.length, total: this.queueTotal };
  }

  /**
   * The other devices of this account, drawn above the queue.
   *
   * Fetched when the panel opens rather than kept live: a list of two or three
   * rows that nobody is looking at is not worth a poll, and the moment somebody
   * wants to know what is playing in the other room is the moment they open
   * this panel.
   */
  private async renderQueueDevices(): Promise<void> {
    const sync = this.queueSync;
    if (!sync) return;
    if (Date.now() - this.queueDevicesAt < 4000) return;
    this.queueDevicesAt = Date.now();
    let devices: PlaybackQueueDevice[] = [];
    try {
      devices = await sync.others();
    } catch {
      return;
    }
    this.queueDevices.replaceChildren();
    this.queueDevices.classList.toggle("hidden", devices.length === 0);
    if (devices.length === 0) return;
    this.queueDevices.append(el("h3", { className: "queue-devices__title", text: t("Na innych urządzeniach") }));
    for (const device of devices) {
      const take = el(
        "button",
        { className: "button button--ghost queue-devices__take", attrs: { type: "button" } },
        icon("play"),
        el("span", { text: t("Przejmij") })
      );
      take.addEventListener("click", () => {
        take.disabled = true;
        void this.takeOver(device).finally(() => { take.disabled = false; });
      });
      this.queueDevices.append(el(
        "div",
        { className: "queue-devices__row" + (device.is_playing ? " is-playing" : "") },
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
            text: [device.context, device.is_playing ? t("odtwarza") : timeAgo(device.updated_at)]
              .filter(Boolean)
              .join(" · ")
          })
        ),
        take
      ));
    }
  }

  /**
   * Continue here what another device was playing.
   *
   * The state is claimed from the server rather than read from the row on
   * screen: the listing is a few seconds old, and what gets rebuilt should be
   * what the other device had at the moment somebody pressed the button.
   */
  private async takeOver(device: PlaybackQueueDevice): Promise<void> {
    const sync = this.queueSync;
    if (!sync) return;
    try {
      const claimed = await sync.claim(device.device_id);
      const source = claimed.source;
      if (!source) throw new Error("queue without a source");
      const started = await startQueueFromSource(this, source as QueueSource, {
        offset: claimed.offset,
        mediaItemId: claimed.media_item_id,
        positionSeconds: claimed.position_ms / 1000,
        context: claimed.context || t("Przejęta kolejka"),
        autoplay: true
      });
      if (!started) throw new Error("empty queue");
      this.repeat = claimed.repeat;
      this.updateRepeatButton();
      // The list on screen still shows that device as playing, because it was
      // when it was drawn. Bypass the throttle: this is the one moment the row
      // is certainly stale.
      this.queueDevicesAt = 0;
      void this.renderQueueDevices();
    } catch {
      this.queueContext.textContent = t("Nie udało się przejąć kolejki.");
    }
  }

  private async restoreState(): Promise<void> {
    let state: StoredPlayerState | null = null;
    try {
      state = JSON.parse(localStorage.getItem(this.storageKey()) ?? "null") as StoredPlayerState | null;
    } catch { state = null; }
    if (!state || state.version !== 1 || !Array.isArray(state.queue) || state.queue.length === 0) return;
    this.queue = state.queue.filter((item) => item?.media_kind === "audio");
    if (this.queue.length === 0) return;
    this.index = Math.min(this.queue.length - 1, Math.max(0, Number(state.index) || 0));
    this.queueOffset = Math.max(0, Number(state.offset) || 0);
    this.queueTotal = Math.max(this.queue.length, Number(state.total) || this.queue.length);
    this.shuffleMode = state.shuffleMode ?? "current";
    this.repeat = state.repeat ?? "off";
    // Kept for the page to re-attach the loaders; until it does, playback works
    // inside the restored window only.
    this.queueSource = state.source && typeof state.source.id === "number" ? state.source : null;
    // A state written by an older build holds bare ids; they still let "previous"
    // work inside the loaded window, just not across a random jump.
    this.playbackHistory = Array.isArray(state.playbackHistory)
      ? state.playbackHistory
          .slice(-200)
          .map((entry) => (typeof entry === "number" ? { id: entry, offset: -1, generation: -1 } : entry))
          .filter((entry): entry is HistoryEntry => typeof entry?.id === "number")
          // Positions belong to the ordering of the session that stored them.
          .map((entry) => ({ ...entry, generation: -1 }))
      : [];
    this.queueContext.textContent = state.context?.trim() || t("Przywrócona kolejka");
    this.listeningItemId = this.queue[this.index]?.id ?? -1;
    this.playbackStartedItemId = state.playbackCounted ? this.listeningItemId : -1;
    this.listenedSeconds = Math.max(0, Number(state.listenedSeconds) || 0);
    this.root.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("has-audio-player");
    this.updateShuffleButton();
    this.updateRepeatButton();
    this.renderQueue(true);
    await this.loadCurrent(Boolean(state.playing), Math.max(0, Number(state.position) || 0));
  }

  /**
   * Step back through the tracks that actually played.
   *
   * With random playback the queue window is replaced on every jump, so the
   * previous track is usually absent from `queue`; its stored absolute position
   * is then used to reload the window around it. The history entry is dropped
   * only once the move succeeded, otherwise repeated presses would eat the trail
   * and land on an unrelated neighbour.
   */
  /**
   * Play a track the listener already visited.
   *
   * With random playback the queue window is replaced on every jump, so a
   * remembered track is usually absent from `queue`; its stored absolute position
   * then reloads the window around it. Returns false when the track can no longer
   * be reached, so the caller can fall back to plain queue movement.
   */
  private async goToHistoryEntry(entry: HistoryEntry): Promise<boolean> {
    const windowIndex = this.queue.findIndex((item) => item.id === entry.id);
    if (windowIndex >= 0) {
      this.index = windowIndex;
      await this.loadCurrent(true);
      return true;
    }
    const loader = this.globalQueueLoader;
    // A stored position only means something inside the ordering it was taken in;
    // after a re-shuffle the same offset points at a different track.
    if (loader && entry.offset >= 0 && entry.generation === this.queueGeneration) {
      await this.loadGlobalWindowAt(entry.offset, true, loader);
      // The listing may also have shifted (a scan added files), so prefer the id
      // when it is in the freshly loaded window.
      const reloadedIndex = this.queue.findIndex((item) => item.id === entry.id);
      if (reloadedIndex >= 0 && reloadedIndex !== this.index) {
        this.index = reloadedIndex;
        await this.loadCurrent(true);
      }
      return true;
    }
    // Out of reach in the current ordering: play the remembered track itself. It
    // sits outside the loaded window, which the player already supports.
    if (entry.item) {
      this.activeItem = entry.item;
      this.index = -1;
      this.activeAbsoluteIndex = -1;
      await this.loadCurrent(true);
      return true;
    }
    return false;
  }

  private currentHistoryEntry(): HistoryEntry | null {
    const item = this.current();
    if (!item) return null;
    return {
      id: item.id,
      offset: this.index >= 0 ? this.queueOffset + this.index : -1,
      generation: this.queueGeneration,
      item
    };
  }

  /**
   * Step back through the tracks that actually played. The history entry is
   * dropped only once the move succeeded, otherwise repeated presses would eat
   * the trail and land on an unrelated neighbour.
   */
  private async previous(): Promise<void> {
    if (this.audio.currentTime > 5) {
      this.audio.currentTime = 0;
      return;
    }
    if (!this.queue.length) return;
    const currentEntry = this.currentHistoryEntry();
    const trail = [...this.playbackHistory];
    if (trail.at(-1)?.id === currentEntry?.id) trail.pop();
    const target = trail.at(-1);
    if (target !== undefined && await this.goToHistoryEntry(target)) {
      this.playbackHistory = trail;
      // Rewinding builds a forward trail, so the next press retraces the same
      // tracks instead of jumping somewhere new.
      if (currentEntry) this.playbackFuture.push(currentEntry);
      return;
    }
    if (this.index === 0 && this.paging?.hasBefore) await this.loadPage("before");
    this.index = this.index > 0 ? this.index - 1 : this.queue.length - 1;
    await this.loadCurrent(true);
  }

  private async next(automatic: boolean): Promise<void> {
    if (!this.queue.length) return;
    // Retrace a rewind before choosing anything new.
    const rewound = this.playbackFuture.at(-1);
    if (rewound !== undefined && !(automatic && ["once", "one"].includes(this.repeat))) {
      this.playbackFuture.pop();
      if (await this.goToHistoryEntry(rewound)) return;
    }
    const useGlobalRandom = this.globalQueueLoader && (this.shuffleMode === "all" || this.shuffleWithinQueue);
    if (useGlobalRandom && !(automatic && ["once", "one"].includes(this.repeat))) {
      await this.jumpToRandomGlobal();
      return;
    }
    if (this.index < 0 && this.globalQueueLoader && this.activeAbsoluteIndex >= 0) {
      await this.loadGlobalWindowAt(Math.min(this.queueTotal - 1, this.activeAbsoluteIndex + 1), true);
      return;
    }
    if (this.index >= this.queue.length - 1 && this.paging?.hasAfter) await this.loadPage("after");
    if (automatic && this.index >= this.queue.length - 1 && !this.paging?.hasAfter
        && ["folders", "mixed"].includes(this.shuffleMode) && !["once", "one"].includes(this.repeat)) {
      await Promise.resolve(this.queueModeChangeHandler?.(false));
      return;
    }
    const repeatBefore = this.repeat;
    const nextIndex = nextTrackIndex(this.queue.length, this.index, {
      automatic,
      repeat: repeatBefore,
      shuffle: this.shuffleWithinQueue && this.shuffleMode !== "off" && !this.globalQueueLoader
    });
    if (automatic && repeatBefore === "once" && nextIndex === this.index) {
      this.repeat = "off";
      this.updateRepeatButton();
    }
    if (nextIndex < 0) {
      this.audio.pause();
      return;
    }
    if (nextIndex === this.index) {
      this.audio.currentTime = 0;
      await this.audio.play().catch(() => undefined);
      return;
    }
    this.index = nextIndex;
    await this.loadCurrent(true);
  }

  private async jumpToRandomGlobal(): Promise<void> {
    if (!this.globalQueueLoader || this.queueTotal < 1) return;
    if (this.globalShufflePending) return this.globalShufflePending;
    const loader = this.globalQueueLoader;
    const operation = (async (): Promise<void> => {
      const randomValues = crypto.getRandomValues(new Uint32Array(1));
      let absoluteIndex = (randomValues[0] ?? 0) % this.queueTotal;
      const currentAbsolute = this.queueOffset + Math.max(0, this.index);
      if (this.queueTotal > 1 && absoluteIndex === currentAbsolute) {
        absoluteIndex = (absoluteIndex + 1 + ((randomValues[0] ?? 0) % (this.queueTotal - 1))) % this.queueTotal;
      }
      await this.loadGlobalWindowAt(absoluteIndex, true, loader);
    })();
    this.globalShufflePending = operation;
    try {
      await operation;
    } finally {
      if (this.globalShufflePending === operation) this.globalShufflePending = null;

    }
  }
  private async loadGlobalWindowAt(
    absoluteIndex: number,
    autoplay: boolean,
    expectedLoader: GlobalQueueLoader | null = this.globalQueueLoader
  ): Promise<void> {
    const loader = expectedLoader;
    if (!loader || this.queueTotal < 1) return;
    const target = Math.max(0, Math.min(this.queueTotal - 1, absoluteIndex));
    const windowSize = Math.min(QUEUE_RENDER_LIMIT, this.queueTotal);
    const windowOffset = Math.max(0, Math.min(this.queueTotal - windowSize, target - Math.floor(windowSize / 3)));
    const page = await loader(windowOffset);
    if (this.globalQueueLoader !== loader) return;
    const incoming = page.items.filter((item) => item.media_kind === "audio");
    if (incoming.length === 0) return;
    this.queue = incoming;
    this.queueOffset = Math.max(0, page.offset);
    this.queueTotal = Math.max(incoming.length, page.total);
    this.index = Math.min(incoming.length - 1, Math.max(0, target - this.queueOffset));
    this.configureGlobalPaging();
    this.queueRenderStart = Math.max(0, this.index - Math.floor(QUEUE_RENDER_LIMIT / 3));
    this.renderQueue(true);
    await this.loadCurrent(autoplay);
    if (this.queuePanel.getAttribute("aria-hidden") === "false") {
      // The list was just rebuilt, so let the browser lay it out from the top and
      // then glide down to the picked track — the visible "spin" of a random jump
      // — instead of teleporting the window onto it.
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.queueScrollCooldownUntil = performance.now() + (reducedMotion ? 0 : 900);
      if (!reducedMotion) this.queueList.scrollTop = 0;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => this.scrollCurrentInQueue(reducedMotion ? "auto" : "smooth", true));
      });
    }
  }

  private trimQueueWindow(direction: QueueDirection, paging: QueuePagingState): void {
    const trimmed = trimQueueItems(this.queue, direction, QUEUE_MEMORY_LIMIT);
    if (trimmed.removedBefore === 0 && trimmed.removedAfter === 0) return;
    this.queue = trimmed.items;
    if (trimmed.removedBefore > 0) {
      this.queueOffset += trimmed.removedBefore;
      this.queueRenderStart = Math.max(0, this.queueRenderStart - trimmed.removedBefore);
      paging.hasBefore = true;
    }
    if (trimmed.removedAfter > 0) {
      paging.hasAfter = true;
    }
    this.index = this.activeItem ? this.queue.findIndex((item) => item.id === this.activeItem?.id) : -1;
  }

  private async loadPage(direction: QueueDirection): Promise<number> {
    const paging = this.paging;
    if (!paging || this.queue.length === 0) return 0;
    const hasMore = direction === "before" ? paging.hasBefore : paging.hasAfter;
    const pendingKey = direction === "before" ? "pendingBefore" : "pendingAfter";
    if (!hasMore) return 0;
    const pending = paging[pendingKey];
    if (pending) return pending;
    const cursorItem = direction === "before" ? this.queue[0] : this.queue[this.queue.length - 1];
    if (!cursorItem) return 0;
    const currentId = this.current()?.id;
    const operation = (async (): Promise<number> => {
      try {
        const page = await paging.loader(direction, cursorItem.id);
        if (this.paging !== paging) return 0;
        const incoming = page.items.filter((item) => item.media_kind === "audio");
        const previousLength = this.queue.length;
        this.queue = mergeQueueItems(this.queue, incoming, direction);
        const added = this.queue.length - previousLength;
        this.queueTotal = Math.max(this.queue.length, page.total);
        if (direction === "before" && added > 0) this.queueOffset = Math.min(this.queueOffset, page.offset);
        if (direction === "before" && added > 0) this.queueRenderStart += added;
        if (direction === "before") paging.hasBefore = page.has_more;
        else paging.hasAfter = page.has_more;
        this.trimQueueWindow(direction, paging);
        if (currentId !== undefined) this.index = this.queue.findIndex((item) => item.id === currentId);
        this.updateQueueMeta();
        if (this.queuePanel.getAttribute("aria-hidden") === "false") {
          const anchor = this.captureQueueAnchor();
          this.renderQueue(false);
          this.restoreQueueAnchor(anchor);
        }
        return added;
      } catch {
        return 0;
      }
    })();
    paging[pendingKey] = operation;
    try {
      return await operation;
    } finally {
      if (this.paging === paging && paging[pendingKey] === operation) paging[pendingKey] = null;
    }
  }
  private updatePlayState(): void {
    this.playButton.replaceChildren(icon(this.audio.paused ? "play" : "pause"));
    this.playButton.setAttribute("aria-label", this.audio.paused ? t("Odtwórz") : t("Pauza"));
    this.root.classList.toggle("is-playing", !this.audio.paused);
    if (!this.audio.paused && this.visualizer.getAttribute("aria-hidden") === "false") this.visualizerEngine?.start();
  }

  private updateQueueMeta(): void {
    if (this.queue.length === 0) {
      this.queueMeta.textContent = t("0 utworów");
      return;
    }
    const first = this.queueOffset + 1;
    const last = this.queueOffset + this.queue.length;
    this.queueMeta.textContent = t("Pozycje {first}–{last} z {total}", {
      first: first.toLocaleString(locale()),
      last: last.toLocaleString(locale()),
      total: this.queueTotal.toLocaleString(locale())
    });
  }

  private renderQueue(alignCurrent: boolean): void {
    this.updateQueueMeta();
    if (alignCurrent && this.index >= 0) {
      this.queueRenderStart = Math.max(0, this.index - Math.floor(QUEUE_RENDER_LIMIT / 3));
    }
    const maxStart = Math.max(0, this.queue.length - QUEUE_RENDER_LIMIT);
    this.queueRenderStart = Math.min(maxStart, Math.max(0, this.queueRenderStart));
    const end = Math.min(this.queue.length, this.queueRenderStart + QUEUE_RENDER_LIMIT);
    const fragment = document.createDocumentFragment();
    const markOverflowing: HTMLElement[] = [];

    if (this.queueRenderStart > 0 || this.paging?.hasBefore) {
      const earlier = el("button", { className: "queue-window-sentinel", attrs: { type: "button" }, text: t("↑ Wcześniejsze utwory") });
      earlier.addEventListener("click", () => void this.revealBefore());
      fragment.append(earlier);
    }
    const columns = this.queueColumns();
    const ratingLabel = this.queueRatingLabel(columns);
    for (let index = this.queueRenderStart; index < end; index += 1) {
      const item = this.queue[index];
      if (!item) continue;
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
        columns.index
          ? el("span", { className: "queue-item__index", text: String(this.queueOffset + index + 1) })
          : null,
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
                attrs: { title: this.queueFavoriteLabel(columns), "aria-label": this.queueFavoriteLabel(columns) }
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
      main.addEventListener("click", () => {
        this.index = index;
        void this.loadCurrent(true);
      });
      const row = el("div", {
        className: "queue-item",
        attrs: { ...(index === this.index ? { "aria-current": "true" } : {}) },
        dataset: { queueIndex: index, mediaId: item.id }
      }, main);
      // Marked once the row is laid out: only lines that really do not fit get
      // the marquee, and each one scrolls exactly as far as it overflows.
      markOverflowing.push(main);
      if (this.collectionHandler && this.can("can_create_collections")) {
        const add = el("button", {
          className: "icon-button queue-item__collection",
          attrs: { type: "button", "aria-label": t("Dodaj {title} do kolekcji", { title: item.title }) }
        }, icon("list"));
        add.dataset.tooltip = t("Dodaj do kolekcji");
        add.addEventListener("click", () => this.collectionHandler?.(item));
        row.append(add);
      }
      fragment.append(row);
    }
    if (end < this.queue.length || this.paging?.hasAfter) {
      const later = el("button", { className: "queue-window-sentinel", attrs: { type: "button" }, text: t("Następne utwory ↓") });
      later.addEventListener("click", () => void this.revealAfter());
      fragment.append(later);
    }
    this.queueList.replaceChildren(fragment);
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

  private scheduleQueueScroll(): void {
    if (this.queueScrollScheduled) return;
    this.queueScrollScheduled = true;
    window.requestAnimationFrame(() => {
      this.queueScrollScheduled = false;
      if (this.queueRevealPending || performance.now() < this.queueScrollCooldownUntil) return;
      if (this.queueList.scrollTop <= 32) void this.revealBefore();
      else if (this.queueList.scrollHeight - this.queueList.scrollTop - this.queueList.clientHeight <= 32) void this.revealAfter();
    });
  }

  private async revealBefore(): Promise<void> {
    if (this.queueRevealPending) return;
    this.queueRevealPending = true;
    const anchor = this.captureQueueAnchor();
    try {
      if (this.queueRenderStart > 0) {
        this.queueRenderStart = Math.max(0, this.queueRenderStart - QUEUE_RENDER_STEP);
        this.renderQueue(false);
        this.restoreQueueAnchor(anchor);
        return;
      }
      const added = await this.loadPage("before");
      if (added > 0) {
        this.queueRenderStart = Math.max(0, this.queueRenderStart - QUEUE_RENDER_STEP);
        this.renderQueue(false);
        this.restoreQueueAnchor(anchor);
      }
    } finally {
      this.releaseQueueRevealLock();
    }
  }

  private async revealAfter(): Promise<void> {
    if (this.queueRevealPending) return;
    this.queueRevealPending = true;
    const anchor = this.captureQueueAnchor();
    try {
      let canAdvance = this.queueRenderStart + QUEUE_RENDER_LIMIT < this.queue.length;
      if (!canAdvance) {
        const added = await this.loadPage("after");
        canAdvance = added > 0;
      }
      if (!canAdvance) return;
      this.queueRenderStart = Math.min(
        Math.max(0, this.queue.length - QUEUE_RENDER_LIMIT),
        this.queueRenderStart + QUEUE_RENDER_STEP
      );
      this.renderQueue(false);
      this.restoreQueueAnchor(anchor);
    } finally {
      this.releaseQueueRevealLock();
    }
  }

  private captureQueueAnchor(): { mediaId: string; offset: number } | null {
    const listBounds = this.queueList.getBoundingClientRect();
    const rows = this.queueList.querySelectorAll<HTMLElement>(".queue-item[data-media-id]");
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom > listBounds.top + 1) {
        return { mediaId: row.dataset.mediaId ?? "", offset: bounds.top - listBounds.top };
      }
    }
    return null;
  }

  private restoreQueueAnchor(anchor: { mediaId: string; offset: number } | null): void {
    if (!anchor?.mediaId) return;
    const row = this.queueList.querySelector<HTMLElement>('[data-media-id="' + anchor.mediaId + '"]');
    if (!row) return;
    const listBounds = this.queueList.getBoundingClientRect();
    const currentOffset = row.getBoundingClientRect().top - listBounds.top;
    this.queueList.scrollTop += currentOffset - anchor.offset;
  }

  private scrollCurrentInQueue(behavior: ScrollBehavior = "auto", highlight = false): void {
    let row = this.queueList.querySelector<HTMLElement>('[aria-current="true"]');
    if (!row && this.index >= 0) {
      this.queueRenderStart = Math.max(0, this.index - Math.floor(QUEUE_RENDER_LIMIT / 2));
      this.renderQueue(false);
      row = this.queueList.querySelector<HTMLElement>('[aria-current="true"]');
    }
    row?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    if (row && highlight) {
      // A short flash marks where the random jump landed once the scroll settles.
      row.classList.add("queue-item--jumped");
      window.setTimeout(() => row.classList.remove("queue-item--jumped"), 1400);
    }
  }

  private releaseQueueRevealLock(): void {
    this.queueScrollCooldownUntil = performance.now() + 180;
    window.requestAnimationFrame(() => { this.queueRevealPending = false; });
  }

  private renderRating(item: MediaItem): void {
    const picker = ratingPicker({
      value: item.rating ?? 0,
      summary: item.rating === null ? t("Oceń") : `Twoja: ${item.rating.toFixed(1)}`,
      ariaLabel: t("Oceń utwór {title}", { title: item.title }),
      disabled: !this.can("can_rate"),
      onSelect: async (value) => {
        const summary = await updateRating(item.id, { rating: item.rating === value ? null : value });
        // Applied through the shared path so the queue row repaints as well.
        this.applyItemUpdate({
          id: item.id,
          rating: summary.user_rating,
          avg_rating: summary.avg_rating,
          rating_count: summary.rating_count
        });
      }
    });
    this.rating.replaceChildren(picker);
    this.favoriteButton.classList.toggle("is-active", item.favorite);
  }

  private async toggleFavorite(): Promise<void> {
    const item = this.current();
    if (!item || !this.can("can_favorite")) return;
    const summary = await updateRating(item.id, { favorite: !item.favorite });
    this.applyItemUpdate({ id: item.id, favorite: summary.user_favorite });
  }

  private async downloadCurrent(): Promise<void> {
    const item = this.current();
    if (!item || !this.can("can_download_file")) return;
    try {
      const transfer = await createFileTransfer(item.id, false);
      window.location.assign(transfer.url);
    } catch (error) {
      window.alert(error instanceof ApiError && error.status === 429
        ? error.message
        : t("Nie udało się przygotować pobierania."));
    }
  }

  private can(permission: "can_download_file" | "can_rate" | "can_favorite" | "can_create_collections"): boolean {
    return can(this.session, permission);
  }

  private setQueuePanel(open: boolean): void {
    this.queuePanel.setAttribute("aria-hidden", String(!open));
    this.queueBackdrop.setAttribute("aria-hidden", String(!open));
    document.documentElement.classList.toggle("has-open-queue", open);
    if (open) {
      this.renderQueue(true);
      void this.renderQueueDevices();
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        this.scrollCurrentInQueue("smooth");
        this.queueList.focus({ preventScroll: true });
      }));
    }
  }

  private async toggleVisualizer(): Promise<void> {
    const open = this.visualizer.getAttribute("aria-hidden") === "true";
    this.setVisualizer(open);
    if (!open) {
      return;
    }
    await this.ensureVisualizerEngine();
    this.visualizerEngine?.start();
    this.scheduleVisualizerResize(true);
  }

  private scheduleVisualizerResize(reset = false): void {
    if (this.visualizer.getAttribute("aria-hidden") !== "false") return;
    this.visualizerResetPending ||= reset;
    window.cancelAnimationFrame(this.visualizerResizeFrame);
    this.visualizerResizeFrame = window.requestAnimationFrame(() => {
      const shouldReset = this.visualizerResetPending;
      this.visualizerResetPending = false;
      this.visualizerEngine?.resize(shouldReset);
      this.visualizerResizeFrame = window.requestAnimationFrame(() => {
        this.visualizerResizeFrame = 0;
        this.visualizerEngine?.resize();
      });
    });
  }

  private async ensureVisualizerEngine(): Promise<void> {
    if (!this.analyser) {
      const context = new AudioContext();
      const source = context.createMediaElementSource(this.audio);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);
      this.analyser.connect(context.destination);
      await context.resume();
    }
    if (!this.visualizerEngine) {
      this.visualizerEngine = new VisualizerEngine(this.canvas, this.analyser, this.allVisualizerPlugins);
      this.visualizerMode.value = this.visualizerEngine.current()?.id ?? this.visualizerMode.value;
    }
  }

  private setVisualizer(open: boolean): void {
    this.visualizer.setAttribute("aria-hidden", String(!open));
    this.visualizerBackdrop.setAttribute("aria-hidden", String(!open));
    if (open) return;
    if (document.fullscreenElement === this.visualizer) void document.exitFullscreen().catch(() => undefined);
    this.stopVisualization();
  }

  private stopVisualization(): void {
    this.visualizerEngine?.stop();
  }
}
