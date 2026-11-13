import { ChevronDown, createElement, Eye, EyeOff, ImageOff, ImagePlus, Palette, Shuffle, SlidersHorizontal, type IconNode } from "lucide";

import { t } from "../../i18n";
import { HALFTONE_MODES, HALFTONE_SHAPES, type HalftoneLook } from "./halftone";

/**
 * The overlays voltviz 0.35.1 puts over two of its visualizations (React components named
 * `Overlay` in Icons.tsx and HalftonePulse.tsx), as plain DOM in the visualization's layer of the
 * stage: the same markup and Tailwind classes (their rules in stage.css, in Tailwind 4.3.3's
 * order), lucide's icons, the same behaviour. Upstream hides them with its app's UI ("Hide UI");
 * here they are `.visualizer-panel__overlay`, which rests with the panel's toolbar (panels.css).
 * The words go through t(): in English they are voltviz's.
 *
 * Halftone Pulse's "Upload Image" is upstream's label with a hidden file input; the picture never
 * leaves the browser (HalftonePicture). Added to upstream: the label answers the keyboard, and once
 * a picture is chosen a round button beside it goes back to the track's cover.
 */

export interface MountedOverlay {
  dispose(): void;
  /** Drawn again: what it shows changed elsewhere (another layer's overlay chose a picture). */
  refresh?(): void;
}

interface IconsApi {
  shuffle(): void;
  getIconName(): string | null;
  subscribe(listener: (name: string | null) => void): () => void;
}

interface HalftoneApi {
  setMode(mode: string): void;
  setShape(shape: string): void;
  setNeon(on: boolean): void;
}

/**
 * The listener's own picture for Halftone Pulse, in place of the cover (voltviz's "Upload
 * Image"): the adapter keeps it, as an object URL of the file, and gives it to the visualization.
 */
export interface HalftonePicture {
  /** Whether one is chosen: the pill says "Change Image" then, and the way back shows. */
  chosen(): boolean;
  /** A file picked in the overlay; false when the browser cannot draw it (nothing changes then). */
  choose(file: File): Promise<boolean>;
  /** Back to the track's cover. */
  clear(): void;
}

/** How long the pill says that a file could not be read. */
const UNREADABLE_MS = 3000;

/** The names of Icons' ICON_POOL (voltviz's English, the chip's text) in the interface's language. */
const ICON_NAMES: Readonly<Record<string, () => string>> = {
  Heart: () => t("Serce"), Star: () => t("Gwiazda"), Music: () => t("Muzyka"), Zap: () => t("Piorun"),
  Flame: () => t("Płomień"), Crown: () => t("Korona"), Diamond: () => t("Diament"), Skull: () => t("Czaszka"),
  Ghost: () => t("Duch"), Rocket: () => t("Rakieta"), Atom: () => t("Atom"), Brain: () => t("Mózg"),
  Bug: () => t("Robak"), Camera: () => t("Aparat"), Cloud: () => t("Chmura"), Coffee: () => t("Kawa"),
  Compass: () => t("Kompas"), Crosshair: () => t("Celownik"), Flower: () => t("Kwiat"),
  Gamepad: () => t("Pad"), Globe: () => t("Globus"), Headphones: () => t("Słuchawki"),
  Hexagon: () => t("Sześciokąt"), Key: () => t("Klucz"), Leaf: () => t("Liść"), Moon: () => t("Księżyc"),
  Shield: () => t("Tarcza"), Snowflake: () => t("Płatek śniegu"), Sun: () => t("Słońce"), Target: () => t("Cel"),
  Tree: () => t("Drzewo"), Umbrella: () => t("Parasol"), Wind: () => t("Wiatr"), Aperture: () => t("Przysłona"),
  Fingerprint: () => t("Odcisk palca"), Anchor: () => t("Kotwica"), Bell: () => t("Dzwonek"),
  Bookmark: () => t("Zakładka"), Eye: () => t("Oko"), Fish: () => t("Ryba")
};

/** An icon's name in the interface's language (voltviz's own where none is known). */
export function iconName(name: string): string {
  return ICON_NAMES[name]?.() ?? name;
}

/** The names Icons may show, for the tests. */
export const ICON_NAME_KEYS: readonly string[] = Object.keys(ICON_NAMES);

/** A lucide icon as lucide-react renders it: `<svg class="lucide lucide-<name> …">`. */
function lucide(node: IconNode, name: string, className: string): SVGElement {
  return createElement(node, { class: `lucide lucide-${name} ${className}`, "aria-hidden": "true" });
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

function button(className: string, ...children: (Node | string)[]): HTMLButtonElement {
  const node = element("button", className, ...children);
  node.type = "button";
  return node;
}

/** The root every overlay has: rests with the toolbar, and carries upstream's base styles. */
const ROOT = "visualizer-panel__overlay voltviz-overlay";

/** Upstream's eye toggle: "collapsed to the eye toggle until opened". */
function eyeToggle(className: string, onToggle: () => void): { button: HTMLButtonElement; render(shown: boolean): void } {
  const toggle = button(className);
  toggle.addEventListener("click", onToggle);
  return {
    button: toggle,
    render(shown: boolean): void {
      const label = shown ? t("Ukryj przyciski") : t("Pokaż przyciski");
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("aria-pressed", String(shown));
      toggle.replaceChildren(shown ? lucide(EyeOff, "eye-off", "w-4 h-4") : lucide(Eye, "eye", "w-4 h-4"));
    }
  };
}

/** Icons: the icon's name and Shuffle (a new icon, never the same), behind the eye. */
export function iconsOverlay(container: HTMLElement, api: IconsApi): MountedOverlay {
  const root = element("div", `${ROOT} absolute bottom-6 right-6 flex items-center gap-3 z-10`);
  let showUI = false;
  let name = api.getIconName();
  const chip = element("span", "px-3 py-2 bg-white/10 border border-white/20 rounded-full text-sm text-white/70");
  const shuffle = button(
    "flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full text-sm text-white cursor-pointer transition-colors",
    lucide(Shuffle, "shuffle", "w-4 h-4"), t("Losuj")
  );
  shuffle.addEventListener("click", () => api.shuffle());
  const eye = eyeToggle("p-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full text-white transition-colors", () => {
    showUI = !showUI;
    render();
  });
  const render = (): void => {
    chip.textContent = name ? iconName(name) : "";
    root.replaceChildren(...(showUI ? [...(name ? [chip] : []), shuffle] : []), eye.button);
    eye.render(showUI);
  };
  const unsubscribe = api.subscribe((next) => {
    name = next;
    render();
  });
  render();
  container.append(root);
  return {
    dispose(): void {
      unsubscribe();
      root.remove();
    }
  };
}

/**
 * Halftone Pulse: Style opens Mode, Shape and Colors, behind the eye, beside Upload Image. Each
 * change is set at once (setMode, setShape, setNeon), as upstream's effects set it, and told to
 * `onLook` with the whole look; `look` is the one on screen when the overlay comes up. A picture
 * chosen goes to `picture`.
 */
export function halftoneOverlay(container: HTMLElement, api: HalftoneApi, look: HalftoneLook, onLook: (look: HalftoneLook) => void,
  picture: HalftonePicture): MountedOverlay {
  const current: HalftoneLook = { ...look };
  let showUI = false;
  let styleOpen = false;
  const pill = "px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full text-sm text-white cursor-pointer transition-colors";
  const field = "w-full px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full text-sm text-white cursor-pointer outline-none transition-colors";
  // appearance-none + dark options: Chrome on Windows paints the native option list with the
  // select's own (translucent white) background, which left white text on a near-white list.
  const select = `${field} appearance-none pl-4 pr-9 focus-visible:ring-2 focus-visible:ring-purple-500`;
  const option = "bg-gray-900 text-white";
  const chevron = "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/70";

  const root = element("div", `${ROOT} absolute bottom-6 right-6 flex flex-col items-end gap-3 z-20`);
  const choice = (label: string, auto: string, entries: readonly (readonly [string, string, () => string])[], value: string,
    set: (value: string) => void): HTMLDivElement => {
    const list = element("select", select);
    list.setAttribute("aria-label", label);
    list.style.colorScheme = "dark";
    const make = (id: string, text: string): HTMLOptionElement => {
      const item = element("option", option, text);
      item.value = id;
      return item;
    };
    list.append(make("auto", auto), ...entries.map(([id, , name]) => make(id, name())));
    list.value = value;
    list.addEventListener("change", () => set(list.value));
    return element("div", "relative", list, lucide(ChevronDown, "chevron-down", chevron));
  };
  const changed = (): void => onLook({ ...current });
  const mode = choice(t("Tryb"), t("Tryb: Auto (co 8 taktów)"), HALFTONE_MODES, current.mode, (value) => {
    current.mode = value;
    api.setMode(value);
    changed();
  });
  const shape = choice(t("Kształt"), t("Kształt: Auto"), HALFTONE_SHAPES, current.shape, (value) => {
    current.shape = value;
    api.setShape(value);
    changed();
  });
  // Upstream's neon classes come before the plain ones in Tailwind's order and lose to them:
  // the button keeps its look and says which colours are on, as in voltviz.
  const neon = button("");
  const renderNeon = (): void => {
    neon.className = `flex items-center justify-center gap-2 ${field} ${current.neon ? "bg-fuchsia-500/20 border-fuchsia-400/50 text-fuchsia-200" : ""}`.trim();
    neon.replaceChildren(lucide(Palette, "palette", "w-4 h-4"), current.neon ? t("Kolory: neon") : t("Kolory: źródło"));
    neon.setAttribute("aria-pressed", String(current.neon));
  };
  neon.addEventListener("click", () => {
    current.neon = !current.neon;
    api.setNeon(current.neon);
    renderNeon();
    changed();
  });
  renderNeon();
  const card = element("div", "w-64 max-w-[calc(100vw-3rem)] flex flex-col gap-2 p-3 bg-black/60 backdrop-blur-sm border border-white/20 rounded-2xl", mode, shape, neon);
  card.id = `voltviz-style-${Math.random().toString(36).slice(2, 10)}`;
  const style = button(`flex items-center gap-2 ${pill}`, lucide(SlidersHorizontal, "sliders-horizontal", "w-4 h-4"), t("Styl"));
  style.setAttribute("aria-controls", card.id);
  style.addEventListener("click", () => {
    styleOpen = !styleOpen;
    render();
  });
  // Upload Image: upstream's label around a hidden file input, "Change Image" once one is chosen.
  const input = element("input", "hidden");
  input.type = "file";
  input.accept = "image/*";
  const uploadText = document.createTextNode("");
  const upload = element("label", `flex items-center gap-2 ${pill}`, lucide(ImagePlus, "image-plus", "w-4 h-4"), uploadText, input);
  upload.tabIndex = 0;
  upload.setAttribute("role", "button");
  upload.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    input.click();
  });
  let unreadable = false;
  let unreadableTimer = 0;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    // The same file again is a change too.
    input.value = "";
    if (!file) return;
    void picture.choose(file).then((ok) => {
      window.clearTimeout(unreadableTimer);
      unreadable = !ok;
      if (unreadable) {
        unreadableTimer = window.setTimeout(() => {
          unreadable = false;
          render();
        }, UNREADABLE_MS);
      }
      render();
    });
  });
  const cover = button("p-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full text-white transition-colors cursor-pointer", lucide(ImageOff, "image-off", "w-4 h-4"));
  cover.addEventListener("click", () => {
    picture.clear();
    render();
  });
  const eye = eyeToggle("p-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full text-white transition-colors cursor-pointer", () => {
    showUI = !showUI;
    render();
  });
  const row = element("div", "flex items-center gap-3");
  const render = (): void => {
    style.setAttribute("aria-expanded", String(styleOpen));
    const chosen = picture.chosen();
    uploadText.data = unreadable ? t("Tego pliku nie da się wyświetlić") : chosen ? t("Zmień obraz") : t("Wybierz obraz");
    upload.title = t("Twój obraz zamiast okładki: zostaje w przeglądarce, nigdzie nie jest wysyłany");
    cover.title = t("Wróć do okładki");
    cover.setAttribute("aria-label", cover.title);
    row.replaceChildren(...(showUI ? [style, upload, ...(chosen ? [cover] : [])] : []), eye.button);
    root.replaceChildren(...(showUI && styleOpen ? [card] : []), row);
    eye.render(showUI);
  };
  render();
  container.append(root);
  return {
    dispose(): void {
      window.clearTimeout(unreadableTimer);
      root.remove();
    },
    refresh: render
  };
}
