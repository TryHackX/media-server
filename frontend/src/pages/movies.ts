import "../styles/index.css";

import { mountMediaPage } from "./media-page";

export async function mount(): Promise<void> {
  await mountMediaPage({
    kind: "movies",
    title: "Movies",
    eyebrow: "Biblioteka wideo",
    archiveName: "tryhackx-movies.zip"
  });
}

