/**
 * What the scenes of "Klasyka retro" (retro/index.ts) are handed and what they give back.
 *
 * A scene draws one picture at the resolution its original had (a 228-clock TV line, a
 * 640 × 400 VGA screen, Cthugha's buffer) into an RGBA image; the presenter (presenter.ts)
 * scales it to the panel with sharp, even pixels. Nothing here touches the DOM, so a scene runs
 * the same in the browser and in a test.
 */

/** The music, read once a frame for every scene (analysis.ts, audio.ts). */
export interface RetroAudio {
  /** The rate the samples are at: the context's at 44.1/48 kHz, read down to it above (audio-rate.ts). */
  readonly rate: number;
  /** The newest WINDOW samples of each channel, −1…1, oldest first. */
  readonly left: Float32Array;
  readonly right: Float32Array;
  /** Their mean, as a mono mix. */
  readonly mono: Float32Array;
  /** How many of the newest samples arrived since the previous frame (0 … WINDOW). */
  readonly fresh: number;
  /** The mono mix's spectrum: SPECTRUM_BINS bins of `binHz` each, 0–1 on a −90…−20 dB scale, smoothed. */
  readonly spectrum: Float32Array;
  readonly binHz: number;
  /** RMS of the fresh samples, 0–1 (a full-scale sine is about 0.71). */
  readonly rmsLeft: number;
  readonly rmsRight: number;
  /** Peak of the fresh samples, 0–1. */
  readonly peakLeft: number;
  readonly peakRight: number;
  /** 1 at a kick, falling back to 0 within half a second. */
  readonly beat: number;
  /** True for the frame a kick was heard in. */
  readonly onset: boolean;
  /** Something is playing (the fresh samples are above the noise floor). */
  readonly sounding: boolean;
  /** Seconds the music has been silent (0 while it plays). */
  readonly silence: number;
}

/** What else a scene may show: the track and where it stands. */
export interface RetroTrack {
  /** "Title — Artist", or an empty string. */
  title: string;
  /** Seconds into the track, and its length (0 when unknown). */
  position: number;
  duration: number;
}

export interface RetroFrame {
  audio: RetroAudio;
  track: RetroTrack;
  /** Seconds since the scene started, and since its previous frame (0.1 at most). */
  time: number;
  dt: number;
}

/** An RGBA picture, `width × height`, rows top to bottom. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * How the picture fills the panel:
 * - `aspect` > 0: the whole picture keeps that shape (4:3 for a monitor of its time) and is
 *   letterboxed in black;
 * - `aspect` 0: it is stretched over the panel (a scene that adapts, through `resize`).
 */
export interface RetroScene {
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  /** A CRT finish for the presenter: scanlines of a TV set, or none (a sharp monitor). */
  readonly crt?: "tv" | "none";
  /** Told the panel's size in CSS pixels; may change `width` and `height` (Cthugha-L adapts). */
  resize?(panelWidth: number, panelHeight: number): void;
  /** One frame into `image`, which is `width × height`. */
  render(frame: RetroFrame, image: PixelImage): void;
  /**
   * A scene that draws with WebGL instead (glcthugha, in the Cthugha port of vendor/): the
   * canvas it drew this frame on, `width × height`, which the presenter shows in place of
   * `image`. It needs the DOM, so such a scene runs in the browser only.
   */
  surface?(): CanvasImageSource | null;
  /** Free what it holds; it is not used again. */
  dispose?(): void;
}
