function meta(name: string, fallback: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim();
  return value || fallback;
}

export const appBase = meta("media-app-base", "/media-next/").replace(/\/?$/, "/");
export const apiBase = meta("media-api-base", "/media-next-api");

export function appUrl(path = ""): string {
  return appBase + path.replace(/^\//, "");
}

