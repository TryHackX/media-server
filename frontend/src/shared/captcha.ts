/**
 * Renders whichever challenge widget the server asks for.
 *
 * reCAPTCHA, hCaptcha and Turnstile all work the same way from the page's side:
 * load one script, put a div with the right class and `data-sitekey` where the
 * widget should appear, and read the solved token out of a form field the widget
 * injects. That shared shape is why one helper covers all three.
 */

interface Provider {
  script: string;
  className: string;
  field: string;
}

const PROVIDERS: Record<string, Provider> = {
  recaptcha: {
    script: "https://www.google.com/recaptcha/api.js",
    className: "g-recaptcha",
    field: "g-recaptcha-response"
  },
  hcaptcha: {
    script: "https://js.hcaptcha.com/1/api.js",
    className: "h-captcha",
    field: "h-captcha-response"
  },
  turnstile: {
    script: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    className: "cf-turnstile",
    field: "cf-turnstile-response"
  }
};

export interface CaptchaWidget {
  element: HTMLElement;
  /** The solved token, or an empty string while the challenge is outstanding. */
  token(): string;
  reset(): void;
}

const loaded = new Set<string>();

function loadScript(source: string): void {
  if (loaded.has(source)) return;
  loaded.add(source);
  const script = document.createElement("script");
  script.src = source;
  script.async = true;
  script.defer = true;
  document.head.append(script);
}

/** Returns null when no provider is configured, so callers can skip the field. */
export function mountCaptcha(provider: string, siteKey: string): CaptchaWidget | null {
  const definition = PROVIDERS[provider];
  if (!definition || siteKey === "") return null;
  loadScript(definition.script);
  const element = document.createElement("div");
  element.className = `captcha-widget ${definition.className}`;
  element.dataset.sitekey = siteKey;
  element.dataset.theme = "dark";
  return {
    element,
    token(): string {
      const field = element.querySelector<HTMLTextAreaElement | HTMLInputElement>(
        `[name="${definition.field}"]`
      );
      return field?.value ?? "";
    },
    reset(): void {
      // Each provider exposes a global reset; falling back to clearing the field
      // keeps a stale token from being submitted twice if the global is missing.
      const global = (window as unknown as Record<string, { reset?: () => void } | undefined>)[
        provider === "recaptcha" ? "grecaptcha" : provider
      ];
      if (global && typeof global.reset === "function") {
        global.reset();
        return;
      }
      const field = element.querySelector<HTMLTextAreaElement | HTMLInputElement>(
        `[name="${definition.field}"]`
      );
      if (field) field.value = "";
    }
  };
}
