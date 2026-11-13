/**
 * Times the bridge sends, read and written out for a person.
 *
 * The bridge answers in two shapes. The old one is what MySQL prints —
 * `2026-11-11 20:14:03`, the database's wall clock with no zone on it. The new
 * one (audit ACC-09) is ISO 8601 with an offset, `2026-11-11T19:14:03+00:00`,
 * which names an instant. The pages used to cut either to sixteen characters and
 * show it raw, and compared the zoneless one against the browser's clock as if
 * both stood in the same room — true at home, wrong on a phone abroad, and a
 * link "expired" an hour early or late.
 *
 * A value with an offset is the instant it names. One without is read as local
 * time, which is the old behaviour and still the best guess for a home server
 * and a household in one time zone.
 *
 * No imports on purpose, so `node --test` can load it as it is; `format.ts`
 * supplies the interface language.
 */

const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Milliseconds since the epoch, or NaN when the value is not a time. */
export function parseServerTime(value: string | null | undefined): number {
  if (typeof value !== "string") return Number.NaN;
  const match = STAMP.exec(value.trim());
  if (!match) return Number.NaN;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zone] = match;
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)] as const;
  if (parts[1] < 0 || parts[1] > 11 || parts[2] < 1 || parts[2] > 31 || parts[3] > 23 || parts[4] > 59 || parts[5] > 60) return Number.NaN;
  const millis = fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0;
  if (zone === undefined) return new Date(...parts, millis).getTime();
  const utc = Date.UTC(...parts, millis);
  if (zone.toUpperCase() === "Z") return utc;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0");
  return utc - sign * offsetMinutes * 60_000;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** How much of the time to write: the day alone, to the minute, or to the second (an audit trail). */
export type TimeDetail = boolean | "seconds";

function formatter(locale: string, detail: TimeDetail): Intl.DateTimeFormat {
  const key = `${locale}|${detail}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, detail === false
      ? { dateStyle: "medium" }
      : { dateStyle: "medium", timeStyle: detail === "seconds" ? "medium" : "short" });
    formatters.set(key, found);
  }
  return found;
}

/**
 * "11 lis 2026, 20:14" / "11 Nov 2026, 20:14", in the reader's own time zone.
 *
 * A value that is not a time comes back as it was (cut to the minute, as the
 * pages used to show it) rather than as "Invalid Date": a strange value on
 * screen is a bug report, an empty one is a mystery.
 */
export function formatServerTime(value: string | null | undefined, locale: string, detail: TimeDetail = true): string {
  const stamp = parseServerTime(value);
  if (Number.isNaN(stamp)) return typeof value === "string" ? value.slice(0, detail === "seconds" ? 19 : 16).replace("T", " ") : "";
  return formatter(locale, detail).format(new Date(stamp));
}

/** Whole minutes from the value until `now` (negative: the value is in the future); NaN when it is not a time. */
export function minutesSince(value: string | null | undefined, now: number = Date.now()): number {
  const stamp = parseServerTime(value);
  return Number.isNaN(stamp) ? Number.NaN : Math.floor((now - stamp) / 60_000);
}

/** Whether the value names a moment that has passed. A value that is not a time has not passed. */
export function isPast(value: string | null | undefined, now: number = Date.now()): boolean {
  const stamp = parseServerTime(value);
  return !Number.isNaN(stamp) && stamp < now;
}

/**
 * Let an answer's times be the instants they are.
 *
 * Beside every timestamp the bridge sends the way the database prints it —
 * `created_at: "2026-11-11 20:19:17"`, the server's wall clock — it sends the
 * same moment with its zone: `created_at_iso: "2026-11-11T19:19:17+00:00"`.
 * This writes the second over the first, everywhere in the answer, so that the
 * pages go on reading `created_at` and get a value nobody can misread. Done
 * once, where answers arrive (api.ts), instead of at each of the thirty places
 * a time is shown.
 *
 * Only where both are present and the `_iso` one is a string: an older bridge
 * sends no siblings and its answers pass through untouched, and a time that is
 * null stays null. The `_iso` fields themselves are left in place.
 */
export function adoptIsoTimes<T>(answer: T): T {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (key.endsWith("_iso")) {
        const plain = key.slice(0, -4);
        if (typeof value === "string" && plain !== "" && plain in record) record[plain] = value;
      } else if (value !== null && typeof value === "object") {
        walk(value);
      }
    }
  };
  walk(answer);
  return answer;
}
