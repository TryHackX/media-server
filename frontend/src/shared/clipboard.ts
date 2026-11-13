/** Copy text to the clipboard, falling back to a hidden textarea on older engines. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.setAttribute("readonly", "");
  input.setAttribute("aria-hidden", "true");
  input.value = text;
  input.style.setProperty("position", "fixed");
  input.style.setProperty("opacity", "0");
  document.body.append(input);
  input.select();
  try {
    document.execCommand("copy");
  } finally {
    input.remove();
  }
}

/** Copy the current page address with the given query parameters (share links). */
export async function copyShareLink(parameters: Record<string, string>): Promise<void> {
  const url = new URL(window.location.href);
  url.search = "";
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  await copyText(url.href);
}
