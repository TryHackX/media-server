export type Child = Node | string | number | false | null | undefined;

export interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string | number | null | undefined>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) {
    node.className = options.className;
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === false || value === null || value === undefined) {
      continue;
    }
    node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    if (value !== null && value !== undefined) {
      node.dataset[name] = String(value);
    }
  }
  for (const child of children) {
    if (child === false || child === null || child === undefined) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** The stagger in styles/motion.css: eleven steps of 24 ms, then 300 ms for the last child to land. */
const ARRIVAL_MS = 11 * 24 + 300 + 60;

/**
 * Let a list that has just been drawn arrive: its children rise into place, the
 * first dozen one after another (styles/motion.css, `[data-entering]`).
 *
 * Called by whoever draws a *new* listing — a page's first paint, a folder
 * walked into. The animation used to hang on the containers themselves, so it
 * ran for every child they were ever given: each keystroke in a search box
 * redrew the grid and every card faded in again, and a panel that refreshes
 * itself every four seconds re-arrived every four seconds. A redraw of the same
 * listing simply does not call this.
 */
export function arrive<T extends HTMLElement>(container: T): T {
  container.dataset.entering = "true";
  window.setTimeout(() => { delete container.dataset.entering; }, ARRIVAL_MS);
  return container;
}

export function requireRoot(): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    throw new Error("Brak kontenera aplikacji.");
  }
  return root;
}

