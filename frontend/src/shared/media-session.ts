/**
 * What the system is told about the music: the lock screen, the notification
 * shade, a watch, the keyboard's media keys, a car's display.
 *
 * Every call is guarded — the Media Session API is missing in an old browser
 * and partial in most — and none of them can throw into the player.
 */

export interface TrackForSystem {
  title: string;
  artist?: string | null;
  album?: string | null;
}

export interface SystemControls {
  play(): void;
  pause(): void;
  previous(): void;
  next(): void;
}

interface Playhead {
  duration: number;
  playbackRate: number;
  currentTime: number;
}

/**
 * What `setPositionState` may be given, or null when there is nothing to say
 * yet: the call throws for a duration that is not a positive number and for a
 * position past the end, which a track is for an instant when it finishes.
 */
export function positionState(playhead: Playhead): { duration: number; playbackRate: number; position: number } | null {
  const { duration } = playhead;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const rate = Number.isFinite(playhead.playbackRate) && playhead.playbackRate > 0 ? playhead.playbackRate : 1;
  const position = Number.isFinite(playhead.currentTime) ? Math.min(duration, Math.max(0, playhead.currentTime)) : 0;
  return { duration, playbackRate: rate, position };
}

/**
 * The track's name, and its cover — the one the dock shows; the system fetches
 * it as this page would, session included. Without it the lock screen drew a
 * grey note beside three lines of text.
 */
export function describeTrack(track: TrackForSystem, coverUrl: string): void {
  if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist ?? "",
    album: track.album ?? "",
    artwork: [{ src: coverUrl }]
  });
}

/**
 * Where the track is and how long it runs, for the system's own progress bar.
 *
 * Told at the moments it changes course — a new track, play, pause, a seek —
 * and the system counts on from there by itself; without it the lock screen
 * showed a bar with no position, or none at all.
 */
export function reportPlaybackPosition(playhead: Playhead): void {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
  const state = positionState(playhead);
  if (!state) return;
  try {
    navigator.mediaSession.setPositionState(state);
  } catch { /* refused for an instant; the next report corrects it */ }
}

export function reportPlaying(playing: boolean): void {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
}

/**
 * The system's buttons: play, pause, previous, next, and its progress bar.
 *
 * One at a time and guarded: a browser that does not know an action throws for
 * it, and that must not cost the ones it does know.
 *
 * Deliberately no "seekbackward" / "seekforward": where both kinds are
 * registered, iOS draws the ±10 s buttons in place of previous/next on the lock
 * screen — and for music the next track is the button people reach for.
 */
export function bindSystemControls(audio: HTMLMediaElement, controls: SystemControls): void {
  if (!("mediaSession" in navigator)) return;
  const handle = (action: MediaSessionAction, handler: MediaSessionActionHandler): void => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* not offered by this browser */ }
  };
  handle("play", () => controls.play());
  handle("pause", () => controls.pause());
  handle("previoustrack", () => controls.previous());
  handle("nexttrack", () => controls.next());
  handle("seekto", (details) => {
    if (typeof details.seekTime !== "number" || !Number.isFinite(audio.duration)) return;
    const target = Math.min(audio.duration, Math.max(0, details.seekTime));
    if (details.fastSeek && typeof audio.fastSeek === "function") audio.fastSeek(target);
    else audio.currentTime = target;
    reportPlaybackPosition(audio);
  });
}
