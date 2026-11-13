/**
 * Interface language.
 *
 * The Polish text is the key. Every caller writes `t("Odtwórz")` rather than
 * `t("player.play")`, for three reasons that matter in a codebase whose strings
 * were written straight into the markup:
 *
 *   - extraction is mechanical and cannot go wrong — you wrap the literal that
 *     is already there instead of inventing a name for it;
 *   - an untranslated string renders in Polish rather than as a raw key, so a
 *     half-filled dictionary degrades into "some English" instead of "broken";
 *   - the Polish interface keeps working, unchanged, at every step.
 *
 * Placeholders are named and written in braces: `t("Odtworzono {count}×", { count })`.
 * A missing placeholder is left in place rather than replaced with "undefined",
 * because a visible `{count}` is a bug report and an invisible one is not.
 */

export type Language = "pl" | "en";

export const LANGUAGES: Language[] = ["pl", "en"];

/**
 * Polish stays the default for accounts that never chose.
 *
 * Reading the browser's language instead would quietly turn the interface
 * English for the people who have been using it in Polish all along.
 */
export const DEFAULT_LANGUAGE: Language = "pl";

export function isLanguage(value: unknown): value is Language {
  return value === "pl" || value === "en";
}

/**
 * The words of each language by their Polish source text. Polish needs none —
 * the source text is the Polish. English lives in i18n-en.ts, a chunk of its
 * own, and is here only once `loadLanguage` has fetched it (or a test has
 * handed it over): until then English reads as Polish, which is the same
 * fallback an untranslated sentence has always had.
 */
const dictionaries: Record<Language, Readonly<Record<string, string>>> = { pl: {}, en: {} };
let englishRequest: Promise<void> | null = null;

/** Hand a language its words. The application fetches them (`loadLanguage`); a test imports the file and calls this. */
export function provideDictionary(language: Language, words: Readonly<Record<string, string>>): void {
  dictionaries[language] = words;
}

function fetchEnglish(): Promise<void> {
  englishRequest ??= import("./i18n-en").then(
    (module) => provideDictionary("en", module.english),
    // Not kept, so the next page asks again; meanwhile the interface is Polish rather than broken.
    () => { englishRequest = null; }
  );
  return englishRequest;
}

/**
 * Start fetching a language's words without waiting for them — for a caller
 * that expects the language (the one this browser used last) before it knows.
 */
export function preloadLanguage(value: unknown): void {
  if (value === "en") void fetchEnglish();
}

/**
 * Switch to a language and wait until its words are here. Everything is
 * translated as it is drawn, so this comes before the first thing drawn.
 * Never fails: words that could not be fetched leave the Polish in place.
 */
export async function loadLanguage(value: unknown): Promise<Language> {
  const language = setLanguage(value);
  if (language === "en") await fetchEnglish();
  return language;
}

let active: Language = DEFAULT_LANGUAGE;

/**
 * Anything unrecognised falls back to the default rather than blanking the interface.
 * Only switches: the application calls `loadLanguage`, which also has the words fetched.
 */
export function setLanguage(value: unknown): Language {
  active = isLanguage(value) ? value : DEFAULT_LANGUAGE;
  return active;
}

export function currentLanguage(): Language {
  return active;
}

/**
 * Translate, then fill named placeholders.
 *
 * @param text Polish source text, which doubles as the dictionary key
 * @param values values for `{name}` placeholders, if the text has any
 */
export function t(text: string, values?: Record<string, string | number>): string {
  const translated = dictionaries[active][text] ?? text;
  if (!values) return translated;
  return translated.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * The three Polish forms a noun takes after a number, each one a source text.
 *
 * `one` is for exactly 1 ("1 plik"), `few` for 2–4, 22–24 and so on ("2 pliki"),
 * `many` for everything else, 12–14 included ("5 plików", "12 plików").
 */
export interface PluralForms {
  one: string;
  few: string;
  many: string;
}

const pluralRules = new Map<Language, Intl.PluralRules>();

function pluralCategory(count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(active);
  if (!rules) {
    rules = new Intl.PluralRules(active === "en" ? "en-GB" : "pl-PL");
    pluralRules.set(active, rules);
  }
  return rules.select(count);
}

/**
 * Text that depends on a number — `tn(3, { one: "{count} plik", few: "{count} pliki", many: "{count} plików" })`.
 *
 * Only the genitive plural used to be written, so the interface said "1 plików",
 * "2 kolekcji" and "2 kanałów" wherever a number met a noun. The forms are Polish
 * source text like every other key; English needs two of them, so it reads the
 * translation of `one` for exactly one and of `many` for everything else, and
 * the `few` form never has to be translated at all.
 *
 * `{count}` is filled with the number formatted for the interface language
 * ("12 982" or "12,982"); pass `count` in `values` to show something else.
 */
export function tn(count: number, forms: PluralForms, values?: Record<string, string | number>): string {
  const category = pluralCategory(count);
  const source = category === "one" ? forms.one : active === "pl" && category === "few" ? forms.few : forms.many;
  return t(source, { count: count.toLocaleString(active === "en" ? "en-GB" : "pl-PL"), ...values });
}
