import { initSegmentEnd, mp4MimeType } from "./mp4-codecs";

/**
 * A film in compatibility mode, loaded ahead through Media Source.
 *
 * The server sends the film as fragmented MP4 on one long response (stereo.py:
 * FFmpeg, an empty moov, then a fragment every 2 s). Given to <video> as its src,
 * Chrome keeps only some 2–3 seconds of such a stream ahead — it cannot tell the
 * bitrate of a response without a length. Measured 11.11.2026: 2.3–2.4 s all the
 * way, on a computer and on a phone, so any slow moment of the network stopped
 * the picture. Here the page reads the response itself and hands it to a
 * SourceBuffer until `ahead` seconds lie loaded in front of the playhead, then
 * stops reading — FFmpeg on the server waits behind its own read-ahead — and
 * reads on as playback moves. The files stay as they are.
 *
 * What lies more than BEHIND seconds behind the playhead is let go, so the
 * browser's quota (some 150 MB of video on a computer, less on a phone) is spent
 * on what is ahead; when it is full anyway, the target shrinks to what fits.
 *
 * The element sees the same timeline as with a plain src: zero is the stream's
 * first frame. A seek inside what is loaded needs no new stream (covers()).
 */

/** Seconds of film kept behind the playhead (a step back stays instant). */
const BEHIND = 30;
/** Bytes collected before an append: fewer, larger appends cost the parser less. */
const APPEND_BYTES = 512 * 1024;
/** How long the reader waits for playback before it checks the buffer again. */
const IDLE_MS = 1000;

export interface StreamBufferOptions {
  /** Seconds to keep loaded ahead of the playhead. */
  ahead: number;
  /**
   * The stream turned out to be one Media Source cannot take (its codecs), before
   * anything played: the caller plays the same URL as a plain src instead.
   */
  onUnsupported(): void;
}

type Wake = () => void;
/** Bytes on an ordinary ArrayBuffer — what appendBuffer() takes. */
type Bytes = Uint8Array<ArrayBuffer>;

export class StreamBuffer {
  /** Media Source and readable response bodies — everything this needs. */
  public static supported(): boolean {
    return typeof MediaSource !== "undefined"
      && typeof MediaSource.isTypeSupported === "function"
      && typeof ReadableStream !== "undefined";
  }

  private readonly abort = new AbortController();
  private readonly source = new MediaSource();
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl = "";
  private target: number;
  private destroyed = false;
  private wake: Wake | null = null;

  public constructor(
    private readonly video: HTMLVideoElement,
    private readonly url: string,
    private readonly options: StreamBufferOptions
  ) {
    this.target = Math.max(4, options.ahead);
  }

  /** Puts the stream on the element: its src becomes the Media Source. */
  public attach(): void {
    this.objectUrl = URL.createObjectURL(this.source);
    this.source.addEventListener("sourceopen", () => void this.run(), { once: true });
    this.video.addEventListener("timeupdate", this.nudge);
    this.video.addEventListener("seeking", this.nudge);
    this.video.src = this.objectUrl;
  }

  /** Whether `seconds` of the stream are loaded, so the element can seek there without a new stream. */
  public covers(seconds: number): boolean {
    if (this.destroyed || !this.sourceBuffer) return false;
    const ranges = this.video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      if (seconds >= ranges.start(index) && seconds <= ranges.end(index) - 0.5) return true;
    }
    return false;
  }

  /** Stops reading and lets the stream go (the element's src is the caller's to change). */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.video.removeEventListener("timeupdate", this.nudge);
    this.video.removeEventListener("seeking", this.nudge);
    this.nudge();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }

  private readonly nudge = (): void => {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  };

  /** Until playback moves (timeupdate, a seek) or a second passes. */
  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.wake === done) this.wake = null;
        resolve();
      }, IDLE_MS);
      const done: Wake = () => {
        window.clearTimeout(timer);
        resolve();
      };
      this.wake = done;
    });
  }

  /** Seconds loaded in front of the playhead, in the range it stands in. */
  private ahead(): number {
    const now = this.video.currentTime;
    const ranges = this.video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= now + 0.3 && ranges.end(index) > now) return ranges.end(index) - now;
    }
    return 0;
  }

  private settled(): Promise<void> {
    const buffer = this.sourceBuffer;
    if (!buffer || !buffer.updating) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", done);
        resolve();
      };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", done);
    });
  }

  /** Lets go of what lies behind the playhead — `keep` seconds of it stay. */
  private async trim(keep: number): Promise<void> {
    const buffer = this.sourceBuffer;
    if (!buffer) return;
    const ranges = buffer.buffered;
    if (ranges.length === 0) return;
    const cut = this.video.currentTime - keep;
    if (ranges.start(0) >= cut - 1) return;
    await this.settled();
    if (this.destroyed || this.source.readyState !== "open") return;
    buffer.remove(ranges.start(0), cut);
    await this.settled();
  }

  /** One append, made to fit: a full quota drops what is behind and then lowers the target. */
  private async append(bytes: Bytes): Promise<void> {
    const buffer = this.sourceBuffer;
    if (!buffer) return;
    for (let attempt = 0; ; attempt += 1) {
      await this.trim(BEHIND);
      await this.settled();
      if (this.destroyed || this.source.readyState !== "open") return;
      try {
        buffer.appendBuffer(bytes);
        await this.settled();
        return;
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "QuotaExceededError" || attempt >= 40) throw error;
        // Full: hold less ahead from now on, keep only a little behind, and
        // wait for playback to make room.
        this.target = Math.max(4, Math.min(this.target, this.ahead() * 0.8));
        await this.trim(4);
        await this.idle();
      }
    }
  }

  private async run(): Promise<void> {
    let reader: ReadableStreamDefaultReader<Bytes>;
    try {
      const response = await fetch(this.url, { credentials: "same-origin", cache: "no-store", signal: this.abort.signal });
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      reader = response.body.getReader() as ReadableStreamDefaultReader<Bytes>;
    } catch {
      this.fail("network");
      return;
    }
    try {
      // The header first: the codecs are read from it before a SourceBuffer can exist.
      let head: Bytes = new Uint8Array(0);
      let headerEnd = -1;
      while (headerEnd < 0) {
        const { done, value } = await reader.read();
        if (done || this.destroyed) {
          if (!this.destroyed) this.fail("network");
          return;
        }
        head = concat([head, value]);
        headerEnd = initSegmentEnd(head);
        if (headerEnd < 0 && head.length > 8 * 1024 * 1024) throw new Error("no MP4 header");
      }
      const mime = mp4MimeType(head.subarray(0, headerEnd));
      if (!mime || !MediaSource.isTypeSupported(mime)) {
        this.unsupported(reader);
        return;
      }
      this.sourceBuffer = this.source.addSourceBuffer(mime);
      await this.append(head);
      this.startAtFirstFrame();
      // Then the rest, as far ahead as the target.
      let pending: Bytes[] = [];
      let pendingBytes = 0;
      for (;;) {
        while (!this.destroyed && this.ahead() >= this.target) await this.idle();
        if (this.destroyed) return;
        const { done, value } = await reader.read();
        if (this.destroyed) return;
        if (!done) {
          pending.push(value);
          pendingBytes += value.length;
        }
        if (pendingBytes >= APPEND_BYTES || (done && pendingBytes > 0)) {
          await this.append(concat(pending));
          pending = [];
          pendingBytes = 0;
        }
        if (done) break;
      }
      await this.settled();
      if (!this.destroyed && this.source.readyState === "open") this.source.endOfStream();
    } catch {
      if (!this.destroyed) this.fail(this.sourceBuffer ? "decode" : "network");
    }
  }

  /**
   * A stream whose first frame lies a hair after zero would leave the element
   * waiting at zero for data that never comes; start it where the picture does.
   */
  private startAtFirstFrame(): void {
    const ranges = this.video.buffered;
    if (ranges.length > 0 && ranges.start(0) > this.video.currentTime + 0.001 && ranges.start(0) < 3) {
      this.video.currentTime = ranges.start(0);
    }
  }

  private unsupported(reader: ReadableStreamDefaultReader<Bytes>): void {
    void reader.cancel().catch(() => undefined);
    if (this.destroyed) return;
    this.options.onUnsupported();
  }

  /**
   * The stream broke. Ending the source with an error is what the element reports
   * as a media error, and the viewer's error handling starts a new stream from the
   * same second (media-viewer.ts) — the same way a broken plain src recovers.
   */
  private fail(kind: "network" | "decode"): void {
    if (this.destroyed) return;
    this.destroy();
    try {
      if (this.source.readyState === "open") this.source.endOfStream(kind);
    } catch { /* źródło już zamknięte */ }
  }
}

function concat(parts: Bytes[]): Bytes {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
