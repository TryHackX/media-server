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

export function requireRoot(): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    throw new Error("Brak kontenera aplikacji.");
  }
  return root;
}

