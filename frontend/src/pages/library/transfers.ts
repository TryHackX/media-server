import { ApiError } from "../../shared/api";
import { el } from "../../shared/dom";
import type { ArchiveTransfer } from "../../shared/types";

/** Download failures worth naming precisely: quota (429) and group rights (403). */
export function downloadFailureText(error: unknown, fallback: string): string {
  return error instanceof ApiError && (error.status === 429 || error.status === 403) ? error.message : fallback;
}

/** Hand a prepared archive to the browser: a form posted into a new tab, which becomes the download. */
export function submitArchive(transfer: ArchiveTransfer): void {
  const form = el("form", { attrs: { method: "post", action: transfer.url, target: "_blank" } });
  form.append(el("input", { attrs: { type: "hidden", name: "token", value: transfer.form.token } }));
  document.body.append(form);
  form.submit();
  form.remove();
}
