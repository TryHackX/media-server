import type { RepeatMode, ShuffleMode } from "../player-state";
import type { MediaItem, PlaybackQueueDevice, QueueDisplay, SessionResponse } from "../types";

/**
 * What the player's parts ask of each other.
 *
 * The player used to be one class of 2 700 lines: the queue and its paging, the
 * dock, the queue panel and the visualizer panel all read and wrote the same
 * forty fields. It is four files now — the player itself (audio-player.ts: what
 * is playing, what comes next, what is remembered) and its three surfaces — and
 * these interfaces are everything that crosses between them. A surface draws and
 * reports what was pressed; it holds no playback state of its own.
 */

export type QueueDirection = "before" | "after";

/**
 * Where the player is a phone's: a mini-player along the bottom edge that opens
 * into a sheet (dock.ts), instead of a dock of one or two rows.
 *
 * A narrow screen — or a short one held sideways, where two rows would take a
 * third of what there is. The same words stand in styles/player.css; the two
 * must change together.
 */
export const PHONE_PLAYER = "(max-width: 46rem), (max-width: 64rem) and (max-height: 30rem) and (orientation: landscape)";

/** The dock stands in two rows up to this width of its own, in rem (`@container dock` in styles/player.css). */
export const DOCK_TWO_ROWS_REM = 68;

/** How many rows of the queue are drawn at once, and by how many the window moves. */
export const QUEUE_RENDER_LIMIT = 160;
export const QUEUE_RENDER_STEP = 80;

/** What the dock reports. Every one of these is something a person pressed. */
export interface DockHandlers {
  playPause(): void;
  previous(): void;
  next(): void;
  /** A place on the timeline, 0–1. */
  seek(fraction: number): void;
  cycleShuffle(): void;
  toggleShuffleWithinQueue(): void;
  cycleRepeat(): void;
  /** 0–1. */
  setVolume(level: number): void;
  toggleMute(): void;
  toggleFavorite(): void;
  edit(): void;
  download(): void;
  toggleVisualizer(): void;
  toggleQueue(): void;
  /** Everything the player draws on <body>: what stays usable beside an open sheet. */
  surfaces(): HTMLElement[];
}

/** The queue as the queue panel reads it, and what it may ask for. */
export interface QueueModel {
  /** The loaded window of the queue. */
  items(): readonly MediaItem[];
  /** The playing track's place in that window, or -1. */
  index(): number;
  /** Where the window starts in the whole listing. */
  offset(): number;
  total(): number;
  hasBefore(): boolean;
  hasAfter(): boolean;
  /** What a row shows, settled between the account's choice and the playlist's. */
  columns(): QueueDisplay;
  /** "Add to a playlist", when the page offers it and the account may. */
  collector(): ((item: MediaItem) => void) | null;
  playAt(index: number): void;
  /** Fetch the next page in a direction; resolves with how many tracks it added. */
  loadPage(direction: QueueDirection): Promise<number>;
  /** Continue here what another device was playing; false when it could not be done. */
  takeOver(device: PlaybackQueueDevice): Promise<boolean>;
  shuffleWithinQueue(): boolean;
  toggleShuffleWithinQueue(): void;
  surfaces(): HTMLElement[];
}

/** What the visualizer panel needs of the player. */
export interface VisualizerHost {
  readonly session: SessionResponse;
  /** The element that plays: the panel routes it through Web Audio once, on its first opening. */
  readonly audio: HTMLAudioElement;
  /** The graph exists: from now on the volume belongs on this gain, after the analyser. */
  adoptGraph(context: AudioContext, gain: GainNode): void;
  /** The context changed state (an interruption on iOS): the player decides whether to wake it. */
  contextStateChanged(): void;
  /** Whether there is anything to show at all — the dock's button follows. */
  availabilityChanged(available: boolean): void;
  surfaces(): HTMLElement[];
}

export type { RepeatMode, ShuffleMode };
