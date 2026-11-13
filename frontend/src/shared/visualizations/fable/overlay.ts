import { createElement, ImageOff, ImagePlus, type IconNode } from "lucide";

import { t } from "../../i18n";

/**
 * The control the Fable presets that work on a picture put over it: "choose an image or a
 * video" — a label around a hidden file input, as VoltViz's "Upload Image" is — and, once one
 * is chosen, a round button back to the track's cover. The file never leaves the browser: the
 * host reads it through an object URL, nothing is sent and nothing is stored.
 */

/** The listener's own picture or video in place of the cover; the host keeps it. */
export interface FablePicture {
  /** Whether one is chosen. */
  chosen(): boolean;
  /** A file picked here; false when the browser cannot show it (nothing changes then). */
  choose(file: File): Promise<boolean>;
  /** Back to the track's cover. */
  clear(): void;
}

export interface MountedOverlay {
  dispose(): void;
}

/** How long the pill says that a file could not be read. */
const UNREADABLE_MS = 3000;

function icon(node: IconNode, name: string): SVGElement {
  return createElement(node, { class: `lucide lucide-${name}`, "aria-hidden": "true" });
}

export function pictureOverlay(container: HTMLElement, picture: FablePicture): MountedOverlay {
  const root = document.createElement("div");
  root.className = "visualizer-panel__overlay fable-overlay";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,video/*";
  const text = document.createTextNode("");
  const pill = document.createElement("label");
  pill.className = "fable-overlay__pill";
  pill.append(icon(ImagePlus, "image-plus"), text, input);
  pill.tabIndex = 0;
  pill.setAttribute("role", "button");
  pill.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    input.click();
  });
  const cover = document.createElement("button");
  cover.type = "button";
  cover.className = "fable-overlay__round";
  cover.append(icon(ImageOff, "image-off"));
  let unreadable = false;
  let timer = 0;
  const render = (): void => {
    const chosen = picture.chosen();
    text.data = unreadable ? t("Tego pliku nie da się wyświetlić") : chosen ? t("Zmień obraz lub wideo") : t("Wybierz obraz lub wideo");
    pill.title = t("Twój obraz lub wideo zamiast okładki: zostaje w przeglądarce, nigdzie nie jest wysyłany");
    cover.title = t("Wróć do okładki");
    cover.setAttribute("aria-label", cover.title);
    root.replaceChildren(pill, ...(chosen ? [cover] : []));
  };
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    // The same file again is a change too.
    input.value = "";
    if (!file) return;
    void picture.choose(file).then((ok) => {
      window.clearTimeout(timer);
      unreadable = !ok;
      if (unreadable) {
        timer = window.setTimeout(() => {
          unreadable = false;
          render();
        }, UNREADABLE_MS);
      }
      render();
    });
  });
  cover.addEventListener("click", () => {
    picture.clear();
    render();
  });
  render();
  container.append(root);
  return {
    dispose(): void {
      window.clearTimeout(timer);
      root.remove();
    }
  };
}
