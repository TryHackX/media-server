import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";

import { el } from "./dom";
import { icon, type IconName } from "./icons";
import { t } from "./i18n";

/**
 * Reject by content, not by extension: a file dialog filter is a hint, and the
 * server checks the decoded image again before storing it.
 */
async function supportedImage(file: File): Promise<boolean> {
  if (file.size <= 0 || file.size > 8 * 1024 * 1024) return false;
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const webp = bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return jpeg || png || webp;
}

async function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error(t("Nie można zakodować obrazu.")));
    reader.onerror = () => reject(new Error(t("Nie można zakodować obrazu.")));
    reader.readAsDataURL(blob);
  });
}

export interface CoverPickerOptions {
  /** Sentence under the heading, naming what the cover belongs to. */
  hint: string;
  /** Drawn behind an empty preview. */
  placeholder: IconName;
  /** Where progress and validation messages go; a local line by default. */
  onMessage?: (text: string, error: boolean) => void;
}

/**
 * Choose, crop and clear a square cover image.
 *
 * Shared by the track tag editor and the playlist view: both send the same
 * 500x500 WebP data URL to their own endpoint, so only the wording and the save
 * call differ. The picker never saves anything itself — the owner reads
 * `change()` when its form is submitted.
 */
export class CoverPicker {
  public readonly element: HTMLElement;
  private readonly cover: HTMLImageElement;
  private readonly coverInput: HTMLInputElement;
  private readonly cropStage: HTMLElement;
  private readonly cropImage: HTMLImageElement;
  private readonly status: HTMLElement;
  private cropper: Cropper | null = null;
  private objectUrl: string | null = null;
  /** undefined: untouched, null: remove on save, string: new cover on save. */
  private pending: string | null | undefined;

  public constructor(private readonly options: CoverPickerOptions) {
    this.status = el("div", { className: "hidden", attrs: { role: "status", "aria-live": "polite" } });
    this.cover = el("img", { className: "cover-editor__image", attrs: { alt: t("Aktualna okładka") } });
    this.cover.addEventListener("load", () => this.cover.classList.remove("is-missing"));
    this.cover.addEventListener("error", () => this.cover.classList.add("is-missing"));
    this.coverInput = el("input", {
      className: "cover-editor__input",
      attrs: { type: "file", accept: "image/jpeg,image/png,image/webp", tabindex: "-1" }
    });
    this.coverInput.addEventListener("change", () => void this.chooseFile(this.coverInput.files?.[0]));

    const dropZone = el(
      "div",
      {
        className: "cover-editor__dropzone",
        attrs: { tabindex: "0", role: "button", "aria-label": t("Wybierz lub upuść nową okładkę") }
      },
      el("span", { className: "cover-editor__upload-icon" }, icon("image")),
      el("strong", { text: t("Przeciągnij okładkę tutaj") }),
      el("span", { text: t("albo kliknij, aby wybrać JPG, PNG lub WebP do 8 MB") }),
      this.coverInput
    );
    dropZone.addEventListener("click", () => this.coverInput.click());
    dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.coverInput.click();
      }
    });
    for (const name of ["dragenter", "dragover"]) {
      dropZone.addEventListener(name, (event) => {
        event.preventDefault();
        dropZone.classList.add("is-dragging");
      });
    }
    for (const name of ["dragleave", "drop"]) {
      dropZone.addEventListener(name, (event) => {
        event.preventDefault();
        dropZone.classList.remove("is-dragging");
      });
    }
    dropZone.addEventListener("drop", (event) => void this.chooseFile(event.dataTransfer?.files[0]));

    this.cropImage = el("img", { className: "cover-editor__crop-image", attrs: { alt: t("Kadrowanie nowej okładki") } });
    const confirmCrop = el(
      "button",
      { className: "button button--primary", attrs: { type: "button" } },
      icon("check"),
      t("Zastosuj kadr")
    );
    confirmCrop.addEventListener("click", () => void this.confirmCrop());
    const cancelCrop = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Anuluj"));
    cancelCrop.addEventListener("click", () => this.cancelCrop());
    this.cropStage = el(
      "div",
      { className: "cover-editor__crop-stage hidden" },
      el("div", { className: "cover-editor__crop-canvas" }, this.cropImage),
      el("div", { className: "cover-editor__crop-actions" },
        el("span", { text: t("Przesuwaj obraz i zmieniaj rozmiar kwadratowego kadru.") }),
        el("div", {}, cancelCrop, confirmCrop)
      )
    );

    const removeCover = el(
      "button",
      { className: "button button--danger cover-editor__remove", attrs: { type: "button" } },
      icon("close"),
      t("Usuń okładkę")
    );
    removeCover.addEventListener("click", () => {
      this.cancelCrop();
      this.pending = null;
      this.cover.removeAttribute("src");
      this.cover.classList.add("is-missing");
      this.message(t("Własna okładka zostanie usunięta po zapisaniu zmian."), false);
    });

    const editCover = el(
      "button",
      { className: "button button--secondary", attrs: { type: "button" } },
      icon("edit"),
      t("Edytuj kadr")
    );
    editCover.addEventListener("click", () => {
      if (!this.cover.src || this.cover.classList.contains("is-missing")) {
        this.message(t("Nie ma okładki, którą można edytować."), true);
        return;
      }
      editCover.disabled = true;
      this.message(t("Wczytywanie bieżącej okładki do edytora…"), false);
      void fetch(this.cover.src, { credentials: "same-origin", cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("cover fetch failed");
          const blob = await response.blob();
          const type = blob.type || "image/webp";
          await this.chooseFile(new File([blob], "current-cover." + (type.split("/")[1] || "webp"), { type }));
        })
        .catch(() => this.message(t("Nie udało się wczytać bieżącej okładki do kadrowania."), true))
        .finally(() => { editCover.disabled = false; });
    });

    this.element = el(
      "section",
      { className: "cover-editor" },
      el("div", { className: "cover-editor__heading" },
        el("div", {}, el("h3", { text: t("Okładka") }), el("p", { text: options.hint })),
        el("span", { className: "status-pill", text: "500 × 500 WebP" })
      ),
      dropZone,
      el("div", { className: "cover-editor__workspace" },
        el(
          "div",
          { className: "cover-editor__current" },
          el("div", { className: "cover-editor__preview" }, icon(options.placeholder), this.cover),
          el("div", { className: "cover-editor__current-actions" }, editCover, removeCover)
        ),
        this.cropStage
      ),
      options.onMessage ? null : this.status
    );
  }

  /** Point the picker at the cover that is stored today and forget any pending change. */
  public reset(currentUrl: string | null): void {
    this.cancelCrop();
    this.pending = undefined;
    this.coverInput.value = "";
    this.cover.classList.remove("is-missing");
    if (currentUrl) this.cover.src = currentUrl;
    else {
      this.cover.removeAttribute("src");
      this.cover.classList.add("is-missing");
    }
    this.status.className = "hidden";
    this.status.textContent = "";
  }

  /** undefined when nothing was chosen, null to remove, otherwise the new data URL. */
  public change(): string | null | undefined {
    return this.pending;
  }

  /** Called after the owner saved, so a second save does not resend the image. */
  public markSaved(): void {
    this.pending = undefined;
  }

  public destroy(): void {
    this.cancelCrop();
  }

  private message(text: string, error: boolean): void {
    if (this.options.onMessage) {
      this.options.onMessage(text, error);
      return;
    }
    this.status.className = error ? "notice notice--error" : "notice";
    this.status.textContent = text;
  }

  private async chooseFile(file?: File): Promise<void> {
    if (!file) return;
    if (!(await supportedImage(file))) {
      this.coverInput.value = "";
      this.message(t("Wybierz prawidłowy JPG, PNG lub WebP do 8 MB."), true);
      return;
    }
    this.cancelCrop();
    this.objectUrl = URL.createObjectURL(file);
    this.cropStage.classList.remove("hidden");
    this.message("Ustaw kadr i kliknij „Zastosuj kadr”.", false);
    this.cropImage.addEventListener("load", () => {
      this.cropper = new Cropper(this.cropImage, {
        aspectRatio: 1,
        viewMode: 2,
        autoCropArea: 0.82,
        responsive: true,
        restore: false,
        background: false,
        guides: true,
        center: true,
        highlight: true,
        cropBoxMovable: true,
        cropBoxResizable: true,
        dragMode: "move",
        minCropBoxWidth: 160,
        minCropBoxHeight: 160
      });
    }, { once: true });
    this.cropImage.src = this.objectUrl;
  }

  private async confirmCrop(): Promise<void> {
    if (!this.cropper) return;
    const canvas = this.cropper.getCroppedCanvas({
      width: 500,
      height: 500,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
      fillColor: "#0b0f14"
    });
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error(t("Nie można utworzyć okładki."))), "image/webp", 0.88);
    });
    this.pending = await blobDataUrl(blob);
    this.cover.src = this.pending;
    this.cover.classList.remove("is-missing");
    this.cancelCrop();
    this.message(t("Kadr jest gotowy. Zapisz zmiany, aby zastosować okładkę."), false);
  }

  private cancelCrop(): void {
    this.cropper?.destroy();
    this.cropper = null;
    this.cropStage.classList.add("hidden");
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.cropImage.removeAttribute("src");
  }
}
