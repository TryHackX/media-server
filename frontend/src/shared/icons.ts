export type IconName =
  | "admin"
  | "archive"
  | "arrow"
  | "chart"
  | "check"
  | "chevron"
  | "chevron-left"
  | "close"
  | "database"
  | "dice"
  | "download"
  | "edit"
  | "eye"
  | "file"
  | "film"
  | "filter"
  | "folder"
  | "fullscreen"
  | "fullscreen-exit"
  | "grip"
  | "heart"
  | "history"
  | "home"
  | "icons"
  | "image"
  | "info"
  | "link"
  | "list"
  | "lock"
  | "logout"
  | "magnet"
  | "menu"
  | "more"
  | "music"
  | "next"
  | "pause"
  | "play"
  | "previous"
  | "refresh"
  | "repeat"
  | "save"
  | "seek-back"
  | "seek-forward"
  | "search"
  | "server"
  | "settings"
  | "share"
  | "shuffle"
  | "smart"
  | "star"
  | "tags"
  | "trash"
  | "upload"
  | "user"
  | "users"
  | "visualizer"
  | "volume"
  | "volume-muted";

const definitions: Record<IconName, string> = {
  admin: "fa-user-shield",
  archive: "fa-file-zipper",
  arrow: "fa-arrow-right",
  chart: "fa-chart-simple",
  check: "fa-check",
  chevron: "fa-chevron-right",
  "chevron-left": "fa-chevron-left",
  close: "fa-xmark",
  database: "fa-database",
  dice: "fa-dice",
  download: "fa-download",
  edit: "fa-pen",
  eye: "fa-eye",
  file: "fa-file",
  film: "fa-film",
  filter: "fa-sliders",
  folder: "fa-folder",
  fullscreen: "fa-expand",
  "fullscreen-exit": "fa-compress",
  grip: "fa-grip-vertical",
  heart: "fa-heart",
  history: "fa-clock-rotate-left",
  home: "fa-house",
  icons: "fa-icons",
  image: "fa-image",
  info: "fa-circle-info",
  link: "fa-link",
  list: "fa-list-ol",
  lock: "fa-lock",
  logout: "fa-right-from-bracket",
  magnet: "fa-magnet",
  menu: "fa-bars",
  more: "fa-ellipsis",
  music: "fa-music",
  next: "fa-forward-step",
  pause: "fa-pause",
  play: "fa-play",
  previous: "fa-backward-step",
  refresh: "fa-rotate",
  repeat: "fa-repeat",
  save: "fa-floppy-disk",
  "seek-back": "fa-rotate-left",
  "seek-forward": "fa-rotate-right",
  search: "fa-magnifying-glass",
  server: "fa-server",
  settings: "fa-gear",
  share: "fa-share-nodes",
  shuffle: "fa-shuffle",
  smart: "fa-wand-magic-sparkles",
  star: "fa-star",
  tags: "fa-tags",
  trash: "fa-trash-can",
  upload: "fa-upload",
  user: "fa-user",
  users: "fa-users",
  visualizer: "fa-wave-square",
  volume: "fa-volume-high",
  "volume-muted": "fa-volume-xmark"
};

/** Every Font Awesome class the interface draws; styles/icons.css must define each. */
export const ICON_CLASSES: readonly string[] = Object.values(definitions);

/**
 * Ask for the icon font now rather than when the first icon is laid out.
 *
 * A browser fetches a web font once something drawn in it reaches layout — on
 * an application page that is after the session has answered and the shell has
 * been built — and until the font lands every icon is an empty box
 * (`font-display: block`, the only sensible setting for glyphs that have no
 * fallback: `swap` would paint the private-use code points as squares). Asked
 * for as the page's script starts, the font downloads beside the session
 * instead of after it.
 *
 * Font Awesome Free only: an installed Pro style has its own priming
 * (shared/icon-pack.ts), and asking for both would download a font nobody sees.
 */
export function primeIconFont(): void {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  void document.fonts.load('900 1em "Font Awesome 7 Free"', "\uf04b").catch(() => undefined);
}

export function icon(name: IconName, label?: string): HTMLSpanElement {
  const wrapper = document.createElement("span");
  wrapper.className = `icon icon--${name}`;
  const glyph = document.createElement("i");
  // No family class: the family and weight come from styles/icons.css, which
  // the chosen icon pack (Free, or an installed Pro style) sets as variables.
  glyph.className = `icon__glyph ${definitions[name]}`;
  if (label) {
    wrapper.setAttribute("aria-label", label);
    wrapper.setAttribute("role", "img");
  } else {
    wrapper.setAttribute("aria-hidden", "true");
  }
  wrapper.append(glyph);
  return wrapper;
}