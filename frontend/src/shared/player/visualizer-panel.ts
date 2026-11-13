import { el } from "../dom";
import { icon, type IconName } from "../icons";
import { t, tn } from "../i18n";
import { ListPicker, type PickerRow } from "../list-picker";
import { openModal } from "../modal";
import { showToast } from "../toast";
import type { PresetState, VisualizerEngine } from "../visualizations/engine";
import { canonicalVisualizerId } from "../visualizations/internal-plugin";
import type { PresetSearch } from "../visualizations/preset-catalogs";
import { parseFoundValue } from "../visualizations/preset-search";
import type { PresetPool, VisualizerPlugin } from "../visualizations/types";
import type { VisualizerHost } from "./contracts";

/** The preset list's value for "Auto, over the favourites only". */
const AUTO_FAVORITES = "auto:favorites";

/** The visualizers themselves, fetched when the panel is first opened (visualizations/kit.ts). */
type VisualizerKit = typeof import("../visualizations/kit");

/**
 * The visualizer panel: the picture over the page, its toolbar, and the audio
 * graph the picture reads.
 *
 * Nothing of the visualizers rides along with a page: the plug-ins, the engine
 * and the preset search are one chunk (visualizations/kit.ts) fetched the first
 * time the panel opens. The audio graph is made at the same moment and handed
 * to the player (`adoptGraph`), which from then on sets the volume on a gain
 * after the analyser — the visualizers see the music as it is, whatever the
 * slider says.
 *
 * It covers the page behind a backdrop, so it is a dialog and behaves as one:
 * the page under it is inert, the focus is inside (on the panel itself — on a
 * control it would hold the toolbar on screen), Escape closes it and the focus
 * goes back to the button that opened it. It arrives by being uncovered from its
 * bottom edge and leaves the same way (styles/player.css).
 */
export class VisualizerPanel {
  public readonly element: HTMLElement;
  public readonly backdrop: HTMLButtonElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly mode: HTMLSelectElement;
  /**
   * The preset list: shown only while a visualizer with presets is selected. A list picker, not a
   * select — up to 16 900 presets, which a select built into its popup on every opening.
   */
  private readonly preset: ListPicker;
  /**
   * The preset list's search across the visualizers: what is typed there also finds the presets of
   * every other visualizer offered, from catalogs fetched on the first key (preset-catalogs.ts).
   */
  private search: PresetSearch | null = null;
  /** ‹ and › beside the preset list: back and forward over the presets shown (engine history). */
  private readonly presetPrevious: HTMLButtonElement;
  private readonly presetNext: HTMLButtonElement;
  /** "Random next": › and a double click pick a preset at random instead of the next one. */
  private readonly random: HTMLButtonElement;
  /** Which pack the presets come from — only for a build with packs of its own (vendor/milkdrop-presets). */
  private readonly pack: ListPicker;
  /** "Keep this one": what Auto shows becomes the chosen preset. */
  private readonly keep: HTMLButtonElement;
  /** The preset on screen into the favourites or out of them. */
  private readonly favorite: HTMLButtonElement;
  /** What the preset list was built from (plugin, pack, length, revision); rebuilt when it changes. */
  private listKey = "";
  /** The list below its head, the presets' names by id and the ids offered, kept with that key. */
  private listRows: PickerRow[] = [];
  private labels = new Map<string, string>();
  private offered = new Set<string>();
  /** The head of the list (the two Auto choices and the favourites) as last drawn. */
  private headKey = "";
  /** The packs as last listed. */
  private poolsKey = "";
  /** What the list marks on its rows: a star on the favourites, a wave on the preset on screen. */
  private marks: { favorites: ReadonlySet<string>; playing: string } = { favorites: new Set(), playing: "" };
  private marksKey = "";
  /** How many rests in a row a focused list put off (see rest). */
  private restsPutOff = 0;
  /** Hides the toolbar and the pointer over a picture nobody is touching. */
  private idleTimer = 0;
  /** What last woke the toolbar: "mouse", "touch" or "pen" (see rest). */
  private pointerType = "mouse";
  private analyser: AnalyserNode | null = null;
  private engine: VisualizerEngine | null = null;
  private resizeFrame = 0;
  private resetPending = false;
  /** The visualizers this account is offered, and every one there is — both empty until the kit has loaded. */
  private plugins: VisualizerPlugin[] = [];
  private allPlugins: VisualizerPlugin[] = [];
  private kit: Promise<VisualizerKit> | null = null;
  /** Undoes the panel's modality. */
  private releaseModal: (() => void) | null = null;

  public constructor(private readonly host: VisualizerHost) {
    this.backdrop = el("button", {
      className: "visualizer-backdrop",
      attrs: { type: "button", "aria-label": t("Zamknij wizualizację"), "aria-hidden": "true", tabindex: "-1" }
    }) as HTMLButtonElement;
    this.backdrop.addEventListener("click", () => this.setOpen(false));
    this.canvas = el("canvas", { className: "visualizer-panel__canvas" });
    // Its options arrive with the visualizers themselves (loadVisualizers); until then it says so.
    this.mode = el("select", { className: "input input--compact visualizer-panel__select", attrs: { "aria-label": t("Tryb wizualizacji") } });
    this.mode.append(el("option", { text: t("Wczytywanie wizualizacji…"), attrs: { value: "" } }));
    this.mode.disabled = true;
    this.mode.addEventListener("change", () => {
      localStorage.setItem("media-visualizer-mode", this.mode.value);
      this.engine?.select(this.mode.value);
    });
    // The preset list, searchable; a choice made with the pointer leaves no focus behind, so the
    // toolbar may rest again (list-picker.ts), one made with the keyboard returns it to the list.
    // The search also lists what the other visualizers have (preset-catalogs.ts), so even a short
    // list has the field.
    this.preset = new ListPicker({
      label: t("Preset wizualizacji"),
      className: "visualizer-panel__select visualizer-panel__preset hidden",
      searchLabel: t("Szukaj presetu"),
      countLabel: (count) => tn(count, { one: "{count} preset", few: "{count} presety", many: "{count} presetów" }),
      searchFrom: 1,
      minWidth: 26,
      marks: (value) => ({ favorite: this.marks.favorites.has(value), playing: value === this.marks.playing }),
      onActivity: () => this.wake(),
      searchMore: (query) => this.search?.rows(
        query, this.plugins, this.engine?.current()?.id ?? this.mode.value, this.offered
      ) ?? null,
      onAction: (value) => { this.search?.expand(value); },
      onClose: () => this.search?.end(),
      onChoose: (value, input) => {
        const found = parseFoundValue(value);
        if (found) this.chooseFoundPreset(found.visualizer, found.preset, input === "keyboard");
        else if (value === AUTO_FAVORITES) this.engine?.setAutoFavorites(true);
        else if (value === "auto") this.engine?.setAutoFavorites(false);
        else this.engine?.choosePreset(value);
      }
    });
    // ‹ and ›: the preset level (whatever pack or category the lists stand on), back and
    // forward over what was shown — after "Auto" too. The big ⏮ ⏭ change the visualizer.
    this.presetPrevious = this.control("chevron-left", t("Poprzedni preset"), () => this.engine?.previousPreset());
    this.presetPrevious.classList.add("visualizer-panel__preset-step", "visualizer-panel__preset-previous", "hidden");
    this.presetNext = this.control("chevron", t("Następny preset (albo dwuklik na obrazie)"), () => this.engine?.stepPresetForward());
    this.presetNext.classList.add("visualizer-panel__preset-step", "visualizer-panel__preset-next", "hidden");
    // Beside them, the toggle that makes › (and the double click) a random pick (engine.ts).
    this.random = this.control("dice", t("Losowy następny preset"), () => {
      const engine = this.engine;
      if (engine) engine.setRandomNext(!engine.isRandomNext());
    });
    this.random.classList.add("visualizer-panel__random", "hidden");
    this.keep = this.control("lock", t("Zostaw ten preset (koniec trybu Auto)"), () => this.engine?.keepCurrentPreset());
    this.keep.classList.add("visualizer-panel__keep", "hidden");
    this.favorite = this.control("star", t("Dodaj preset do ulubionych"), () => this.engine?.toggleFavoritePreset());
    this.favorite.classList.add("visualizer-panel__favorite", "hidden");
    // AVS lists some 770 packs and folders.
    this.pack = new ListPicker({
      label: t("Paczka presetów"),
      className: "visualizer-panel__select visualizer-panel__pack hidden",
      searchLabel: t("Szukaj paczki"),
      countLabel: (count) => tn(count, { one: "{count} pozycja", few: "{count} pozycje", many: "{count} pozycji" }),
      minWidth: 22,
      onActivity: () => this.wake(),
      onChoose: (value) => this.engine?.choosePool(value)
    });
    this.pack.setTitle(t("Paczka presetów: z niej biorą presety lista i tryb Auto"));
    const shift = (direction: 1 | -1): void => {
      const current = Math.max(0, this.plugins.findIndex((plugin) => plugin.id === this.mode.value));
      const nextIndex = (current + direction + this.plugins.length) % this.plugins.length;
      const next = this.plugins[nextIndex];
      if (!next) return;
      this.mode.value = next.id;
      localStorage.setItem("media-visualizer-mode", next.id);
      this.engine?.select(next.id);
    };
    this.element = el(
      "div",
      {
        className: "visualizer-panel",
        attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("Wizualizacja"), "aria-hidden": "true", tabindex: "-1" }
      },
      this.canvas,
      el(
        "div",
        { className: "visualizer-panel__toolbar" },
        this.control("previous", t("Poprzednia wizualizacja"), () => shift(-1)),
        this.mode,
        this.pack.element,
        this.presetPrevious,
        this.preset.element,
        this.presetNext,
        this.random,
        this.keep,
        this.favorite,
        this.control("next", t("Następna wizualizacja"), () => shift(1)),
        this.control("fullscreen", t("Pełny ekran"), () => {
          const operation = document.fullscreenElement === this.element
            ? document.exitFullscreen()
            : this.element.requestFullscreen();
          void operation.catch(() => undefined);
        }),
        this.control("close", t("Zamknij"), () => this.setOpen(false))
      )
    );
    for (const type of ["pointermove", "pointerdown", "keydown"]) {
      this.element.addEventListener(type, (event) => this.wake(event));
    }
    // Off the picture (the panel is not full screen) the toolbar is simply there.
    // Only a mouse leaves that way: a finger lifting off a touch screen fires
    // `pointerleave` too, and treating it as "off the picture" pinned the toolbar
    // after every tap on a phone.
    this.element.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      window.clearTimeout(this.idleTimer);
      this.element.classList.remove("is-idle");
    });
    // On a touch screen a select (the visualizer's) opens as the system's own picker,
    // which is closed once a choice is made. The select keeps the focus all the same,
    // and a focused select holds the toolbar for up to half a minute (see rest) — so
    // let it go after the choice and the toolbar rests as usual.
    this.element.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      if (this.element.dataset.input !== "pointer" || this.pointerType === "mouse") return;
      target.blur();
    });
    // A double click on the picture moves to the next MilkDrop preset — in auto
    // mode it brings the next change forward. Nothing happens for the others.
    this.element.addEventListener("dblclick", (event) => {
      // Not on the toolbar, nor on a visualization's own controls over the picture.
      if ((event.target as Element | null)?.closest(".visualizer-panel__toolbar, .visualizer-panel__overlay")) return;
      this.engine?.stepPresetForward();
    });
    document.addEventListener("fullscreenchange", () => this.scheduleResize(true));
    window.addEventListener("resize", () => this.scheduleResize());
    if ("ResizeObserver" in window) new ResizeObserver(() => this.scheduleResize()).observe(this.element);
  }

  private control(name: IconName, label: string, handler: () => void): HTMLButtonElement {
    const button = el("button", { className: "player-control", attrs: { type: "button", "aria-label": label } }, icon(name));
    button.addEventListener("click", handler);
    return button as HTMLButtonElement;
  }

  public isOpen(): boolean {
    return this.element.getAttribute("aria-hidden") === "false";
  }

  // --- What the player tells the panel ----------------------------------------------------

  /** A new track: visualizers that show the title show this one. */
  public announce(text: string): void {
    this.engine?.announce(text);
  }

  /** The music started (again): a panel that is open draws again. */
  public playbackStarted(): void {
    if (this.isOpen()) this.engine?.start();
  }

  /** The dock's button. */
  public async toggle(): Promise<void> {
    const open = !this.isOpen();
    this.setOpen(open);
    if (!open) return;
    if (!(await this.ensureEngine())) return;
    if (this.plugins.length === 0) {
      // The setting names only visualizers this build does not have: nothing to offer after all.
      this.setOpen(false);
      this.host.availabilityChanged(false);
      return;
    }
    this.engine?.start();
    this.scheduleResize(true);
  }

  /**
   * Show one visualizer whether or not the panel offers it — the administrator's
   * "preview" beside each one in the settings.
   */
  public async preview(id: string): Promise<void> {
    // Opened at once: the audio context has to start inside this press (ensureEngine).
    this.setOpen(true);
    if (!(await this.ensureEngine())) return;
    const plugin = this.allPlugins.find((candidate) => candidate.id === id);
    if (!plugin) return;
    if (!this.mode.querySelector(`option[value="${CSS.escape(id)}"]`)) {
      this.mode.append(el("option", { text: t("{name} (podgląd)", { name: plugin.label }), attrs: { value: id } }));
    }
    this.mode.value = id;
    localStorage.setItem("media-visualizer-mode", id);
    this.engine?.select(id);
    this.engine?.start();
  }

  // --- The visualizers and the audio graph ---------------------------------------------------

  /**
   * Fetch the visualizers (the first time the panel opens) and name them in the
   * panel's list. Until this the player holds no plug-in at all — which is the
   * point: none of it rides along with every page (visualizations/kit.ts).
   */
  private loadVisualizers(): Promise<VisualizerKit> {
    this.kit ??= import("../visualizations/kit").then((kit) => {
      const settings = this.host.session.settings;
      this.allPlugins = kit.orderedVisualizerPlugins(settings.visualizer_order);
      this.plugins = kit.orderedVisualizerPlugins(settings.visualizer_order, settings.visualizer_enabled);
      this.search = new kit.PresetSearch(() => this.preset.refreshSearch());
      this.mode.replaceChildren(
        ...this.plugins.map((plugin) => el("option", { text: plugin.label, attrs: { value: plugin.id } }))
      );
      this.mode.disabled = false;
      // A choice saved before Internal took the player's own visualizations over names one of them.
      const saved = canonicalVisualizerId(localStorage.getItem("media-visualizer-mode") ?? "");
      if (saved && this.plugins.some((plugin) => plugin.id === saved)) this.mode.value = saved;
      return kit;
    }).catch((error: unknown) => {
      // Not kept: the next press of the button asks again.
      this.kit = null;
      throw error;
    });
    return this.kit;
  }

  private scheduleResize(reset = false): void {
    if (!this.isOpen()) return;
    this.resetPending ||= reset;
    window.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = window.requestAnimationFrame(() => {
      const shouldReset = this.resetPending;
      this.resetPending = false;
      this.engine?.resize(shouldReset);
      this.resizeFrame = window.requestAnimationFrame(() => {
        this.resizeFrame = 0;
        this.engine?.resize();
      });
    });
  }

  /**
   * The audio graph and the engine, made on the panel's first opening. False
   * when there is nothing to draw on after all: the visualizers could not be
   * fetched, or the panel was closed while they were on the way.
   *
   * The audio context is made first and before any waiting — this is still
   * inside the press that opened the panel, the only moment Safari lets a
   * context start.
   */
  private async ensureEngine(): Promise<boolean> {
    if (!this.analyser) {
      const context = new AudioContext();
      const source = context.createMediaElementSource(this.host.audio);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 256;
      const gain = context.createGain();
      source.connect(this.analyser);
      this.analyser.connect(gain);
      gain.connect(context.destination);
      this.host.adoptGraph(context, gain);
      // An interruption (iOS: a call, Siri, the lock screen) stops the context
      // and leaves the element playing into it; whenever the state moves, the
      // player decides whether the music is meant to be on and asks for it back.
      context.addEventListener("statechange", () => this.host.contextStateChanged());
      await context.resume().catch(() => undefined);
    }
    if (!this.engine) {
      let kit: VisualizerKit;
      try {
        kit = await this.loadVisualizers();
      } catch {
        this.setOpen(false);
        showToast(t("Nie udało się wczytać wizualizacji. Spróbuj ponownie."), "error");
        return false;
      }
      // Two presses in a row wait for the same fetch; the first to come back builds the engine.
      if (!this.engine) {
        this.engine = new kit.VisualizerEngine(
          this.canvas, this.analyser, this.allPlugins, this.plugins.map((plugin) => plugin.id)
        );
        this.mode.value = this.engine.current()?.id ?? this.mode.value;
        this.engine.onPresets((state) => this.renderPresetChoice(state));
        // AVS presets read the track's position and length (Winamp gave them); a paused track
        // keeps its position, which is how some of them notice a pause.
        const audio = this.host.audio;
        this.engine.setPlayback(() => ({ position: audio.currentTime, duration: audio.duration }));
      }
    }
    return this.isOpen();
  }

  private renderPresetChoice(state: PresetState | null): void {
    const picker = this.preset;
    const packs = this.pack;
    // A visualizer left with no presets (every one failed) has nothing to choose or skip.
    const none = state !== null && !state.loading && !state.failed && state.presets.length === 0;
    picker.element.classList.toggle("hidden", state === null || none);
    if (state === null || none) picker.close();
    const stepping = state === null || state.loading || state.failed || none;
    this.presetNext.classList.toggle("hidden", stepping);
    this.presetPrevious.classList.toggle("hidden", stepping);
    this.presetPrevious.disabled = !state?.canGoBack;
    this.random.classList.toggle("hidden", stepping);
    const random = Boolean(state?.randomNext);
    this.random.classList.toggle("is-active", random);
    this.random.setAttribute("aria-pressed", String(random));
    this.random.dataset.tooltip = random
      ? t("Losowy następny preset: włączony. › i dwuklik losują preset z listy.")
      : t("Losowy następny preset: wyłączony. › i dwuklik biorą następny z listy.");
    const nextLabel = random ? t("Losowy preset (albo dwuklik na obrazie)") : t("Następny preset (albo dwuklik na obrazie)");
    this.presetNext.setAttribute("aria-label", nextLabel);
    const ready = state !== null && !state.loading && !state.failed && Boolean(state.current);
    this.keep.classList.toggle("hidden", !ready || state?.chosen !== "auto");
    this.favorite.classList.toggle("hidden", !ready);
    const favorite = ready && state!.favorites.includes(state!.current);
    this.favorite.classList.toggle("is-active", favorite);
    this.favorite.setAttribute("aria-pressed", String(favorite));
    const favoriteLabel = favorite ? t("Usuń preset z ulubionych") : t("Dodaj preset do ulubionych");
    this.favorite.setAttribute("aria-label", favoriteLabel);
    this.favorite.title = favoriteLabel;
    // A pack choice only when there is something to choose: a build without
    // packs of its own shows the toolbar it always had.
    const offerPacks = state !== null && !state.loading && !state.failed && state.pools.length > 1;
    packs.element.classList.toggle("hidden", !offerPacks);
    if (!offerPacks) packs.close();
    if (!state) return;
    picker.setDisabled(state.loading || state.failed);
    if (state.failed || state.loading) {
      picker.setRows([]);
      picker.setValue("auto", state.failed ? t("Niedostępne w tej przeglądarce") : t("Wczytywanie presetów…"));
      picker.setTitle(state.failed ? t("Wymaga WebGL 2 i zgody na WebAssembly ('wasm-unsafe-eval' w CSP).") : "");
      this.listKey = "";
      this.headKey = "";
      return;
    }
    if (offerPacks) {
      const pools = `${state.pluginId}|${state.pools.map((pool) => `${pool.id}\t${pool.label}\t${pool.group ?? ""}`).join("\n")}`;
      if (this.poolsKey !== pools) {
        packs.setRows(this.poolRows(state.pools));
        this.poolsKey = pools;
        // Named by the visualizer where its choice is not packs (Geiss: the colour depth).
        packs.setLabel(state.poolsLabel ?? t("Paczka presetów"));
        packs.setTitle(state.poolsLabel ?? t("Paczka presetów: z niej biorą presety lista i tryb Auto"));
      }
      packs.setValue(state.pool, state.pools.find((pool) => pool.id === state.pool)?.label ?? "");
    }
    // Rebuilt when the plugin, the pack or the list's length changes — a pack's
    // list arriving, a preset that failed — or the visualizer renames presets
    // (Geiss: a slot saved over), not on every choice. Rows are plain objects
    // (the list draws only those in view), but 16 900 of them, their names by id
    // and the set of ids are still nothing to make again for nothing.
    const list = `${state.pluginId}|${state.pool}|${state.presets.length}|${state.revision}`;
    if (this.listKey !== list) {
      const labels = new Map<string, string>();
      for (const group of state.groups ?? []) for (const preset of group.presets) labels.set(preset.id, preset.label);
      this.labels = labels;
      this.offered = new Set(state.presets);
      this.listRows = state.groups
        ? state.groups.flatMap((group): PickerRow[] => {
            const grouped = Boolean(group.label);
            const options = group.presets.map((preset): PickerRow => ({ kind: "option", value: preset.id, label: preset.label, grouped }));
            return grouped ? [{ kind: "heading", label: group.label }, ...options] : options;
          })
        : state.presets.map((name): PickerRow => ({ kind: "option", value: name, label: name }));
      this.listKey = list;
      this.headKey = "";
    }
    const label = (id: string): string => this.labels.get(id) ?? id;
    // "Ulubione" is all favourites: no group of them on top, no "Auto — favourites only".
    const favorites = state.favoritesList ? [] : state.favorites.filter((id) => this.offered.has(id));
    // In Auto the list says what is on screen; one choice there keeps it.
    const autoOnFavorites = state.chosen === "auto" && state.autoFavorites && favorites.length >= 2;
    const showing = state.current ? label(state.current) : "";
    const autoText = state.chosen === "auto" && !autoOnFavorites && showing
      ? t("Auto: {name}", { name: showing })
      : t("Auto — płynne przejścia");
    const autoFavoritesText = autoOnFavorites && showing
      ? t("Auto, ulubione: {name}", { name: showing })
      : t("Auto — tylko ulubione");
    // The head of the list — Auto, Auto over the favourites, the favourites — changes with every
    // star and with what Auto shows; the rows below stay the same objects (and keep the folded
    // names the search compares).
    const head = [autoText, favorites.length >= 2 ? autoFavoritesText : "", ...favorites].join("\n");
    if (this.headKey !== head) {
      // Shortcuts beside the list (`aside`): the count says how many presets there are, and a
      // favourite on top needs no star of its own.
      const rows: PickerRow[] = [{ kind: "option", value: "auto", label: autoText, aside: true }];
      if (favorites.length >= 2) rows.push({ kind: "option", value: AUTO_FAVORITES, label: autoFavoritesText, aside: true });
      if (favorites.length) {
        rows.push({ kind: "heading", label: t("★ Ulubione") });
        for (const id of favorites) rows.push({ kind: "option", value: id, label: label(id), grouped: true, aside: true });
      }
      picker.setRows(rows.concat(this.listRows));
      this.headKey = head;
    }
    const value = state.chosen === "auto" ? (autoOnFavorites ? AUTO_FAVORITES : "auto") : state.chosen;
    picker.setValue(value, value === "auto" ? autoText : value === AUTO_FAVORITES ? autoFavoritesText : label(state.chosen));
    picker.setTitle(state.chosen === "auto" && showing ? showing : "");
    const marks = `${favorites.join("\n")}|${state.current}`;
    if (this.marksKey !== marks) {
      this.marks = { favorites: new Set(favorites), playing: state.current };
      this.marksKey = marks;
      picker.refresh();
    }
  }

  /**
   * A preset another visualizer has, found by the preset list's search: the panel switches to that
   * visualizer as its own list would (the choice remembered) and starts it on that preset — in a
   * pack that has it — rather than on the one it had. Chosen with the keyboard, the focus goes to
   * the visualizer list, which names it now: the preset list is out of use while it loads.
   */
  private chooseFoundPreset(visualizer: string, preset: string, keyboard: boolean): void {
    if (!this.plugins.some((plugin) => plugin.id === visualizer)) return;
    this.mode.value = visualizer;
    localStorage.setItem("media-visualizer-mode", visualizer);
    this.engine?.select(visualizer, preset);
    if (keyboard) this.mode.focus({ preventScroll: true });
  }

  /** The pack choice: a pack's categories listed under its name. */
  private poolRows(pools: readonly PresetPool[]): PickerRow[] {
    const entries: (PresetPool | { heading: string; pools: PresetPool[] })[] = [];
    const headings = new Map<string, PresetPool[]>();
    for (const pool of pools) {
      if (!pool.group) {
        entries.push(pool);
        continue;
      }
      let members = headings.get(pool.group);
      if (!members) {
        members = [];
        headings.set(pool.group, members);
        entries.push({ heading: pool.group, pools: members });
      }
      members.push(pool);
    }
    return entries.flatMap((entry): PickerRow[] => ("heading" in entry
      ? [
          { kind: "heading", label: entry.heading },
          ...entry.pools.map((pool): PickerRow => ({ kind: "option", value: pool.id, label: pool.label, grouped: true }))
        ]
      : [{ kind: "option", value: entry.id, label: entry.label }]));
  }

  // --- A toolbar that steps aside ---------------------------------------------------------------

  /**
   * The toolbar and the pointer step aside after a moment without movement over
   * the picture — on the panel and in full screen alike — and come back with the
   * first movement, touch or key. Keyboard use keeps the toolbar: its focus is
   * the only way back to it.
   */
  private wake(event?: Event): void {
    const panel = this.element;
    if (event?.type === "keydown") panel.dataset.input = "keyboard";
    else if (event) panel.dataset.input = "pointer";
    if (event instanceof PointerEvent && event.pointerType) this.pointerType = event.pointerType;
    panel.classList.remove("is-idle");
    window.clearTimeout(this.idleTimer);
    if (!this.isOpen()) return;
    this.restsPutOff = 0;
    this.idleTimer = window.setTimeout(() => this.rest(), 2500);
  }

  /**
   * The toolbar rests — unless one of its lists is open, or its select has the
   * focus: an open list would be left hanging over the picture without its
   * toolbar. That holds it for half a minute at most; a list in use (scrolled,
   * searched) wakes the toolbar itself, so the half minute counts from then.
   * Past it the lists close.
   */
  private rest(): void {
    const active = document.activeElement;
    const focusedSelect = active instanceof HTMLSelectElement && this.element.contains(active);
    if (focusedSelect || this.preset.isOpen() || this.pack.isOpen()) {
      this.restsPutOff += 1;
      if (this.restsPutOff < 12) {
        this.idleTimer = window.setTimeout(() => this.rest(), 2500);
        return;
      }
      const keyboard = this.element.dataset.input === "keyboard";
      this.preset.close(keyboard);
      this.pack.close(keyboard);
      if (active instanceof HTMLSelectElement && focusedSelect) active.blur();
    }
    this.element.classList.add("is-idle");
  }

  // --- Open and closed -----------------------------------------------------------------------------

  public setOpen(open: boolean): void {
    this.element.setAttribute("aria-hidden", String(!open));
    this.backdrop.setAttribute("aria-hidden", String(!open));
    this.wake();
    if (open) {
      this.releaseModal ??= openModal(this.element, {
        onEscape: () => this.setOpen(false),
        initialFocus: this.element,
        alsoActive: this.host.surfaces()
      });
      return;
    }
    this.releaseModal?.();
    this.releaseModal = null;
    this.preset.close();
    this.pack.close();
    if (document.fullscreenElement === this.element) void document.exitFullscreen().catch(() => undefined);
    this.engine?.stop();
  }
}
