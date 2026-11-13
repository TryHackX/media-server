import { mountLibraryPage } from "./library-page";

export async function mount(): Promise<void> {
  await mountLibraryPage({
    kind: "music",
    title: "Muzyka",
    eyebrow: "Biblioteka audio",
    archiveName: "tryhackx-music.zip"
  });
}
