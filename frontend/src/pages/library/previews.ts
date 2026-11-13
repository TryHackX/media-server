import { previewUrl } from "../../shared/api";
import { el } from "../../shared/dom";
import { icon, type IconName } from "../../shared/icons";
import { supportsThumbnail } from "../../shared/library-state";
import type { MediaItem, MediaKind } from "../../shared/types";

interface SlidingPreview {
  visual: HTMLElement;
  /** Image URLs to try, in order; a failing one hands over to the next. */
  candidates: string[];
  index: number;
  visible: boolean;
  busy: boolean;
  failures: number;
}

export interface PreviewSource {
  /** The item whose own thumbnail this is, when there are no candidates. */
  itemId: number | null;
  kind: MediaItem["media_kind"] | null;
  /** The glyph shown until (or instead of) a picture. */
  fallback: IconName;
  /** A folder's or a playlist's pictures; each is tried, a missing one hands over to the next. */
  candidates?: Array<{ id: number; kind: MediaKind }>;
  /** Turn the candidates over, one every few seconds, while the card is in view. */
  slideshow?: boolean;
  /** Tried before the candidates; a 404 (no own cover) falls through to them. */
  leadUrl?: string | null;
}

export interface Previews {
  /** The picture of a card: `.media-card__preview`, loading by itself. */
  create(source: PreviewSource): HTMLElement;
  /** A card entered or left the drawn window of the grid: its pictures are watched, or left alone. */
  setActivity(card: HTMLElement, active: boolean): void;
  dispose(): void;
}

/** How long a folder's picture stays before the next one takes its place. */
const TURN_MS = 9500;
/** How long the picture that left is kept for the cross-fade (styles/cards.css). */
const LEAVE_MS = 1900;

/**
 * The pictures on the library's cards.
 *
 * Each loads lazily and falls back along its candidates; a folder's or a
 * playlist's turn over slowly, but only those in view, and not at all while the
 * tab is hidden or a dialog lies over the grid — each turn is an image fetched
 * and decoded, and nobody is looking.
 */
export function createPreviews(): Previews {
  let sliding: SlidingPreview[] = [];
  const states = new WeakMap<Element, SlidingPreview>();
  const observer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const state = states.get(entry.target);
      if (state) state.visible = entry.isIntersecting;
    }
  }, { rootMargin: "240px" }) : null;

  /** The next picture is in: it fades in over the one that was there, which then goes. */
  const swap = (visual: HTMLElement, next: HTMLImageElement): void => {
    const previous = visual.querySelector<HTMLImageElement>(".media-preview__image.is-active");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        next.classList.add("is-active");
        if (!previous) return;
        previous.classList.remove("is-active");
        previous.classList.add("is-leaving");
        window.setTimeout(() => previous.remove(), LEAVE_MS);
      });
    });
  };

  const create = (source: PreviewSource): HTMLElement => {
    const visual = el("div", { className: "media-card__preview" }, icon(source.fallback));
    const usable = (source.candidates ?? []).filter((candidate, index, all) =>
      supportsThumbnail(candidate.kind) && all.findIndex((other) => other.id === candidate.id) === index
    );
    if (usable.length === 0 && source.itemId !== null && supportsThumbnail(source.kind)) {
      usable.push({ id: source.itemId, kind: source.kind as MediaKind });
    }
    const sources = usable.map((candidate) => previewUrl(candidate.id));
    if (source.leadUrl) sources.unshift(source.leadUrl);
    const slideshow = source.slideshow === true && sources.length > 1;
    if (slideshow) {
      const entropy = crypto.getRandomValues(new Uint32Array(sources.length));
      for (let index = sources.length - 1; index > 0; index -= 1) {
        const target = (entropy[index] ?? 0) % (index + 1);
        const current = sources[index]!;
        sources[index] = sources[target]!;
        sources[target] = current;
      }
    }
    if (sources.length === 0) return visual;

    const state: SlidingPreview = { visual, candidates: sources, index: 0, visible: observer === null, busy: false, failures: 0 };
    const load = (): void => {
      if (state.busy || !state.candidates[state.index]) return;
      state.busy = true;
      const image = el("img", {
        className: "media-preview__image",
        attrs: { alt: "", loading: "lazy", decoding: "async", src: state.candidates[state.index]! }
      });
      image.addEventListener("load", () => {
        state.busy = false;
        state.failures = 0;
        visual.classList.add("has-image");
        image.classList.add("is-active");
      }, { once: true });
      image.addEventListener("error", () => {
        image.remove();
        state.busy = false;
        state.failures += 1;
        if (state.failures >= state.candidates.length) return;
        state.index = (state.index + 1) % state.candidates.length;
        load();
      }, { once: true });
      visual.append(image);
    };
    states.set(visual, state);
    observer?.observe(visual);
    load();
    if (slideshow) {
      visual.classList.add("is-slideshow");
      sliding.push(state);
    }
    return visual;
  };

  const timer = window.setInterval(() => {
    if (document.hidden || document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])')) return;
    sliding = sliding.filter((state) => {
      if (!state.visual.isConnected) observer?.unobserve(state.visual);
      return state.visual.isConnected;
    });
    for (const state of sliding) {
      if (!state.visible || state.busy) continue;
      state.index = (state.index + 1) % state.candidates.length;
      state.visual.querySelector<HTMLImageElement>(".media-preview__image:not(.is-active)")?.remove();
      const candidate = state.candidates[state.index];
      if (!candidate) continue;
      const next = el("img", { className: "media-preview__image", attrs: { alt: "", decoding: "async", src: candidate } });
      state.busy = true;
      next.addEventListener("load", () => {
        state.busy = false;
        void next.offsetWidth;
        swap(state.visual, next);
      }, { once: true });
      next.addEventListener("error", () => { state.busy = false; next.remove(); }, { once: true });
      state.visual.append(next);
    }
  }, TURN_MS);

  return {
    create,
    setActivity(card: HTMLElement, active: boolean): void {
      for (const visual of Array.from(card.querySelectorAll(".media-card__preview"))) {
        const state = states.get(visual);
        if (state) state.visible = active;
        if (active) observer?.observe(visual);
        else observer?.unobserve(visual);
      }
    },
    dispose(): void {
      observer?.disconnect();
      window.clearInterval(timer);
    }
  };
}
