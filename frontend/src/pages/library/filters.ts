import { getLibraryFilters } from "../../shared/api";
import { el } from "../../shared/dom";
import { collapsibleFilters } from "../../shared/filter-panel";
import { formatCount } from "../../shared/format";
import { icon } from "../../shared/icons";
import { t } from "../../shared/i18n";
import { decadeLabel } from "../../shared/library-labels";
import type { LibraryFilters, LibraryKind } from "../../shared/types";

export interface LibraryFilterBarOptions {
  kind: LibraryKind;
  /** The address the page was opened with: a filtered view can be sent on, like a search or a folder. */
  route: URLSearchParams;
  /**
   * Whether to keep room for the bar from the first paint (as many pixels as it
   * took the last time this browser showed this library). Not on a playlist's
   * page, which has no bar.
   */
  holdRoom: boolean;
  /** Whether the bar now on screen is the library's own (and worth remembering the height of). */
  shouldRemember: () => boolean;
  /** A filter was changed or cleared: the listing is asked for again. */
  onChange: () => void;
  /** The page has gone; nothing more is drawn. */
  isGone: () => boolean;
}

export interface LibraryFilterBar {
  /** The switch that unfolds the panel on a phone; hidden until the library turns out to have filters. */
  toggle: HTMLElement;
  /** The panel, for the page to place above its grid. */
  wrapper: HTMLElement;
  /** What is chosen now. */
  current(): LibraryFilters;
  /** Settles when the controls are filled — or when there turned out to be none. */
  mounted: Promise<void>;
  /** The address named a filter: the first listing waits for `mounted`, and is asked for once, with them. */
  inAddress: boolean;
}

const FILTER_NAMES = ["resolution", "hdr", "video_codec", "audio_codec", "genre", "decade", "tag_genre", "format", "quality", "hires"];

/**
 * A function, not a constant: a module-level table would resolve its labels when
 * the bundle loads, which is before the shell has taken the account's language,
 * and the picture filter would then stay Polish whatever the account chose. The
 * same trap the audit-event and permission tables fell into.
 */
function resolutionLabels(): Array<[NonNullable<LibraryFilters["resolution"]>, string]> {
  return [
    ["uhd", t("4K i wyżej")],
    ["fhd", t("1080p i wyżej")],
    ["hd", t("720p i wyżej")]
  ];
}

/**
 * The library's filters: a row of selects above the grid.
 *
 * Offered only where they mean something. Films get the picture — resolution,
 * HDR, the two codecs — once the library has been through the ffprobe pass, and
 * genre and decade once a title lookup has found any. Music has no resolution;
 * what it has is a format, whether the file kept every sample, and the genre
 * somebody typed into the tag. Every select is filled from what the catalogue
 * actually holds, so none of them offers a codec nobody owns.
 */
export function createLibraryFilters(options: LibraryFilterBarOptions): LibraryFilterBar {
  const { kind, route } = options;
  const filterSelect = (label: string): HTMLSelectElement =>
    el("select", { className: "input library-filter__select", attrs: { "aria-label": label } });
  const resolutionFilter = filterSelect(t("Rozdzielczość"));
  const hdrFilter = filterSelect(t("Zakres tonalny"));
  const videoCodecFilter = filterSelect(t("Kodek wideo"));
  const audioCodecFilter = filterSelect(t("Kodek audio"));
  // What the film is about and when it came out. Unlike the four above, these do
  // not come from the file: they are what the title lookup found, so the selects
  // appear only once something has been looked up.
  const genreFilter = filterSelect(t("Gatunek"));
  const decadeFilter = filterSelect(t("Dekada"));
  // Music genre is free text from the tag, not a dictionary slug, so it is a
  // separate control and a separate query key from the film one.
  const tagGenreFilter = filterSelect(t("Gatunek"));
  const formatFilter = filterSelect(t("Format pliku"));
  const qualityFilter = filterSelect(t("Jakość"));
  const hiresFilter = filterSelect(t("Hi-res"));
  const clearFilters = el(
    "button",
    { className: "button button--secondary", attrs: { type: "button" } },
    icon("close"),
    el("span", { text: t("Wyczyść filtry") })
  );
  const field = (label: string, control: HTMLSelectElement): HTMLElement =>
    el("label", { className: "library-filter__field hidden" }, el("span", { text: label }), control);
  const bar = el(
    "div",
    { className: "library-filter hidden" },
    // Every field starts hidden; `mount` reveals the ones this library has.
    field(t("Rozdzielczość"), resolutionFilter),
    field(t("HDR"), hdrFilter),
    field(t("Kodek wideo"), videoCodecFilter),
    field(t("Kodek audio"), audioCodecFilter),
    field(t("Gatunek"), genreFilter),
    field(t("Dekada"), decadeFilter),
    field(t("Gatunek"), tagGenreFilter),
    field(t("Format"), formatFilter),
    field(t("Jakość"), qualityFilter),
    field(t("Hi-res"), hiresFilter),
    clearFilters
  );
  // On a phone the panel folds away behind a "Filters" switch that counts what
  // is set; on a wide screen it stays open and the switch is never shown. Both
  // stay hidden until this library turns out to have filters at all.
  const fold = collapsibleFilters(bar);
  fold.toggle.classList.add("hidden");

  const read = (): LibraryFilters => ({
    ...(resolutionFilter.value ? { resolution: resolutionFilter.value as LibraryFilters["resolution"] } : {}),
    ...(hdrFilter.value ? { hdr: hdrFilter.value as LibraryFilters["hdr"] } : {}),
    ...(videoCodecFilter.value ? { video_codec: videoCodecFilter.value } : {}),
    ...(audioCodecFilter.value ? { audio_codec: audioCodecFilter.value } : {}),
    ...(genreFilter.value ? { genre: genreFilter.value } : {}),
    ...(decadeFilter.value ? { decade: decadeFilter.value } : {}),
    ...(tagGenreFilter.value ? { tag_genre: tagGenreFilter.value } : {}),
    ...(formatFilter.value ? { format: formatFilter.value } : {}),
    ...(qualityFilter.value ? { quality: qualityFilter.value as LibraryFilters["quality"] } : {}),
    ...(hiresFilter.value ? { hires: hiresFilter.value as LibraryFilters["hires"] } : {})
  });
  let filters: LibraryFilters = {};

  const showState = (): void => {
    const count = Object.keys(filters).length;
    clearFilters.classList.toggle("hidden", count === 0);
    bar.classList.toggle("is-active", count > 0);
    fold.setActiveCount(count);
  };

  /**
   * Hang the shared behaviour on whichever controls this library revealed:
   * changing one reloads the listing, the address carries the choice so a
   * filtered view can be sent on, and "clear" empties exactly these controls.
   */
  const wire = (controls: HTMLSelectElement[], names: string[]): void => {
    const apply = (): void => {
      filters = read();
      showState();
      const url = new URL(window.location.href);
      for (const name of names) url.searchParams.delete(name);
      for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);
      window.history.replaceState({}, "", url);
      options.onChange();
    };
    for (const control of controls) control.addEventListener("change", apply);
    clearFilters.addEventListener("click", () => {
      for (const control of controls) control.value = "";
      apply();
    });
    filters = read();
    showState();
  };

  const mount = async (): Promise<void> => {
    const available = await getLibraryFilters(kind).catch(() => null);
    // No filters here (or none answered): the bar stays hidden.
    if (!available || available.probed === 0 || options.isGone()) return;
    const option = (value: string, label: string): HTMLOptionElement =>
      el("option", { text: label, attrs: { value } });
    const count = (value: number): string => formatCount(value);
    const decades = available.decades ?? [];
    const decadeOptions = (): HTMLOptionElement[] => [
      option("", t("Wszystkie")),
      ...decades.map((entry) => option(String(entry.decade), `${decadeLabel(entry.decade)} (${count(entry.count)})`))
    ];
    const reveal = (controls: HTMLSelectElement[], names: string[]): void => {
      for (const control of controls) control.closest(".library-filter__field")?.classList.remove("hidden");
      bar.classList.remove("hidden");
      fold.toggle.classList.remove("hidden");
      wire(controls, names);
    };

    if (kind === "music") {
      // Each library reveals its own controls; the others stay out of the bar.
      const controls = [formatFilter, qualityFilter, hiresFilter];
      const names = ["format", "quality", "hires"];
      if ((available.tag_genres ?? []).length > 0) {
        controls.push(tagGenreFilter);
        names.push("tag_genre");
      }
      if (decades.length > 0) {
        controls.push(decadeFilter);
        names.push("decade");
      }
      formatFilter.replaceChildren(
        option("", t("Wszystkie")),
        ...(available.formats ?? []).map((format) =>
          option(format.value, `${format.value.toUpperCase()} (${count(format.count)})`))
      );
      const quality = available.quality ?? { lossless: 0, high: 0, standard: 0 };
      qualityFilter.replaceChildren(
        option("", t("Wszystkie")),
        ...(quality.lossless > 0 ? [option("lossless", t("Bezstratne ({count})", { count: count(quality.lossless) }))] : []),
        ...(quality.high > 0 ? [option("high", t("Od 320 kb/s ({count})", { count: count(quality.high) }))] : []),
        ...(quality.standard > 0 ? [option("standard", t("Poniżej 320 kb/s ({count})", { count: count(quality.standard) }))] : [])
      );
      hiresFilter.replaceChildren(
        option("", t("Wszystkie")),
        option("yes", t("Od 88,2 kHz ({count})", { count: count(available.hires ?? 0) })),
        option("no", t("Do 48 kHz"))
      );
      tagGenreFilter.replaceChildren(
        option("", t("Wszystkie")),
        // The tag's own spelling, so it is not put through t(): "Nu Metal" is
        // what somebody typed into the file, not a word this interface owns.
        ...(available.tag_genres ?? []).map((genre) => option(genre.value, `${genre.value} (${count(genre.count)})`)),
        ...(available.unidentified ? [option("none", `${t("Bez gatunku")} (${count(available.unidentified)})`)] : [])
      );
      decadeFilter.replaceChildren(...decadeOptions());
      tagGenreFilter.value = route.get("tag_genre") ?? "";
      decadeFilter.value = route.get("decade") ?? "";
      formatFilter.value = route.get("format") ?? "";
      qualityFilter.value = route.get("quality") ?? "";
      hiresFilter.value = route.get("hires") ?? "";
      reveal(controls, names);
      return;
    }

    // Genre and decade join the film bar only when a lookup has actually filled
    // them in; on a library that has never run one they would be empty selects.
    const controls = [resolutionFilter, hdrFilter, videoCodecFilter, audioCodecFilter];
    const names = ["resolution", "hdr", "video_codec", "audio_codec"];
    if ((available.genres ?? []).length > 0) {
      controls.push(genreFilter);
      names.push("genre");
    }
    if (decades.length > 0) {
      controls.push(decadeFilter);
      names.push("decade");
    }
    // The buckets the server counts are exclusive, the filter is "this or better",
    // so the numbers shown add up from the top.
    let atLeast = 0;
    resolutionFilter.replaceChildren(option("", t("Wszystkie")));
    for (const [value, label] of resolutionLabels()) {
      atLeast += available.resolutions[value] ?? 0;
      if (atLeast > 0) resolutionFilter.append(option(value, `${label} (${formatCount(atLeast)})`));
    }
    hdrFilter.replaceChildren(
      option("", t("Wszystkie")),
      option("yes", t("Tylko HDR ({count})", { count: formatCount(available.hdr) })),
      option("no", t("Bez HDR"))
    );
    videoCodecFilter.replaceChildren(
      option("", t("Wszystkie")),
      ...available.video_codecs.map((codec) => option(codec.value, `${codec.value} (${formatCount(codec.count)})`))
    );
    audioCodecFilter.replaceChildren(
      option("", t("Wszystkie")),
      ...available.audio_codecs.map((codec) => option(codec.value, `${codec.value} (${formatCount(codec.count)})`))
    );
    genreFilter.replaceChildren(
      option("", t("Wszystkie")),
      // The dictionary carries both spellings, so switching language does not
      // ask the server again.
      ...(available.genres ?? []).map((genre) =>
        option(genre.slug, `${t(genre.name_pl)} (${count(genre.count)})`)),
      // "What has the lookup not managed to identify?" — a real question with a
      // real answer, and the only way to see those files as a group.
      ...(available.unidentified ? [option("none", `${t("Bez gatunku")} (${count(available.unidentified)})`)] : [])
    );
    decadeFilter.replaceChildren(...decadeOptions());
    resolutionFilter.value = route.get("resolution") ?? "";
    hdrFilter.value = route.get("hdr") ?? "";
    videoCodecFilter.value = route.get("video_codec") ?? "";
    audioCodecFilter.value = route.get("audio_codec") ?? "";
    genreFilter.value = route.get("genre") ?? "";
    decadeFilter.value = route.get("decade") ?? "";
    reveal(controls, names);
  };

  // The bar sits above the grid and used to be built after it: the listing
  // appeared, then the bar arrived over it and pushed every card down. It is
  // asked for together with the listing now, and its room is held from the
  // first paint: as many pixels as the bar took the last time this browser
  // showed this library (nothing on a phone, where the bar is folded away, and
  // nothing in a library that has no filters).
  const roomKey = `media-${kind}-filter-bar`;
  const rememberedRoom = (): number => {
    try {
      const stored = Number(localStorage.getItem(roomKey));
      return Number.isFinite(stored) && stored > 1 && stored < 800 ? stored : 0;
    } catch { return 0; }
  };
  const rememberRoom = (height: number): void => {
    try {
      if (height > 1) localStorage.setItem(roomKey, String(Math.round(height)));
      else localStorage.removeItem(roomKey);
    } catch { /* pamięć przeglądarki może być niedostępna */ }
  };
  const held = options.holdRoom ? rememberedRoom() : 0;
  if (held > 0) fold.wrapper.style.minHeight = `${held}px`;
  const mounted = mount().then(() => {
    fold.wrapper.style.minHeight = "";
    // Measured once it has been laid out; a playlist's page says nothing about the library's bar.
    requestAnimationFrame(() => {
      if (!options.isGone() && options.shouldRemember()) rememberRoom(fold.wrapper.getBoundingClientRect().height);
    });
  });

  return {
    toggle: fold.toggle,
    wrapper: fold.wrapper,
    current: () => filters,
    mounted,
    inAddress: FILTER_NAMES.some((name) => route.has(name))
  };
}
