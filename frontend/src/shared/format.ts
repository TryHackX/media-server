import { formatServerTime, type TimeDetail } from "./datetime";
import { currentLanguage, t } from "./i18n";

/**
 * Number formatting follows the interface language, not the browser.
 *
 * "3,4 GB" in a Polish interface and "3.4 GB" in an English one; a page that has
 * been switched to English but still writes Polish decimal commas reads as a
 * half-finished translation, which is exactly what it would be.
 */
function locale(): string {
  return currentLanguage() === "en" ? "en-GB" : "pl-PL";
}

/**
 * A time the bridge sent, written for the reader: "11 lis 2026, 20:14" in a
 * Polish interface, "11 Nov 2026, 20:14" in an English one, in the reader's own
 * time zone (datetime.ts says how the two shapes the bridge sends are read).
 */
export function formatDateTime(value: string | null | undefined, detail: TimeDetail = true): string {
  return formatServerTime(value, locale(), detail);
}

/** A whole number grouped the way the interface language writes it: "12 982" or "12,982". */
export function formatCount(value: number): string {
  return value.toLocaleString(locale());
}

export function formatBytes(value: number | null): string {
  if (value === null || value < 0) {
    return t("Rozmiar nieznany");
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toLocaleString(locale(), { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

export function formatDuration(value: number | null): string {
  if (value === null || value < 0) {
    return t("Czas nieznany");
  }
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

