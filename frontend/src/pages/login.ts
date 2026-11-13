import "../styles/core.css";

import {
  activateAccount,
  confirmEmailChange,
  getAuthState,
  getSession,
  resendActivation,
  signIn,
  signInSecondFactor,
  signUp,
  type AuthState
} from "../shared/api";
import { mountCaptcha, type CaptchaWidget } from "../shared/captcha";
import { codeInput, recoveryCodesView, setupView } from "../shared/two-factor-ui";
import type { SignInStep } from "../shared/types";
import { appBase, appUrl } from "../shared/config";
import { safeLanding } from "../shared/landing";
import { el, requireRoot } from "../shared/dom";
import { DEFAULT_LANGUAGE, isLanguage, loadLanguage, t } from "../shared/i18n";
import { icon, primeIconFont } from "../shared/icons";

type Mode = "login" | "register";

primeIconFont();

// Signing in happens before there is an account to read a preference from, so
// this one page follows the browser instead. It cannot change anybody's stored
// choice — that lives with the account and applies from the moment they are in.
// English words are a chunk of their own (i18n-en.ts): nothing below is drawn
// until they are here, and a Polish browser waits for nothing.
const browserLanguage = navigator.language.slice(0, 2).toLowerCase();
document.documentElement.lang = await loadLanguage(isLanguage(browserLanguage) ? browserLanguage : DEFAULT_LANGUAGE);

const root = requireRoot();
// An error interrupts (`alert`), anything else waits its turn (`status`). It
// used to be both at once — role="alert" with aria-live="polite" — which a
// screen reader settles one way or the other, never the way the message needs.
const notice = el("div", { className: "notice hidden", attrs: { role: "status" } });
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
  return safeLanding(new URLSearchParams(window.location.search).get("next"), window.location.origin, appBase, appUrl("login/"), appUrl());
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
  notice.setAttribute("role", kind === "error" ? "alert" : "status");
  notice.textContent = text;
}

function clearNotice(): void {
  notice.className = "notice hidden";
  notice.textContent = "";
}

/** Turn a bridge failure into something a person can act on. */
function explain(error: unknown, fallback: string): string {
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message : "";
  if (status === 401) return t("Nieprawidłowy login lub hasło.");
  if (status === 403) return t("Sesja wygasła. Odśwież stronę i spróbuj ponownie.");
  // The challenge was closed without being solved (the request layer asked for it).
  if (status === 428) return t("Potwierdź, że nie jesteś robotem.");
  const antiBot = t("Weryfikacja antybotowa nie powiodła się. Spróbuj ponownie.");
  if (status === 422 && message === antiBot) return antiBot;
  // An unknown activation or confirmation link answers 404, a used or expired one 422.
  if (status === 404 || status === 422) return fallback;
  // The bridge says which limit it was — a pause or a block — and for how long to wait.
  if (status === 429) return message || t("Zbyt wiele prób. Odczekaj chwilę.");
  return t("Usługa jest chwilowo niedostępna.");
}

function render(mode: Mode): void {
  clearNotice();
  const registering = mode === "register";
  const heading = registering ? t("Załóż konto") : t("Zaloguj się");
  const lead = registering
    ? t("Po wysłaniu formularza potwierdź adres e-mail linkiem, który do Ciebie wyślemy.")
    : t("Użyj obecnego konta. Hasło nie jest zapisywane w przeglądarce.");

  const username = field("username", t("Użytkownik"), {
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
  if (!registering) footer.append(activationResend());

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
    submit.textContent = registering ? t("Zakładanie…") : t("Sprawdzanie…");
    clearNotice();
    try {
      // Asynchronous for every provider: v3 runs here, proof of work may still be searching.
      const token = captcha ? await captcha.token(registering ? "register" : "login") : "";
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
      const step = await signIn(username.input.value.trim(), password.input.value, token);
      if (step.two_factor) {
        renderSecondFactor(step);
        return;
      }
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

/**
 * The second step of signing in, when the account has two-factor sign-in on
 * (a code from the app, or a recovery code) or an operator requires it of
 * administrators and this one has none yet (set it up here, then the code).
 * The server holds a ticket for a few minutes between the steps; the session
 * itself only opens once the code is accepted.
 */
function renderSecondFactor(step: SignInStep): void {
  clearNotice();
  const setup = step.two_factor === "setup" && step.secret && step.otpauth_uri;
  let recovery = false;
  const label = el("span", { className: "field__label" });
  let input = codeInput(false);
  const wrap = el("label", { className: "field" }, label, input);
  const paintLabel = (): void => {
    label.textContent = recovery ? t("Kod odzyskiwania") : t("Kod z aplikacji");
  };
  paintLabel();
  const submit = el("button", { className: "button button--primary", attrs: { type: "submit" } }, t("Potwierdź")) as HTMLButtonElement;
  const form = el("form", { className: "login-form", attrs: { novalidate: true } },
    ...(setup ? [setupView(step.secret ?? "", step.otpauth_uri ?? "")] : []),
    wrap,
    notice,
    submit
  );
  const footer = el("div", { className: "login-card__footer" });
  const back = el("button", { className: "button button--ghost", attrs: { type: "button" } }, t("Wróć do logowania"));
  back.addEventListener("click", () => render("login"));
  footer.append(back);
  if (!setup) {
    const toggle = el("button", { className: "link-button", attrs: { type: "button" } }, t("Nie mam telefonu — użyję kodu odzyskiwania"));
    toggle.addEventListener("click", () => {
      recovery = !recovery;
      const next = codeInput(recovery);
      input.replaceWith(next);
      input = next;
      paintLabel();
      toggle.textContent = recovery ? t("Mam telefon — wpiszę kod z aplikacji") : t("Nie mam telefonu — użyję kodu odzyskiwania");
      input.focus();
    });
    footer.append(toggle);
  }
  card.replaceChildren(
    el("div", { className: "stack" },
      el("span", { className: "status-pill", text: t("Bezpieczna sesja") }),
      el("h2", { text: t("Weryfikacja dwuetapowa"), attrs: { id: "login-title" } }),
      el("p", { className: "muted", text: setup
        ? t("Administrator wymaga weryfikacji dwuetapowej od kont administratorów. Dodaj konto w aplikacji uwierzytelniającej i wpisz pokazany kod.")
        : t("Wpisz 6-cyfrowy kod z aplikacji uwierzytelniającej.") })
    ),
    form,
    footer
  );
  input.focus();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (input.value.trim() === "") {
      input.focus();
      return;
    }
    submit.disabled = true;
    clearNotice();
    try {
      const result = await signInSecondFactor(input.value.trim());
      if (result.recovery_codes && result.recovery_codes.length > 0) {
        // Shown once, right after the forced setup; the session is already open.
        card.replaceChildren(
          el("div", { className: "stack" },
            el("h2", { text: t("Weryfikacja dwuetapowa włączona"), attrs: { id: "login-title" } })
          ),
          recoveryCodesView(result.recovery_codes, () => window.location.assign(landingUrl()), t("Dalej"))
        );
        return;
      }
      await getSession();
      window.location.assign(landingUrl());
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      const message = error instanceof Error ? error.message : "";
      if (status === 422 && message === t("Logowanie wygasło. Zaloguj się ponownie.")) {
        render("login");
        say(message);
        return;
      }
      if (status === 429) {
        // Too many wrong codes: the ticket is gone, the password comes first again.
        render("login");
        say(message || t("Zbyt wiele prób. Odczekaj chwilę."));
        return;
      }
      say(status === 422 ? message || t("Nieprawidłowy kod.") : explain(error, t("Nieprawidłowy kod.")));
      input.value = "";
      input.focus();
    } finally {
      submit.disabled = false;
    }
  });
}

/**
 * "The activation link never arrived": a link that opens a field for the address
 * right where it stands.
 *
 * It used to be `window.prompt` — a system box with the server's address in its
 * title, no e-mail keyboard on a phone, no validation, and no way to paste on
 * some of them. A real field gets all of that from the browser.
 */
function activationResend(): HTMLElement {
  const host = el("div", { className: "login-resend" });
  const open = el("button", { className: "link-button", attrs: { type: "button", "aria-expanded": "false" } },
    t("Nie dotarł link aktywacyjny?"));
  const address = el("input", {
    className: "input",
    attrs: { type: "email", name: "resend-email", autocomplete: "email", required: true, maxlength: 254, "aria-label": t("Adres e-mail użyty przy rejestracji"), placeholder: t("Adres e-mail użyty przy rejestracji") }
  }) as HTMLInputElement;
  const send = el("button", { className: "button button--secondary", attrs: { type: "submit" } }, t("Wyślij link ponownie")) as HTMLButtonElement;
  const form = el("form", { className: "login-resend__form hidden", attrs: { novalidate: true } }, address, send);
  open.addEventListener("click", () => {
    const show = form.classList.contains("hidden");
    form.classList.toggle("hidden", !show);
    open.setAttribute("aria-expanded", String(show));
    if (show) address.focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    send.disabled = true;
    void resendActivation(address.value.trim())
      .then(() => {
        form.classList.add("hidden");
        open.setAttribute("aria-expanded", "false");
        address.value = "";
        // Deliberately the same answer either way: whether an address is registered
        // is not something this form should reveal.
        say(t("Jeżeli konto czeka na potwierdzenie, link został wysłany ponownie."), "success");
      })
      .catch((error: unknown) => say(explain(error, t("Nie udało się wysłać linku."))))
      .finally(() => { send.disabled = false; });
  });
  host.append(open, form);
  return host;
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
  // The form first. It needs nothing from the server to be drawn; what the
  // server adds — the anti-bot widget, the link to registration — is laid in
  // when the answer comes. Both requests used to finish before anything showed.
  render("login");
  // A mailed link must be consumed even when a session is already open, so the
  // signed-in redirect waits until we know no token is in the address bar.
  const params = new URLSearchParams(window.location.search);
  const hasMailToken = params.has("activate") || params.has("email_change");
  // One question answers both "is somebody signed in" and "what does the form
  // need". Asking for the session to find out meant a 401 on every visit by
  // somebody not signed in — the normal case here — which the browser writes to
  // the console as an error whether or not anything is wrong.
  let state: AuthState | null = null;
  try {
    state = await getAuthState();
  } catch {
    state = null;
  }
  if (state?.authenticated && !hasMailToken) {
    window.location.replace(landingUrl());
    return;
  }
  authState = state;
  if (state !== null) redrawKeepingInput();
  await consumeActivation();
  await consumeEmailChange();
})();

/**
 * Draw the form again with what the server said it needs, without taking away
 * what was typed while the answer was on its way.
 */
function redrawKeepingInput(): void {
  const typed = new Map<string, string>();
  for (const input of Array.from(card.querySelectorAll<HTMLInputElement>("input[id]"))) typed.set(input.id, input.value);
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement.id : "";
  const kept = notice.className;
  const keptText = notice.textContent ?? "";
  const keptRole = notice.getAttribute("role") ?? "status";
  render("login");
  for (const [id, value] of typed) {
    const input = card.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`);
    if (input) input.value = value;
  }
  if (focused) card.querySelector<HTMLInputElement>(`#${CSS.escape(focused)}`)?.focus();
  notice.className = kept;
  notice.textContent = keptText;
  notice.setAttribute("role", keptRole);
}
