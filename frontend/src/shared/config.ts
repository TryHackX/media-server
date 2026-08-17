function meta(name: string, fallback: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim();
  return value || fallback;
}

// Every built page carries the meta; the fallback only covers a page served
// from somewhere the build never touched, and then the root is the safer guess
// — it is what `MEDIA_APP_BASE` defaults to.
export const appBase = meta("media-app-base", "/").replace(/\/?$/, "/");
export const apiBase = meta("media-api-base", "/media-next-api");

export function appUrl(path = ""): string {
  return appBase + path.replace(/^\//, "");
}

