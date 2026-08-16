import "../styles/index.css";

import {
  activateAccount,
  confirmEmailChange,
  getAuthState,
  getSession,
  resendActivation,
  signIn,
  signUp,
  type AuthState
} from "../shared/api";
import { mountCaptcha, type CaptchaWidget } from "../shared/captcha";
import { appBase, appUrl } from "../shared/config";
import { el, requireRoot } from "../shared/dom";
import { DEFAULT_LANGUAGE, isLanguage, setLanguage, t } from "../shared/i18n";
import { icon } from "../shared/icons";

type Mode = "login" | "register";

// Signing in happens before there is an account to read a preference from, so
// this one page follows the browser instead. It cannot change anybody's stored
// choice — that lives with the account and applies from the moment they are in.
const browserLanguage = navigator.language.slice(0, 2).toLowerCase();
setLanguage(isLanguage(browserLanguage) ? browserLanguage : DEFAULT_LANGUAGE);
document.documentElement.lang = browserLanguage === "en" ? "en" : "pl";

const root = requireRoot();
const notice = el("div", { className: "notice hidden", attrs: { role: "alert", "aria-live": "polite" } });
const card = el("div", { className: "login-card" });
let authState: AuthState | null = null;
let captcha: CaptchaWidget | null = null;

/**
 * Where to land after signing in.
 *
 * api.ts sends an expired session here with `?next=` naming the page it was
 * thrown out of, so the trip back to sign in costs the reader their place only
 * once. Only same-application paths are honoured: `next` arrives in the address
 * bar, which anybody can write, and following it anywhere else would turn this
 * page into an open redirect.
 */
function landingUrl(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith(appBase) || next.startsWith("//")) return appUrl();
  return next === appUrl("login/") ? appUrl() : next;
}

function field(id: string, label: string, attrs: Record<string, unknown>): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el("input", { className: "input", attrs: { id, name: id, ...attrs } }) as HTMLInputElement;
  const wrap = el(
    "label",
    { className: "field", attrs: { for: id } },
    el("span", { className: "field__label", text: label }),
    input
  );
  return { wrap, input };
}

function say(text: string, kind: "error" | "success" | "info" = "error"): void {
  notice.className = `notice notice--${kind === "error" ? "error" : kind === "success" ? "success" : "info"}`;
  notice.textContent = text;
}

function clearNotice(): void {
  notice.className = "notice hidden";
  notice.textContent = "";
}

/** Turn a bridge failure into something a person can act on. */
function explain(error: unknown, fallback: string): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401) return t("Nieprawidłowy login lub hasło.");
  if (status === 403) return t("Sesja wygasła. Odśwież stronę i spróbuj ponownie.");
  if (status === 422) return fallback;
  if (status === 429) return t("Zbyt wiele prób. Odczekaj chwilę.");
  return t("Usługa jest chwilowo niedostępna.");
}

function render(mode: Mode): void {
  clearNotice();
  const registering = mode === "register";
  const heading = registering ? t("Załóż konto") : t("Zaloguj się");
  const lead = registering
    ? t("Po wysłaniu formularza potwierdź adres e-mail linkiem, który do Ciebie wyślemy.")
    : t("Użyj obecnego konta. Hasło nie jest zapisywane w przeglądarce.");

  const username = field("username", "Użytkownik", {
    type: "text",
    autocomplete: "username",
    required: true,
    maxlength: 32,
    ...(registering ? { pattern: "[A-Za-z0-9._-]{3,32}" } : {})
  });
  const email = field("email", t("Adres e-mail"), { type: "email", autocomplete: "email", required: true, maxlength: 254 });
  const password = field("password", registering ? t("Hasło (min. 12 znaków)") : t("Hasło"), {
    type: "password",
    autocomplete: registering ? "new-password" : "current-password",
    required: true,
    ...(registering ? { minlength: 12 } : {})
  });

  const submit = el("button", { className: "button button--primary", attrs: { type: "submit" } },
    registering ? t("Załóż konto") : t("Zaloguj się")) as HTMLButtonElement;

  const form = el("form", { className: "login-form", attrs: { novalidate: true } },
    username.wrap,
    ...(registering ? [email.wrap] : []),
    password.wrap
  );

  captcha = authState && (registering ? authState.captcha.register : authState.captcha.login)
    ? mountCaptcha(authState.captcha.provider, authState.captcha.site_key)
    : null;
  if (captcha) form.append(captcha.element);
  form.append(notice, submit);

  const footer = el("div", { className: "login-card__footer" });
  if (authState?.registration_enabled) {
    const swap = el("button", { className: "button button--ghost", attrs: { type: "button" } },
      registering ? t("Mam już konto") : t("Nie masz konta? Załóż je"));
    swap.addEventListener("click", () => render(registering ? "login" : "register"));
    footer.append(swap);
  }
  if (!registering) {
    const resend = el("button", { className: "link-button", attrs: { type: "button" } },
      t("Nie dotarł link aktywacyjny?"));
    resend.addEventListener("click", () => void requestActivationLink());
    footer.append(resend);
  }

  card.replaceChildren(
    el("div", { className: "stack" },
      el("span", { className: "status-pill", text: t("Bezpieczna sesja") }),
      el("h2", { text: heading, attrs: { id: "login-title" } }),
      el("p", { className: "muted", text: lead })
    ),
    form,
    footer
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = registering ? t("Zakładanie…") : "Sprawdzanie…";
    clearNotice();
    try {
      const token = captcha?.token() ?? "";
      if (captcha && token === "") {
        say(t("Potwierdź, że nie jesteś robotem."));
        return;
      }
      if (registering) {
        const result = await signUp(username.input.value.trim(), email.input.value.trim(), password.input.value, token);
        render("login");
        say(
          result.status === "active"
            ? t("Konto gotowe. Możesz się zalogować.")
            : t("Konto założone. Sprawdź pocztę i kliknij link aktywacyjny."),
          "success"
        );
        return;
      }
      await signIn(username.input.value.trim(), password.input.value, token);
      await getSession();
      window.location.assign(landingUrl());
    } catch (error) {
      say(explain(error, registering
        ? t("Sprawdź dane: nazwa 3-32 znaki, poprawny adres i hasło min. 12 znaków. Nazwa lub adres mogą być zajęte.")
        : t("Nieprawidłowy login lub hasło.")));
      password.input.value = "";
      password.input.focus();
      captcha?.reset();
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  });
}

async function requestActivationLink(): Promise<void> {
  const address = window.prompt("Podaj adres e-mail użyty przy rejestracji:");
  if (address === null || address.trim() === "") return;
  try {
    await resendActivation(address.trim());
    // Deliberately the same answer either way: whether an address is registered
    // is not something this form should reveal.
    say(t("Jeżeli konto czeka na potwierdzenie, link został wysłany ponownie."), "success");
  } catch (error) {
    say(explain(error, t("Nie udało się wysłać linku.")));
  }
}

/** Consume an activation link before drawing the form, so the result is visible. */
async function consumeActivation(): Promise<void> {
  const token = new URLSearchParams(window.location.search).get("activate");
  if (token === null) return;
  // Drop the token from the address bar so it is not kept in history.
  window.history.replaceState(null, "", window.location.pathname);
  try {
    const result = await activateAccount(token);
    say(t("Konto {username} zostało potwierdzone. Możesz się zalogować.", { username: result.username }), "success");
  } catch (error) {
    say(explain(error, t("Link aktywacyjny jest nieprawidłowy, wygasł lub został już użyty.")));
  }
}

/** Consume an e-mail-change confirmation link, mailed to the new address. */
async function consumeEmailChange(): Promise<void> {
  const token = new URLSearchParams(window.location.search).get("email_change");
  if (token === null) return;
  window.history.replaceState(null, "", window.location.pathname);
  try {
    const result = await confirmEmailChange(token);
    say(t("Nowy adres e-mail konta {username} został potwierdzony.", { username: result.username }), "success");
  } catch (error) {
    say(explain(error, t("Link potwierdzający jest nieprawidłowy, wygasł lub został już użyty.")));
  }
}

root.replaceChildren(
  el("main", { className: "login-page" },
    el("section", { className: "login-visual", attrs: { "aria-label": "TryHackX Media" } },
      el("a", { className: "brand", attrs: { href: appUrl() } },
        el("span", { className: "brand__mark" }, icon("server")),
        el("span", { className: "brand__copy" }, "TryHackX Media", el("small", { text: t("Home server") }))
      ),
      el("div", { className: "login-visual__copy" },
        el("span", { className: "status-pill", text: t("Prywatna biblioteka") }),
        el("h1", { text: t("Muzyka i filmy. Jedno miejsce.") }),
        el("p", { className: "muted",
          text: t("Wspólny, lekki interfejs oraz transfer przygotowany do dużych plików i wznawiania.") })
      ),
      el("small", { text: t("Dostęp wyłącznie dla autoryzowanych użytkowników.") })
    ),
    el("section", { className: "login-panel", attrs: { "aria-labelledby": "login-title" } }, card)
  )
);

void (async () => {
  // A mailed link must be consumed even when a session is already open, so the
  // signed-in redirect waits until we know no token is in the address bar.
  const params = new URLSearchParams(window.location.search);
  const hasMailToken = params.has("activate") || params.has("email_change");
  if (!hasMailToken) {
    try {
      await getSession();
      window.location.replace(landingUrl());
      return;
    } catch {
      // Not signed in, which is the normal case on this page.
    }
  }
  try {
    authState = await getAuthState();
  } catch {
    authState = null;
  }
  render("login");
  await consumeActivation();
  await consumeEmailChange();
})();
