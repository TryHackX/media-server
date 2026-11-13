/**
 * Renders whichever challenge the server asks for and hands back its token.
 *
 * Providers:
 *  - reCAPTCHA v2, hCaptcha and Turnstile share one shape from the page's side:
 *    load one script, render a widget into an element, read the solved token back
 *    by widget id;
 *  - reCAPTCHA v3 shows no widget (Google's badge only) and makes a scored token
 *    on demand — `token(action)` runs it on submit, with the action name the
 *    server checks;
 *  - `pow` is our own proof of work: it fetches a puzzle from the bridge and
 *    solves it in a worker while the person types, showing a quiet line of
 *    progress. It needs no third-party script, which is why it is the only
 *    provider that works inside the application pages (their CSP allows our own
 *    scripts alone); the others work on the sign-in page.
 *
 * `token()` is asynchronous for all of them. A token is spent by the request
 * that carries it, so callers `reset()` after every attempt.
 *
 * Rendering of the widget providers is explicit (`render=explicit` plus an
 * `onload` callback), not the providers' default: the default scans the page
 * once, when the script loads — and the script loads once, while the sign-in
 * page draws a fresh form whenever it switches between signing in and
 * registering.
 */
import { apiBase } from "./config";
import { t } from "./i18n";
import { encodeSolution, solveChallenge, type PowChallenge } from "./pow";

interface WidgetProvider {
  script: string;
  /** The global the script defines once it is ready. */
  global: string;
  className: string;
}

/** The part of the three widget providers' APIs this helper uses; they agree on it. */
interface WidgetApi {
  render(element: HTMLElement, options: Record<string, unknown>): string | number;
  getResponse(widgetId?: string | number): string;
  reset(widgetId?: string | number): void;
}

interface RecaptchaV3Api {
  ready(callback: () => void): void;
  execute(siteKey: string, options: { action: string }): Promise<string>;
}

const WIDGETS: Record<string, WidgetProvider> = {
  recaptcha: {
    script: "https://www.google.com/recaptcha/api.js",
    global: "grecaptcha",
    className: "g-recaptcha"
  },
  hcaptcha: {
    script: "https://js.hcaptcha.com/1/api.js",
    global: "hcaptcha",
    className: "h-captcha"
  },
  turnstile: {
    script: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    global: "turnstile",
    className: "cf-turnstile"
  }
};

export interface CaptchaWidget {
  element: HTMLElement;
  /** The solved token for this action, or "" while the challenge is outstanding. */
  token(action: string): Promise<string>;
  /** Forget a spent token; proof of work starts on a fresh puzzle. */
  reset(): void;
  /** Whether the person has to do something (tick, pick pictures); false for v3 and proof of work. */
  interactive: boolean;
}

const scripts = new Map<string, Promise<unknown>>();

/** Load a provider's script once; a failed load may be retried by the next form. */
function loadScript(key: string, src: string, global: string, withCallback: boolean): Promise<unknown> {
  let loading = scripts.get(key);
  if (!loading) {
    loading = new Promise<unknown>((resolve, reject) => {
      const scope = window as unknown as Record<string, unknown>;
      const script = document.createElement("script");
      if (withCallback) {
        const callback = `__tryhackxCaptchaReady_${key.replace(/[^A-Za-z0-9_]/g, "_")}`;
        scope[callback] = () => {
          const loaded = scope[global];
          if (loaded) resolve(loaded);
          else reject(new Error(`${key}: the script loaded without its API`));
        };
        script.src = `${src}${src.includes("?") ? "&" : "?"}render=explicit&onload=${callback}`;
      } else {
        script.src = src;
        script.addEventListener("load", () => {
          const loaded = scope[global];
          if (loaded) resolve(loaded);
          else reject(new Error(`${key}: the script loaded without its API`));
        });
      }
      script.async = true;
      script.defer = true;
      script.addEventListener("error", () => reject(new Error(`${key}: the script did not load`)));
      document.head.append(script);
    });
    loading.catch(() => scripts.delete(key));
    scripts.set(key, loading);
  }
  return loading;
}

function mountWidget(name: string, definition: WidgetProvider, siteKey: string): CaptchaWidget {
  const element = document.createElement("div");
  element.className = `captcha-widget ${definition.className}`;
  let api: WidgetApi | null = null;
  let widgetId: string | number | null = null;
  // Rendered once the API is there and the element is in the document — the
  // caller places it in its form after this returns.
  const renderInto = (loaded: WidgetApi): void => {
    if (widgetId === null) widgetId = loaded.render(element, { sitekey: siteKey, theme: "dark" });
  };
  void loadScript(name, definition.script, definition.global, true)
    .then((loaded) => {
      api = loaded as WidgetApi;
      if (element.isConnected) {
        renderInto(api);
        return;
      }
      const observer = new MutationObserver(() => {
        if (!element.isConnected || !api) return;
        observer.disconnect();
        renderInto(api);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    })
    .catch(() => undefined);
  return {
    element,
    interactive: true,
    token(): Promise<string> {
      if (!api || widgetId === null) return Promise.resolve("");
      try {
        return Promise.resolve(api.getResponse(widgetId) ?? "");
      } catch {
        return Promise.resolve("");
      }
    },
    reset(): void {
      if (!api || widgetId === null) return;
      try {
        api.reset(widgetId);
      } catch {
        // A widget whose element has gone has nothing left to reset.
      }
    }
  };
}

function mountRecaptchaV3(siteKey: string): CaptchaWidget {
  // Nothing to draw: Google's badge appears by itself and says what protects the form.
  const element = document.createElement("div");
  element.className = "captcha-widget captcha-widget--invisible";
  const ready = loadScript(`recaptcha_v3:${siteKey}`, `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`, "grecaptcha", false);
  return {
    element,
    interactive: false,
    async token(action: string): Promise<string> {
      try {
        const api = (await ready) as RecaptchaV3Api;
        await new Promise<void>((resolve) => api.ready(resolve));
        return (await api.execute(siteKey, { action })) ?? "";
      } catch {
        return "";
      }
    },
    reset(): void {
      // Every execute() makes a new token; there is nothing to clear.
    }
  };
}

/** Start the search: in a worker when the browser gives us one, in slices on this thread otherwise. */
function solveInBackground(challenge: PowChallenge, onProgress: (fraction: number) => void): { result: Promise<number | null>; cancel(): void } {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./pow-worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  let cancelled = false;
  if (worker) {
    const running = worker;
    const result = new Promise<number | null>((resolve) => {
      running.onmessage = (event: MessageEvent<{ progress?: number; number?: number | null }>) => {
        if (typeof event.data.progress === "number") {
          onProgress(event.data.progress);
          return;
        }
        resolve(event.data.number ?? null);
        running.terminate();
      };
      running.onerror = () => {
        running.terminate();
        resolve(solveSliced(challenge, onProgress, () => cancelled));
      };
      running.postMessage(challenge);
    });
    return { result, cancel: () => { cancelled = true; running.terminate(); } };
  }
  return { result: solveSliced(challenge, onProgress, () => cancelled), cancel: () => { cancelled = true; } };
}

async function solveSliced(challenge: PowChallenge, onProgress: (fraction: number) => void, stopped: () => boolean): Promise<number | null> {
  const slice = 20000;
  for (let from = 0; from <= challenge.maxnumber; from += slice) {
    if (stopped()) return null;
    const found = solveChallenge(challenge, { from, to: from + slice - 1 });
    if (found !== null) return found;
    onProgress(Math.min(1, (from + slice) / Math.max(1, challenge.maxnumber)));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return null;
}

async function fetchPowChallenge(): Promise<PowChallenge> {
  const response = await fetch(`${apiBase}?action=captcha_challenge`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`captcha_challenge: ${response.status}`);
  const body = (await response.json()) as { challenge?: PowChallenge };
  if (!body.challenge) throw new Error("captcha_challenge: no challenge");
  return body.challenge;
}

function mountProofOfWork(): CaptchaWidget {
  const element = document.createElement("div");
  element.className = "captcha-widget captcha-pow";
  element.setAttribute("role", "status");
  const label = document.createElement("span");
  label.className = "captcha-pow__label";
  const bar = document.createElement("span");
  bar.className = "captcha-pow__bar";
  const fill = document.createElement("span");
  bar.append(fill);
  element.append(bar, label);

  let attempt: Promise<string> = Promise.resolve("");
  let cancel: () => void = () => undefined;
  const paint = (state: "working" | "done" | "failed", fraction = 0): void => {
    element.dataset.state = state;
    fill.style.width = `${Math.round((state === "done" ? 1 : fraction) * 100)}%`;
    label.textContent = state === "done"
      ? t("Przeglądarka sprawdzona.")
      : state === "failed"
        ? t("Nie udało się sprawdzić przeglądarki. Spróbuj ponownie.")
        : t("Sprawdzanie przeglądarki…");
  };
  const start = (): void => {
    cancel();
    paint("working");
    let stop = false;
    let stopSearch: () => void = () => undefined;
    cancel = () => { stop = true; stopSearch(); };
    attempt = (async () => {
      try {
        const challenge = await fetchPowChallenge();
        if (stop) return "";
        // The search ends somewhere in the range; the bar shows how far it has looked.
        const search = solveInBackground(challenge, (fraction) => { if (!stop) paint("working", fraction); });
        stopSearch = search.cancel;
        const number = await search.result;
        if (stop) return "";
        if (number === null) {
          paint("failed");
          return "";
        }
        paint("done");
        return encodeSolution(challenge, number);
      } catch {
        if (!stop) paint("failed");
        return "";
      }
    })();
  };
  start();
  return {
    element,
    interactive: false,
    token(): Promise<string> {
      // A failed attempt (network, a 429) is tried once more before giving up.
      return attempt.then((token) => {
        if (token !== "" || element.dataset.state !== "failed") return token;
        start();
        return attempt;
      });
    },
    reset(): void {
      start();
    }
  };
}

/** Returns null when no usable provider is named, so callers can skip the field. */
export function mountCaptcha(provider: string, siteKey: string): CaptchaWidget | null {
  if (provider === "pow") return mountProofOfWork();
  if (siteKey === "") return null;
  if (provider === "recaptcha_v3") return mountRecaptchaV3(siteKey);
  const definition = WIDGETS[provider];
  return definition ? mountWidget(provider, definition, siteKey) : null;
}
