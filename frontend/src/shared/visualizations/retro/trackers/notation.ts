import type { Effect } from "./song";

/**
 * How the trackers spell a pattern's cells (song.ts writes them in no notation). Without
 * runtime imports, so the tests run it as it is (trackers.test.ts).
 *
 * ProTracker and Fasttracker number their effects in hex (0 arpeggio, 1 slide up … F speed);
 * Scream Tracker and Impulse Tracker letter them (J arpeggio, F slide up … A speed, T tempo).
 */

const NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

/** A note as a tracker writes it ("C-3", "F#2"); outside 0–119 `none`. */
export function noteText(note: number, none = "---"): string {
  if (!Number.isInteger(note) || note < 0 || note > 119) return none;
  return `${NAMES[note % 12]}${Math.floor(note / 12)}`;
}

/** Upper-case hex with leading zeros. */
export function hex(value: number, digits: number): string {
  return (Math.max(0, Math.round(value)) >>> 0).toString(16).toUpperCase().padStart(digits, "0").slice(-digits);
}

/** Decimal with leading zeros. */
export function decimal(value: number, digits: number): string {
  return String(Math.max(0, Math.round(value))).padStart(digits, "0").slice(-digits);
}

/** An effect in ProTracker's and Fasttracker's notation: command and parameter, three hex digits. */
export function modEffect(effect: Effect, param: number): string {
  const p = param & 255;
  switch (effect) {
    case "arpeggio": return `0${hex(p, 2)}`;
    case "slideUp": return `1${hex(p, 2)}`;
    case "slideDown": return `2${hex(p, 2)}`;
    case "tonePorta": return `3${hex(p, 2)}`;
    case "vibrato": return `4${hex(p, 2)}`;
    case "offset": return `9${hex(p, 2)}`;
    case "volumeSlide": return `A${hex(p & 15, 2)}`;
    case "volume": return `C${hex(Math.min(64, p), 2)}`;
    case "retrigger": return `E9${hex(p & 15, 1)}`;
    case "cut": return `EC${hex(p & 15, 1)}`;
    case "panning": return `E8${hex(p & 15, 1)}`;
    case "speed": return `F${hex(Math.min(31, p), 2)}`;
    case "tempo": return `F${hex(Math.max(32, p), 2)}`;
    default: return "000";
  }
}

/** An effect in Scream Tracker's and Impulse Tracker's notation: a letter and two hex digits. */
export function letterEffect(effect: Effect, param: number): string | null {
  const p = param & 255;
  switch (effect) {
    case "arpeggio": return `J${hex(p, 2)}`;
    case "slideUp": return `F${hex(p, 2)}`;
    case "slideDown": return `E${hex(p, 2)}`;
    case "tonePorta": return `G${hex(p, 2)}`;
    case "vibrato": return `H${hex(p, 2)}`;
    case "offset": return `O${hex(p, 2)}`;
    case "volumeSlide": return `D0${hex(p & 15, 1)}`;
    case "retrigger": return `Q0${hex(p & 15, 1)}`;
    case "cut": return `SC${hex(p & 15, 1)}`;
    case "panning": return `S8${hex(p & 15, 1)}`;
    case "speed": return `A${hex(p, 2)}`;
    case "tempo": return `T${hex(p, 2)}`;
    default: return null;
  }
}

/** A track title as a tracker's name field shows it: as it is, or upper-case, cut to the field. */
export function fieldText(title: string, width: number, upper: boolean, pad = " "): string {
  const text = (upper ? title.toUpperCase() : title).replace(/\s+/g, " ").trim();
  return text.slice(0, width).padEnd(width, pad);
}

/** Seconds as mm:ss (ProTracker's clock) or h:mm:ss. */
export function clock(seconds: number, hours = false): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60);
  if (!hours) return `${decimal(m % 100, 2)}:${decimal(s, 2)}`;
  return `${Math.floor(m / 60)}:${decimal(m % 60, 2)}:${decimal(s, 2)}`;
}
