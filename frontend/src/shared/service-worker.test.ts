import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

/*
 * The offline shell is anchored to one value — where the application lives —
 * and every rule in the worker is expressed in terms of it. When it was written
 * by hand it survived the move from `/media-next/` to the root without a single
 * error: the worker installed, activated, and then ignored every request there
 * was. Nothing tells you that has happened, which is exactly why it is worth a
 * test.
 *
 * `sw.js` is a public asset, so it cannot be imported: it runs in a worker
 * scope, not a module scope. It is loaded here into a fake one, which also lets
 * the handlers it registers be called directly.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");

type Handler = (event: unknown) => void;

interface Scope {
  BASE: string;
  SHELL: string[];
  handlers: Map<string, Handler>;
  /** Every cache the worker opened, by name: address -> body text. */
  stores: Map<string, Map<string, string>>;
  /** What the network answers; null is "no network". */
  network: { answer: ((url: string) => Response) | null };
}

const keyOf = (target: string | Request, base: string): string =>
  typeof target === "string" ? new URL(target, base).href : target.url;

/** A worker scope with a Cache API that remembers, so what the worker keeps and drops can be read back. */
function load(workerUrl: string): Scope {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, string>>();
  const network: Scope["network"] = { answer: () => new Response("", { status: 200 }) };
  const self = {
    location: new URL(workerUrl),
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() }
  };
  const cacheFor = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    const entries = store;
    return {
      add: (target: string) => { entries.set(keyOf(target, workerUrl), ""); return Promise.resolve(); },
      put: async (target: string | Request, response: Response) => { entries.set(keyOf(target, workerUrl), await response.text()); },
      match: (target: string | Request) => {
        const body = entries.get(keyOf(target, workerUrl));
        return Promise.resolve(body === undefined ? undefined : new Response(body));
      },
      keys: () => Promise.resolve(Array.from(entries.keys(), (url) => new Request(url))),
      delete: (target: string | Request) => Promise.resolve(entries.delete(keyOf(target, workerUrl)))
    };
  };
  const caches = {
    open: (name: string) => Promise.resolve(cacheFor(name)),
    match: (target: string | Request) => {
      for (const store of stores.values()) {
        const body = store.get(keyOf(target, workerUrl));
        if (body !== undefined) return Promise.resolve(new Response(body));
      }
      return Promise.resolve(undefined);
    },
    keys: () => Promise.resolve(Array.from(stores.keys())),
    delete: (name: string) => Promise.resolve(stores.delete(name))
  };
  const context = vm.createContext({
    self,
    URL,
    Response,
    Request,
    Promise,
    caches,
    fetch: (request: Request) => (network.answer ? Promise.resolve(network.answer(request.url)) : Promise.reject(new TypeError("offline")))
  });
  // The completion value of the script: `const` declarations live in the
  // script's own lexical scope, so they are read by evaluating them there.
  const { BASE, SHELL } = vm.runInContext(`${SOURCE}\n;({ BASE, SHELL })`, context) as {
    BASE: string;
    SHELL: string[];
  };
  return { BASE, SHELL, handlers, stores, network };
}

/** Ask the worker for a page as the browser does, and wait for whatever it does afterwards. */
async function navigate(scope: Scope, url: string): Promise<Response | null> {
  const request = new Request(url, { method: "GET" });
  Object.defineProperty(request, "mode", { value: "navigate" });
  let answer: Promise<Response> | null = null;
  scope.handlers.get("fetch")!({ request, respondWith: (response: Promise<Response>) => { answer = response; } });
  const response = answer === null ? null : await (answer as Promise<Response>);
  // The worker keeps the page after answering; let that settle.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return response;
}

async function fetchAsset(scope: Scope, url: string): Promise<void> {
  let answer: Promise<Response> | null = null;
  scope.handlers.get("fetch")!({ request: new Request(url, { method: "GET" }), respondWith: (response: Promise<Response>) => { answer = response; } });
  if (answer !== null) await (answer as Promise<Response>);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const page = (...assets: string[]): Response =>
  new Response(`<!doctype html>${assets.map((name) => `<script type="module" src="/assets/${name}"></script>`).join("")}`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });

test("the base is where the worker itself was served, not a path written by hand", () => {
  assert.equal(load("https://example.test/sw.js").BASE, "/");
  assert.equal(load("https://example.test/media-next/sw.js").BASE, "/media-next/");
});

test("the precached shell is anchored to that base", () => {
  const root = load("https://example.test/sw.js");
  assert.ok(root.SHELL.includes("/"));
  assert.ok(root.SHELL.includes("/music/"));

  const nested = load("https://example.test/media-next/sw.js");
  assert.ok(nested.SHELL.every((url) => url.startsWith("/media-next/")));
  assert.ok(nested.SHELL.includes("/media-next/music/"));
});

test("a request outside the application is left alone", () => {
  const { handlers } = load("https://example.test/media-next/sw.js");
  const fetchHandler = handlers.get("fetch");
  assert.ok(fetchHandler);

  let answered = false;
  const event = {
    request: new Request("https://example.test/other-app/index.html", { method: "GET" }),
    respondWith: () => {
      answered = true;
    }
  };
  fetchHandler(event);
  assert.equal(answered, false, "the worker must not answer for anything outside its own base");
});

test("a page inside the application is answered", async () => {
  const scope = load("https://example.test/media-next/sw.js");
  const response = await navigate(scope, "https://example.test/media-next/music/");
  assert.ok(response);
  assert.equal(response.status, 200);
});

test("offline, a page seen before is answered with its own copy — whatever query it is asked with", async () => {
  const scope = load("https://example.test/sw.js");
  scope.network.answer = () => page("router-AAA.js");
  await navigate(scope, "https://example.test/music/?collection=3");
  scope.network.answer = null;
  const offline = await navigate(scope, "https://example.test/music/?directory=77");
  assert.ok(offline);
  assert.equal(offline.status, 200);
  assert.match(await offline.text(), /router-AAA\.js/);
});

test("offline, any profile is answered by the one account page", async () => {
  const scope = load("https://example.test/sw.js");
  scope.network.answer = () => page("router-AAA.js");
  await navigate(scope, "https://example.test/account/");
  scope.network.answer = null;
  const offline = await navigate(scope, "https://example.test/account/somebody/");
  assert.ok(offline);
  assert.equal(offline.status, 200);
});

test("offline, a page never seen gets the offline page — never another page's copy", async () => {
  // The start page used to stand in for it. Served at the sign-in address it ran
  // the application there, which redirected to sign-in: a reload loop.
  const scope = load("https://example.test/sw.js");
  scope.network.answer = () => page("router-AAA.js");
  await navigate(scope, "https://example.test/");
  scope.network.answer = null;
  const offline = await navigate(scope, "https://example.test/login/");
  assert.ok(offline);
  assert.equal(offline.status, 503);
  const text = await offline.text();
  assert.match(text, /Brak połączenia/);
  assert.doesNotMatch(text, /router-AAA\.js/);
});

test("a page that names different files is a new build: the old build's assets are dropped", async () => {
  const scope = load("https://example.test/sw.js");
  const assets = (): string[] => Array.from(scope.stores.get("tryhackx-media-assets-shell-v3")?.keys() ?? []);
  scope.network.answer = (url) => (url.endsWith("/music/") ? page("router-AAA.js", "index-AAA.css") : new Response("x", { status: 200 }));
  await navigate(scope, "https://example.test/music/");
  await fetchAsset(scope, "https://example.test/assets/router-AAA.js");
  await fetchAsset(scope, "https://example.test/assets/avs-AAA.js");
  assert.equal(assets().length, 2);

  // The same build again: nothing is dropped.
  await navigate(scope, "https://example.test/music/");
  assert.equal(assets().length, 2);

  // A new build: the page names new files.
  scope.network.answer = (url) => (url.endsWith("/music/") ? page("router-BBB.js", "index-BBB.css") : new Response("x", { status: 200 }));
  await navigate(scope, "https://example.test/music/");
  assert.equal(assets().length, 0, "assets of the build that was replaced must go");
  await fetchAsset(scope, "https://example.test/assets/router-BBB.js");
  assert.deepEqual(assets(), ["https://example.test/assets/router-BBB.js"]);
});

test("the theme's boot script is kept by its version, and only with one", async () => {
  const scope = load("https://example.test/media-next/sw.js");
  const assets = (): string[] => Array.from(scope.stores.get("tryhackx-media-assets-shell-v3")?.keys() ?? []);
  scope.network.answer = () => new Response("/* boot */", { status: 200 });
  await fetchAsset(scope, "https://example.test/media-next/theme-boot.js?v=0123456789");
  assert.deepEqual(assets(), ["https://example.test/media-next/theme-boot.js?v=0123456789"]);
  // Offline it is answered from the copy — the page waits for this script before it paints.
  scope.network.answer = null;
  let answer: Promise<Response> | null = null;
  scope.handlers.get("fetch")!({
    request: new Request("https://example.test/media-next/theme-boot.js?v=0123456789", { method: "GET" }),
    respondWith: (response: Promise<Response>) => { answer = response; }
  });
  assert.ok(answer, "the worker answers for the boot script");
  assert.equal(await (await (answer as Promise<Response>)).text(), "/* boot */");
  // Without a version in the address it is an ordinary file: left to the browser, never kept for good.
  let answered = false;
  scope.handlers.get("fetch")!({
    request: new Request("https://example.test/media-next/theme-boot.js", { method: "GET" }),
    respondWith: () => { answered = true; }
  });
  assert.equal(answered, false);
  assert.equal(assets().length, 1);
});

test("the API and media are never kept", async () => {
  const scope = load("https://example.test/media-next/sw.js");
  let answered = false;
  scope.handlers.get("fetch")!({
    request: new Request("https://example.test/media-next-api?action=session", { method: "GET" }),
    respondWith: () => { answered = true; }
  });
  scope.handlers.get("fetch")!({
    request: new Request("https://example.test/media-transfer/v1/files/abc", { method: "GET" }),
    respondWith: () => { answered = true; }
  });
  assert.equal(answered, false);
  assert.equal(scope.stores.size, 0);
});

test("at the root, the bridge and the transfer service are inside the base and still left alone", async () => {
  // A download is a navigation. With the application at "/" every address
  // starts with the base, and the worker used to answer for the film itself.
  const scope = load("https://example.test/sw.js");
  assert.equal(await navigate(scope, "https://example.test/media-transfer/v1/files/token"), null);
  assert.equal(await navigate(scope, "https://example.test/media-next-api?action=ratings_export&format=csv"), null);
  assert.equal(scope.stores.size, 0);
});

test("a navigation that is not a page is passed through and not kept", async () => {
  const scope = load("https://example.test/sw.js");
  scope.network.answer = () => new Response("%PDF", { status: 200, headers: { "Content-Type": "application/pdf" } });
  const response = await navigate(scope, "https://example.test/some-file.pdf");
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(scope.stores.get("tryhackx-media-shell-v3")?.size ?? 0, 0);
});
