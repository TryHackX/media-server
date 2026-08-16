import { previewUrl, saveArtwork, saveMetadata } from "./api";
import { CoverPicker } from "./cover-picker";
import { el } from "./dom";
import { icon } from "./icons";
import { t } from "./i18n";
import { openModal } from "./modal";
import type { MediaItem } from "./types";

export class MetadataEditor {
  private readonly root: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly filename: HTMLInputElement;
  private readonly title: HTMLInputElement;
  private readonly artist: HTMLInputElement;
  private readonly album: HTMLInputElement;
  private readonly year: HTMLInputElement;
  private readonly genre: HTMLInputElement;
  private readonly artwork: CoverPicker;
  private readonly feedback: HTMLElement;
  private item: MediaItem | null = null;
  private releaseModal: (() => void) | null = null;
  private readonly heading: HTMLElement;
  private readonly artistLabel: HTMLElement;
  private readonly albumLabel: HTMLElement;
  private readonly note: HTMLElement;

  /** Called after a successful save so open views can repaint the track. */
  public onSaved: ((item: MediaItem) => void) | null = null;

  public constructor() {
    this.filename = this.input("Pełna nazwa pliku");
    this.filename.readOnly = true;
    this.title = this.input("Tytuł");
    this.artist = this.input("Artysta");
    this.album = this.input("Album");
    this.year = this.input("Rok");
    this.genre = this.input("Gatunek");
    this.feedback = el("div", { className: "hidden", attrs: { role: "status", "aria-live": "polite" } });
    this.artwork = new CoverPicker({
      hint: t("Wybierz obraz, ustaw kadr 1:1 i zatwierdź podgląd."),
      placeholder: "music",
      onMessage: (text, error) => {
        this.feedback.className = error ? "notice notice--error" : "notice";
        this.feedback.textContent = text;
      }
    });

    // A film and a track share these five fields but not their names: an
    // "album" is a series and an "artist" is whoever directed it. The store
    // does not care, and the person filling the form does.
    this.heading = el("h2", { text: t("Edytuj metadane i okładkę") });
    this.artistLabel = el("span", { className: "field__label", text: t("Artysta") });
    this.albumLabel = el("span", { className: "field__label", text: t("Album") });
    this.note = el("p", { className: "form-note", text: t("Zmiany są zapisywane w katalogu aplikacji. Oryginalny plik audio pozostaje bez zmian.") });
    const close = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
    close.addEventListener("click", () => this.close());
    const cancelEditor = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Anuluj"));
    cancelEditor.addEventListener("click", () => this.close());
    this.form = el(
      "form",
      { className: "metadata-form" },
      this.field(t("Pełna nazwa pliku"), this.filename),
      this.artwork.element,
      this.field(t("Tytuł"), this.title),
      el("label", { className: "field" }, this.artistLabel, this.artist),
      el("label", { className: "field" }, this.albumLabel, this.album),
      el("div", { className: "form-grid" }, this.field(t("Rok"), this.year), this.field(t("Gatunek"), this.genre)),
      this.note,
      this.feedback,
      el("div", { className: "metadata-form__actions" },
        cancelEditor,
        el("button", { className: "button button--primary", attrs: { type: "submit" } }, icon("check"), t("Zapisz zmiany"))
      )
    );
    this.form.addEventListener("submit", (event) => void this.submit(event));
    this.root = el(
      "div",
      { className: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "true" } },
      el("button", { className: "dialog__backdrop", attrs: { type: "button", "aria-label": t("Zamknij") } }),
      el(
        "section",
        { className: "dialog__panel dialog__panel--metadata" },
        el("header", { className: "dialog__header" },
          el("div", {}, el("span", { className: "eyebrow", text: t("Katalog") }), this.heading),
          close
        ),
        this.form
      )
    );
    this.root.querySelector(".dialog__backdrop")?.addEventListener("click", () => this.close());
    document.body.append(this.root);
  }

  public open(item: MediaItem): void {
    this.item = item;
    const film = item.media_kind === "video";
    this.heading.textContent = film ? t("Edytuj opis filmu i okładkę") : t("Edytuj metadane i okładkę");
    this.artistLabel.textContent = film ? t("Reżyseria") : t("Artysta");
    this.albumLabel.textContent = film ? t("Seria lub kolekcja") : t("Album");
    this.note.textContent = film
      ? t("Zmiany są zapisywane w katalogu aplikacji. Plik filmu pozostaje bez zmian.")
      : t("Zmiany są zapisywane w katalogu aplikacji. Oryginalny plik audio pozostaje bez zmian.");
    this.filename.value = item.relative_path.split("/").pop() ?? item.relative_path;
    this.filename.title = item.relative_path;
    this.title.value = item.title;
    this.artist.value = item.artist ?? "";
    this.album.value = item.album ?? "";
    this.year.value = item.year ?? "";
    this.genre.value = item.genre ?? "";
    this.artwork.reset(previewUrl(item.id) + "&revision=" + Date.now());
    this.feedback.className = "hidden";
    this.feedback.textContent = "";
    this.root.setAttribute("aria-hidden", "false");
    this.releaseModal?.();
    this.releaseModal = openModal(this.root, { onEscape: () => this.close(), initialFocus: this.title });
  }

  public close(): void {
    this.artwork.destroy();
    this.root.setAttribute("aria-hidden", "true");
    this.releaseModal?.();
    this.releaseModal = null;
  }

  public destroy(): void {
    this.close();
    this.root.remove();
  }

  private input(label: string): HTMLInputElement {
    return el("input", { className: "input", attrs: { type: "text", maxlength: "512", "aria-label": label } });
  }

  private field(label: string, input: HTMLInputElement): HTMLElement {
    return el("label", { className: "field" }, el("span", { className: "field__label", text: label }), input);
  }

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.item) return;
    const submit = this.form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await saveMetadata(this.item.id, {
        title: this.title.value,
        artist: this.artist.value,
        album: this.album.value,
        year: this.year.value,
        genre: this.genre.value
      });
      const artworkChange = this.artwork.change();
      if (artworkChange !== undefined) await saveArtwork(this.item.id, artworkChange);
      Object.assign(this.item, {
        title: this.title.value.trim() || this.item.title,
        artist: this.artist.value.trim() || null,
        album: this.album.value.trim() || null,
        year: this.year.value.trim() || null,
        genre: this.genre.value.trim() || null
      });
      this.artwork.markSaved();
      this.feedback.className = "notice";
      this.feedback.textContent = t("Metadane i okładka zostały zapisane.");
      this.onSaved?.(this.item);
    } catch {
      this.feedback.className = "notice notice--error";
      this.feedback.textContent = t("Nie udało się zapisać zmian.");
    } finally {
      if (submit) submit.disabled = false;
    }
  }
}
