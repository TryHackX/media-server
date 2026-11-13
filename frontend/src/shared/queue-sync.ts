import { claimPlaybackQueue, forgetPlaybackQueue, getPlaybackQueues, savePlaybackQueue } from "./api";
import { minutesSince } from "./datetime";
import { agentLabel, onDeviceLabelChange, ownDeviceLabel } from "./device-label";
import { t } from "./i18n";
import { randomId } from "./random-id";
import type { RepeatMode } from "./player-state";
import type { PlaybackQueueDevice, QueueSourceState } from "./types";

/**
 * The queue, told to the server.
 *
 * The player has always written its queue to `localStorage`, which is one
 * browser profile on one machine: the phone in the kitchen cannot see what the
 * computer is playing, and "hand playback over" has nothing to hand over. This
 * is the other half — the same state, kept per device where every device of the
 * account can read it.
 *
 * Local storage is not replaced. It restores this device instantly and works
 * with the network down; the server is what makes the *other* device visible.
 */

const DEVICE_KEY = "media-device-id";

/** How often a playing device writes. Also how fast a handover is noticed. */
const SAVE_INTERVAL_MS = 8000;

/**
 * This browser's name for itself.
 *
 * Kept in storage rather than derived on each visit, so a device stays the same
 * device across sessions. Clearing site data makes it a *new* device — which is
 * the honest outcome: nothing is left that could prove it is the old one.
 */
function deviceId(): string {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    value = randomId(12);
    try { localStorage.setItem(DEVICE_KEY, value); } catch { /* pamięć przeglądarki może być niedostępna */ }
  }
  return value;
}

/** The name read from this browser's user agent ("Windows · Chrome"). */
export function defaultDeviceLabel(): string {
  return agentLabel(navigator.userAgent, t("Nieznane urządzenie"));
}

/**
 * A name a person will recognise in a list of two or three devices: the one
 * given by hand (Moje konto → Ustawienia → To urządzenie), else the read one.
 */
export function deviceLabel(): string {
  return ownDeviceLabel() || defaultDeviceLabel();
}

export interface QueueSnapshot {
  source: QueueSourceState | null;
  offset: number;
  total: number;
  mediaItemId: number | null;
  positionMs: number;
  isPlaying: boolean;
  repeat: RepeatMode;
  context: string;
}

/**
 * Writes on a leash.
 *
 * A player saves on every track change, every play and pause, and every couple
 * of seconds while playing. Sending each of those would be a request per second
 * to say the same sentence, so writes are collapsed: one goes out immediately
 * when the queue itself changed (a new list, a new track), and otherwise at most
 * one every {@link SAVE_INTERVAL_MS}. The last one, on `pagehide`, is sent with
 * `keepalive` so it survives the tab closing.
 */
export class QueueSync {
  private readonly id = deviceId();
  private lastWriteAt = 0;
  private timer = 0;
  private pending: QueueSnapshot | null = null;
  private lastKey = "";
  private inFlight = false;
  /** A save came due while another was on its way, and still has to go out. */
  private owed = false;

  public constructor(private readonly onYielded: (toDevice: string) => void) {
    // A rename (Moje konto → Ustawienia) is sent at once, not at the next track.
    onDeviceLabelChange(() => this.resend());
  }

  public identifier(): string {
    return this.id;
  }

  /** Read at every save rather than once, so a rename applies without a reload. */
  public name(): string {
    return deviceLabel();
  }

  /** Send the last state again, under whatever this device is called now. */
  public resend(): void {
    if (this.pending) void this.flush();
  }

  /** What changed decides how soon it is sent, not the caller. */
  public push(snapshot: QueueSnapshot): void {
    this.pending = snapshot;
    const key = `${snapshot.source?.kind ?? ""}:${snapshot.source?.id ?? 0}:${snapshot.mediaItemId ?? 0}:${snapshot.isPlaying}`;
    const changed = key !== this.lastKey;
    this.lastKey = key;
    const due = changed ? 0 : Math.max(0, SAVE_INTERVAL_MS - (Date.now() - this.lastWriteAt));
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), due);
  }

  /** Send whatever is pending right now; used when the page is going away. */
  public async flush(keepalive = false): Promise<void> {
    const snapshot = this.pending;
    if (!snapshot) return;
    // A save that comes due while another is on its way is owed, not dropped. It
    // used to be dropped: pause right after a track change and the pause never
    // reached the server, so every other device went on showing this one as
    // playing. The page-is-going-away save does not wait at all — there is no
    // later in which to send it.
    if (this.inFlight && !keepalive) {
      this.owed = true;
      return;
    }
    if (this.timer) { window.clearTimeout(this.timer); this.timer = 0; }
    this.inFlight = true;
    this.lastWriteAt = Date.now();
    try {
      const answer = await savePlaybackQueue({
        device_id: this.id,
        device_label: this.name(),
        source: snapshot.source,
        offset: Math.max(0, Math.round(snapshot.offset)),
        total: Math.max(0, Math.round(snapshot.total)),
        media_item_id: snapshot.mediaItemId,
        position_ms: Math.max(0, Math.round(snapshot.positionMs)),
        is_playing: snapshot.isPlaying,
        repeat: snapshot.repeat,
        context: snapshot.context.slice(0, 191)
      }, { keepalive });
      if (answer.yielded_to) this.onYielded(answer.yielded_to);
    } catch {
      // A queue that failed to reach the server is not worth interrupting
      // playback over; the next save carries the same state anyway.
    } finally {
      this.inFlight = false;
      if (this.owed) {
        this.owed = false;
        void this.flush();
      }
    }
  }

  /** The other devices, newest first — this one is never in the list. */
  public async others(): Promise<PlaybackQueueDevice[]> {
    const devices = await getPlaybackQueues(this.id);
    return devices.filter((device) => !device.is_current && device.source !== null);
  }

  public async claim(fromDeviceId: string): Promise<PlaybackQueueDevice> {
    return claimPlaybackQueue(this.id, this.name(), fromDeviceId);
  }

  /** Drops a recent device from the list (a live one would save itself back). */
  public async forget(deviceId: string): Promise<void> {
    await forgetPlaybackQueue(this.id, deviceId);
  }
}

/** "przed chwilą", "12 min temu", "wczoraj" — enough to judge how stale a row is. */
export function timeAgo(iso: string): string {
  const minutes = minutesSince(iso);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return t("przed chwilą");
  if (minutes < 60) return t("{count} min temu", { count: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{count} godz. temu", { count: String(hours) });
  const days = Math.floor(hours / 24);
  return days === 1 ? t("wczoraj") : t("{count} dni temu", { count: String(days) });
}
