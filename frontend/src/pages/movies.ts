import { mountLibraryPage } from "./library-page";

export async function mount(): Promise<void> {
  await mountLibraryPage({
    kind: "movies",
    title: "Filmy",
    eyebrow: "Biblioteka wideo",
    archiveName: "tryhackx-movies.zip"
  });
}
