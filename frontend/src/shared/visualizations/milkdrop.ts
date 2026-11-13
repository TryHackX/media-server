import type { DoublePreset, PackInfo, PackPreset } from "./milkdrop-packs";
import type {
  CatalogFetch, ExternalOptions, ExternalVisualizer, PresetGroup, PresetPool, VisualizerPlugin
} from "./types";

/**
 * MilkDrop — Ryan Geiss's Winamp visualizer — through butterchurn, its WebGL 2
 * reimplementation (MIT), with the community preset packs it ships.
 *
 * Presets are compiled to WebAssembly (`onlyUseWASM`). butterchurn's other path
 * builds every preset equation with `new Function`, which this site's
 * `script-src 'self'` rightly refuses; WebAssembly needs only
 * `'wasm-unsafe-eval'`, which lets a page compile wasm and nothing else.
 *
 * Everything here is fetched on first use: the engine and ~3.4 MB of presets
 * (butterchurn-presets' base, extra, md1 and image packs) stay out of every
 * page that never opens it, and the service worker caches them only once they
 * have been asked for.
 *
 * The textures presets name are handed over as each preset loads
 * (milkdrop-textures.ts): the build's own (vendor/milkdrop-textures), else
 * the few butterchurn-presets carries, else butterchurn's clouds2 as before.
 *
 * "Auto" is what Winamp did: a preset plays for a while, then blends into the
 * next one. The order is a shuffled deck — every preset once before any comes
 * back — for the same reason the music shuffle no longer draws with replacement.
 *
 * A build may also carry packs of its own (projectM's, converted from
 * vendor/milkdrop-presets — see milkdrop-packs.ts). They sit beside
 * butterchurn's presets, never in place of them: the panel then offers a pack
 * choice, butterchurn's presets stay the default, and a pack's list and its
 * presets are fetched only once somebody picks it.
 */

type PresetMap = Record<string, object>;

export const AUTO_PRESET = "auto";
/** Seconds a preset plays in auto mode, and seconds two presets blend. */
const AUTO_SECONDS = 24;
const BLEND_SECONDS = 2.7;
/** After a pack's preset could not be fetched, auto mode tries another this much later. */
const RETRY_SECONDS = 5;
/**
 * A sharper picture costs fill rate and memory: butterchurn keeps half a dozen
 * full-size textures, so the internal picture is capped at 1440p — the device's
 * pixel ratio up to 2 below that.
 */
const MAX_PIXEL_RATIO = 2;
const MAX_PIXELS = 2560 * 1440;
/** How long a picture may stay black while music plays before auto mode moves on. */
const DARK_SECONDS = 5;

/**
 * Presets that fail in butterchurn 3 whatever is patched, never offered. Empty since 10.11.2026.
 *
 * The audit of 07.11.2026 (every preset, ten seconds of the same synthetic music, from a black
 * frame) put six here: two never drew a pixel — Geiss's Game of Life 3 among them — and four went
 * black within seconds. The cause was butterchurn's simple waveform drawn as dots, which set no
 * point size and drew nothing in Chrome (the "basic-wave-dots" patch in
 * scripts/butterchurn-patches.mjs): Game of Life 3 is seeded by those dots alone, and the others
 * fade without them. Flexi, Geiss and Rovastar's "chaos layered tokamak" still goes flat from a
 * black frame, as it does in MilkDrop — its reaction grows out of the picture the preset before it
 * left. (The two that threw from WebAssembly, astral projection and FractalDrop (Spark Machine
 * v2.0), play since 09.11.2026.) What misbehaves on a particular machine is caught while it plays.
 */
export const BROKEN_PRESETS: ReadonlySet<string> = new Set<string>();

/** Presets that threw on this browser, remembered so auto mode stops dealing them. */
const FAILED_KEY = "media-visualizer-failed-presets";

let presetsPromise: Promise<PresetMap> | null = null;

/** The preset packs are UMD bundles of an ES module; the map sits under one or two `default`s. */
function unwrap(module: unknown): PresetMap {
  let value: unknown = module;
  for (let depth = 0; depth < 3 && value && typeof value === "object" && "default" in value; depth += 1) {
    value = (value as { default: unknown }).default;
  }
  return (value && typeof value === "object" ? value : {}) as PresetMap;
}

function loadPresets(): Promise<PresetMap> {
  // The image pack first: 29 of its names are in the others too, whose version is kept.
  presetsPromise ??= Promise.all([
    import("butterchurn-presets/dist/image.min.js"),
    import("butterchurn-presets/dist/base.min.js"),
    import("butterchurn-presets/dist/extra.min.js"),
    import("butterchurn-presets/dist/md1.min.js")
  ])
    .then((packs) => Object.assign({}, ...packs.map(unwrap)) as PresetMap)
    .catch((error: unknown) => {
      presetsPromise = null;
      throw error;
    });
  return presetsPromise;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* pamięć przeglądarki może być niedostępna */ }
}

function failedPresets(): Set<string> {
  try {
    const stored: unknown = JSON.parse(readStored(FAILED_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((name): name is string => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

/** The presets a pool may offer: known failures and this browser's failures left out. */
export function playablePresets(
  names: readonly string[],
  pool: (name: string) => boolean,
  failed: ReadonlySet<string> = new Set()
): string[] {
  return names
    .filter((name) => pool(name) && !BROKEN_PRESETS.has(name) && !failed.has(name))
    .sort((left, right) => left.localeCompare(right));
}

/** Every name once, in random order, then a new order — never the same name twice in a row. */
export function presetDeck(names: readonly string[], random: () => number = Math.random): () => string {
  let deck: string[] = [];
  let last = "";
  return () => {
    if (deck.length === 0) {
      deck = [...names];
      for (let index = deck.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [deck[index], deck[swap]] = [deck[swap]!, deck[index]!];
      }
      if (deck.length > 1 && deck.at(-1) === last) [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1]!, deck[0]!];
    }
    last = deck.pop()!;
    return last;
  };
}

/** Where a visualizer's list and presets come from: butterchurn's alone, or with the build's packs. */
interface PresetSource {
  pools(): readonly PresetPool[];
  pool(): string;
  /** Another pool; resolves once its list is there, at once for one already fetched. */
  setPool(id: string): Promise<void>;
  /** The pool's presets in list order. */
  members(): readonly string[];
  groups(): readonly PresetGroup[] | null;
  has(id: string): boolean;
  data(id: string): Promise<object>;
}

/** butterchurn's presets alone — the visualizer as it always was. */
function builtinSource(names: readonly string[], all: PresetMap): PresetSource {
  const known = new Set(names);
  return {
    pools: () => [],
    pool: () => "",
    setPool: () => Promise.resolve(),
    members: () => names,
    groups: () => null,
    has: (id) => known.has(id),
    data: (id) => Promise.resolve(all[id]!)
  };
}

/** What the interface calls the packs it knows; any other pack keeps its folder's name. */
export function packLabel(pack: Pick<PackInfo, "id" | "name">, t: (text: string) => string): string {
  if (pack.id.includes("milkdrop-original")) return t("Oryginalny MilkDrop 2 (klasyka)");
  if (pack.id.includes("cream-of-the-crop")) return t("projectM — Cream of the Crop");
  if (pack.id.includes("projectm-classic")) return t("projectM — klasyczne presety");
  if (pack.id === "en-d" || pack.id.endsWith("-en-d")) return "projectM — En D";
  if (pack.id.includes("beatdrop")) return "BeatDrop";
  if (pack.id.includes("milkdrop3")) return "MilkDrop 3";
  return pack.name;
}

function fetchJson(url: string): Promise<unknown> {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.json() as Promise<unknown>;
  });
}

/**
 * butterchurn's presets and the build's packs, one pool at a time. The pool
 * chosen last is remembered; butterchurn's presets are the pool until then.
 * A pack's index is fetched when a pool needs it, and its presets a chunk at
 * a time when one of them is about to play. `wanted`: a preset to start on,
 * which the pool has to have (the panel's search found it in another pack).
 */
async function packSource(
  packList: readonly PackInfo[],
  names: readonly string[],
  all: PresetMap,
  failed: ReadonlySet<string>,
  poolKey: string,
  persist = true,
  wanted?: string
): Promise<PresetSource> {
  const [packs, { t }, { formatCount }] = await Promise.all([import("./milkdrop-packs"), import("../i18n"), import("../format")]);
  const labels = {
    builtin: t("Wbudowane (butterchurn)"),
    all: t("Wszystkie paczki"),
    allCategories: t("Wszystkie kategorie"),
    pack: (pack: PackInfo) => packLabel(pack, t),
    count: formatCount
  };
  const pools = packs.poolOptions(packList, names.length, labels);
  const loaded = new Map<string, PackPreset[]>();
  const byId = new Map<string, PackPreset>();
  const fetching = new Map<string, Promise<void>>();
  const chunk = packs.chunkLoader(fetchJson);
  const loadPack = (id: string): Promise<void> => {
    let pending = fetching.get(id);
    const pack = packList.find((candidate) => candidate.id === id);
    if (!pending && pack) {
      pending = fetchJson(pack.index).then((index) => {
        const presets = packs.packPresets(pack, index);
        loaded.set(id, presets);
        for (const preset of presets) byId.set(preset.id, preset);
      });
      // A failed fetch is tried again the next time the pool is chosen.
      pending.catch(() => fetching.delete(id));
      fetching.set(id, pending);
    }
    return pending ?? Promise.resolve();
  };
  let current = packs.BUILTIN_POOL;
  let groups: PresetGroup[] = [];
  let members: string[] = [];
  let memberSet = new Set<string>();
  let failures = -1;
  const rebuild = (): void => {
    groups = packs.poolGroups(current, names, packList, loaded, labels, failed);
    members = groups.flatMap((group) => group.presets.map((preset) => preset.id));
    memberSet = new Set(members);
    failures = failed.size;
  };
  const setPool = async (requested: string): Promise<void> => {
    const id = packs.parsePool(requested, packList) ? requested : packs.BUILTIN_POOL;
    current = id;
    if (persist) writeStored(poolKey, id);
    // What is there already: an empty list until the pack's index arrives.
    rebuild();
    try {
      await Promise.all(packs.poolPacks(id, packList).map(loadPack));
    } catch (error) {
      console.warn("MilkDrop pack unavailable", error);
      // For now, not for good: the choice stays remembered for the next visit.
      if (current === id) current = packs.BUILTIN_POOL;
    }
    rebuild();
  };
  // Not remembering (a favourite from any pack): every pack at once, the saved pool untouched.
  await setPool(persist ? readStored(poolKey) ?? packs.BUILTIN_POOL : packs.ALL_POOL);
  // A preset to start on that this pool does not have: the pool becomes its pack (or
  // butterchurn's presets), remembered as a pool chosen in the list would be.
  if (wanted !== undefined && !memberSet.has(wanted) && !failed.has(wanted)) {
    const home = packs.presetPool(wanted, names, packList);
    if (home && home !== current) await setPool(home);
  }
  return {
    pools: () => pools,
    pool: () => current,
    setPool,
    members() {
      if (failures !== failed.size) rebuild();
      return members;
    },
    groups() {
      if (failures !== failed.size) rebuild();
      return groups;
    },
    has(id) {
      if (failures !== failed.size) rebuild();
      return memberSet.has(id);
    },
    async data(id) {
      const preset = byId.get(id);
      if (!preset) {
        if (Object.hasOwn(all, id)) return all[id]!;
        throw new Error(`Unknown MilkDrop preset ${id}`);
      }
      const presets = await chunk(preset.chunk);
      if (!(preset.key in presets)) throw new Error(`MilkDrop preset missing from its chunk: ${id}`);
      return packs.hydratePreset(presets[preset.key]);
    }
  };
}

type BuildInfo = Exclude<(typeof import("virtual:milkdrop-presets"))["default"], null>;

/** What the build added — packs, textures — or null: without either, MilkDrop is exactly what it was. */
async function buildInfo(): Promise<BuildInfo | null> {
  try {
    const { default: info } = await import("virtual:milkdrop-presets");
    return info ?? null;
  } catch {
    return null;
  }
}

function milkdrop(pool: (name: string) => boolean, storageKey: string, withPacks = false) {
  return async (analyser: AnalyserNode, options: ExternalOptions = {}): Promise<ExternalVisualizer> => {
    const [{ default: butterchurn }, all, info, { textureBinder }] = await Promise.all([
      import("butterchurn"),
      loadPresets(),
      buildInfo(),
      import("./milkdrop-textures")
    ]);
    const packList = withPacks && info?.packs.length ? info.packs : null;
    const failed = failedPresets();
    const persist = options.persist !== false;
    const names = playablePresets(Object.keys(all), pool, failed);
    if (names.length === 0) throw new Error("No MilkDrop presets in this pool");
    const remember = (name: string): void => {
      failed.add(name);
      writeStored(FAILED_KEY, JSON.stringify([...failed].slice(-200)));
    };
    let source = builtinSource(names, all);
    if (packList) {
      try {
        source = await packSource(packList, names, all, failed, storageKey.replace("-preset:", "-pack:"), persist, options.preset);
      } catch (error) {
        console.warn("MilkDrop packs unavailable", error);
      }
    }
    const canvas = document.createElement("canvas");
    canvas.className = "visualizer-panel__canvas visualizer-panel__canvas--webgl";
    // Above 48 kHz butterchurn is handed samples read down to 48 kHz, and told that rate
    // (its bass, mid and treble bands are set from it); at 44.1/48 it reads its own.
    const { atRate, rateFactor, stereoTap } = await import("./audio-rate");
    const factor = rateFactor(analyser.context.sampleRate);
    const tap = factor > 1 ? stereoTap(analyser, BUTTERCHURN_SAMPLES, factor) : null;
    const audioLevels = tap
      ? (): { timeByteArray: Uint8Array; timeByteArrayL: Uint8Array; timeByteArrayR: Uint8Array } => {
          const { mono, left, right } = tap.read();
          return { timeByteArray: mono, timeByteArrayL: left, timeByteArrayR: right };
        }
      : null;
    const visualizer = butterchurn.createVisualizer(tap ? atRate(analyser.context, factor) : analyser.context, canvas, {
      width: 960,
      height: 540,
      pixelRatio: 1,
      onlyUseWASM: true
    });
    if (!tap) visualizer.connectAudio(analyser);
    // The patched engine (scripts/butterchurn-patches.mjs) asks for these: float samples for
    // BeatDrop's get_fft()/get_wave() textures, once a preset reads them, and the pointer.
    const engine = (visualizer as { renderer?: EngineInputs }).renderer ?? null;
    const shaderAudio = shaderAudioSource(analyser, factor);
    const pointer = pointerInput(canvas);
    if (engine) {
      engine.mdShaderAudio = shaderAudio.read;
      engine.mdPointer = pointer.state;
      // A preset loaded with a blend is applied after eight more frames of the old one, as MilkDrop
      // 2 and 3 load it (LoadPresetTick); loadPreset resolves then.
      engine.mdStageLoads = true;
      // MilkDrop's `progress`: through the preset's auto turn, 0 → 1; a preset picked by hand
      // is MilkDrop's locked preset, whose progress stays 0.
      engine.mdProgress = () => (chosen === AUTO_PRESET && switchAt > 0
        ? Math.max(0, 1 - (switchAt - performance.now()) / (AUTO_SECONDS * 1000))
        : 0);
    }
    // A pack's shader that this GPU will not compile draws nothing, and
    // butterchurn never asks: the context it draws with tells us instead, and a
    // pack preset whose shader failed is dropped like one that throws.
    // butterchurn's own presets are left to the checks they always had.
    let shaderFailed = false;
    const gl = visualizer.gl;
    if (gl && typeof gl.compileShader === "function") {
      const compile = gl.compileShader.bind(gl);
      gl.compileShader = (shader: WebGLShader): void => {
        compile(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) shaderFailed = true;
      };
    }
    // Each preset is given the textures it names before it loads (a random
    // slot drawn anew each time); one that is slow to arrive shows up the
    // frame it is there.
    const textures = textureBinder(visualizer, info?.textures ?? null, () => import("butterchurn-presets/dist/imageData.min.js"));
    const loadChecked = async (name: string, preset: object, blend: number): Promise<void> => {
      const double = (preset as Partial<DoublePreset>).double;
      const halves = double
        ? [await textures.prepare(double.first), (await textures.prepare(double.second)) as { md?: object }] as const
        : null;
      const ready = halves ? null : await textures.prepare(preset);
      // Leaving a double preset blends it out as MilkDrop 3 does: its first half goes into the
      // second, then the next preset comes in as usual.
      const releasing = blend > 0 ? engine?.mdReleaseDouble?.(blend) ?? 0 : 0;
      if (releasing > 0) await sleep(releasing);
      shaderFailed = false;
      if (halves && double) {
        // MilkDrop 3's double preset: the first half, then the second blended over it — a
        // transition the patched engine moves to the file's progress, in its pattern, and holds.
        // The file is staged as one (the first half's load waits its eight frames); the second
        // half is part of what was read, so it goes in at once.
        await visualizer.loadPreset(halves[0], blend);
        if (blend > 0) await sleep(blend);
        await visualizer.loadPreset({ ...halves[1], md: { ...halves[1].md, blend: double.blend }, mdLoadAtOnce: true }, blend);
      } else {
        await visualizer.loadPreset(ready!, blend);
      }
      if (shaderFailed && !Object.hasOwn(all, name)) throw new Error(`MilkDrop shader did not compile: ${name}`);
    };
    let deal = presetDeck(source.members());
    // Deals only what has not failed since the deck was shuffled; nothing while
    // a pack's list is still on its way.
    // "Auto" over the listener's favourites only, when any of them is in this pack.
    // The favourites Auto deals from are known before the first preset is compiled.
    let autoFilter: Set<string> | null = options.autoFilter?.length ? new Set(options.autoFilter) : null;
    const draw = (): string | undefined => {
      const offered = source.members();
      const dealable = (name: string): boolean => !failed.has(name) && (!autoFilter || autoFilter.has(name));
      const filter = autoFilter && offered.some(dealable) ? autoFilter : null;
      const fits = (name: string): boolean => !failed.has(name) && (!filter || filter.has(name));
      for (let attempt = 0; attempt < offered.length * 2; attempt += 1) {
        const name = deal();
        if (fits(name) && source.has(name)) return name;
      }
      return offered.find(fits) ?? offered.find((name) => !failed.has(name));
    };
    let chosen = (options.preset !== undefined && source.has(options.preset) ? options.preset : null)
      ?? readStored(storageKey) ?? AUTO_PRESET;
    if (chosen !== AUTO_PRESET && !source.has(chosen)) chosen = AUTO_PRESET;
    let loaded = "";
    let loading: Promise<void> | null = null;
    let listener: (() => void) | null = null;
    let switchAt = 0;
    // A choice made while a preset is still compiling waits its turn rather
    // than being lost; only the latest one is kept.
    let queued: { name: string; blend: number } | null = null;

    /**
     * A preset that throws is dropped for good on this browser and replaced at
     * once. Before this, the exception left the animation loop, so the picture
     * froze black and auto mode — which lives in that loop — never moved on.
     */
    const fail = (name: string): void => {
      if (!name || failed.has(name)) return;
      remember(name);
      if (chosen === name) {
        chosen = AUTO_PRESET;
        if (persist) writeStored(storageKey, chosen);
      }
      switchAt = 0;
      listener?.();
    };

    const load = (name: string, blend: number): void => {
      if (loading) {
        queued = { name, blend };
        return;
      }
      const previous = loaded;
      loaded = name;
      loading = source.data(name)
        .then(
          (preset) => loadChecked(name, preset, blend).catch(() => fail(name)),
          (error: unknown) => {
            // A pack's chunk did not arrive: the network, not the preset, so it
            // is not remembered as broken. The picture stays as it was.
            console.warn("MilkDrop preset unavailable", name, error);
            loaded = previous;
            if (chosen === name) {
              chosen = AUTO_PRESET;
              if (persist) writeStored(storageKey, chosen);
              listener?.();
            }
            switchAt = performance.now() + RETRY_SECONDS * 1000;
          }
        )
        .finally(() => {
          loading = null;
          const next = queued;
          queued = null;
          if (next && next.name !== loaded) load(next.name, next.blend);
        });
    };

    // The first preset is compiled before the visualizer counts as mounted. A
    // page whose policy refuses WebAssembly fails here — and the panel says so —
    // instead of mounting a canvas that stays black. That test is made with one
    // of butterchurn's presets: a pack's preset that will not load says nothing
    // about the page, so it is dropped and one of butterchurn's tried instead.
    let first = chosen === AUTO_PRESET ? draw() : chosen;
    const firstPreset = first === undefined ? null : await source.data(first).catch(() => null);
    try {
      if (first === undefined || !firstPreset) throw new Error("No pack preset to start with");
      await loadChecked(first, firstPreset, 0);
    } catch (error) {
      if (first !== undefined && Object.hasOwn(all, first)) {
        visualizer.loseGLContext?.();
        throw error;
      }
      if (first !== undefined && firstPreset) remember(first);
      first = presetDeck(names)();
      chosen = AUTO_PRESET;
      try {
        await visualizer.loadPreset(await textures.prepare(all[first]!), 0);
      } catch (fallbackError) {
        visualizer.loseGLContext?.();
        throw fallbackError;
      }
    }
    loaded = first;
    switchAt = chosen === AUTO_PRESET ? performance.now() + AUTO_SECONDS * 1000 : 0;

    // Black while the music plays: auto mode moves on rather than waiting out
    // the preset's turn. Silence is left alone — fading out with it is what many
    // presets are meant to do.
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    let samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    let probedAt = 0;
    let darkSince = 0;
    const watchForDark = (time: number): void => {
      if (!probe || chosen !== AUTO_PRESET || time - probedAt < 1000) return;
      probedAt = time;
      probe.canvas.width = 16;
      probe.canvas.height = 9;
      probe.drawImage(canvas, 0, 0, 16, 9);
      const pixels = probe.getImageData(0, 0, 16, 9).data;
      let brightest = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        brightest = Math.max(brightest, pixels[index]!, pixels[index + 1]!, pixels[index + 2]!);
      }
      if (samples.length !== analyser.fftSize) samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      analyser.getByteTimeDomainData(samples);
      let loudest = 0;
      for (const sample of samples) loudest = Math.max(loudest, Math.abs(sample - 128));
      if (brightest < 24 && loudest > 6) {
        darkSince ||= time;
        if (time - darkSince > DARK_SECONDS * 1000) {
          darkSince = 0;
          switchAt = 0;
        }
      } else {
        darkSince = 0;
      }
    };

    let size = "";
    return {
      canvas,
      presets: () => source.members().filter((name) => !failed.has(name)),
      presetGroups: () => source.groups(),
      pools: () => source.pools(),
      pool: () => source.pool(),
      choosePool(id: string): void {
        if (id === source.pool()) return;
        void source.setPool(id).then(() => {
          deal = presetDeck(source.members());
          if (chosen !== AUTO_PRESET && !source.has(chosen)) {
            chosen = AUTO_PRESET;
            if (persist) writeStored(storageKey, chosen);
          }
          // A new pack shows itself at once.
          if (chosen === AUTO_PRESET) switchAt = 0;
          listener?.();
        });
      },
      chosen: () => chosen,
      current: () => loaded,
      setListener(next: (() => void) | null): void {
        listener = next;
      },
      setAutoFilter(ids: readonly string[] | null): void {
        autoFilter = ids && ids.length ? new Set(ids) : null;
        // Showing something outside the new choice: Auto moves on now.
        if (chosen === AUTO_PRESET && autoFilter && !autoFilter.has(loaded) && source.members().some((name) => autoFilter!.has(name))) {
          switchAt = 0;
        }
      },
      choose(id: string): void {
        chosen = id === AUTO_PRESET || (source.has(id) && !failed.has(id)) ? id : AUTO_PRESET;
        if (persist) writeStored(storageKey, chosen);
        if (chosen === AUTO_PRESET) switchAt = 0;
        else if (chosen !== loaded) load(chosen, BLEND_SECONDS);
      },
      next(): void {
        if (chosen === AUTO_PRESET) {
          switchAt = 0;
          return;
        }
        // Pinned: the next one in the list, still pinned.
        const offered = source.members().filter((name) => !failed.has(name));
        const following = offered[(offered.indexOf(chosen) + 1) % offered.length];
        if (!following) return;
        chosen = following;
        if (persist) writeStored(storageKey, chosen);
        load(chosen, BLEND_SECONDS);
        listener?.();
      },
      announce(text: string): void {
        try {
          visualizer.launchSongTitleAnim?.(text);
        } catch { /* napis to ozdoba */ }
      },
      render(time: number): void {
        if (chosen === AUTO_PRESET && time >= switchAt && !loading) {
          switchAt = time + AUTO_SECONDS * 1000;
          const next = draw();
          if (next === undefined) {
            switchAt = time + 1000;
          } else {
            const broken = failed.has(loaded);
            load(next, loaded && !broken ? BLEND_SECONDS : 0);
          }
        }
        try {
          visualizer.render(audioLevels ? { audioLevels: audioLevels() } : undefined);
        } catch {
          fail(loaded);
          return;
        }
        pointer.frame();
        watchForDark(time);
      },
      resize(width: number, height: number): void {
        const ratio = Math.min(
          MAX_PIXEL_RATIO,
          window.devicePixelRatio || 1,
          Math.sqrt(MAX_PIXELS / Math.max(1, width * height))
        );
        const key = `${width}x${height}@${ratio.toFixed(3)}`;
        if (key === size) return;
        size = key;
        // butterchurn 3 draws into a canvas of its own and copies the frame
        // here, so this canvas's buffer is ours to size; left alone it stays
        // 300 × 150 and the picture is stretched from that.
        const pixelWidth = Math.max(1, Math.round(width * ratio));
        const pixelHeight = Math.max(1, Math.round(height * ratio));
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        // Its own canvas takes the size given here as it is; pixelRatio only
        // scales the textures inside, and the frame is copied over 1 : 1. So it
        // is given this canvas's pixels and a ratio of 1. Given the panel's CSS
        // size and the ratio, a phone (ratio 2) saw a quarter of the picture in
        // the top left corner, and a 4K screen (ratio below 1) the top left of
        // a picture too big for the canvas. The textures come out the same size.
        visualizer.setRendererSize(pixelWidth, pixelHeight, { pixelRatio: 1 });
      },
      destroy(): void {
        listener = null;
        try {
          if (tap) tap.disconnect();
          else visualizer.disconnectAudio(analyser);
        } catch { /* już odłączony */ }
        shaderAudio.disconnect();
        pointer.detach();
        visualizer.loseGLContext?.();
        canvas.remove();
      }
    };
  };
}

/** What the patched butterchurn's renderer reads from the page, and offers it (scripts/butterchurn-patches.mjs). */
interface EngineInputs {
  mdShaderAudio?: () => { left: Float32Array; right: Float32Array } | null;
  mdPointer?: PointerState;
  mdProgress?: () => number;
  /** A double preset showing: its first half starts blending into the second; seconds until it is gone, else 0. */
  mdReleaseDouble?: (seconds: number) => number;
  /** Blended loads are staged over eight frames, as MilkDrop's LoadPresetTick does. */
  mdStageLoads?: boolean;
}

const sleep = (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** BeatDrop's mouse: 0–1 from the bottom left, -1 outside; held, clicked (2 frames), and where the last press was (y from the top). */
interface PointerState {
  x: number;
  y: number;
  down: boolean;
  clicked: boolean;
  lastX: number;
  lastY: number;
}

/** Samples a channel BeatDrop's shader FFT is made from (MY_FFT_SHADER_WINDOW). */
const SHADER_FFT_WINDOW = 2048;

/**
 * Left and right as floats, SHADER_FFT_WINDOW of them at the visualizers' rate, newest last —
 * from analysers made the first time a preset's shader reads the FFT or the waveform, as
 * BeatDrop reads its audio for them (butterchurn's own are 1024 samples of 8 bits).
 */
function shaderAudioSource(source: AnalyserNode, factor: number): {
  read: () => { left: Float32Array; right: Float32Array } | null;
  disconnect: () => void;
} {
  let nodes: { splitter: ChannelSplitterNode; left: AnalyserNode; right: AnalyserNode; raw: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] } | null = null;
  const out = { left: new Float32Array(SHADER_FFT_WINDOW), right: new Float32Array(SHADER_FFT_WINDOW) };
  return {
    read() {
      try {
        if (!nodes) {
          const context = source.context;
          const span = Math.min(32768, SHADER_FFT_WINDOW * factor);
          const splitter = context.createChannelSplitter(2);
          const channel = (): AnalyserNode => {
            const node = context.createAnalyser();
            node.fftSize = span;
            node.smoothingTimeConstant = 0;
            return node;
          };
          nodes = { splitter, left: channel(), right: channel(), raw: [new Float32Array(span), new Float32Array(span)] };
          source.connect(splitter);
          splitter.connect(nodes.left, 0);
          splitter.connect(nodes.right, 1);
        }
        nodes.left.getFloatTimeDomainData(nodes.raw[0]);
        nodes.right.getFloatTimeDomainData(nodes.raw[1]);
        // Read down to the visualizers' rate: every factor-th sample, the newest at the end.
        const step = nodes.raw[0].length / SHADER_FFT_WINDOW;
        for (let index = 0; index < SHADER_FFT_WINDOW; index += 1) {
          const at = Math.min(nodes.raw[0].length - 1, Math.round((index + 1) * step) - 1);
          out.left[index] = nodes.raw[0][at]!;
          out.right[index] = nodes.raw[1][at]!;
        }
        return out;
      } catch {
        return null;
      }
    },
    disconnect() {
      if (!nodes) return;
      try {
        source.disconnect(nodes.splitter);
        nodes.splitter.disconnect();
      } catch { /* już odłączony */ }
      nodes = null;
    }
  };
}

/** The pointer over the picture, as BeatDrop gives its mouse to presets that read it. */
function pointerInput(canvas: HTMLCanvasElement): { state: PointerState; frame: () => void; detach: () => void } {
  const state: PointerState = { x: -1, y: -1, down: false, clicked: false, lastX: 0, lastY: 0 };
  let clickedFrames = 0;
  const place = (event: PointerEvent): void => {
    const box = canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    state.x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    state.y = Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height));
  };
  const move = (event: PointerEvent): void => place(event);
  const leave = (): void => {
    state.x = -1;
    state.y = -1;
  };
  const press = (event: PointerEvent): void => {
    place(event);
    state.down = true;
    clickedFrames = 2;
    state.clicked = true;
    state.lastX = state.x;
    state.lastY = 1 - state.y;
  };
  const release = (): void => {
    state.down = false;
  };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("pointerdown", press);
  window.addEventListener("pointerup", release);
  return {
    state,
    frame() {
      if (clickedFrames > 0) clickedFrames -= 1;
      state.clicked = clickedFrames > 0;
    },
    detach() {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
    }
  };
}

/**
 * The samples butterchurn takes a frame, per channel: 23 ms at 44.1 kHz, but 5 ms at 192 kHz,
 * where every wave came out a nearly flat line and the bass band was two bins. Above 48 kHz it
 * is handed them read down to 48 kHz instead (audio-rate.ts, stereoTap).
 */
const BUTTERCHURN_SAMPLES = 1024;

/** Presets Ryan Geiss made, alone or leading — his own warps, reaction-diffusion and cauldrons. */
const isGeiss = (name: string): boolean => /^geiss\b/i.test(name);

/**
 * Every preset the visualizer can play, for the panel's search across visualizers, named as its list
 * names them where it lists every pack ("Wszystkie paczki"): butterchurn's under their own names —
 * read from butterchurn-presets' list of names, not its 3.4 MB of presets — and each pack's from its
 * index, under "pack · category · group". Presets that failed on this browser are left out, as the
 * list leaves them out; a pack whose index cannot be had lists nothing.
 */
function milkdropCatalog(pool: (name: string) => boolean, withPacks: boolean) {
  return async (fetchJson: CatalogFetch): Promise<PresetGroup[]> => {
    const [meta, info, packs, { t }] = await Promise.all([
      import("butterchurn-presets/dist/presetPackMeta.min.js"),
      withPacks ? buildInfo() : Promise.resolve(null),
      import("./milkdrop-packs"),
      import("../i18n")
    ]);
    const failed = failedPresets();
    const names = playablePresets(packs.builtinPresetNames(meta), pool, failed);
    const packList = info?.packs ?? [];
    const loaded = new Map<string, PackPreset[]>();
    await Promise.all(packList.map(async (pack) => {
      try {
        loaded.set(pack.id, packs.packPresets(pack, await fetchJson(pack.index)));
      } catch (error) {
        console.warn("MilkDrop pack index unavailable", pack.id, error);
      }
    }));
    const labels = { builtin: t("Wbudowane (butterchurn)"), pack: (pack: PackInfo) => packLabel(pack, t) };
    return packs.poolGroups(packs.ALL_POOL, names, packList, loaded, labels, failed);
  };
}

export const milkdropVisualizers: VisualizerPlugin[] = [
  {
    id: "milkdrop",
    label: "MilkDrop",
    // butterchurn's presets, and the build's own packs beside them when it has any.
    external: milkdrop(() => true, "media-visualizer-preset:milkdrop", true),
    catalog: milkdropCatalog(() => true, true),
    render: () => undefined
  },
  {
    id: "geiss",
    label: "Geiss (MilkDrop)",
    external: milkdrop(isGeiss, "media-visualizer-preset:geiss"),
    catalog: milkdropCatalog(isGeiss, false),
    render: () => undefined
  }
];
