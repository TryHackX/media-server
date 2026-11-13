import { ApiError, createFileTransfer, previewUrl, recordPlayback, updateRating } from "./api";
import { t } from "./i18n";
import { bindSystemControls, describeTrack, reportPlaybackPosition, reportPlaying } from "./media-session";
import { can } from "./permissions";
import { QUEUE_RENDER_LIMIT, type QueueDirection } from "./player/contracts";
import { PlayerDock } from "./player/dock";
import { QueuePanel } from "./player/queue-panel";
import { VisualizerPanel } from "./player/visualizer-panel";
import { cycleRepeat, cycleShuffle, mergeQueueItems, nextTrackIndex, nextUnplayedIndex, resolveQueueDisplay, resumePoint, storedLevel, trimQueueItems, type RepeatMode, type ShuffleMode } from "./player-state";
import { startQueueFromSource } from "./queue-loaders";
import { QueueSync } from "./queue-sync";
import { randomId } from "./random-id";
import { ratingPicker } from "./rating";
import { showToast } from "./toast";
import {
  defaultUserPreferences,
  type MediaItem,
  type PlaybackQueueDevice,
  type QueueDisplay,
  type QueuePage,
  type QueueSourceState,
  type SessionResponse
} from "./types";

type EditHandler = (item: MediaItem) => void;
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
  /** Tracks this ordering has already played, so a reload does not deal them again. */
  played?: number[];
  /** When this snapshot was written (Date.now()), to tell it from an older progress record. */
  savedAt?: number;
}

/**
 * The part of the state that changes while a track plays.
 *
 * Written every few seconds of playback instead of the whole snapshot, which
 * carries up to 400 tracks (~550 bytes each) and used to be serialised and
 * stored every 2.5 s — 90 to 220 KB a time, to move one number. The snapshot is
 * written when the queue or the track changes; `resumePoint` joins the two on
 * restore.
 */
interface StoredProgress {
  version: 1;
  mediaItemId: number;
  position: number;
  playing: boolean;
  listenedSeconds: number;
  playbackCounted: boolean;
  savedAt: number;
}

const QUEUE_MEMORY_LIMIT = QUEUE_RENDER_LIMIT * 5;

/**
 * Whether an audio element's volume is the page's to set. On an iPhone it is
 * not: `volume` is read-only there and stays 1 — the keys on the side of the
 * phone are the only volume it has.
 */
function elementVolumeSettable(): boolean {
  try {
    const probe = document.createElement("audio");
    probe.volume = 0.5;
    return probe.volume === 0.5;
  } catch {
    return true;
  }
}

/**
 * The player: what is playing, what comes next, and what is remembered of it.
 *
 * One instance lives for the life of the tab (shared/shell.ts) and outlives
 * every page. It owns the audio element, the queue and its paging, the play
 * history, the saved state and the account's record of plays — and nothing that
 * is drawn. The three things that are drawn are its surfaces, each a file of its
 * own under shared/player/: the dock, the queue panel and the visualizer panel.
 * They are told what changed and report what was pressed
 * (shared/player/contracts.ts); this class is what they report to.
 */
export class AudioPlayer {
  private readonly audio = new Audio();
  private readonly elementVolume = elementVolumeSettable();
  private readonly dock: PlayerDock;
  private readonly queuePanel: QueuePanel;
  private readonly visualizer: VisualizerPanel;
  /**
   * The queue, told to the server, so another device can see it and take it
   * over. A guest has no account to hang a device on, so it stays local.
   */
  private readonly queueSync: QueueSync | null;
  private queue: MediaItem[] = [];
  private index = -1;
  private activeItem: MediaItem | null = null;
  private activeAbsoluteIndex = -1;
  private queueOffset = 0;
  private queueTotal = 0;
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
  /**
   * Every track the current ordering has started, by id.
   *
   * Shuffle used to pick each next track at random from the whole list — with
   * replacement. Over a favourites list of a few hundred songs that is the
   * birthday problem: a repeat within the first twenty picks more often than
   * not, while other songs never came up at all. The order is now walked as the
   * permutation it is, and this set is what keeps one pass from dealing a song
   * twice (the track picked to start the pass, a list that changed underneath).
   */
  private shufflePlayed = new Set<number>();
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
  // Tracks skipped in a row because they would not play; reset by any playback.
  private unplayableInARow = 0;
  /** When the current track last got a fresh ticket after failing. */
  private lastStreamRetry = { itemId: -1, at: 0 };
  /**
   * Volume and mute, once the visualizer has routed the audio through Web Audio: a gain after
   * the analyser. Set on the element, they reached the analyser too, so every visualizer saw the
   * music only as loud as the slider — at 30 % an AVS preset reading getspec() got a third of
   * what Winamp, which took its data before the volume, handed it, and on mute nothing at all.
   */
  private volumeGain: GainNode | null = null;
  private volumeLevel = 0.8;
  private volumeMuted = false;
  private collectionHandler: CollectionHandler | null = null;
  private onEdit: EditHandler | null;
  private readonly restoration: Promise<void>;
  private stateWriteAt = 0;
  /** The visualizer's audio graph. Once it exists, every sound the element makes passes through it. */
  private audioContext: AudioContext | null = null;
  /**
   * A stream ticket for the current track is on its way. The element has no
   * source until it lands, so a press of play in that moment is remembered and
   * carried out when it does, instead of being lost to a play() that fails.
   */
  private awaitingTicket = false;
  private playWhenTicketArrives = false;

  public constructor(
    private readonly session: SessionResponse,
    onEdit?: EditHandler
  ) {
    this.onEdit = onEdit ?? null;
    this.queueSync = session.user.is_guest
      ? null
      : new QueueSync((toDevice) => this.yieldPlayback(toDevice));
    this.audio.preload = "metadata";
    this.volumeLevel = storedLevel(localStorage.getItem("media-volume"), 0.8);

    const surfaces = (): HTMLElement[] => this.playerSurfaces();
    this.dock = new PlayerDock(session, {
      playPause: () => {
        if (!this.current()) return;
        if (this.audio.paused) this.requestPlay();
        else this.audio.pause();
      },
      previous: () => void this.previous(),
      next: () => void this.next(false),
      seek: (fraction) => {
        if (Number.isFinite(this.audio.duration)) this.audio.currentTime = fraction * this.audio.duration;
      },
      cycleShuffle: () => {
        this.shuffleMode = cycleShuffle(this.shuffleMode);
        this.shuffleSeed = this.createShuffleSeed();
        // The mode lives in two places — here and in the remembered source — and
        // they are one fact. Only the music library used to keep them together,
        // so switching shuffle anywhere else left the source claiming the old
        // mode; the loaders rebuilt from it on the next navigation, and random
        // playback quietly shrank to the window it happened to be holding.
        this.rememberQueueMode();
        this.showShuffle();
        void Promise.resolve(this.queueModeChangeHandler?.(true)).catch(() => undefined);
      },
      toggleShuffleWithinQueue: () => this.toggleQueueShuffle(),
      cycleRepeat: () => {
        this.repeat = cycleRepeat(this.repeat);
        this.dock.setRepeat(this.repeat);
        // Part of the snapshot, which is no longer rewritten every few seconds.
        this.persistState();
      },
      setVolume: (level) => {
        this.volumeLevel = level;
        if (this.volumeLevel > 0) this.volumeMuted = false;
        localStorage.setItem("media-volume", String(level));
        this.applyVolume();
      },
      toggleMute: () => {
        this.volumeMuted = !this.volumeMuted;
        this.applyVolume();
      },
      toggleFavorite: () => void this.toggleFavorite(),
      edit: () => {
        const item = this.current();
        if (item && this.onEdit) this.onEdit(item);
      },
      download: () => void this.downloadCurrent(),
      toggleVisualizer: () => void this.visualizer.toggle(),
      toggleQueue: () => this.queuePanel.toggle(),
      surfaces
    });
    this.dock.setEditable(this.onEdit !== null);
    this.queuePanel = new QueuePanel({
      items: () => this.queue,
      index: () => this.index,
      offset: () => this.queueOffset,
      total: () => this.queueTotal,
      hasBefore: () => this.paging?.hasBefore === true,
      hasAfter: () => this.paging?.hasAfter === true,
      columns: () => this.queueColumns(),
      collector: () => (this.collectionHandler && this.can("can_create_collections") ? this.collectionHandler : null),
      playAt: (index) => {
        this.index = index;
        void this.loadCurrent(true);
      },
      loadPage: (direction) => this.loadPage(direction),
      takeOver: (device) => this.takeOver(device),
      shuffleWithinQueue: () => this.shuffleWithinQueue,
      toggleShuffleWithinQueue: () => this.toggleQueueShuffle(),
      surfaces
    }, this.queueSync);
    this.visualizer = new VisualizerPanel({
      session,
      audio: this.audio,
      adoptGraph: (context, gain) => {
        this.audioContext = context;
        this.volumeGain = gain;
        this.applyVolume();
      },
      contextStateChanged: () => {
        if (!this.audio.paused || this.desiredPlaying) this.resumeAudioContext();
      },
      availabilityChanged: (available) => this.dock.setVisualizerAvailable(available),
      surfaces
    });
    this.applyVolume();
    this.showShuffle();
    this.dock.setRepeat(this.repeat);
    document.body.append(this.dock.root, this.queuePanel.backdrop, this.queuePanel.element, this.visualizer.backdrop, this.visualizer.element);
    this.bindEvents();
    this.restoration = this.restoreState();
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

  /** Rebuild the queue rows after the account's display choices changed. */
  public refreshQueueColumns(): void {
    this.queuePanel.render(false);
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
    this.dock.setEditable(handler !== null);
  }

  public setQueueModeChangeHandler(handler: ((preserveCurrent: boolean) => void | Promise<void>) | null): void {
    this.queueModeChangeHandler = handler;
  }

  public setCollectionHandler(handler: CollectionHandler | null): void {
    this.collectionHandler = handler;
    this.queuePanel.render(false);
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

  /**
   * Show one visualizer whether or not the panel offers it — the administrator's
   * "preview" beside each one in the settings.
   */
  public previewVisualizer(id: string): Promise<void> {
    return this.visualizer.preview(id);
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
    // Captured before the queue is replaced: the track the element already holds.
    const loadedId = this.audio.currentSrc && !this.audio.ended ? this.current()?.id ?? null : null;
    this.paging = null;
    this.globalQueueLoader = null;
    this.queue = items.filter((item) => item.media_kind === "audio");
    this.activeItem = null;
    this.activeAbsoluteIndex = -1;
    // A new queue is a new ordering: positions recorded so far stop being valid
    // (the tracks themselves stay reachable). The rewind trail starts over.
    this.queueGeneration += 1;
    this.playbackFuture = [];
    this.shufflePlayed = new Set();
    // A new queue is not the old source any more. Callers that know where it
    // came from say so right after (setQueueSource); one that does not used to
    // inherit the previous playlist, and a reload rebuilt that list's loaders
    // under a queue of different tracks.
    this.queueSource = null;
    this.dock.setSource(null);
    this.queueOffset = Math.max(0, position?.offset ?? 0);
    this.queueTotal = Math.max(this.queue.length, position?.total ?? this.queue.length);
    this.queuePanel.context = position?.context?.trim() || t("Bieżąca kolejka");
    this.index = Math.max(0, startId ? this.queue.findIndex((item) => item.id === startId) : 0);
    if (this.queue.length === 0) {
      this.index = -1;
      return;
    }
    this.dock.show();
    this.queuePanel.render(true);
    this.persistState();
    // The same track at the head of a new order — shuffle switched on or off, the
    // list re-drawn around what is playing — keeps going where it is. Reloading
    // it sent the song back to 0:00 on every press of shuffle, and a second press
    // during that reload read the player as paused and left it that way. Only
    // when no position was asked for: taking a queue over from another device
    // names its own second, and that must win.
    const lead = this.queue[this.index];
    if (lead && loadedId === lead.id && position?.resumeSeconds === undefined) {
      this.activeItem = lead;
      this.activeAbsoluteIndex = this.queueOffset + this.index;
      this.shufflePlayed.add(lead.id);
      if (autoplay && this.audio.paused) await this.audio.play().catch(() => undefined);
      return;
    }
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
    this.queuePanel.render(false);
  }

  public setGlobalQueueLoader(loader: GlobalQueueLoader | null): void {
    this.globalQueueLoader = loader;
    if (loader) this.configureGlobalPaging();
  }

  /** Record where this queue came from, so a reload can rebuild its loaders. */
  public setQueueSource(source: QueueSource | null): void {
    this.queueSource = source;
    this.dock.setSource(source);
    this.persistState();
    // The source also carries a playlist's display rules, so the rows have to
    // repaint: without this, they keep the previous list's columns.
    this.queuePanel.render(false);
  }

  /** Source restored from the last session, until a page re-attaches its loaders. */
  public queueSourceInfo(): QueueSource | null {
    return this.queueSource;
  }

  /** Carry the current shuffle mode and seed into the remembered source, and store both. */
  private rememberQueueMode(): void {
    if (this.queueSource) {
      this.queueSource = { ...this.queueSource, shuffleMode: this.shuffleMode, shuffleSeed: this.shuffleSeed };
    }
    this.persistState();
  }

  /** Where the current track is, in seconds — for rebuilding a queue in place. */
  public playbackPosition(): number {
    return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
  }

  /** What the queue says it is ("Folder: …", "Playlista: …"), for a rebuild. */
  public queueContextLabel(): string {
    return this.queuePanel.context;
  }

  private configureGlobalPaging(): void {
    const loader = this.globalQueueLoader;
    if (!loader) return;
    const pageLoader: QueueLoader = async (direction) => {
      // Forward pages start one row early. A window that begins with the track
      // somebody picked holds one row more than the ordering it was cut from, so
      // "offset + length" stepped over a song every time; the overlapping row is
      // already in the window and the merge drops it.
      const offset = direction === "before"
        ? Math.max(0, this.queueOffset - QUEUE_RENDER_LIMIT)
        : Math.max(0, Math.min(this.queueTotal - 1, this.queueOffset + this.queue.length - 1));
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
    const wasFavorite = this.current()?.id === update.id ? this.current()?.favorite === true : false;
    for (const target of targets) Object.assign(target, update);
    const current = this.current();
    if (current?.id === update.id) {
      this.renderRating(current, !wasFavorite && current.favorite);
      this.dock.updateTrack(current, previewUrl(current.id) + "&revision=" + Date.now());
      this.describeToSystem(current, String(Date.now()));
    }
    this.queuePanel.repaintRow(update.id);
    // The stored queue carries the track too, and is written only on changes now.
    this.persistState();
  }

  private current(): MediaItem | null {
    return this.index >= 0 ? this.queue[this.index] ?? this.activeItem : this.activeItem;
  }

  private createShuffleSeed(): string {
    return randomId();
  }

  /** The system's "now playing" (shared/media-session.ts), with the cover the dock shows. */
  private describeToSystem(item: MediaItem, revision = String(item.id)): void {
    describeTrack(item, new URL(`${previewUrl(item.id)}&revision=${revision}`, window.location.href).href);
  }

  private reportPosition(): void {
    reportPlaybackPosition(this.audio);
  }

  private toggleQueueShuffle(): void {
    this.shuffleWithinQueue = !this.shuffleWithinQueue;
    localStorage.setItem("media-shuffle-within-queue", String(this.shuffleWithinQueue));
    this.showShuffle();
  }

  /** The shuffle mode, on the dock's button and on the queue panel's switch. */
  private showShuffle(): void {
    this.dock.setShuffle(this.shuffleMode, this.shuffleWithinQueue);
    this.queuePanel.setShuffleWithinQueue(this.shuffleWithinQueue);
  }

  /**
   * Play — from the button, the keyboard or the system's media keys.
   *
   * Through a stream ticket still on its way (the element has no source yet, and
   * play() would only fail), and with the visualizer's audio graph awake: this
   * runs inside the user's gesture, which is when Safari agrees to resume it.
   */
  private requestPlay(): void {
    this.resumeAudioContext();
    if (this.awaitingTicket) {
      this.playWhenTicketArrives = true;
      return;
    }
    void this.audio.play().catch(() => undefined);
  }

  /**
   * Wake the visualizer's audio graph.
   *
   * Once the visualizer has routed the element through Web Audio, every sound
   * passes through this context, and a context that is not running is silence
   * while the dock says "playing". iOS leaves exactly that behind after an
   * interruption — a call, Siri, another app's audio, the lock screen: the
   * context goes "interrupted" or "suspended" and the element carries on. It was
   * resumed once, when the visualizer first opened, and never again. Safari
   * resumes only inside a user gesture or once the interruption is over, so this
   * runs on both: every play press, every play event and every state change.
   */
  private resumeAudioContext(): void {
    const context = this.audioContext;
    if (!context || context.state === "running" || context.state === "closed") return;
    void context.resume().catch(() => undefined);
  }

  private bindEvents(): void {
    this.audio.addEventListener("play", () => {
      this.desiredPlaying = true;
      this.streamRefreshItemId = -1;
      this.resumeAudioContext();
      this.updatePlayState();
      this.persistProgress();
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
      this.persistProgress();
    });
    // A stream ticket is good for five minutes, which is shorter than a coffee.
    // Pause for longer than that, press play, and the element re-requests a
    // range it is no longer allowed to have: the request is refused, the
    // element gives up, and because nothing was listening the dock went on
    // showing a track that was playing silence. Mint a new ticket and carry on
    // from the same second.
    this.audio.addEventListener("error", () => this.handleStreamError());
    this.audio.addEventListener("playing", () => {
      this.playbackTick = performance.now();
      this.unplayableInARow = 0;
      this.resumeAudioContext();
    });
    // Back from the lock screen or another app with the music still "playing":
    // the moment to find out whether the graph went quiet in the meantime.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.audio.paused) this.resumeAudioContext();
    });
    this.audio.addEventListener("waiting", () => { this.playbackTick = 0; });
    this.audio.addEventListener("seeking", () => { this.playbackTick = 0; });
    for (const name of ["loadedmetadata", "durationchange", "seeked", "ratechange"]) {
      this.audio.addEventListener(name, () => this.reportPosition());
    }
    this.audio.addEventListener("timeupdate", () => {
      this.captureListenedTime();
      this.dock.setProgress(this.audio.currentTime, this.audio.duration || 0);
      if (this.audio.currentTime - this.lastProgressSent >= 20) {
        this.lastProgressSent = this.audio.currentTime;
        const item = this.current();
        if (item) void this.record(item.id, "progress", this.audio.currentTime * 1000);
      }
      if (performance.now() - this.stateWriteAt >= 2500) this.persistProgress();
    });
    this.audio.addEventListener("ended", () => {
      const item = this.current();
      if (item) {
        this.captureListenedTime();
        this.qualifyPlayback(item);
        this.listeningItemId = -1;
        // In the background: writes are chained in order, so this "complete" still
        // lands before the next track's "start" — but the next track no longer waits
        // behind every earlier write. Over a slow link that was a gap between songs,
        // and one hung request stopped the music altogether.
        void this.record(item.id, "complete").catch(() => undefined);
        this.advanceAutomatically();
      }
      else this.advanceAutomatically();
    });
    document.addEventListener("keydown", (event) => {
      // Escape closes the open panels first: it must work even while focus sits on
      // the control that opened them (which the form-field guard below skips), and
      // in fullscreen the first press only leaves fullscreen.
      if (event.key === "Escape") {
        const queueOpen = this.queuePanel.isOpen();
        const visualizerOpen = this.visualizer.isOpen();
        if (!queueOpen && !visualizerOpen) return;
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
          return;
        }
        event.preventDefault();
        // The queue panel is modal and answers Escape itself (openModal); this is
        // the visualizer's, and the queue's should a dialog above it have gone.
        if (queueOpen) this.queuePanel.setOpen(false);
        if (visualizerOpen) this.visualizer.setOpen(false);
        return;
      }
      if (event.code !== "Space" || event.defaultPrevented) return;
      // Space belongs to whatever has focus when that thing answers to it: a
      // control, a link, a film with its own player, anything editable. It used
      // to be checked against form fields and buttons only, so Space on a focused
      // film paused the film and started the music behind it at the same time.
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest(
        "input, textarea, select, button, a[href], [role='button'], [role='slider'], [role='menuitem'], video, audio"
      ))) return;
      // An open dialog owns the keyboard — the film viewer, the tag editor — except
      // the player's own surfaces, where Space toggling the music is exactly right.
      const modal = document.querySelector<HTMLElement>('[aria-modal="true"]:not([aria-hidden="true"])');
      if (modal && !this.playerSurfaces().includes(modal)) return;
      if (this.current()) {
        event.preventDefault();
        if (this.audio.paused) this.requestPlay();
        else this.audio.pause();
      }
    });
    window.addEventListener("pagehide", () => {
      this.persistState();
      // The tab is going away, and a plain fetch would go with it. This is the
      // save the other device reads to see where this one stopped.
      void this.queueSync?.flush(true);
    });
    bindSystemControls(this.audio, {
      play: () => this.requestPlay(),
      pause: () => this.audio.pause(),
      previous: () => void this.previous(),
      next: () => void this.next(false)
    });
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
    this.shufflePlayed.add(item.id);
    this.audio.pause();
    if (this.listeningItemId !== item.id) {
      this.listeningItemId = item.id;
      this.listenedSeconds = 0;
      this.playbackStartedItemId = -1;
    }
    this.playbackTick = 0;
    this.lastProgressSent = 0;
    this.visualizer.announce([item.title, item.artist].filter(Boolean).join(" — "));
    this.dock.showTrack(item, previewUrl(item.id) + "&revision=" + item.id);
    this.renderRating(item);
    this.queuePanel.markCurrent();
    // Whoever shows this track elsewhere (a card of the library) marks it as the one playing.
    document.dispatchEvent(new CustomEvent("media:track-changed", { detail: { id: item.id } }));
    if (this.queuePanel.isOpen()) {
      window.requestAnimationFrame(() => this.queuePanel.scrollToCurrent("smooth"));
    }
    this.awaitingTicket = true;
    this.playWhenTicketArrives = autoplay;
    try {
      const transfer = await createFileTransfer(item.id, true);
      if (revision !== this.loadRevision) return;
      this.awaitingTicket = false;
      // Read now, not when the load began: play may have been pressed meanwhile.
      const play = this.playWhenTicketArrives;
      this.audio.src = transfer.url;
      this.audio.load();
      const beginPlayback = (): void => {
        if (revision !== this.loadRevision) return;
        if (resumeSeconds > 0 && Number.isFinite(this.audio.duration)) {
          this.audio.currentTime = Math.min(resumeSeconds, Math.max(0, this.audio.duration - 0.1));
        }
        if (play) void this.audio.play().catch(() => undefined);
      };
      this.describeToSystem(item);
      if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) beginPlayback();
      else this.audio.addEventListener("loadedmetadata", beginPlayback, { once: true });
      this.persistState();
      if (this.index >= this.queue.length - 3) void this.loadPage("after");
    } catch {
      if (revision === this.loadRevision) {
        this.awaitingTicket = false;
        this.dock.setSubtitle(t("Nie udało się przygotować utworu"));
      }
    }
  }

  /**
   * The element gave up on the current track.
   *
   * The first failure is usually a stream ticket that expired during a long pause
   * (it lives five minutes), and a fresh one fixes it. A second failure on the same
   * track, with a fresh ticket, means the file will not play in this browser —
   * WMA, ALAC or APE that a shuffle across twenty thousand tracks is bound to
   * reach, or a server that refuses it. The error code cannot tell those two cases
   * apart (a refused ticket is reported as "source not supported" too), so the
   * order of attempts does. That second failure used to be the end of it: the dock
   * went on claiming the track was playing, and nothing else happened.
   */
  private handleStreamError(): void {
    const item = this.current();
    if (!item) return;
    // Decided by time, not by `streamRefreshItemId`: that marker is cleared by
    // every `play`, so a file that decodes for a while and then breaks went round
    // for ever — fresh ticket, seek back to the same second, play, break again.
    // A ticket lives five minutes, so a genuine second expiry can never come
    // within a minute of the previous refresh; a broken file always does.
    const retriedRecently = this.lastStreamRetry.itemId === item.id
      && performance.now() - this.lastStreamRetry.at < 60_000;
    if (!retriedRecently) {
      this.lastStreamRetry = { itemId: item.id, at: performance.now() };
      this.streamRefreshItemId = -1;
      void this.refreshStream();
      return;
    }
    this.unplayableInARow += 1;
    // A handful in a row is no longer a bad file, it is a server that is down or
    // a library this browser cannot read; skipping on would race through it all.
    if (this.unplayableInARow >= 5) {
      this.desiredPlaying = false;
      this.audio.pause();
      this.dock.setSubtitle(t("Kilka utworów z rzędu nie dało się odtworzyć — odtwarzanie zatrzymane."));
      return;
    }
    this.dock.setSubtitle(t("Nie udało się odtworzyć „{title}” — przechodzę dalej.", { title: item.title }));
    if (this.desiredPlaying) this.advanceAutomatically();
  }

  /**
   * Move on by itself — at the end of a track, or past one that will not play.
   * The next window can fail to load (a random page over a slow link); that must
   * leave a message, not an unhandled rejection and a silent player.
   */
  private advanceAutomatically(): void {
    void this.next(true).catch(() => {
      this.dock.setSubtitle(t("Nie udało się wczytać następnego utworu."));
    });
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
      if (revision === this.loadRevision) this.dock.setSubtitle(t("Nie udało się przygotować utworu"));
    }
  }

  private storageKey(): string {
    return `media-player-state-v1:${this.session.user.id}`;
  }

  private progressKey(): string {
    return `media-player-progress-v1:${this.session.user.id}`;
  }

  /**
   * The whole snapshot — the window of tracks, history, modes, source. Written
   * when one of those changes (a new queue, a new track, a mode, a page of
   * tracks), never on the clock; the clock writes `persistProgress`.
   */
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
      context: this.queuePanel.context,
      ...(this.queueSource ? { source: this.queueSource } : {}),
      played: [...this.shufflePlayed].slice(-1000),
      savedAt: Date.now()
    };
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(state));
      this.stateWriteAt = performance.now();
    } catch { /* pamięć przeglądarki może być niedostępna */ }
    this.pushQueueSync();
  }

  /**
   * Where the track is — a couple of hundred bytes, every few seconds of playback
   * and on play and pause. The snapshot used to be rewritten for this.
   */
  private persistProgress(): void {
    const item = this.current();
    if (this.queue.length === 0 || this.index < 0 || !item) return;
    const progress: StoredProgress = {
      version: 1,
      mediaItemId: item.id,
      position: Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0,
      playing: !this.audio.paused,
      listenedSeconds: this.listenedSeconds,
      playbackCounted: this.playbackStartedItemId === item.id,
      savedAt: Date.now()
    };
    try {
      localStorage.setItem(this.progressKey(), JSON.stringify(progress));
      this.stateWriteAt = performance.now();
    } catch { /* pamięć przeglądarki może być niedostępna */ }
    this.pushQueueSync();
  }

  private pushQueueSync(): void {
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
      context: this.queuePanel.context
    });
  }

  /**
   * Another device took this queue over.
   *
   * "Hand playback over" has to mean the music stops here, otherwise it is
   * copying, not handing. The queue says which device has it now — a player that
   * pauses itself with no explanation looks broken.
   */
  private yieldPlayback(toDevice: string): void {
    if (this.audio.paused) return;
    this.audio.pause();
    this.queuePanel.context = t("Odtwarzanie przejęte przez: {device}", { device: toDevice });
  }

  /** Where the loaded window sits in the whole listing, for the paging loaders. */
  public queueWindow(): { offset: number; length: number; total: number } {
    return { offset: this.queueOffset, length: this.queue.length, total: this.queueTotal };
  }

  /**
   * Continue here what another device was playing.
   *
   * The state is claimed from the server rather than read from the row on
   * screen: the listing is a few seconds old, and what gets rebuilt should be
   * what the other device had at the moment somebody pressed the button. False
   * when it could not be done; the queue panel says so.
   */
  private async takeOver(device: PlaybackQueueDevice): Promise<boolean> {
    const sync = this.queueSync;
    if (!sync) return false;
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
      this.dock.setRepeat(this.repeat);
      this.persistState();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Put back what the last visit left: the queue, the modes, the second.
   *
   * Resolves as soon as the stored state is in place — which is all the shell
   * waits for before it draws the page. The restored track's stream ticket is
   * fetched after that, in the background; the first paint after F5 used to wait
   * for it.
   */
  private async restoreState(): Promise<void> {
    let state: StoredPlayerState | null = null;
    try {
      state = JSON.parse(localStorage.getItem(this.storageKey()) ?? "null") as StoredPlayerState | null;
    } catch { state = null; }
    if (!state || state.version !== 1 || !Array.isArray(state.queue) || state.queue.length === 0) return;
    let progress: (Partial<StoredProgress> & Record<string, unknown>) | null = null;
    try {
      progress = JSON.parse(localStorage.getItem(this.progressKey()) ?? "null") as typeof progress;
    } catch { progress = null; }
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
    this.dock.setSource(this.queueSource);
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
    this.queuePanel.context = state.context?.trim() || t("Przywrócona kolejka");
    // The ordering survives a reload (the source keeps its seed), so what it
    // already dealt has to survive with it.
    this.shufflePlayed = new Set(
      Array.isArray(state.played) ? state.played.filter((id): id is number => Number.isSafeInteger(id)) : []
    );
    this.listeningItemId = this.queue[this.index]?.id ?? -1;
    const point = resumePoint(
      { ...state, currentId: this.listeningItemId >= 0 ? this.listeningItemId : null },
      progress && typeof progress === "object" ? progress : null
    );
    this.playbackStartedItemId = point.counted ? this.listeningItemId : -1;
    this.listenedSeconds = point.listenedSeconds;
    this.dock.show();
    this.showShuffle();
    this.dock.setRepeat(this.repeat);
    this.queuePanel.render(true);
    // Not awaited: the page is drawn while the ticket is on its way.
    void this.loadCurrent(point.playing, point.position);
  }

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

  /**
   * Move on: retrace a rewind, otherwise take the next track of the ordering.
   *
   * A shuffled queue is already a random permutation — the server deals it from
   * the seed — so "next" walks it rather than jumping somewhere at random, and a
   * pass plays every track once. Jumping was drawing with replacement: repeats
   * early, and songs that never came up in a whole evening.
   */
  private async next(automatic: boolean): Promise<void> {
    if (!this.queue.length) return;
    const repeatsTrack = automatic && ["once", "one"].includes(this.repeat);
    // Retrace a rewind before choosing anything new.
    const rewound = this.playbackFuture.at(-1);
    if (rewound !== undefined && !repeatsTrack) {
      this.playbackFuture.pop();
      if (await this.goToHistoryEntry(rewound)) return;
    }
    if (this.index < 0 && this.globalQueueLoader && this.activeAbsoluteIndex >= 0) {
      await this.loadGlobalWindowAt(Math.min(this.queueTotal - 1, this.activeAbsoluteIndex + 1), true);
      return;
    }
    // Mixing the loaded window only means something when no ordering stands
    // behind the queue — a hand-made list of tracks rather than a folder or a
    // playlist the server shuffles.
    if (!repeatsTrack && this.shuffleWithinQueue && this.shuffleMode !== "off" && !this.globalQueueLoader) {
      await this.nextWithinWindow(automatic);
      return;
    }
    const repeatBefore = this.repeat;
    const shuffled = this.shuffleMode !== "off";
    let position = this.index;
    let nextIndex = -1;
    for (let skipped = 0; ; skipped += 1) {
      if (position >= this.queue.length - 1 && this.paging?.hasAfter) {
        const anchor = this.queue[position]?.id;
        await this.loadPage("after");
        const moved = anchor === undefined ? -1 : this.queue.findIndex((item) => item.id === anchor);
        position = moved >= 0 ? moved : this.index;
      }
      const atEnd = position >= this.queue.length - 1 && !this.paging?.hasAfter;
      if (atEnd && !repeatsTrack && await this.startNextPass(automatic)) return;
      nextIndex = nextTrackIndex(this.queue.length, position, { automatic, repeat: repeatBefore });
      const candidate = nextIndex >= 0 ? this.queue[nextIndex] : undefined;
      // One pass deals each track once: the track that started it sits at the
      // head of the window and again wherever the shuffle put it.
      if (shuffled && !repeatsTrack && candidate && nextIndex !== position && skipped < 50
          && this.shufflePlayed.has(candidate.id)) {
        position = nextIndex;
        continue;
      }
      break;
    }
    if (automatic && repeatBefore === "once" && nextIndex === this.index) {
      this.repeat = "off";
      this.dock.setRepeat(this.repeat);
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

  /** Random order inside the loaded window, without dealing a track twice. */
  private async nextWithinWindow(automatic: boolean): Promise<void> {
    const ids = this.queue.map((item) => item.id);
    const choice = nextUnplayedIndex(ids, this.index, this.shufflePlayed, { automatic, repeat: this.repeat });
    if (choice.restart) this.shufflePlayed = new Set(this.index >= 0 && ids[this.index] !== undefined ? [ids[this.index]!] : []);
    if (choice.index < 0) {
      this.audio.pause();
      return;
    }
    if (choice.index === this.index) {
      this.audio.currentTime = 0;
      await this.audio.play().catch(() => undefined);
      return;
    }
    this.index = choice.index;
    await this.loadCurrent(true);
  }

  /**
   * The end of the list: begin the next pass from the list's real start.
   *
   * Wrapping used to go to index 0 of the loaded *window*. In a list longer than
   * the window that is somewhere in the middle, so "repeat all" replayed the last
   * few hundred tracks forever. A shuffled list also gets a fresh seed — the next
   * pass is a new order, not the same one again. Returns false when the ordinary
   * rule applies: stop, or wrap inside a list that is loaded whole.
   */
  private async startNextPass(automatic: boolean): Promise<boolean> {
    const handler = this.queueModeChangeHandler;
    if (!handler) return false;
    const shuffled = this.shuffleMode !== "off";
    const endless = ["folders", "mixed"].includes(this.shuffleMode);
    if (automatic && this.repeat !== "all" && !endless) return false;
    const partial = this.queueOffset > 0 || this.paging?.hasBefore === true;
    if (!shuffled && !partial) return false;
    if (shuffled) {
      this.shuffleSeed = this.createShuffleSeed();
      this.rememberQueueMode();
    }
    await Promise.resolve(handler(false)).catch(() => undefined);
    return true;
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
    this.queuePanel.render(true);
    await this.loadCurrent(autoplay);
    // The list was just rebuilt: an open panel glides down to the picked track.
    this.queuePanel.glideToCurrent();
  }

  /** Keep the loaded window within its memory limit; says how many rows left its start. */
  private trimQueueWindow(direction: QueueDirection, paging: QueuePagingState): number {
    const trimmed = trimQueueItems(this.queue, direction, QUEUE_MEMORY_LIMIT);
    if (trimmed.removedBefore === 0 && trimmed.removedAfter === 0) return 0;
    this.queue = trimmed.items;
    if (trimmed.removedBefore > 0) {
      this.queueOffset += trimmed.removedBefore;
      paging.hasBefore = true;
    }
    if (trimmed.removedAfter > 0) {
      paging.hasAfter = true;
    }
    this.index = this.activeItem ? this.queue.findIndex((item) => item.id === this.activeItem?.id) : -1;
    return trimmed.removedBefore;
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
        if (direction === "before") paging.hasBefore = page.has_more;
        else paging.hasAfter = page.has_more;
        const trimmedBefore = this.trimQueueWindow(direction, paging);
        if (currentId !== undefined) this.index = this.queue.findIndex((item) => item.id === currentId);
        this.queuePanel.pageLoaded(direction, added, trimmedBefore);
        // The window the snapshot holds changed; the clock no longer writes it.
        if (added > 0) this.persistState();
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
    const playing = !this.audio.paused;
    this.dock.setPlaying(playing);
    // What moves with the music elsewhere (the bars on the playing row and card) follows this.
    document.documentElement.classList.toggle("is-audio-playing", playing);
    reportPlaying(playing);
    this.reportPosition();
    if (playing) this.visualizer.playbackStarted();
  }

  private renderRating(item: MediaItem, celebrate = false): void {
    const picker = ratingPicker({
      value: item.rating ?? 0,
      summary: item.rating === null ? t("Oceń") : t("Twoja: {value}", { value: item.rating.toFixed(1) }),
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
    this.dock.setRating(picker);
    this.dock.setFavorite(item.favorite, celebrate);
  }

  private async toggleFavorite(): Promise<void> {
    const item = this.current();
    if (!item || !this.can("can_favorite")) return;
    try {
      const summary = await updateRating(item.id, { favorite: !item.favorite });
      this.applyItemUpdate({ id: item.id, favorite: summary.user_favorite });
    } catch {
      this.dock.flashStatus(t("Nie udało się zmienić ulubionych."));
    }
  }

  private async downloadCurrent(): Promise<void> {
    const item = this.current();
    if (!item || !this.can("can_download_file")) return;
    try {
      const transfer = await createFileTransfer(item.id, false);
      window.location.assign(transfer.url);
    } catch (error) {
      showToast(error instanceof ApiError && (error.status === 429 || error.status === 403)
        ? error.message
        : t("Nie udało się przygotować pobierania."), "error");
    }
  }

  private can(permission: "can_download_file" | "can_rate" | "can_favorite" | "can_create_collections"): boolean {
    return can(this.session, permission);
  }

  /**
   * Everything the player draws on <body>. Whichever of its surfaces opens as a
   * dialog, the others stay usable: the dock beside a panel (to pause, to skip,
   * to open the other panel), and a panel with its backdrop beside the dock's own
   * sheet — opened first or second, none may find itself inert under another.
   */
  private playerSurfaces(): HTMLElement[] {
    return [this.dock.root, this.queuePanel.element, this.queuePanel.backdrop, this.visualizer.element, this.visualizer.backdrop];
  }

  /**
   * Volume and mute where they belong: on the element while it plays on its own, and once the
   * visualizer has routed it through Web Audio on a gain after the analyser, the element left
   * at full volume — the visualizers see the music as it is, as Winamp's saw it, whatever the
   * slider says.
   */
  private applyVolume(): void {
    if (this.volumeGain) {
      this.audio.volume = 1;
      this.audio.muted = false;
      this.volumeGain.gain.value = this.volumeMuted ? 0 : this.volumeLevel;
    } else {
      this.audio.volume = this.volumeLevel;
      this.audio.muted = this.volumeMuted;
    }
    this.dock.setVolume(this.volumeLevel, this.volumeMuted);
    // With the visualizer's audio graph in place the volume is a gain node's,
    // which works everywhere; until then it is the element's, which an iPhone ignores.
    this.dock.setVolumeControllable(this.volumeGain !== null || this.elementVolume);
  }
}
