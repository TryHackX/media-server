export type IconName =
  | "admin"
  | "archive"
  | "arrow"
  | "check"
  | "chevron"
  | "close"
  | "download"
  | "edit"
  | "eye"
  | "file"
  | "film"
  | "folder"
  | "fullscreen"
  | "grip"
  | "heart"
  | "history"
  | "home"
  | "image"
  | "info"
  | "list"
  | "magnet"
  | "menu"
  | "music"
  | "next"
  | "pause"
  | "play"
  | "previous"
  | "repeat"
  | "search"
  | "server"
  | "share"
  | "shuffle"
  | "star"
  | "user"
  | "visualizer"
  | "volume"
  | "volume-muted";

const definitions: Record<IconName, string> = {
  admin: "fa-user-shield",
  archive: "fa-file-zipper",
  arrow: "fa-arrow-right",
  check: "fa-check",
  chevron: "fa-chevron-right",
  close: "fa-xmark",
  download: "fa-download",
  edit: "fa-pen",
  eye: "fa-eye",
  file: "fa-file",
  film: "fa-film",
  folder: "fa-folder",
  fullscreen: "fa-expand",
  grip: "fa-grip-vertical",
  heart: "fa-heart",
  history: "fa-clock-rotate-left",
  home: "fa-house",
  image: "fa-image",
  info: "fa-circle-info",
  list: "fa-list-ol",
  magnet: "fa-magnet",
  menu: "fa-bars",
  music: "fa-music",
  next: "fa-forward-step",
  pause: "fa-pause",
  play: "fa-play",
  previous: "fa-backward-step",
  repeat: "fa-repeat",
  search: "fa-magnifying-glass",
  server: "fa-server",
  share: "fa-share-nodes",
  shuffle: "fa-shuffle",
  star: "fa-star",
  user: "fa-user",
  visualizer: "fa-wave-square",
  volume: "fa-volume-high",
  "volume-muted": "fa-volume-xmark"
};

export function icon(name: IconName, label?: string): HTMLSpanElement {
  const wrapper = document.createElement("span");
  wrapper.className = `icon icon--${name}`;
  const glyph = document.createElement("i");
  glyph.className = `icon__glyph fa-solid ${definitions[name]}`;
  if (label) {
    wrapper.setAttribute("aria-label", label);
    wrapper.setAttribute("role", "img");
  } else {
    wrapper.setAttribute("aria-hidden", "true");
  }
  wrapper.append(glyph);
  return wrapper;
}