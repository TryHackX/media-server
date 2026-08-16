import "../styles/index.css";

import { mountMediaPage } from "./media-page";

export async function mount(): Promise<void> {
  await mountMediaPage({
    kind: "music",
    title: "Music",
    eyebrow: "Biblioteka audio",
    archiveName: "tryhackx-music.zip"
  });
}

